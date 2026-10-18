/**
 * The Phase 4 gate (docs/memory.md): "a fact one conversation stored changes what a brand-new second
 * conversation says, and correcting it leaves the old row queryable as history."
 *
 * This is the end-to-end version of that sentence, and the reason the other tests are not enough on their
 * own: they drive the recall extension with a synthetic tool_result and a session that is never a real
 * conversation. Here the sessions are the ones flypi would serve — real agent loop, real MCP client, real
 * SQLite reached over HTTP — and the conversations are separate the way the UI would open them.
 *
 * What is asserted is the part a scripted model cannot fake: what flypi put in front of the model, what it
 * recorded about the turn, and what the store still keeps after a correction.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { startMemoryServer } from "../../src/memory/mcp.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import { addUsage, emptyUsage, usageOf, type RenderedUsage } from "../../src/shared/transcript.ts";
import { activeToolNames, harness } from "../helpers/flypi-harness.ts";
import { openTestDb, wordEmbedder } from "../helpers/memory-db.ts";
import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "../helpers/stub-model.ts";

const TOKEN = "cross-session-token";
/** The memory tools a turn may call, and the ones flypi calls on its own behalf after the turn. */
const VISIBLE = ["mcp__flypi_memory__memory_write", "mcp__flypi_memory__memory_supersede"];
const HIDDEN = ["mcp__flypi_memory__memory_cite", "mcp__flypi_memory__memory_capture", "mcp__flypi_memory__memory_turn"];

const PNPM = "the package manager in this repo is pnpm, never npm";
const BUN = "the package manager in this repo is bun";

let store: MemoryStore;
let db: DatabaseSync;
let server: Awaited<ReturnType<typeof startMemoryServer>>;

beforeAll(async () => {
	// A real store behind the real server over HTTP: two conversations reaching the same memory has to be
	// proved through the path a session actually takes, not through the store's own API.
	db = openTestDb();
	store = new MemoryStore(db, wordEmbedder());
	server = await startMemoryServer({ store, token: TOKEN });
});

afterAll(async () => {
	await server.close();
});

/**
 * An MCP connection opens in the background (docs/mcp.md), so a turn has to wait for its tools to be
 * declared. The same check proves the after-the-turn tools stayed off the prompt.
 */
async function ready(session: { getActiveToolNames(): string[] }): Promise<void> {
	const active = await activeToolNames(session, VISIBLE);
	expect(active.filter((tool) => HIDDEN.includes(tool))).toEqual([]);
}

/**
 * A citation and a turn log are not part of the model's answer, so `prompt()` can resolve before they
 * land. Waiting on the fact rather than on a sleep is the same argument as the connection above.
 */
