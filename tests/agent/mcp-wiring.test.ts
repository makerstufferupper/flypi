/**
 * Does the server in `.flypi/agent/mcp.json` reach the model? It did not: an SDK session loads no MCP
 * support at all, and pi's own MCP config loader points at `$PI_CODING_AGENT_DIR` (else `~/.pi/agent`)
 * rather than the `agentDir` flypi passes — so the entry was inert and no `mcp__flypi-memory__*` tool
 * was ever declared (docs/pi-api.md, "MCP is off until you ask for it").
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFlypiSession, readFlypiMcpConfig } from "../../src/agent/runtime.ts";
import { memoryInstruction } from "../../src/memory/recall.ts";
import { flypiPaths } from "../../src/agent/paths.ts";
import { startMemoryServer, type MemoryServerHandle } from "../../src/memory/mcp.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import { createTempFlypiRoot } from "../helpers/flypi-root.ts";
import { activeToolNames } from "../helpers/flypi-harness.ts";
import { createStubModel, fauxAssistantMessage, fauxText, fauxToolCall } from "../helpers/stub-model.ts";
import { openTestDb, wordEmbedder } from "../helpers/memory-db.ts";

const TOKEN = "wired-memory-token";
const MEMORY_TOOLS = ["mcp__flypi_memory__memory_search", "mcp__flypi_memory__memory_write"];
const PNPM = "the package manager is pnpm, never npm";

let handle: MemoryServerHandle;
let store: MemoryStore;

beforeAll(async () => {
	store = new MemoryStore(openTestDb(), wordEmbedder());
	await store.addMemory({ kind: "preference", body: PNPM, origin_class: "owner", session_kind: "interactive", actor: "test" });
	handle = await startMemoryServer({ store, token: TOKEN });
});

afterAll(async () => {
	await handle.close();
});

/** A checkout that connects to the memory server, with the token referenced the way pi documents it. */
function rootWithMemoryMcp(): string {
	const root = createTempFlypiRoot();
	writeFileSync(
		join(root, ".flypi", "agent", "mcp.json"),
		JSON.stringify({
			mcpServers: {
				"flypi-memory": {
					url: handle.url,
					headers: { Authorization: `Bearer ${"${FLYPI_MEMORY_TOKEN}"}` },
					exposure: "direct",
					// As in flypi's own mcp.json: the after-the-turn reports are flypi's, not the model's.
					toolExposure: { memory_cite: "hidden", memory_capture: "hidden", memory_turn: "hidden" },
				},
			},
		}),
	);
	return root;
}

