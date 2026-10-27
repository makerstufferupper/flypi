import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	createAgentSession,
	createMcpExtension,
	createToolSearchExtension,
	DefaultResourceLoader,
	type LoadedMcpConfig,
	type McpServerConfig,
	type McpServerEntry,
	ModelRuntime,
	type CreateAgentSessionOptions,
	type ExtensionUIContext,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { assertFlypiOwned, flypiPaths, type FlypiPaths } from "./paths.ts";
import { mcpCredentials, usesMcpOAuth } from "./pi-mcp.ts";
import { importEnvCredential, readAuth, resolveCredential } from "./onboarding.ts";
import { memoryConfig } from "../memory/config.ts";
import { createMemoryRecallExtension, memoryInstruction, memoryTool, recallServer } from "../memory/recall.ts";
import { backgroundMount, reviewPrompt, type ReviewParent } from "../memory/review.ts";
import { createPermissionGateExtension } from "./permission-gate.ts";
import { createGoalDriverExtension, createGoalExtension, createTaskExtension, goalsConfig } from "./goals.ts";
import { createSecretsExtension } from "../secrets/extension.ts";
import type { SecretStore } from "../secrets/vault.ts";

/** Derived from pi's own option types, so no transitive pi-ai / pi-agent-core import is needed here. */
export type FlypiModel = NonNullable<CreateAgentSessionOptions["model"]>;
export type FlypiThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;
export type FlypiSession = NonNullable<Awaited<ReturnType<typeof createAgentSession>>["session"]>;

/** A configuration problem the user can act on. probe.ts prints `message`, never a stack trace. */
export class FlypiConfigError extends Error {}

/**
 * The chat renders markdown (ui/Chat.svelte, src/shared/markdown.ts) and nothing in pi's prompt asks
 * for it — pi's only answer-shaping rules are "be concise" and "show file paths clearly" — so the
 * format the renderer was built for is stated once, here. The loader's `appendSystemPrompt` becomes
 * the prompt's addendum section, so it is byte-stable across turns like the rest of the system prompt.
 */
export const ANSWER_FORMAT_PROMPT =
	"Answer in markdown — this interface renders it: headings for structure, fenced code blocks for code and command output, tables for comparisons, backticks for file paths and identifiers.";

/**
 * The one place flypi creates an `AgentSession`: probe, the WS server, and the tests all go
 * through here, so the config-isolation invariant (docs/risks.md risk 1) is enforced once.
 *
 * `modelRuntime`/`model` are overridable so a test can pass the stub model
 * (tests/helpers/stub-model.ts) instead of a real provider.
 */
