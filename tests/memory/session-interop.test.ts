/**
 * Phase 6's remaining interop check (docs/memory.md): memory survives a session **fork** and a session
 * **reopened from its file** — and is not said twice on the way. The `/compact` half of that check lives in
 * prompt-prefix.test.ts; these are the other two halves.
 *
 * They only became testable once Phase 4.7 C2 made the block a session entry instead of a transient message:
 * a fork and a reopen carry a session *file*, not a process, so the only thing that can stop a branched or
 * reopened conversation from being told the same memories a second time is the digest gate reading the digest
 * stored in that file (src/memory/recall.ts liveBlocks).
 *
 * Both failures are quiet. Drop the gate and a forked conversation is shown its memories twice, and the whole
 * context behind the first copy is re-paid at the next boundary (docs/prompt-cache.md C1). Lose the entry from
 * the file and the rows sit in it while the model is shown none of them for the rest of the conversation,
 * with nothing anywhere saying so.
 *
 * Real pi, real MCP memory server, real session files. The model is the stub and calls no tools: what is under
 * test is what the turn put in front of it, not what it did afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { CustomMessageEntry } from "@earendil-works/pi-coding-agent";
import type { FlypiSession } from "../../src/agent/runtime.ts";
import { startMemoryServer } from "../../src/memory/mcp.ts";
import { RECALL_ENTRY, setDigest } from "../../src/memory/recall.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import { SessionRegistry } from "../../src/server/session-registry.ts";
import { carriesBlock, harness, messagesOf, stubCreateSession } from "../helpers/flypi-harness.ts";
import { openTestDb, wordEmbedder } from "../helpers/memory-db.ts";
import { fauxAssistantMessage, fauxText, type StubModel } from "../helpers/stub-model.ts";

const TOKEN = "interop-test-token";
// Worded to match the seeded fact so the store's keyword half really hits: the retrieval the block carries has
// to be a real one, not a turn that found nothing and had nothing to duplicate.
const PROMPT = "fix the failing test in this repo";
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

/** One answer, no tool calls — every turn here is judged by what it was shown. */
const oneAnswer = () => [fauxAssistantMessage([fauxText("the comparator coerced to strings")], { timestamp: 0 })];

/**
 * The memory entries this session is being shown right now, taken the way the digest gate takes them: pi's
 * projection, which has already dropped anything a `context_edit` omitted, so an entry here is in front of the
 * model. Narrowed to the recall entries, because their `details.digest` is the field a fork and a reopen have
 * to survive with.
 */
function blocksInFront(session: FlypiSession): CustomMessageEntry[] {
	return session.sessionManager.buildSessionProjection().entries.flatMap((entry) => {
		const source = entry.sourceEntry;
		if (source.type !== "custom_message" || source.customType !== RECALL_ENTRY || entry.messages.length === 0) return [];
		return [source];
	});
}

const digestOf = (entry: CustomMessageEntry): string =>
	String((entry.details as { digest?: string } | undefined)?.digest ?? "");