describe("the memory MCP server is connected to flypi's own sessions", () => {
	it("declares memory_write and memory_search to the model, token expanded from the environment", async () => {
		process.env.FLYPI_MEMORY_TOKEN = TOKEN;
		const stub = await createStubModel();
		const { session } = await createFlypiSession({ root: rootWithMemoryMcp(), modelRuntime: stub.modelRuntime, model: stub.model });
		try {
			const active = await activeToolNames(session, MEMORY_TOOLS);
			expect(active).toEqual(expect.arrayContaining(MEMORY_TOOLS));
			// These three exist for flypi, not for the model: a count the model can raise about itself would
			// measure politeness, not usefulness, and a turn log it could write would not be a measurement.
			for (const hidden of ["memory_cite", "memory_capture", "memory_turn"]) {
				expect(active).not.toContain(`mcp__flypi_memory__${hidden}`);
			}
		} finally {
			session.dispose();
			delete process.env.FLYPI_MEMORY_TOKEN;
		}
	});

	// The counter the debug panel and dreaming will read, proven on a real session rather than at the
	// handler: the model cited a row it was shown, so the store knows that fact earned its place.
	it("counts a citation the model wrote in its own reply", async () => {
		process.env.FLYPI_MEMORY_TOKEN = TOKEN;
		const stub = await createStubModel({ responses: [fauxAssistantMessage([fauxText(`we use pnpm, per #1 and #404`)], { timestamp: 0 })] });
		const { session } = await createFlypiSession({ root: rootWithMemoryMcp(), modelRuntime: stub.modelRuntime, model: stub.model });
		try {
			await session.prompt("which package manager do we use?");
			// The report is a call to another process; wait for it with a deadline rather than a sleep.
			const until = Date.now() + 5_000;
			while (store.memory(1)!.cited_count === 0 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25));
			expect(store.memory(1)!.cited_count).toBe(1);
			// #404 was never shown to the model, so it is not a citation of anything.
			expect(store.memory(404)).toBeUndefined();
		} finally {
			session.dispose();
			delete process.env.FLYPI_MEMORY_TOKEN;
		}
	});

	// The point of the wiring: not that the tools exist, but that the memories are in front of the model
	// on its own, without it deciding to search (docs/memory.md Phase 4).
	it("searches on every turn, not only when the model asks", async () => {
		process.env.FLYPI_MEMORY_TOKEN = TOKEN;
		const stub = await createStubModel({
			responses: [fauxAssistantMessage([fauxText("pnpm")], { timestamp: 0 }), fauxAssistantMessage([fauxText("never npm")], { timestamp: 0 })],
		});
		const { session } = await createFlypiSession({ root: rootWithMemoryMcp(), modelRuntime: stub.modelRuntime, model: stub.model });
		try {
			await session.prompt("which package manager do we use?");
			await session.prompt("and which package manager should we never use?");
			const sent = stub.requests.map((request) => JSON.stringify(request.messages));
			expect(sent).toHaveLength(2);
			for (const messages of sent) {
				expect(messages).toContain("<relevant_memories>");
				expect(messages).toContain(PNPM);
			}
		} finally {
			session.dispose();
			delete process.env.FLYPI_MEMORY_TOKEN;
		}
	});

	// Phase 4.6 B (docs/prompt-cache.md): the standing instruction is said once, in the prompt, where a
	// prompt cache keeps it for the rest of the conversation — not inside the block, which is transient and
	// rides in the newest message, the one region a route re-pays at the turn boundary. Asserted both ways:
	// once in the prompt, nowhere in what the model was asked with.
	it("says the memory instruction once in the prompt and never in the injected block", async () => {
		process.env.FLYPI_MEMORY_TOKEN = TOKEN;
		const stub = await createStubModel({ responses: [fauxAssistantMessage([fauxText("pnpm")], { timestamp: 0 })] });
		const instruction = memoryInstruction("flypi-memory");
		const { session } = await createFlypiSession({ root: rootWithMemoryMcp(), modelRuntime: stub.modelRuntime, model: stub.model });
		try {
			await session.prompt("which package manager do we use?");
			expect(counts(session.systemPrompt, instruction), "the standing instruction is not in the prompt once").toBe(1);
			// Not a vacuous pass: the block really did arrive, naming the row. Everything after the system
			// message is what this turn put there — and it holds rows, nothing else.
			const turn = stub.requests[0]!.messages.filter((message) => (message as { role?: string }).role !== "system");
			const asked = JSON.stringify(turn);
			expect(asked).toContain("<relevant_memories>");
			expect(asked).toContain(PNPM);
			// Matched on the sentence's tail: the prompt's quoted server name is JSON-escaped in the payload,
			// so the whole instruction only matches in `session.systemPrompt` above.
			const tail = "Cite any memory you use as #id.";
			expect(asked).not.toContain(tail);
			expect(asked).not.toContain("mcp__flypi_memory__memory_write");
			// Once in the whole request, which is the system message's doing and not the block's.
			expect(counts(JSON.stringify(stub.requests[0]!.messages), tail)).toBe(1);
		} finally {
			session.dispose();
			delete process.env.FLYPI_MEMORY_TOKEN;
		}
	});

	// The other half of B1: a conversation with no memory server pays for no memory instruction.
	it("says nothing about memory to a session with no memory server", async () => {
		const stub = await createStubModel();
		const { session } = await createFlypiSession({ root: createTempFlypiRoot(), modelRuntime: stub.modelRuntime, model: stub.model });
		try {
			expect(session.systemPrompt).not.toContain("relevant_memories");
			expect(session.systemPrompt).not.toContain("memory_write");
		} finally {
			session.dispose();
		}
	});

	// The dev-instance failure this guards: the entry is configured, the store is up, and the process was
	// started without the token the entry names. pi cannot authenticate, so the tools never arrive — and a
	// prompt that still orders the model to call them, plus a recall note telling it to call `memory_search`
	// itself, leaves it hunting for a tool `tool_search` cannot find.
	it("says nothing about memory when the token the entry names is not set", async () => {
		delete process.env.FLYPI_MEMORY_TOKEN;
		const stub = await createStubModel();
		const { session } = await createFlypiSession({ root: rootWithMemoryMcp(), modelRuntime: stub.modelRuntime, model: stub.model });
		try {
			expect(session.systemPrompt).not.toContain("memory_write");
			// A short deadline: this asserts the tools never arrive, and waiting pi's full startup timeout
			// for a negative would only make the test slow.
			expect(await activeToolNames(session, MEMORY_TOOLS, 1_500)).not.toEqual(expect.arrayContaining(MEMORY_TOOLS));
		} finally {
			session.dispose();
		}
	});

	// `probe:turn -- --no-memory` (C1's control) gets that state from the `mcpConfig` override, not from
	// renaming the real `.flypi/agent/mcp.json` away: a killed run used to leave the memory server
	// unconfigured for the app (code-review.md finding 1). So the override has to reach both halves — the
	// instruction and the recall — while the file on disk still names the server.
	it("runs with no memory server when the caller overrides the config, file and all", async () => {
		process.env.FLYPI_MEMORY_TOKEN = TOKEN;
		const root = rootWithMemoryMcp();
		// Not vacuous: this root really does configure the memory server.
		expect(readFlypiMcpConfig(flypiPaths(root)).servers.map((server) => server.name)).toEqual(["flypi-memory"]);
		const stub = await createStubModel({ responses: [fauxAssistantMessage([fauxText("pnpm")], { timestamp: 0 })] });
		const { session } = await createFlypiSession({
			root,
			mcpConfig: { servers: [], errors: [] },
			modelRuntime: stub.modelRuntime,
			model: stub.model,
		});
		try {
			await session.prompt("which package manager do we use?");
			expect(session.systemPrompt).not.toContain("memory_write");
			expect(JSON.stringify(stub.requests[0]!.messages)).not.toContain("relevant_memories");
		} finally {
			session.dispose();
			delete process.env.FLYPI_MEMORY_TOKEN;
		}
	});

	// The other half of what the user asked for: "remember this" goes to the memory server through the
	// declared write tool, and what was written is in front of the model on the next turn.
	it("writes what the user asked to remember, and reads it back on the next turn", async () => {
		process.env.FLYPI_MEMORY_TOKEN = TOKEN;
		const written = "the deploy target is the small box";
		const stub = await createStubModel({
			responses: [
				fauxAssistantMessage(
					[fauxToolCall("mcp__flypi_memory__memory_write", { body: written, kind: "fact", reason: "the user asked" }, { id: "write-1" })],
					{ stopReason: "toolUse", timestamp: 0 },
				),
				fauxAssistantMessage([fauxText("stored")], { timestamp: 0 }),
				fauxAssistantMessage([fauxText("the small box")], { timestamp: 0 }),
			],
		});
		const { session } = await createFlypiSession({ root: rootWithMemoryMcp(), modelRuntime: stub.modelRuntime, model: stub.model });
		try {
			await session.prompt("remember that we deploy to the small box");
			expect((await store.search({ query: "deploy target" })).results.map((row) => row.body)).toContain(written);

			await session.prompt("where do we deploy?");
			expect(JSON.stringify(stub.requests.at(-1)!.messages)).toContain(written);
		} finally {
			session.dispose();
			delete process.env.FLYPI_MEMORY_TOKEN;
		}
	});

	// Auto-capture v1 (docs/memory.md Phase 4): a fact the user typed that nobody stored. The model is not
	// asked to notice it — these rules run after the turn — so this is the only test that can show flypi
	// wrote it. Proven through the real session, because that is the only place the rules get their input.
	it("captures a stated fact the model left alone, as the user's own words", async () => {
		process.env.FLYPI_MEMORY_TOKEN = TOKEN;
		const stub = await createStubModel({ responses: [fauxAssistantMessage([fauxText("noted")], { timestamp: 0 })] });
		const { session } = await createFlypiSession({ root: rootWithMemoryMcp(), modelRuntime: stub.modelRuntime, model: stub.model });
		try {
			await session.prompt("remember that the build artifact lives in dist/flypi.tar.gz");
			const found = await untilRows(store, "build artifact dist flypi tar");
			// The body is what the user wrote, not a summary of it: an interpretation would be flypi putting
			// words in the user's mouth.
			expect(found.map((row) => row.body)).toContain("the build artifact lives in dist/flypi.tar.gz");
			// `owner`, because it came from the user's sentence — the mount sets that, and capture is the only
			// path to it that runs without the model deciding to store anything.
			expect(found.map((row) => `${row.body} ${row.origin_class}`).filter((row) => row.endsWith("owner"))).toHaveLength(1);
		} finally {
			session.dispose();
			delete process.env.FLYPI_MEMORY_TOKEN;
		}
	});

	// The same sentence, with the model storing it itself. Capturing it again would be a second row for one
	// instruction — and the near-duplicate gate is not reliable enough to be the thing that prevents it.
	it("does not capture a second copy of what the model already stored", async () => {
		process.env.FLYPI_MEMORY_TOKEN = TOKEN;
		const stated = "the release train leaves on fridays";
		const stub = await createStubModel({
			responses: [
				fauxAssistantMessage([fauxToolCall("mcp__flypi_memory__memory_write", { body: stated, kind: "fact", reason: "the user asked" }, { id: "w-1" })], { stopReason: "toolUse", timestamp: 0 }),
				fauxAssistantMessage([fauxText("stored")], { timestamp: 0 }),
			],
		});
		const { session } = await createFlypiSession({ root: rootWithMemoryMcp(), modelRuntime: stub.modelRuntime, model: stub.model });
		try {
			await session.prompt(`remember that ${stated}`);
			const rows = (await untilRows(store, "release train fridays")).filter((row) => row.body === stated);
			expect(rows).toHaveLength(1);
			// The one row is the model's write, so capture stayed out of it.
			expect(rows[0]!.origin_class).toBe("agent");
		} finally {
			session.dispose();
			delete process.env.FLYPI_MEMORY_TOKEN;
		}
	});

	it("keeps what a failed command taught the agent, without crediting the user with it", async () => {
		// A real shell tool, so the failure is real. The two calls differ only in the runner: same argument,
		// one exit 1 and one exit 0 — which is what "the same attempt, fixed" means here (`test -f X` then
		// `echo X`, the shape of `npm run build` then `pnpm run build`). The path cannot exist anywhere, so no
		// cwd can make the first call succeed.
		process.env.FLYPI_MEMORY_TOKEN = TOKEN;
		const stub = await createStubModel({
			responses: [
				fauxAssistantMessage([fauxToolCall("bash", { command: "test -f /definitely/not/here.txt" }, { id: "first" })], { stopReason: "toolUse", timestamp: 0 }),
				fauxAssistantMessage([fauxToolCall("bash", { command: "echo /definitely/not/here.txt" }, { id: "second" })], { stopReason: "toolUse", timestamp: 0 }),
				fauxAssistantMessage([fauxText("built")], { timestamp: 0 }),
			],
		});
		const { session } = await createFlypiSession({ root: rootWithMemoryMcp(), modelRuntime: stub.modelRuntime, model: stub.model });
		try {
			await session.prompt("build it");
			const rows = await untilRows(store, "echo failed worked");
			const lesson = rows.find((row) => row.body.includes("failed;"));
			expect(lesson?.body).toBe("`test -f /definitely/not/here.txt` failed; `echo /definitely/not/here.txt` worked");
			expect(lesson?.kind).toBe("fact");
			// Nobody was told this. It is the agent's own finding, and the column is what keeps that straight
			// when a later turn has to decide what a fact is worth.
			expect(lesson?.origin_class).toBe("agent");
		} finally {
			session.dispose();
			delete process.env.FLYPI_MEMORY_TOKEN;
		}
	});
});