export async function createFlypiSession(options: {
	root?: string;
	modelRuntime?: ModelRuntime;
	model?: FlypiModel;
	thinkingLevel?: FlypiThinkingLevel;
	tools?: string[];
	env?: Record<string, string | undefined>;
	/** Supply an existing or opened session instead of starting a new one. */
	sessionManager?: SessionManager;
	/**
	 * What MCP servers this session gets, instead of what `.flypi/agent/mcp.json` says. Only the probe's
	 * `--no-memory` control needs it (docs/prompt-cache.md C1): renaming the real file aside to run the
	 * control left the memory server unconfigured whenever the process was killed mid-run
	 * (code-review.md finding 1), and the config is not something a measurement is allowed to edit.
	 */
	mcpConfig?: LoadedMcpConfig;
	/**
	 * What automatic recall put in front of the model this turn, handed to the caller as it happens. The block
	 * itself is a session entry now (Phase 4.7 C2), but this is still how the debug panel learns *which* block
	 * the turn in front of it was shown, and the one thing it can never read out of the file is the note a
	 * failed search left on the message (docs/memory.md Phase 4).
	 */
	onMemoryBlock?: (block: string) => void;
	/**
	 * flypi's own id for the conversation, so the turns the memory store records are keyed by the same id the
	 * UI and the registry use (docs/memory.md Phase 4). Left out, nothing is recorded about the turns.
	 */
	conversationId?: string;
	/**
	 * The vault (docs/secrets.md Phase 5.5). Given, the session can reach it and every tool result, memory body
	 * and answer in it is redacted against it; omitted, the conversation has no secret tools at all — which is
	 * what a process that never opened the vault (a bare `probe.ts`, a unit test) should get.
	 */
	vault?: SecretStore;
	/**
	 * This is a conversation a human is in, so it may spawn a review fork after every `memory.reviewInterval`
	 * delivered answers (docs/memory.md Phase 4.8). Off unless asked for: a probe, a daemon job, a subagent and
	 * a fork itself never spawn one, which is the whole suppression rule — there is no runner to fire.
	 */
	review?: boolean;
	/**
	 * The goal round driver (docs/goals.md 9.3): a conversation whose goal is `active` keeps running to its
	 * round cap instead of settling. Off unless asked for, for the same reason as `review` above — a probe, a
	 * daemon job, a subagent and a fork itself must never loop unattended and spend money with nobody watching.
	 * This is the one thing in Phase 9 that can hurt.
	 */
	goalDriver?: boolean;
	/**
	 * The conversation's extension UI (src/server/extension-ui.ts): what `ctx.ui.notify/select/confirm/input`
	 * do. Absent, pi binds its no-op context and an extension command's output goes nowhere — which is what a
	 * process with no page attached (a probe, a fork) should get.
	 */
	extensionUi?: ExtensionUIContext;
	/**
	 * Automatic recall (src/memory/recall.ts). False for a review fork: it inherits the parent's memory block
	 * rather than searching, logging a turn of its own, or auto-capturing over a conversation that is not its
	 * own. The MCP server is still connected, so the fork can still write what it learned.
	 */
	memoryRecall?: boolean;
} = {}): Promise<{ session: FlypiSession; paths: FlypiPaths; modelRuntime: ModelRuntime }> {
	const paths = flypiPaths(options.root ?? process.cwd());
	assertFlypiOwned(paths);

	const modelRuntime =
		options.modelRuntime ??
		(await ModelRuntime.create({ authPath: paths.authPath, modelsPath: paths.modelsPath }));

	const sessionManager = options.sessionManager ?? SessionManager.create(paths.root, paths.sessionsDir);
	// A model the caller injects (the stub-model tests) wins. Otherwise the settings default is read — but
	// it is *passed* only when the session has nothing to restore: createAgentSession restores a resumed
	// session's own model from its `model_change` entries when no model is given, and answering over that
	// is why a reopened chat went back to the default model while pi kept its thinking level. The settings
	// default stays the fallback for a recorded model that can no longer be resolved, and pi's own
	// findInitialModel applies it — so a session with no messages still starts where flypi starts one.
	const resuming = sessionManager.buildSessionContext().messages.length > 0;
	const model = options.model ?? (resuming ? undefined : resolveConfiguredModel(paths, modelRuntime, options.env));

	// MCP is not part of an SDK session unless the host asks for it (docs/sdk.md), and pi's own MCP
	// config loader reads `$PI_CODING_AGENT_DIR` (else `~/.pi/agent`) rather than the `agentDir` passed
	// below — so both the extension and where it reads from are flypi's job (docs/risks.md risk 1).
	const mcpConfig = options.mcpConfig ?? readFlypiMcpConfig(paths);
	// pi keeps an OAuth server's tokens in `mcp-auth.json` in *its* agent dir, which for flypi would be the
	// host `~/.pi/agent` — the same config bleed as the config file itself (risk 1). Only built when an entry
	// could use it, because loading pi's OAuth machinery means loading its MCP client.
	const mcpCredentialsStore = mcpConfig.servers.some((server) => server.config.enabled !== false && usesMcpOAuth(server.config))
		? await mcpCredentials(paths)
		: undefined;
	// Resolved once, and used for both halves of the memory wiring: the instruction below and the recall
	// extension have to agree about whether this session has a memory server at all.
	const memoryServer = recallServer(mcpConfig);
	// The goal config (docs/goals.md 9.0): read once here, not per call. A cap that can move mid-run is not a
	// cap, and a session whose prompt depends on a settings edit made mid-conversation is a prefix regression.
	const goals = goalsConfig(paths);
	// The review fork (docs/memory.md Phase 4.8): a conversation a human is in, a store to write to, and an
	// interval that is not switched off. `session` is read from inside the closure, which runs turns later.
	const reviewInterval = options.review && memoryServer ? memoryConfig(paths).review.interval : 0;
	const review =
		reviewInterval > 0 && memoryServer
			? {
					interval: reviewInterval,
					fork: (parent: ReviewParent) =>
						runReviewFork({ paths, modelRuntime, mcpConfig, memoryServer, vault: options.vault, tools: options.tools, parentSession: () => session }, parent),
				}
			: undefined;
	const resourceLoader = new DefaultResourceLoader({
		cwd: paths.root,
		agentDir: paths.agentDir,
		// The loader, not an extension: these say the same thing on every turn, and a per-turn
		// `before_agent_start` handler could only repeat them. The memory sentence used to sit at the top of
		// the recalled block; there it rode in the newest message, the one region a prompt cache re-pays at
		// the turn boundary, while the prompt is byte-stable and at the front of every request
		// (docs/prompt-cache.md Phase 4.6 B1). A session with no memory server is not told about one.
		appendSystemPrompt: [
			ANSWER_FORMAT_PROMPT,
			...(memoryServer ? [memoryInstruction(memoryServer.name)] : []),
		],
		extensionFactories: [
			// flypi's gate first: a tool the user has not approved is refused before any other extension
			// gets to act on the call (src/agent/permission-gate.ts).
			createPermissionGateExtension(paths),
			createMcpExtension({
				loadConfig: () => mcpConfig,
				logPath: paths.mcpLogPath,
				// Where a signed-in server's token comes from: `.flypi/agent/mcp-auth.json`, the file the settings
				// view's sign-in writes (src/agent/mcp-signin.ts). Left out, pi would read the host's.
				...(mcpCredentialsStore ? { credentials: mcpCredentialsStore } : {}),
			}),
			// The only route to an MCP server the model was not given its tools for: `exposure: "deferred"`,
			// and pi's own default, `codemode` — flypi loads no codemode extension, so without this tool such
			// a server is connected, answers, and can never be used (docs/mcp.md, "Control tool exposure").
			// The settings view offers those exposures, so the sessions have to be able to load them.
			createToolSearchExtension(),
			// `task_write` (docs/goals.md 9.1). Registered unconditionally and with a constant description:
			// pi appends prompt/tool changes rather than rewriting the prefix, so a tool that appeared only when
			// a list existed, or whose description moved with the phase, would re-pay the whole conversation
			// (risk 2). Same rule for the fork below — it has to be advertised the parent's tool set.
			createTaskExtension(),
			// The `goal` tool (docs/goals.md 9.2), registered by the same rule: the tool set stays constant, and
			// what 9.3 makes opt-in per process is the driver that continues a goal, not the tool that records one.
			createGoalExtension(goals.maxRounds),
			// The round driver (docs/goals.md 9.3): a human conversation only, and `goals.autoContinue` off means
			// no handler at all — pi then skips the settle boundary rather than asking an extension about it.
			...(options.goalDriver && goals.autoContinue ? [createGoalDriverExtension()] : []),
			...(options.memoryRecall === false
				? []
				: [createMemoryRecallExtension(memoryServer, options.onMemoryBlock, { conversationId: options.conversationId, ...(review ? { review } : {}) })]),
			// Registered only where a vault was opened, and last: the redaction it installs rewrites what the
			// other extensions produced on the way to the transcript (docs/secrets.md Phase 5.5).
			...(options.vault ? [createSecretsExtension(options.vault, { paths })] : []),
		],
	});
	await resourceLoader.reload();

	mkdirSync(paths.sessionsDir, { recursive: true });
	const { session } = await createAgentSession({
		cwd: paths.root,
		agentDir: paths.agentDir,
		modelRuntime,
		model,
		thinkingLevel: options.thinkingLevel,
		resourceLoader,
		sessionManager,
		settingsManager: SettingsManager.create(paths.root, paths.agentDir),
		tools: options.tools,
	});
	// Emits `session_start`, which is what connects the MCP servers; without it the tools never arrive.
	// Bound once: a second `bindExtensions` would emit `session_start` again and reconnect every server.
	// `rpc`, not `tui`: there is a UI, but it is not a terminal, and extensions guard terminal-only calls
	// (`ctx.ui.custom`, widgets, themes) on that value.
	await session.bindExtensions(options.extensionUi ? { uiContext: options.extensionUi, mode: "rpc" } : {});
	// Registering it is not enough: `tool_search` comes up inactive. A `deferred` server's tools happen to
	// activate it when they register, and a default-exposure (`codemode`) server's do not — the first version
	// of this line was deleted as redundant and only the second case in mcp-tool-search.test.ts noticed.
	// An add-only loadout, so pi keeps the MCP tools still connecting pending and declares them when they
	// arrive (`setActiveToolsByName` in pi's own comment).
	session.setActiveToolsByName([...session.getActiveToolNames(), "tool_search"]);
	return { session, paths, modelRuntime };
}

