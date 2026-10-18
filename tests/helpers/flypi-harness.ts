import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { flypiPaths } from "../../src/agent/paths.ts";
import { openMemoryDb } from "../../src/memory/db.ts";
import { openSecretVault, type SecretStore } from "../../src/secrets/vault.ts";
import { createFlypiSession } from "../../src/agent/runtime.ts";
import { SessionRegistry, type CreateSession } from "../../src/server/session-registry.ts";
import { createTempFlypiRoot } from "./flypi-root.ts";
import {
	createStubModel,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type FauxResponseStep,
	type StubModel,
} from "./stub-model.ts";

export interface StubSession {
	session: Awaited<ReturnType<typeof createFlypiSession>>["session"];
	stub: StubModel;
}

export interface HarnessOptions {
	idleTtlMs?: number;
	now?: () => number;
	logCapacity?: number;
	tokensPerSecond?: number;
	/** Tools to register in the session. Defaults to read+bash, the smallest multi-tool set. */
	tools?: string[];
	/**
	 * Whether these conversations may spawn a review fork (Phase 4.8). Defaults to on with a memory server, the
	 * way the registry has it on for every conversation; a test that counts model calls turns it off.
	 */
	review?: boolean;
	/**
	 * Write an `mcp.json` entry named `flypi-memory` pointing at a real memory server, so the automatic
	 * recall path runs for real inside a registry test (docs/memory.md Phase 4).
	 */
	memoryMcp?: { url: string; token: string };
	/**
	 * Turn lifecycle, for the daemon's `runs` record (docs/architecture.md Phase 4.5). Passed straight to
	 * the registry, so a test can see exactly what a daemon would have written.
	 */
	onRunStatus?: (conversationId: string, status: "running" | "idle" | "aborted", info: { seq: number; sessionFile?: string }) => void;
	/**
	 * A real vault in the session (docs/secrets.md Phase 5.5), so a test can watch a secret reach a tool
	 * result and an answer and still not reach the session file. `withVault` opens one on the checkout the
	 * harness made — the memory database and the key file included — and hands it back.
	 */
	vault?: SecretStore;
	withVault?: boolean;
}

/**
 * The `createSession` a `SessionRegistry` needs in order to answer with the deterministic stub model.
 * `harness()` uses it; the daemon test does too, because `startFlypiDaemon` builds its own registry and a
 * daemon test must not download a model to prove a turn was recorded.
 */
export function stubCreateSession(
	root: string,
	script: () => FauxResponseStep[],
	options: { tokensPerSecond?: number; tools?: string[]; memoryMcp?: { url: string; token: string }; authPath?: string; vault?: SecretStore; review?: boolean; onSession?: (session: StubSession["session"], stub: StubModel) => void } = {},
): CreateSession {
	return async ({ sessionManager, conversationId, onMemoryBlock, extensionUi }) => {
		const stub = await createStubModel({ responses: script(), ...(options.tokensPerSecond ? { tokensPerSecond: options.tokensPerSecond } : {}), ...(options.authPath ? { authPath: options.authPath } : {}) });
		const { session } = await createFlypiSession({
			root,
			sessionManager,
			conversationId,
			modelRuntime: stub.modelRuntime,
			model: stub.model,
			// A tool allowlist with no `mcp__` entry keeps MCP tools off the prompt, so wiring memory
			// without opening the list would test a session that cannot call it (pi's AgentSession options).
			tools: options.memoryMcp ? [...(options.tools ?? ["read", "bash"]), "mcp__*"] : (options.tools ?? ["read", "bash"]),
			...(options.vault ? { vault: options.vault } : {}),
			// As in the registry: a conversation a human is in may spawn a review fork (Phase 4.8). Off with no
			// memory server, since a fork with no store to write to has nothing to be.
			...(options.review === undefined ? (options.memoryMcp ? { review: true } : {}) : options.review ? { review: true } : {}),
			onMemoryBlock,
			extensionUi,
		});
		options.onSession?.(session, stub);
		return session;
	};
}

/**
 * A flypi checkout + a `SessionRegistry` whose sessions come from the deterministic stub model.
 * `script()` is called once per conversation, so two conversations see the same transcript.
 */