describe("memory across a session fork and a reopen (Phase 6 interop)", () => {
	// The fork is the case where the same conversation continues in a new file with a new conversation id, so
	// nothing of the source's state comes with it but its history does. The block has to come along (the
	// memories are still true) and must not be said again (the gate has to see it already there).
	it("a fork carries the memories its source was shown, and is not told them twice", async () => {
		const h = await harness(oneAnswer, { memoryMcp: { url: server.url, token: TOKEN } });
		try {
			const source = await h.registry.create();
			// The seq an answer arrived on is what the UI holds, and the only handle fork() takes.
			let answerSeq = 0;
			h.registry.attach(source.id, (seq, event) => {
				if (event.type === "message_end" && event.message.role === "assistant") answerSeq = seq;
			});
			await h.registry.prompt(source.id, PROMPT);
			expect(answerSeq, "the answer never reached a listener").toBeTruthy();
			const asked = h.sessions[0]!.stub.requests.map(messagesOf).at(-1)!;
			expect(asked.filter(carriesBlock), "the source turn was not shown the memory").toHaveLength(1);

			const forked = await h.registry.fork(source.id, answerSeq);
			// Not vacuous: a different session file, which still carries the entry and its digest — the file is
			// the only thing the fork inherits.
			expect(forked.session.sessionFile).not.toBe(source.session.sessionFile);
			const carried = blocksInFront(forked.session);
			expect(carried, "the fork carried no memories").toHaveLength(1);
			expect(digestOf(carried[0]!), "the fork's entry lost the digest the gate reads").toBe(setDigest([factId]));

			// The fork's own first turn, asking the same thing, so the same row is retrieved. The gate has to
			// notice this brand-new conversation already holds it — from the file, not from the source.
			await h.registry.prompt(forked.id, PROMPT);
			// This turn really did search and really did find the row, so the single block below is the gate
			// holding its tongue rather than a turn that had nothing to say.
			const debug = await h.registry.debugInfo(forked.id);
			expect(debug.memoryBlock, "the fork's turn did not retrieve the memory").toContain(FACT);
			const blocks = h.sessions.at(-1)!.stub.requests.map(messagesOf).at(-1)!.filter(carriesBlock);
			expect(blocks, "the fork was told the same memories twice (risk 4)").toHaveLength(1);
			expect(JSON.stringify(blocks)).toContain(`#${factId} (convention): ${FACT}`);
			expect(blocksInFront(forked.session), "the fork appended a second entry of its own").toHaveLength(1);

			// And the source is untouched: still its own file, still its one block.
			expect(blocksInFront(h.registry.get(source.id).session)).toHaveLength(1);
		} finally {
			h.registry.dispose();
			h.cleanup();
		}
	}, 30_000);

	// The reopen is a new process: a fresh registry on the same checkout, taking the path the sidebar lists and
	// the `switchSession` the client sends (ui/lib/app-state.svelte.ts). No conversation id, no extension
	// state, no in-memory notion of what this conversation has already been told survives — only the file.
	it("a conversation reopened in another process is still shown its memories, once", async () => {
		const h = await harness(oneAnswer, { memoryMcp: { url: server.url, token: TOKEN } });
		let reopenedStub: StubModel | undefined;
		const reopened = new SessionRegistry({
			root: h.root,
			createSession: stubCreateSession(h.root, oneAnswer, {
				memoryMcp: { url: server.url, token: TOKEN },
				authPath: join(h.root, ".flypi", "agent", "auth.json"),
				onSession: (_session, stub) => {
					reopenedStub = stub;
				},
			}),
		});
		try {
			const source = await h.registry.create();
			await h.registry.prompt(source.id, PROMPT);
			const sessionFile = source.session.sessionFile;
			expect(sessionFile, "the first conversation wrote no session file").toBeTruthy();
			const written = blocksInFront(source.session);
			expect(written, "the first turn left no memory entry in the file").toHaveLength(1);

			// The process that wrote the file goes away. Only the file is left to reopen.
			h.registry.dispose();

			const again = await reopened.create();
			await reopened.switchSession(again.id, sessionFile!);
			// The entry came out of the file, so this is the state the gate has to work from.
			expect(blocksInFront(reopened.get(again.id).session), "the reopened session loaded no memory entry").toHaveLength(1);

			await reopened.prompt(again.id, PROMPT);
			const debug = await reopened.debugInfo(again.id);
			expect(debug.memoryBlock, "the reopened turn did not retrieve the memory").toContain(FACT);
			const blocks = reopenedStub!.requests.map(messagesOf).at(-1)!.filter(carriesBlock);
			expect(blocks, "the reopened conversation was told the same memories twice (risk 4)").toHaveLength(1);
			expect(JSON.stringify(blocks)).toContain(`#${factId} (convention): ${FACT}`);
			expect(blocksInFront(reopened.get(again.id).session), "the reopened conversation appended a second entry").toHaveLength(1);
		} finally {
			reopened.dispose();
			h.cleanup();
		}
	}, 30_000);

	// The control for both: none of this is a property of a conversation that merely happens to hold an entry.
	// With no memory server the same two moves carry no block at all, so the assertions above are about recall,
	// not about the harness.
	it("a forked conversation with no memory server carries no block", async () => {
		const h = await harness(oneAnswer);
		try {
			const source = await h.registry.create();
			let answerSeq = 0;
			h.registry.attach(source.id, (seq, event) => {
				if (event.type === "message_end" && event.message.role === "assistant") answerSeq = seq;
			});
			await h.registry.prompt(source.id, PROMPT);
			const forked = await h.registry.fork(source.id, answerSeq);
			await h.registry.prompt(forked.id, PROMPT);
			expect(blocksInFront(forked.session)).toEqual([]);
			expect(h.sessions.at(-1)!.stub.requests.map(messagesOf).flat().filter(carriesBlock), "a block reached a session with no memory server").toEqual([]);
		} finally {
			h.registry.dispose();
			h.cleanup();
		}
	}, 30_000);
});