/**
 * One review fork (docs/memory.md Phase 4.8): the parent's conversation replayed into a session that writes
 * nothing to disk, asked one question — save what is worth saving, or say so — and disposed.
 *
 * It goes through `createFlypiSession` rather than `createAgentSession` so the config-isolation invariant
 * (risk 1) is still enforced once, and so the request is built the same way the parent's was: same provider,
 * model and thinking level, same system-prompt bytes, same advertised tools. That is what lets the fork extend
 * a prefix the route has already read instead of paying ~30K tokens cold (docs/prompt-cache.md).
 *
 * What makes it safe is the session manager: `SessionManager.inMemory` seeded with the parent's entries is
 * pi's own non-persisting session, so the fork can write memories and cannot write a line of the conversation
 * a human is reading (risk 4). Its writes land `session_kind='background'` because its memory server is on the
 * background mount, where the store refuses supersede, forget and `owner` (src/memory/mcp.ts).
 */
async function runReviewFork(
	deps: {
		paths: FlypiPaths;
		modelRuntime: ModelRuntime;
		mcpConfig: LoadedMcpConfig;
		memoryServer: McpServerEntry;
		vault?: SecretStore;
		tools?: string[];
		parentSession: () => FlypiSession;
	},
	parent: ReviewParent,
): Promise<void> {
	const source = deps.parentSession();
	const { session } = await createFlypiSession({
		root: deps.paths.root,
		modelRuntime: deps.modelRuntime,
		// The parent's own model and thinking level, not the settings default: a fork on another model is a
		// different request, and extending the parent's prefix is the whole cost argument.
		...(source.model ? { model: source.model } : {}),
		...(source.thinkingLevel ? { thinkingLevel: source.thinkingLevel } : {}),
		...(deps.tools ? { tools: deps.tools } : {}),
		...(deps.vault ? { vault: deps.vault } : {}),
		// Same servers, names and exposures — only the memory server moved to the background mount.
		mcpConfig: backgroundMount(deps.mcpConfig, deps.memoryServer.name),
		sessionManager: SessionManager.inMemory(deps.paths.root, undefined, parent.entries),
		memoryRecall: false,
	});
	try {
		// MCP tools arrive asynchronously, and asking before they land would advertise a smaller `tools[]` than
		// the parent's: a different request, and a cold cache. Bounded, because a server that never answers must
		// not hang a fork nobody is waiting on.
		if (await toolsArrived(session, memoryTool(deps.memoryServer.name, "memory_write"))) {
			await session.prompt(reviewPrompt(deps.memoryServer.name));
		}
	} finally {
		session.dispose();
	}
}