export async function harness(
	script: () => FauxResponseStep[],
	options: HarnessOptions = {},
): Promise<{
	root: string;
	registry: SessionRegistry;
	sessions: StubSession[];
	disposeCount: () => number;
	/** Only with `withVault`: the vault the sessions are wired to, on this checkout's own database. */
	vault: SecretStore;
	cleanup: () => void;
}> {
	const root = createTempFlypiRoot();
	// Isolate credentials too: without this the runtime reads the developer's ~/.pi/agent/auth.json,
	// so "which models are available" would depend on whose machine runs the suite (risk 1).
	const authPath = join(root, ".flypi", "agent", "auth.json");
	writeFileSync(authPath, "{}\n");
	const sessions: StubSession[] = [];
	let disposes = 0;
	const { tokensPerSecond, tools, memoryMcp, withVault, review, ...registryOptions } = options;
	let vault = options.vault;
	let vaultDb: DatabaseSync | undefined;
	if (withVault) {
		// The same file the memory store would use, opened the way the daemon opens it: one database, one writer.
		vaultDb = openMemoryDb(join(root, ".flypi", "memory", "flypi.db"));
		vault = openSecretVault(flypiPaths(root), { db: vaultDb, write: true });
	}
	if (memoryMcp) {
		writeFileSync(
			join(root, ".flypi", "agent", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					"flypi-memory": {
						url: memoryMcp.url,
						headers: { Authorization: `Bearer ${memoryMcp.token}` },
						exposure: "direct",
						// As in flypi's own mcp.json: the after-the-turn reports are flypi's, not the model's.
						toolExposure: { memory_cite: "hidden", memory_capture: "hidden", memory_turn: "hidden" },
					},
				},
			}),
		);
	}
	const registry = new SessionRegistry({
		root,
		...registryOptions,
		createSession: stubCreateSession(root, script, {
			...(tokensPerSecond === undefined ? {} : { tokensPerSecond }),
			...(tools === undefined ? {} : { tools }),
			...(memoryMcp ? { memoryMcp } : {}),
			...(review === undefined ? {} : { review }),
			...(vault ? { vault } : {}),
			authPath,
			onSession: (session, stub) => {
				// Shadow dispose on the instance so "exactly once" is observable.
				const disposeOriginal = session.dispose.bind(session);
				session.dispose = () => {
					disposes += 1;
					disposeOriginal();
				};
				sessions.push({ session, stub });
			},
		}),
	});
	return {
		root,
		registry,
		sessions,
		disposeCount: () => disposes,
		vault: vault!,
		cleanup: () => {
			// A vault left wired to a deleted database makes the next test in this file fail for reasons that
			// have nothing to do with it (src/secrets/redact.ts pulls from it process-wide).
			vault?.close();
			vaultDb?.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/**
 * MCP servers connect in the background (docs/mcp.md), so proof that a tool is reachable is a wait with a
 * deadline, never a sleep. Shared by every test that needs the memory tools declared.
 */
export async function activeToolNames(session: { getActiveToolNames(): string[] }, want: string[], deadline = 20_000): Promise<string[]> {
	const until = Date.now() + deadline;
	for (;;) {
		const active = session.getActiveToolNames();
		if (want.every((tool) => active.includes(tool)) || Date.now() > until) return active;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

/**
 * The message array pi handed the provider, as the stub recorded it: the payload a provider's prefix cache
 * sees, and the only honest place to ask what a turn was really shown. Shared by every test that reads a
 * model call back rather than trusting what the app says it sent.
 */
export function messagesOf(request: unknown): unknown[] {
	return (request as { messages?: unknown[] }).messages ?? [];
}

/** The tag src/memory/recall.ts renders an injected memory block in. One copy here, not one per test file. */
export const BLOCK_MARK = "<relevant_memories>";
export const carriesBlock = (message: unknown): boolean => JSON.stringify(message).includes(BLOCK_MARK);

/** A turn that calls the real bash tool, then answers. Used by every multi-step test. */
export function toolTurn(finalText = "listed the files"): () => FauxResponseStep[] {
	return () => [
		fauxAssistantMessage([fauxToolCall("bash", { command: "ls" }, { id: "call-1" })], { stopReason: "toolUse", timestamp: 0 }),
		fauxAssistantMessage([fauxText(finalText)], { timestamp: 0 }),
	];
}

/** Resolves once the conversation has produced its first event, i.e. it is mid-turn. */
export function firstEvent(conversationId: string, registry: SessionRegistry): Promise<void> {
	return new Promise((resolve) => {
		const detach = registry.attach(conversationId, () => {
			detach();
			resolve();
		});
	});
}

export function settled(conversationId: string, registry: SessionRegistry): Promise<void> {
	return new Promise((resolve) => {
		const detach = registry.attach(conversationId, (_seq, event) => {
			if (event.type === "agent_settled") {
				detach();
				resolve();
			}
		});
	});
}

/**
 * Strip the things that legitimately differ between two runs of the same script: wall-clock
 * timestamps, the stub's per-call nonce (`faux:1791362893082:2f5jk9dv38b`), and absolute paths
 * under a temporary root. Everything else must match byte-for-byte, or the transcript test
 * proves nothing.
 */
export function normalize(value: unknown, root?: string): unknown {
	if (Array.isArray(value)) return value.map((entry) => normalize(entry, root));
	if (typeof value === "string") {
		const stable = /^faux:\d+:[a-z0-9]+$/.test(value) ? "faux:stable" : value;
		return root ? stable.split(root).join("<root>") : stable;
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([key]) => key !== "timestamp")
				.map(([key, entry]) => [key, normalize(entry, root)]),
		);
	}
	return value;
}
