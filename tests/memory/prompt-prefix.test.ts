/**
 * Phase 4.6 A3 + 4.7 C2 (docs/prompt-cache.md): the property every other cache number depends on — what the
 * model is asked with must start with what it was asked with last time, plus new content after it. A local
 * server reuses its prefix cache only while the request bytes match up to the new text, so this is the test
 * that fails when someone moves the injected memory block, rewrites it mid-turn, or perturbs the history a
 * later call replays. Since C2 the block is part of that history: its bytes carry across the turn boundary
 * instead of being re-paid at it, and a turn that found the same set of memories appends nothing.
 *
 * The turn is the recorded one (tests/helpers/recorded-turn.ts, the input to
 * tests/fixtures/transcript-log): real pi read/edit/bash tools, real MCP memory server, real store, real
 * session file. The model is the stub — and what the stub records is the payload pi handed the provider
 * *after* every context handler, which is exactly what a provider's cache sees.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { startMemoryServer } from "../../src/memory/mcp.ts";
import { RECALL_ENTRY } from "../../src/memory/recall.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import { activeToolNames, BLOCK_MARK, carriesBlock, harness, messagesOf } from "../helpers/flypi-harness.ts";
import { openTestDb, wordEmbedder } from "../helpers/memory-db.ts";
import { FIX_THE_FAILING_TEST, fixTheFailingTest, writeFailingTestRepo } from "../helpers/recorded-turn.ts";
import { fauxAssistantMessage, fauxText } from "../helpers/stub-model.ts";

const TOKEN = "prefix-test-token";
// Worded so the prompt of the recorded turn matches it: the block has to carry rows, not only the
// standing instruction, or this test would pass while pinning nothing worth pinning.
const FACT = "fix the failing test in this repo: sort() compares numbers as strings";

let store: MemoryStore;
let db: DatabaseSync;
let server: Awaited<ReturnType<typeof startMemoryServer>>;
let factId = 0;

beforeAll(async () => {
	db = openTestDb();
	store = new MemoryStore(db, wordEmbedder());
	factId = (await store.addMemory({ kind: "convention", body: FACT, origin_class: "owner", session_kind: "interactive", actor: "test" })).id;
	server = await startMemoryServer({ store, token: TOKEN });
});

afterAll(async () => {
	await server.close();
	db.close();
});

/** The first index at which `later` stops carrying `earlier` byte for byte. */
function divergence(earlier: unknown[], later: unknown[]): number {
	let i = 0;
	while (i < earlier.length && i < later.length && JSON.stringify(earlier[i]) === JSON.stringify(later[i])) i++;
	return i;
}

/** The one assertion the whole file is built on: nothing before the new content may differ. */
function assertExtends(earlier: unknown[], later: unknown[], label: string): void {
	const at = divergence(earlier, later);
	expect(at, `${label}: diverges at message ${at} of ${earlier.length}, so everything from there on was re-paid`).toBe(earlier.length);
	expect(later.length, `${label}: nothing was appended after the previous request`).toBeGreaterThan(earlier.length);
}

/** The blocks in a request, as bytes: two requests that carry the same block compare equal. */
const blockBytesOf = (messages: unknown[]): string => JSON.stringify(messages.filter(carriesBlock));

/**
 * One conversation, two turns: the recorded multi-step turn, then a follow-up question answered from the
 * history. `memoryMcp` decides whether the recall block rides in turn 1.
 */
async function twoTurns(memoryMcp?: { url: string; token: string }) {
	const h = await harness(() => fixTheFailingTest(), {
		tools: ["read", "edit", "bash"],
		...(memoryMcp ? { memoryMcp } : {}),
	});
	writeFailingTestRepo(h.root);
	const conversation = await h.registry.create();
	const stub = h.sessions[0]!.stub;
	if (memoryMcp) await activeToolNames(h.registry.get(conversation.id).session, ["mcp__flypi_memory__memory_write"]);
	await h.registry.prompt(conversation.id, FIX_THE_FAILING_TEST);
	stub.append([fauxAssistantMessage([fauxText("the comparator coerced to strings")], { timestamp: 0 })]);
	await h.registry.prompt(conversation.id, "why did that test fail?");
	return { h, stub };
}