/** Whether the memory tools are declared yet. A fork with no memory tools has nothing to be for. */
async function toolsArrived(session: FlypiSession, writeTool: string, deadlineMs = 10_000): Promise<boolean> {
	const until = Date.now() + deadlineMs;
	for (;;) {
		if (session.getActiveToolNames().includes(writeTool)) return true;
		if (Date.now() > until) return false;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

/**
 * `.flypi/agent/mcp.json` as the MCP extension wants it. Values stay exactly as written: pi expands
 * `${NAME}` in `env`/`headers` itself when it builds a transport, and the settings panel writes the
 * same file (src/agent/config-files.ts), so there is one source of truth for the servers.
 */
export function readFlypiMcpConfig(paths: FlypiPaths): LoadedMcpConfig {
	const servers: McpServerEntry[] = [];
	const errors: string[] = [];
	if (!existsSync(paths.mcpPath)) return { servers, errors };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(paths.mcpPath, "utf8"));
	} catch (error) {
		return { servers, errors: [`${paths.mcpPath}: ${(error as Error).message}`] };
	}
	const entries = (parsed as { mcpServers?: Record<string, Record<string, unknown>> } | undefined)?.mcpServers ?? {};
	for (const [name, config] of Object.entries(entries)) {
		// The rule pi applies itself (docs/mcp.md): an invalid entry is reported, it does not take the
		// rest of the file down with it.
		if (!config || (config.url === undefined && config.command === undefined)) {
			errors.push(`${paths.mcpPath}: "${name}" needs a url (HTTP) or a command (stdio)`);
			continue;
		}
		servers.push({ name, config: config as unknown as McpServerConfig, source: paths.mcpPath, scope: "global" });
	}
	return { servers, errors };
}