/** How many times `needle` appears in `haystack` — "exactly once" needs counting, not `toContain`. */
function counts(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

/**
 * A captured row is written after the turn, in another process, so proof is a wait with a deadline. Same
 * argument as the MCP connection above (docs/mcp.md).
 */
async function untilRows(store: MemoryStore, query: string, deadline = 5_000) {
	const until = Date.now() + deadline;
	for (;;) {
		const results = (await store.search({ query })).results;
		if (results.length > 0 || Date.now() > deadline) return results;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

describe("a memory server that went away mid-turn", () => {
it("answers normally when the store is gone by the time the turn reports", async () => {
	// The after-the-turn reports are the last thing a turn does. If the store is gone by then, the answer the
	// user asked for must still arrive: a measurement that could not be written is not a failed turn.
	const dead = await startMemoryServer({ store: new MemoryStore(openTestDb(), wordEmbedder()), token: TOKEN });
	const url = dead.url;
	await dead.close();
	const root = createTempFlypiRoot();
	writeFileSync(
		join(root, ".flypi", "agent", "mcp.json"),
		JSON.stringify({
			mcpServers: {
				"flypi-memory": {
					url,
					headers: { Authorization: `Bearer ${"${FLYPI_MEMORY_TOKEN}"}` },
					exposure: "direct",
					toolExposure: { memory_cite: "hidden", memory_capture: "hidden", memory_turn: "hidden" },
				},
			},
		}),
	);
	process.env.FLYPI_MEMORY_TOKEN = TOKEN;
	const stub = await createStubModel({ responses: [fauxAssistantMessage([fauxText("still here")], { timestamp: 0 })] });
	const { session } = await createFlypiSession({ root, modelRuntime: stub.modelRuntime, model: stub.model });
	try {
		// A sentence capture would have stored, so every after-the-turn report runs and all of them fail.
		await session.prompt("remember that the release train runs on fridays");
		// Reaching here is the assertion: the turn completed and the model was still asked once.
		expect(stub.requests).toHaveLength(1);
	} finally {
		session.dispose();
		delete process.env.FLYPI_MEMORY_TOKEN;
	}
});
});

describe("reading .flypi/agent/mcp.json", () => {
	it("is empty, not an error, when the file does not exist", () => {
		const config = readFlypiMcpConfig(flypiPaths(createTempFlypiRoot()));
		expect(config).toEqual({ servers: [], errors: [] });
	});

	it("treats a file without an mcpServers key as nothing configured", () => {
		const root = createTempFlypiRoot();
		for (const body of [JSON.stringify({ version: 1 }), "null"]) {
			writeFileSync(join(root, ".flypi", "agent", "mcp.json"), body);
			expect(readFlypiMcpConfig(flypiPaths(root))).toEqual({ servers: [], errors: [] });
		}
	});

	it("reports an entry that names neither a url nor a command, and keeps the others", () => {
		const root = createTempFlypiRoot();
		writeFileSync(
			join(root, ".flypi", "agent", "mcp.json"),
			JSON.stringify({ mcpServers: { broken: {}, ok: { url: "http://127.0.0.1:1/mcp" } } }),
		);
		const config = readFlypiMcpConfig(flypiPaths(root));
		expect(config.errors[0]).toContain('"broken" needs a url');
		expect(config.servers.map((server) => server.name)).toEqual(["ok"]);
	});
});