async function settled(want: () => boolean, why: string, deadline = 5_000): Promise<void> {
	const until = Date.now() + deadline;
	while (!want()) {
		if (Date.now() > until) throw new Error(`never settled: ${why}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/** Everything flypi put in front of the model, as text. */
function toldTo(request: unknown): string {
	const messages = (request as { messages?: { content?: { type: string; text?: string }[] }[] }).messages ?? [];
	return messages.flatMap((message) => message.content ?? []).map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

describe("cross-session memory (Phase 4 gate)", () => {
	it("a fact stored in one conversation changes what a new one is told, and correcting it keeps history", async () => {
		// Set once conversation A has written the row; B's script is only built when B is created, which is
		// after, so the supersede call can name a real id.
		let pnpmId = 0;
		let conversations = 0;

		const { registry, sessions, cleanup } = await harness(
			() => {
				switch (conversations++) {
					case 0:
						// A: the model stores what the user just said. The store is empty, so it gets no block.
						return [
							fauxAssistantMessage([fauxToolCall(VISIBLE[0]!, { body: PNPM, kind: "convention", reason: "the user told me" }, { id: "a1" })], { stopReason: "toolUse", timestamp: 0 }),
							fauxAssistantMessage([fauxText("noted")], { timestamp: 0 }),
						];
					case 1:
						// B: a brand-new conversation asks, answers from what it was given, then is told the
						// fact has changed.
						return [
							fauxAssistantMessage([fauxText(`I will use pnpm, per #${pnpmId}`)], { timestamp: 0 }),
							fauxAssistantMessage([fauxToolCall(VISIBLE[1]!, { id: pnpmId, body: BUN, kind: "convention", reason: "the user corrected it" }, { id: "b1" })], { stopReason: "toolUse", timestamp: 0 }),
							fauxAssistantMessage([fauxText("bun, then")], { timestamp: 0 }),
						];
					default:
						// C: a third brand-new conversation. This is the sentence the gate is about.
						return [fauxAssistantMessage([fauxText("use bun")], { timestamp: 0 })];
				}
			},
			{ memoryMcp: { url: server.url, token: TOKEN } },
		);

		try {
			// --- A stores it.
			const first = await registry.create();
			await ready(sessions[0]!.session);
			await registry.prompt(first.id, "we use pnpm here, remember that");
			const [found] = (await store.search({ query: "package manager" })).results;
			expect(found, "conversation A wrote nothing").toBeTruthy();
			pnpmId = found!.id;

			// --- B is a new conversation, asked cold.
			const second = await registry.create();
			await ready(sessions[1]!.session);
			// What the provider reported for each of B's turns, read straight off its own messages. The rows
			// below have to match these: that is the difference between "the numbers arrived" and "these are
			// the test's own arithmetic" (docs/prompt-cache.md Phase 4.6 A1).
			const reported: RenderedUsage[] = [];
			registry.attach(second.id, (_seq, event) => {
				if (event.type !== "message_end") return;
				const usage = usageOf((event.message as { usage?: unknown }).usage);
				if (usage) reported[reported.length - 1] = addUsage(reported[reported.length - 1]!, usage);
			});
			const measuring = () => reported.push(emptyUsage());
			measuring();
			await registry.prompt(second.id, "which package manager do we use in this repo?");
			const toldToB = toldTo(sessions[1]!.stub.requests[0]);
			expect(toldToB).toContain("<relevant_memories");
			expect(toldToB).toContain(PNPM);
			// The debug panel shows the block the model was actually given, which is the only way anyone can
			// check what a recall did (docs/protocol.md).
			expect((await registry.debugInfo(second.id)).memoryBlock).toContain(`#${pnpmId} (`);
			// The answer cited the row, so the row records that it was used, not merely fetched.
			await settled(() => (store.memory(pnpmId)!.cited_count ?? 0) === 1, "the citation was not recorded");

			// --- B's second turn corrects the fact. A correction supersedes; it does not delete.
			measuring();
			await registry.prompt(second.id, "we use bun now");
			await settled(() => store.memory(pnpmId)!.status === "superseded", "the correction did not land");
			const history = store.history(pnpmId);
			const correction = history.find((entry) => entry.action === "supersede");
			expect(correction, "no supersede entry in the audit").toBeTruthy();
			expect((correction!.pre_image as { body: string }).body).toBe(PNPM);

			// --- C is another new conversation: told the new fact, not the old one.
			const third = await registry.create();
			await ready(sessions[2]!.session);
			await registry.prompt(third.id, "which package manager do we use in this repo?");
			const toldToC = toldTo(sessions[2]!.stub.requests[0]);
			expect(toldToC).toContain(BUN);
			expect(toldToC).not.toContain(PNPM);
			// Nothing was deleted: the superseded row is still there and still readable as history. It is
			// retrieval that stopped offering it.
			expect(store.memory(pnpmId)!.body).toBe(PNPM);

			// --- The four turns, as measured. Each row is keyed by flypi's own conversation id, so one
			// conversation's history can be asked for without a second store of its own.
			await settled(() => store.memoryHitRate().turns === 4, "the turns were not logged");
			const rows = db.prepare("SELECT conversation_id, retrieved_json, cited_json, usage_json FROM turns ORDER BY id").all() as {
				conversation_id: string;
				retrieved_json: string | null;
				cited_json: string | null;
				usage_json: string | null;
			}[];
			expect(rows.map((row) => row.conversation_id)).toEqual([first.id, second.id, second.id, third.id]);
			const ids = (json: string | null) => (json === null ? null : (JSON.parse(json) as number[]));
			// A started with an empty store in front of it. B's first turn was shown the pnpm row and cited it.
			// B's second turn asked about "bun", and no row was about bun yet — being shown a memory and citing
			// one are different counts, and the gap between them is the thing these metrics exist to show.
			expect(rows.map((row) => [ids(row.retrieved_json), ids(row.cited_json)])).toEqual([
				[[], []],
				[[pnpmId], [pnpmId]],
				[[], []],
				[[store.memory(pnpmId)!.superseded_by!], []],
			]);
			expect(store.memoryHitRate()).toEqual({
				turns: 4,
				turns_shown_memories: 2,
				turns_citing: 1,
				memories_retrieved: 2,
				memories_cited: 1,
				rate: 0.5,
			});
			// A1: the row carries the provider's numbers for that turn, summed across its model calls — and
			// only that turn's. A turn of one model call against an empty prefix can only have paid for its own
			// prompt; the next turn re-read that prefix, and the cache read it reports is the number Phase 4.6
			// exists to watch.
			expect(rows.map((row) => JSON.parse(row.usage_json ?? "null"))).toEqual([expect.anything(), reported[0], reported[1], expect.anything()]);
			expect(reported[0]!.input).toBeGreaterThan(0);
			expect(reported[0]!.cacheRead).toBe(0);
			expect(reported[1]!.cacheRead).toBeGreaterThan(0);
		} finally {
			registry.dispose();
			cleanup();
		}
	}, 60_000);
});
