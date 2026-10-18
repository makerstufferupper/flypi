/**
 * Automatic recall (docs/memory.md Phase 4): the prompt of every turn is searched against a real
 * memory server over MCP, and the result reaches the model once per turn as one durable session message
 * (docs/prompt-cache.md Phase 4.7 C2) — a set of memories said once, never twice (risks 2 and 4).
 *
 * The handlers are driven directly here. pi owns *when* they fire and what a real session does with what
 * they return — a real session with a real model is `tests/memory/prompt-prefix.test.ts` — so this file
 * owns what they do with a real store behind a real MCP client, with `fakeSession()` standing in for the
 * session state the two rules owned here need: the digest gate, and dropping a superseded block.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMemoryRecallExtension, memoryTool, RECALL_ENTRY, recallServer, setDigest, turnUsage } from "../../src/memory/recall.ts";
import { readFlypiMcpConfig } from "../../src/agent/runtime.ts";
import { flypiPaths } from "../../src/agent/paths.ts";
import { noneEmbedder } from "../../src/memory/embed.ts";
import { startMemoryServer, type MemoryServerHandle } from "../../src/memory/mcp.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import { createTempFlypiRoot } from "../helpers/flypi-root.ts";
import { openTestDb, refusingEmbedder, wordEmbedder } from "../helpers/memory-db.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const TOKEN = "recall-test-token";
const PNPM = "the package manager is pnpm, never npm";

let handle: MemoryServerHandle;
let store: MemoryStore;

/** An mcp.json entry as flypi reads it, so the extension is pointed at the config the model gets. */
function entryFor(config: Record<string, unknown>) {
	const root = createTempFlypiRoot();
	writeFileSync(join(root, ".flypi", "agent", "mcp.json"), JSON.stringify({ mcpServers: { "flypi-memory": config } }));
	return recallServer(readFlypiMcpConfig(flypiPaths(root)));
}

const httpEntry = (url: string) => ({ url, headers: { Authorization: `Bearer ${TOKEN}` }, exposure: "direct" });

/**
 * A stand-in for the session state the recall extension reads: the block entries appended so far, and which
 * of them a `context_edit` has dropped from model context. Only the shape this extension looks at is here —
 * `prompt-prefix.test.ts` is where a real pi session is driven.
 */
function fakeSession() {
	const blocks: { id: string; entry: Record<string, unknown> }[] = [];
	const omitted = new Set<string>();
	let seq = 0;
	return {
		ctx: {
			sessionManager: {
				buildSessionProjection: () => ({
					entries: blocks.map((block) => ({
						sourceEntry: { type: "custom_message", id: block.id, ...block.entry },
						// Empty is what the real projection uses for an entry a context_edit omitted.
						messages: omitted.has(block.id) ? [] : [{ role: "custom" }],
					})),
				}),
			},
		},
		/** What pi does with a message a `before_agent_start` handler returns: append it to the session. */
		append(message: Record<string, unknown>) {
			blocks.push({ id: `entry-${++seq}`, entry: message });
		},
		/** What pi does with the entries a `turn_end` handler returns. */
		apply(edits: { targetId: string; replacement: unknown }[]) {
			for (const edit of edits) if (edit.replacement === null) omitted.add(edit.targetId);
		},
		/** The block entries the session holds, in the order they were appended. */
		entries: () => blocks.map((block) => block.entry),
		/** The blocks a model reading this session is really shown right now. */
		live: () => blocks.filter((block) => !omitted.has(block.id)).map((block) => String(block.entry.content)),
	};
}