describe("the prompt prefix (Phase 4.6 A3)", () => {
	// The within-turn half: a multi-step turn re-sends its own prompt, so each later model call must be the
	// calls before it plus the newest tool result. This is what breaks if the block moves (say to the end of
	// the array) or is re-rendered per call (docs/risks.md risk 2).
	it("every model call of a multi-step turn extends the previous call byte for byte", async () => {
		const { h, stub } = await twoTurns({ url: server.url, token: TOKEN });
		try {
			const asks = stub.requests.map(messagesOf);
			const calls = fixTheFailingTest().length; // one assistant message per model call in turn 1
			// The script has one assistant message per model call, plus the appended follow-up answer.
			expect(asks.length).toBe(calls + 1);
			// Not a vacuous pass: the block really is in the request, naming the seeded row.
			const block = JSON.stringify(asks[0]);
			expect(block).toContain(BLOCK_MARK);
			expect(block).toContain(`#${factId} (convention): ${FACT}`);

			for (let call = 1; call < calls; call++) {
				assertExtends(asks[call - 1]!, asks[call]!, `turn 1 model call ${call}`);
			}
		} finally {
			h.registry.dispose();
			h.cleanup();
		}
	}, 30_000);

	// The cross-turn half, which is what Phase 4.7 C2 changed (docs/prompt-cache.md). The block is in the
	// session now, so turn 2 replays turn 1 including the block: the prefix that broke at turn 1's user
	// message in A3 holds, and the digest gate means turn 2 appended no second copy of it. If the block goes
	// back to being transient, this fails at exactly the message C1 measured.
	it("across the turn boundary the block's bytes carry through, and only one block is in the request", async () => {
		const { h, stub } = await twoTurns({ url: server.url, token: TOKEN });
		try {
			const asks = stub.requests.map(messagesOf);
			const calls = fixTheFailingTest().length;
			const lastOfTurn1 = asks[calls - 1]!;
			const firstOfTurn2 = asks[calls]!;

			// Not a vacuous pass: the block is in the history turn 2 replays, naming the seeded row.
			expect(JSON.stringify(lastOfTurn1)).toContain(`#${factId} (convention): ${FACT}`);
			assertExtends(lastOfTurn1, firstOfTurn2, "turn 2 replay of turn 1, block included");
			// Exactly one block, the same bytes turn 1 sent: this turn retrieved the same set, so it said
			// nothing new. A second copy here is risk 4 coming back.
			expect(firstOfTurn2.filter(carriesBlock), "a turn said the same set of memories twice (risk 4)").toHaveLength(1);
			expect(blockBytesOf(firstOfTurn2)).toBe(blockBytesOf(lastOfTurn1));
		} finally {
			h.registry.dispose();
			h.cleanup();
		}
	}, 30_000);

	// The other half of risk 4, with a real session: a turn that retrieves a different set is given its
	// block at once, and the superseded one is out of the model's context from the next turn on. The old
	// entry stays in the session file, with the context_edit that dropped it next to it — the pair is the
	// audit trail of what a turn was told.
	it("a turn that finds new memories replaces the block instead of stacking a second one", async () => {
		const h = await harness(() => fixTheFailingTest(), { tools: ["read", "edit", "bash"], memoryMcp: { url: server.url, token: TOKEN } });
		writeFailingTestRepo(h.root);
		const conversation = await h.registry.create();
		const stub = h.sessions[0]!.stub;
		await activeToolNames(h.registry.get(conversation.id).session, ["mcp__flypi_memory__memory_write"]);
		await h.registry.prompt(conversation.id, FIX_THE_FAILING_TEST);
		// A new fact appears between the turns, so the second turn's set really is different.
		const other = await store.addMemory({ kind: "convention", body: "the package manager is pnpm, never npm", origin_class: "owner", session_kind: "interactive", actor: "test" });
		stub.append([fauxAssistantMessage([fauxText("pnpm it is")], { timestamp: 0 })]);
		await h.registry.prompt(conversation.id, "and which package manager should we never use?");
		const asks = stub.requests.map(messagesOf);
		// Mid-turn the prefix is not touched: turn 2's first request carries the old block and the new one,
		// because dropping the old one there would break everything after it. It is retired when the turn ends.
		const turn2 = asks[fixTheFailingTest().length]!;
		expect(turn2.filter(carriesBlock), "the new set did not reach the model in its own turn").toHaveLength(2);
		// A third turn asking the same thing retrieves the same set, so it appends nothing: what it sees is
		// exactly one block, the current one. This is the turn that proves the old one was retired.
		stub.append([fauxAssistantMessage([fauxText("noted")], { timestamp: 0 })]);
		await h.registry.prompt(conversation.id, "and which package manager should we never use?");
		try {
			const turn3 = stub.requests.map(messagesOf).at(-1)!;
			const blocks = turn3.filter(carriesBlock);
			expect(blocks, "a superseded block is still in front of the model, or a third copy appeared").toHaveLength(1);
			const text = JSON.stringify(blocks);
			expect(text).toContain(`#${other.id} (convention): the package manager is pnpm, never npm`);
			expect(text, "the superseded block stayed in front of the model").not.toContain(`(convention): ${FACT}`);
		} finally {
			h.registry.dispose();
			h.cleanup();
		}
	}, 30_000);

	// The one thing C2 knowingly left open (docs/prompt-cache.md, PLAN.md): a compaction replaces the history
	// with a summary, and the block's entry goes with it. The digest gate reads the live projection, so the
	// next turn that retrieves the same set is supposed to append it again. The failure this guards is quiet:
	// the memories stay in the session file and the model is shown none of them for the rest of the
	// conversation, with nothing anywhere saying so.
	it("a compaction that drops the block is healed on the next turn", async () => {
		const h = await harness(() => fixTheFailingTest(), { tools: ["read", "edit", "bash"], memoryMcp: { url: server.url, token: TOKEN } });
		writeFailingTestRepo(h.root);
		// pi refuses to compact a conversation with nothing to cut, so widen the test by shrinking the
		// keep-recent window: the recorded turn is then history enough to summarize. A setting, not a stub of
		// pi's compaction — the cut, the summary and the projection are pi's own.
		writeFileSync(join(h.root, ".flypi", "agent", "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 50, reserveTokens: 100 } }));
		const conversation = await h.registry.create();
		const stub = h.sessions[0]!.stub;
		const session = h.registry.get(conversation.id).session;
		await activeToolNames(session, ["mcp__flypi_memory__memory_write"]);
		await h.registry.prompt(conversation.id, FIX_THE_FAILING_TEST);
		// Turn 1 really did put one block in front of the model.
		expect(stub.requests.map(messagesOf).at(-1)!.filter(carriesBlock)).toHaveLength(1);

		// pi's own manual compaction, the `/compact` entry point. It summarizes in two model calls (the split
		// turn prefix, then the history), so script both.
		stub.append([
			fauxAssistantMessage([fauxText("earlier the user asked for a failing test to be fixed")], { timestamp: 0 }),
			fauxAssistantMessage([fauxText("the sort compared numbers as strings; fixed with a comparator")], { timestamp: 0 }),
		]);
		await session.compact();
		// Not vacuous: the compaction is what removed the entry. If it survived, the gate below would be
		// passing for the wrong reason.
		const kept = session.sessionManager.buildSessionProjection().entries.filter((entry) => {
			const source = entry.sourceEntry;
			return source.type === "custom_message" && source.customType === RECALL_ENTRY;
		});
		expect(kept, "the compaction kept the block, so this tests nothing about healing").toHaveLength(0);

		// Same question, same set of rows retrieved. The gate has to notice the projection no longer holds them.
		stub.append([fauxAssistantMessage([fauxText("the comparator coerced to strings")], { timestamp: 0 })]);
		await h.registry.prompt(conversation.id, "why did that test fail?");
		try {
			const blocks = stub.requests.map(messagesOf).at(-1)!.filter(carriesBlock);
			expect(blocks, "the block was not re-appended after the compaction").toHaveLength(1);
			expect(JSON.stringify(blocks)).toContain(`#${factId} (convention): ${FACT}`);
		} finally {
			h.registry.dispose();
			h.cleanup();
		}
	}, 30_000);

	// The control: with no memory server configured there is nothing transient to lose, so the prefix holds
	// straight through the turn boundary. This is what proves the block is the break, and that neither
	// flypi's prompt nor pi's replay adds one of its own.
	it("a conversation with no memory server keeps its prefix across the turn boundary too", async () => {
		const { h, stub } = await twoTurns();
		try {
			const asks = stub.requests.map(messagesOf);
			expect(asks.length).toBe(fixTheFailingTest().length + 1);
			expect(asks.flat().filter(carriesBlock), "a memory block reached a session with no memory server").toEqual([]);
			for (let call = 1; call < asks.length; call++) assertExtends(asks[call - 1]!, asks[call]!, `model call ${call} across turns`);
		} finally {
			h.registry.dispose();
			h.cleanup();
		}
	}, 30_000);
});