/**
 * Read `.flypi/agent/settings.json` for the default provider/model and check the credential,
 * with the same actionable messages probe.ts prints. Imported env keys land in auth.json once.
 */
export function resolveConfiguredModel(
	paths: FlypiPaths,
	modelRuntime: ModelRuntime,
	env: Record<string, string | undefined> = process.env,
): FlypiModel {
	let settings: Record<string, unknown>;
	let models: Record<string, unknown>;
	try {
		settings = JSON.parse(readFileSync(paths.settingsPath, "utf8")) as Record<string, unknown>;
		models = JSON.parse(readFileSync(paths.modelsPath, "utf8")) as Record<string, unknown>;
	} catch (error) {
		throw new FlypiConfigError(
			`could not read ${paths.settingsPath} or ${paths.modelsPath}: ${(error as Error).message}`,
		);
	}
	const provider = settings.defaultProvider as string | undefined;
	const modelId = settings.defaultModel as string | undefined;
	if (!provider || !modelId) {
		throw new FlypiConfigError(
			`${paths.settingsPath} must set defaultProvider and defaultModel (flypi has no built-in default).`,
		);
	}

	importEnvCredential(paths.authPath, provider, env);
	const credential = resolveCredential({
		provider,
		models: models as never,
		auth: readAuth(paths.authPath),
		env,
	});
	if (!credential.ok) throw new FlypiConfigError(credential.message);

	const model = modelRuntime.getModel(provider, modelId);
	if (!model) {
		const known = modelRuntime
			.getModels()
			.map((m) => `${m.provider}/${m.id}`)
			.join(", ");
		throw new FlypiConfigError(
			`model "${provider}/${modelId}" is not defined in ${paths.modelsPath}. Defined: ${known || "(none)"}`,
		);
	}
	return model;
}