/** Loads the extension through pi's own API shape and returns the handlers it registered. */
async function recallHandlers(entry: ReturnType<typeof entryFor>, onInjected?: (block: string) => void) {
	const session = fakeSession();
	const handlers = new Map<string, (event: never, ctx: never) => unknown>();
	const pi = {
		on: (event: string, handler: (event: never, ctx: never) => unknown) => {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
	} as unknown as ExtensionAPI;
	await createMemoryRecallExtension(entry, onInjected)(pi);
	return {
		/**
		 * The turn's search. Returns the block it put in front of the model, or null when the digest gate held it
		 * back because this conversation already holds those memories — which is what C2 is for.
		 */
		start: async (prompt: string): Promise<string | null> => {
			const result = (await handlers.get("before_agent_start")?.({ type: "before_agent_start", prompt } as never, session.ctx as never)) as
				{ message?: Record<string, unknown> } | undefined;
			if (!result?.message) return null;
			session.append(result.message);
			return String(result.message.content ?? "");
		},
		/** The end of the turn, where a superseded block is dropped from what the model is shown. */
		endTurn: async () => {
			const result = (await handlers.get("turn_end")?.({ type: "turn_end" } as never, session.ctx as never)) as
				{ entries?: { targetId: string; replacement: unknown }[] } | undefined;
			if (result?.entries) session.apply(result.entries);
		},
		/** What the model is asked with, after the transient note (if any) was added at the last moment. */
		context: (messages: unknown[]): unknown[] | undefined =>
			(handlers.get("context")?.({ type: "context", messages } as never, session.ctx as never) as { messages?: unknown[] } | undefined)?.messages,
		entries: session.entries,
		blocks: session.live,
		tool_result: (event: Record<string, unknown>): unknown => handlers.get("tool_result")?.(event as never, session.ctx as never),
		agent_end: (messages: unknown[], willRetry = false): unknown => handlers.get("agent_end")?.({ type: "agent_end", messages, willRetry } as never, session.ctx as never),
	};
}

/** What the last turn put in front of the model: the block it appended, newest first. */
function lastBlock(extension: { blocks: () => string[] }): string {
	return extension.blocks().at(-1)!;
}

/** What a turn whose search went wrong was told at the last moment. Notes are the only thing still added to
 *  the message rather than kept: they are about that one call (src/memory/recall.ts). */
function noteOf(extension: { context: (messages: unknown[]) => unknown[] | undefined }): string {
	const message = extension.context([{ role: "user", content: "which package manager do we use?" }])![0] as {
		content: { text?: string }[];
	};
	return message.content[0]!.text!;
}

beforeAll(async () => {
	store = new MemoryStore(openTestDb(), wordEmbedder());
	await store.addMemory({ kind: "preference", body: PNPM, origin_class: "owner", session_kind: "interactive", actor: "test" });
	handle = await startMemoryServer({ store, token: TOKEN });
});

afterAll(async () => {
	await handle.close();
});

describe("which entry counts as the memory server", () => {
	// The failure this exists for: an agent started without the token mcp.json names. The entry is valid and
	// the store may be up, so nothing else says the requests will be refused — and a session that is told to
	// call `mcp__flypi_memory__memory_write` it does not have spends its turn looking for a tool that is not there.
	const placeholderEntry = { url: "http://127.0.0.1:8790/mcp", headers: { Authorization: "Bearer ${FLYPI_MEMORY_TOKEN}" }, exposure: "direct" };

	it("is no memory server when the env var the entry names is not set", () => {
		delete process.env.FLYPI_MEMORY_TOKEN;
		expect(entryFor(placeholderEntry)).toBeUndefined();
	});

	it("is the memory server once that env var is set", () => {
		process.env.FLYPI_MEMORY_TOKEN = TOKEN;
		expect(entryFor(placeholderEntry)?.name).toBe("flypi-memory");
		delete process.env.FLYPI_MEMORY_TOKEN;
	});
});

describe("per-turn recall", () => {
	it("finds the stored fact and puts it in front of the model as a message of its own", async () => {
		const extension = await recallHandlers(entryFor(httpEntry(handle.url)));
		const block = (await extension.start("which package manager do we use?"))!;

		expect(block).toContain(`#1 (preference): ${PNPM}`);
		// The entry is tagged (risk 4): it is findable as what it is, `display: false` says it is context rather
		// than something anyone said, and the digest in its details is what lets a later turn know it already
		// has these rows. The block itself is only what was found — the sentence that names the write tool rides
		// in the prompt, once per conversation instead of once per turn (docs/prompt-cache.md Phase 4.6 B3).
		const [entry] = extension.entries();
		expect(entry).toMatchObject({ customType: RECALL_ENTRY, display: false, details: { digest: setDigest([1]) } });
		expect(String(entry!.content)).not.toContain(memoryTool("flypi-memory", "memory_write"));
	});

	// C2's whole point: a set of memories is said once. A later turn that retrieves the same rows appends
	// nothing, so the bytes the provider cached stay the bytes it is sent (docs/prompt-cache.md C1).
	it("says a set of memories once: a later turn that finds the same ones appends nothing", async () => {
		const extension = await recallHandlers(entryFor(httpEntry(handle.url)));
		expect(await extension.start("which package manager do we use?")).toContain(`#1 (preference): ${PNPM}`);
		await extension.endTurn();
		expect(await extension.start("which package manager do we use? again")).toBeNull();
		await extension.endTurn();
		expect(await extension.start("pnpm or npm?")).toBeNull();
		expect(extension.blocks()).toHaveLength(1);
	});

	// Which order the store happened to return the rows in is not part of the set, and a new row, a retired row
	// or a different scope filter is. That comparison is a pure function, so it is asserted as one.
	it("compares sets of memories, not the order they came back in", () => {
		expect(setDigest([2, 1, 1])).toBe(setDigest([1, 2]));
		expect(setDigest([1])).not.toBe(setDigest([1, 2]));
		expect(setDigest([])).not.toBe(setDigest([1]));
	});

	// A block belongs to the turn that retrieved it. When the set changes, the new block replaces the old one in
	// what the model is shown; the old entry stays in the session as history, and the context_edit that dropped
	// it is the audit trail (risk 4, docs/prompt-cache.md C2).
	it("replaces the block when the set changes, and leaves only the current one in context", async () => {
		const extension = await recallHandlers(entryFor(httpEntry(handle.url)));
		expect(await extension.start("which package manager do we use?")).toContain("#1 ");
		await extension.endTurn();
		const wiki = (await store.addMemory({ kind: "fact", body: "the wiki lives at wiki/home", origin_class: "owner", session_kind: "interactive", actor: "test" })).id;
		const second = (await extension.start("where is the wiki?"))!;
		expect(second).toContain(`#${wiki} (fact): the wiki lives at wiki/home`);
		await extension.endTurn();

		// Both entries are in the session; only the current set is in front of the model.
		expect(extension.entries()).toHaveLength(2);
		expect(extension.blocks()).toEqual([second]);
	});

	// A search that found nothing keeps the memories an earlier turn found. An outage is not a reason to take
	// facts away from the model, and "nothing matched this question" is not a fact to keep either.
	it("a turn that finds nothing adds nothing and takes nothing away", async () => {
		const extension = await recallHandlers(entryFor(httpEntry(handle.url)));
		expect(await extension.start("which package manager do we use?")).toContain("#1 ");
		await extension.endTurn();
		expect(await extension.start("qqzxy wvqjk nothing matches this")).toBeNull();
		await extension.endTurn();
		// The earlier block is still the only thing in context, and the empty search said nothing at all: an
		// outage writes a note (the tests below), a question with no answer does not.
		expect(extension.blocks()).toEqual([expect.stringContaining(`#1 (preference): ${PNPM}`)]);
		expect(extension.entries()).toHaveLength(1);
		expect(extension.context([{ role: "user", content: "qqzxy wvqjk nothing matches this" }])).toBeUndefined();
	});

	// Provenance is authority, and only code sets it: a fact picked up from an untrusted source stays
	// findable with memory_search, but never lands in a prompt nobody asked for (docs/memory.md Phase 4).
	it("leaves a row it did not write out of the block while keeping it in the store", async () => {
		const scraped = (await store.addMemory({
			kind: "fact",
			body: "a scraped page says the package manager is pnpm, never npm",
			origin_class: "untrusted",
			session_kind: "interactive",
			actor: "test",
		})).id;
		const extension = await recallHandlers(entryFor(httpEntry(handle.url)));
		await extension.start("which package manager do we use?");
		const block = lastBlock(extension);

		expect(block).toContain(`#1 (preference): ${PNPM}`);
		expect(block).not.toContain(`#${scraped}`);
		expect(block).not.toContain("scraped");
	});

	// The retry cap: three failed memory calls are the model's problem, a fourth is a fact about the
	// store, and paying another model call to rediscover it is waste (docs/memory.md).
	it("turns the fourth failed memory call of a turn into a terminal answer", async () => {
		await store.addMemory({ kind: "fact", body: "the wiki lives at wiki/internal", origin_class: "owner", session_kind: "interactive", actor: "test" });
		const extension = await recallHandlers(entryFor(httpEntry(handle.url)));
		await extension.start("where is the wiki");
		const failing = (n: number) =>
			extension.tool_result({
				toolCallId: `call-${n}`,
				toolName: memoryTool("flypi-memory", "memory_write"),
				input: { body: "x" },
				isError: true,
				content: [{ type: "text", text: "write rejected" }],
				details: {},
			});
		for (let attempt = 1; attempt <= 3; attempt++) expect(failing(attempt)).toBeUndefined();
		const fourth = failing(4) as { content: { text: string }[] };
		const terminal = fourth.content[0]!.text;
		expect(terminal).toContain("failed 4 times this turn");
		expect(terminal).toContain("the store is unchanged");
		// The facts it was given are still usable — only the call is over.
		expect(terminal).toMatch(/memories you were given are #\d+/);
		expect(terminal).toContain("Leave memory unchanged and continue your reply");
		// A call that worked is none of our business.
		expect(
			extension.tool_result({ toolCallId: "ok", toolName: memoryTool("flypi-memory", "memory_read"), input: {}, isError: false, content: [], details: {} }),
		).toBeUndefined();
		// A new turn starts from zero: last turn's outages are not this turn's verdict.
		await extension.start("where is the wiki");
		expect(failing(1)).toBeUndefined();
	});

	// cited_count is the metric the plan asks for: it moves when the model's own reply uses a row, not
	// when the store happened to retrieve one. The reply is what is read, never the tool calls.
	it("counts a citation the model actually wrote, and no other number", async () => {
		const wiki = (await store.addMemory({ kind: "fact", body: "the wiki lives at wiki/ops", origin_class: "owner", session_kind: "interactive", actor: "test" })).id;
		const extension = await recallHandlers(entryFor(httpEntry(handle.url)));
		await extension.start("where is the wiki");
		expect(store.memory(wiki)!.cited_count).toBe(0);

		await extension.agent_end([{ role: "assistant", content: [{ type: "text", text: `it is at wiki/ops — see #${wiki} and #404` }] }]);
		// The id that was never shown does not count; the one that was, does.
		expect(store.memory(wiki)!.cited_count).toBe(1);
		expect(store.memory(404)).toBeUndefined();

		// A reply that cites nothing changes nothing.
		await extension.start("where is the wiki");
		await extension.agent_end([{ role: "assistant", content: [{ type: "text", text: "no citations in this one" }] }]);
		expect(store.memory(wiki)!.cited_count).toBe(1);

		// A later turn that cites it again is a second use, and counts again.
		await extension.start("where is the wiki");
		await extension.agent_end([{ role: "assistant", content: [{ type: "text", text: `#${wiki}` }] }]);
		expect(store.memory(wiki)!.cited_count).toBe(2);
		// Within one turn a row counts once, however many times its answer comes back through here —
		// a run that retries re-emits the answer it already gave.
		await extension.agent_end([{ role: "assistant", content: [{ type: "text", text: `#${wiki} again, and #${wiki} once more` }] }]);
		expect(store.memory(wiki)!.cited_count).toBe(2);
	});

	// A row the model fetched for itself is just as citable as one it was handed — but only after it
	// was actually put in front of it, which is what the memory tool result did.
	it("counts a citation of a row the model searched for itself", async () => {
		const board = (await store.addMemory({ kind: "fact", body: "the grafana dashboard is at monitor.internal", origin_class: "owner", session_kind: "interactive", actor: "test" })).id;
		const extension = await recallHandlers(entryFor(httpEntry(handle.url)));
		// A prompt nothing matches, so the block is empty and the row cannot be cited yet.
		await extension.start("qqzxy wvqjk");
		await extension.agent_end([{ role: "assistant", content: [{ type: "text", text: `#${board}` }] }]);
		expect(store.memory(board)!.cited_count).toBe(0);

		extension.tool_result({
			toolCallId: "call-search",
			toolName: memoryTool("flypi-memory", "memory_search"),
			input: { query: "grafana" },
			isError: false,
			content: [{ type: "text", text: JSON.stringify({ results: [{ id: board }] }) }],
			details: {},
		});
		await extension.agent_end([{ role: "assistant", content: [{ type: "text", text: `the dashboard is at monitor.internal, per #${board}` }] }]);
		expect(store.memory(board)!.cited_count).toBe(1);
	});

	// `memory_read` answers with one row, not a list, and a tool result that is not JSON at all is still a
	// result. Both go through the same reader, and only the first one makes a row citable.
	it("reads the ids out of a tool result it can read, and ignores one it cannot", async () => {
		const wiki = (await store.addMemory({ kind: "fact", body: "the runbook is in ops/runbook", origin_class: "owner", session_kind: "interactive", actor: "test" })).id;
		const extension = await recallHandlers(entryFor(httpEntry(handle.url)));
		await extension.start("qqzxy wvqjk"); // nothing matches, so the block is empty

		extension.tool_result({
			toolCallId: "call-read",
			toolName: memoryTool("flypi-memory", "memory_read"),
			input: { id: wiki },
			isError: false,
			content: [{ type: "text", text: JSON.stringify({ memory: { id: wiki, body: "the runbook is in ops/runbook" } }) }],
			details: {},
		});
		extension.tool_result({
			toolCallId: "call-forget",
			toolName: memoryTool("flypi-memory", "memory_forget"),
			input: { id: wiki },
			isError: false,
			content: [{ type: "text", text: "deleted" }], // not JSON: nothing becomes citable because of it
			details: {},
		});

		await extension.agent_end([{ role: "assistant", content: [{ type: "text", text: `#${wiki}, and #777 which was never in the store` }] }]);
		expect(store.memory(wiki)!.cited_count).toBe(1);
		expect(store.memory(777)).toBeUndefined();
	});

	// Reporting a citation is a second MCP client, so it can fail in two ways that must cost a data point
	// and nothing else: an entry with no URL to call (stdio), and a server that is not answering.
	it("still finishes the turn when the citation cannot be reported", async () => {
		const unreachable = [
			{ name: "stdio", config: { command: "node", args: ["memory-server.js"], description: "memory store", exposure: "direct" } },
			{ name: "not listening", config: { url: "http://127.0.0.1:1/mcp", headers: { Authorization: `Bearer ${TOKEN}` }, exposure: "direct" } },
		];
		for (const { name, config } of unreachable) {
			const { id } = await store.addMemory({ kind: "fact", body: `the retention window is 30 days ${name}`, origin_class: "owner", session_kind: "interactive", actor: "test" });
			const extension = await recallHandlers(entryFor(config));
			await extension.start(`qqzxy wvqjk ${name}`);
			extension.tool_result({
				toolCallId: `call-${name}`,
				toolName: memoryTool("flypi-memory", "memory_read"),
				input: { id },
				isError: false,
				content: [{ type: "text", text: JSON.stringify({ memory: { id } }) }],
				details: {},
			});
			await extension.agent_end([{ role: "assistant", content: [{ type: "text", text: `kept for 30 days, per #${id}` }] }]);
			expect(store.memory(id)!.cited_count).toBe(0); // the number did not move; the turn still ended
		}
	});

	// The repo's own mcp.json keeps the token as `${FLYPI_MEMORY_TOKEN}` (docs/mcp.md). pi expands it when it
	// connects; the recall extension opens a second client of its own, so it has to expand it too — or every
	// citation in production is a 401 nobody sees.
	it("expands the token in a header before reporting a citation", async () => {
		process.env.FLYPI_RECALL_TEST_TOKEN = TOKEN;
		const { id } = await store.addMemory({ kind: "fact", body: "the grafana org id is 4471", origin_class: "owner", session_kind: "interactive", actor: "test" });
		const extension = await recallHandlers(entryFor({ url: handle.url, headers: { Authorization: "Bearer ${FLYPI_RECALL_TEST_TOKEN}" }, exposure: "direct" }));
		// The search itself proves the header was expanded: an unresolved `${...}` would be a 401 here.
		await extension.start("what is the grafana org id");
		const block = lastBlock(extension);
		expect(block).toContain(`#${id} (fact): the grafana org id is 4471`);
		await extension.agent_end([{ role: "assistant", content: [{ type: "text", text: `the org id is 4471, per #${id}` }] }]);
		expect(store.memory(id)!.cited_count).toBe(1);
		delete process.env.FLYPI_RECALL_TEST_TOKEN;
	});

	// A memory server that refuses this client is a sentence in the prompt, not an exception: the model has
	// to be told the search did not happen and that it can run one itself.
	it("says the search failed when the memory server refuses the token", async () => {
		const extension = await recallHandlers(entryFor({ url: handle.url, headers: { Authorization: "Bearer not-the-token" }, exposure: "direct" }));
		await extension.start("which package manager do we use?");
		const block = noteOf(extension);
		expect(block).toContain("<relevant_memories>");
		expect(block).toContain("call mcp__flypi_memory__memory_search yourself");
		expect(block).not.toContain("#1 (preference)"); // nothing was found, so nothing is claimed
	});

	// The note belongs to the question it is about, and it is said once. A second model call in the same turn
	// must not stack a second copy (risk 2), and an older turn's block — which reaches the model as a user
	// message too — must keep its exact bytes, since the digest gate and the prefix both read them (C2).
	it("says a failed search once, on the question it was about, and never on an older block", async () => {
		const extension = await recallHandlers(entryFor({ url: handle.url, headers: { Authorization: "Bearer not-the-token" }, exposure: "direct" }));
		await extension.start("which package manager do we use?");
		const older = { role: "user", content: `<relevant_memories>\n#1 (preference): ${PNPM}\n</relevant_memories>` };
		const once = extension.context([
			{ role: "user", content: "an earlier question" },
			older,
			{ role: "assistant", content: "pnpm" },
			{ role: "user", content: "which package manager do we use?" },
		])!;
		const marked = once.at(-1) as { content: { text: string }[] };
		expect(marked.content[0]!.text).toContain("Memory search:");
		expect(marked.content[1]!.text).toBe("which package manager do we use?");
		expect(once[1]).toEqual(older);
		// The next model call of the same turn is told nothing new, which in pi means the prompt is unchanged.
		expect(extension.context(once)).toBeUndefined();
	});

	// A store whose vector half did not run still answers from the keywords. What it may not do is look like
	// a full answer (risk 8), so the block has to carry the reason next to the rows.
	it("says the search was keyword-only when the vector half did not run", async () => {
		const offline = new MemoryStore(openTestDb(), noneEmbedder());
		const { id } = await offline.addMemory({ kind: "fact", body: "the on-call rotation lives in ops/rotation", origin_class: "owner", session_kind: "interactive", actor: "test" });
		const keywordOnly = await startMemoryServer({ store: offline, token: "keyword-only-token" });
		try {
			const extension = await recallHandlers(entryFor({ url: keywordOnly.url, headers: { Authorization: "Bearer keyword-only-token" }, exposure: "direct" }));
			await extension.start("where is the on-call rotation written down");
			const block = lastBlock(extension);
			expect(block).toContain(`#${id} (fact): the on-call rotation lives in ops/rotation`);
			expect(block).toMatch(/Memory search: .*keyword/i);
		} finally {
			await keywordOnly.close();
		}
	});

	// The debug panel can only show what a turn was shown if the extension says so. It is told on every turn,
	// including one the digest gate held back — the model is still being shown those bytes.
	it("hands the host the block of every turn, and the same bytes when the set is the same", async () => {
		const reported: string[] = [];
		const extension = await recallHandlers(entryFor(httpEntry(handle.url)), (block) => reported.push(block));
		await extension.start("which package manager do we use?");
		await extension.endTurn();
		await extension.start("which package manager do we use? again");
		expect(reported).toHaveLength(2);
		expect(reported[1]).toBe(reported[0]);
		expect(reported[0]).toContain(`#1 (preference): ${PNPM}`);
	});

	it("says when the search did not run instead of going silent (risk 8)", async () => {
		const down = await startMemoryServer({ store: new MemoryStore(openTestDb(), noneEmbedder()), token: TOKEN });
		await down.close();
		const extension = await recallHandlers(entryFor(httpEntry(down.url)));
		await extension.start("anything about package managers?");
		const block = noteOf(extension);
		expect(block).toContain("Memory search:");
		expect(block).toContain(memoryTool("flypi-memory", "memory_search"));
	});

	// A turn with only an attachment has no text to search, and the server refuses an empty query. The
	// block still has to arrive, so the model is not left guessing whether recall ran.
	it("says when the search itself is refused", async () => {
		const extension = await recallHandlers(entryFor(httpEntry(handle.url)));
		await extension.start("");
		const block = noteOf(extension);
		expect(block).toContain("<relevant_memories>");
		expect(block).toContain("Memory search:");
	});

	it("carries the reason through when the results are keyword-only", async () => {
		const degradedStore = new MemoryStore(openTestDb(), refusingEmbedder("query embedding is offline"));
		await degradedStore.addMemory({ kind: "preference", body: PNPM, origin_class: "owner", session_kind: "interactive", actor: "test" });
		const degraded = await startMemoryServer({ store: degradedStore });
		try {
			const extension = await recallHandlers(entryFor({ url: degraded.url, headers: { Authorization: `Bearer ${degraded.token}` } }));
			await extension.start("which package manager do we use?");
			const block = lastBlock(extension);
			expect(block).toContain("keyword-only");
			expect(block).toContain(PNPM);
		} finally {
			await degraded.close();
		}
	});

	it("says when the entry is not an HTTP server", async () => {
		const extension = await recallHandlers(entryFor({ command: "node", args: ["scripts/serve-memory.ts"] }));
		await extension.start("anything about package managers?");
		expect(noteOf(extension)).toContain("not an HTTP server");
	});

	it("does nothing when no memory server is configured", async () => {
		const extension = await recallHandlers(undefined);
		expect(await extension.start("hello")).toBeNull();
		expect(extension.blocks()).toHaveLength(0);
	});
});

// What a `turns` row may say about the cost of its own turn (docs/prompt-cache.md Phase 4.6 A1). Those
// numbers come from what the provider answered with, and this is the one place that decides whether there
// are numbers at all — so it is asserted here, not left to a provider's mood.
describe("the numbers a turn reports about itself", () => {
	it("sums what the provider reported across the turn's model calls", () => {
		const turn = turnUsage([
			{ role: "user", content: "q" },
			{ role: "assistant", usage: { input: 100, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 105, cost: 0 } },
			{ role: "toolResult", content: "…" },
			{ role: "assistant", usage: { input: 20, output: 4, cacheRead: 105, cacheWrite: 0, totalTokens: 129, cost: { total: 0.01 } } },
		]);
		expect(turn).toEqual({ input: 120, output: 9, cacheRead: 105, cacheWrite: 0, totalTokens: 234, cost: 0.01 });
	});

	// A route that reports no usage is not a route whose turns cost nothing. Saying nothing is the only
	// honest answer: zeros in that column read back as a measurement of zero.
	it("reports nothing when the provider reported nothing", () => {
		expect(turnUsage([{ role: "user", content: "q" }, { role: "assistant", content: [] }])).toBeNull();
	});
});
