/**
 * The Memory tab's server side read straight off the store (src/server/memory-api.ts). The wire half is in
 * tests/server/memory-server.test.ts; what is asserted here is the API's own edges: a turn whose retrieval
 * was never logged, a turn that names a row the store no longer has, an edit that names one field, one apply
 * that does three things at once, a store with no embedding model, and the property the whole browser rests
 * on — reading the store must not look like searching it, or the promotion gates would count browsing.
 */
import { describe, expect, it } from "vitest";
import { noneEmbedder } from "../../src/memory/embed.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import { renderWiki } from "../../src/memory/wiki.ts";
import { memoryApi } from "../../src/server/memory-api.ts";
import { openTestDb, wordEmbedder } from "../helpers/memory-db.ts";

type Db = import("node:sqlite").DatabaseSync;

function fresh(): { store: MemoryStore; db: Db; api: ReturnType<typeof memoryApi> } {
	const db = openTestDb();
	const store = new MemoryStore(db, wordEmbedder());
	return { store, db, api: memoryApi(store, db) };
}

const remember = async (store: MemoryStore, body: string, kind = "note") =>
	(await store.addMemory({ kind, body, tags: ["deploy"], origin_class: "owner", session_kind: "interactive", actor: "user" })).id;

describe("the memory API", () => {
	it("lists the store newest first, and reading it does not count as fetching it", async () => {
		const { store, api } = fresh();
		const first = await remember(store, "the deploy host is the small box");
		const second = await remember(store, "the build cache lives on the nvme disk");
		await store.search({ query: "deploy" });
		const before = store.memory(first)!.use_count;

		const snapshot = api.snapshot();
		expect(snapshot.memories.map((row) => row.id)).toEqual([second, first]);
		// The browser is a read, not a search: if it moved `use_count`, a promotion gate would count looking.
		expect(store.memory(first)!.use_count).toBe(before);
		expect(snapshot.wiki).toEqual([]);
		expect(snapshot.turns).toEqual([]);
	});

	it("a turn whose retrieval was never logged shows as nothing shown, not as a zero-length block", async () => {
		const { store, api } = fresh();
		await remember(store, "the deploy host is the small box");
		store.ensureConversation({ id: "conv-1", cwd: "/tmp" });
		store.recordTurn("conv-1", { userText: "what is the deploy host" });

		expect(api.snapshot().turns).toEqual([
			{ id: expect.any(Number), conversationId: "conv-1", createdAt: expect.any(String), userText: "what is the deploy host", retrieved: [], cited: [], injectedTokens: 0 },
		]);
		expect(api.snapshot().stats).toMatchObject({ turns: 1, turnsShownMemories: 0, rate: 0 });
	});

	it("a turn that names a row the store no longer has costs nothing and still lists the id", async () => {
		const { store, db, api } = fresh();
		const gone = await remember(store, "the deploy host is the small box");
		store.ensureConversation({ id: "conv-1", cwd: "/tmp" });
		store.recordTurn("conv-1", { userText: "where do we deploy", retrieved: [gone, 404], cited: [gone] });
		db.prepare("DELETE FROM memories WHERE id = ?").run(gone);

		const [turn] = api.snapshot().turns;
		expect(turn).toMatchObject({ retrieved: [gone, 404], cited: [gone] });
		// Only the row that still exists can cost tokens; the missing one estimates as nothing rather than
		// throwing at a row the log outlived.
		expect(turn!.injectedTokens).toBe(0);
		expect(api.snapshot().memories).toEqual([]);
	});

	it("an edit naming one field changes that field and leaves the others", async () => {
		const { store, api } = fresh();
		const id = await remember(store, "the deploy host is the small box");
		expect(api.apply([{ id, kind: "convention" }]).memories[0]).toMatchObject({ kind: "convention", body: "the deploy host is the small box", tags: ["deploy"] });
		expect(api.apply([{ id, tags: [] }]).memories[0]).toMatchObject({ kind: "convention", body: "the deploy host is the small box", tags: [] });
		expect(api.apply([{ id, body: "the deploy host is the tiny box" }]).memories[0]).toMatchObject({ kind: "convention", body: "the deploy host is the tiny box", tags: [] });
		expect(store.history(id).map((entry) => entry.action)).toEqual(["create", "edit", "edit", "edit"]);
	});

	it("one apply can edit, tombstone and undo at once", async () => {
		const { store, api } = fresh();
		const keep = await remember(store, "we use pnpm, never npm");
		const drop = await remember(store, "the deploy host is the small box");
		const merged = await remember(store, "the build cache lives on the nvme disk");
		store.markSuperseded(merged, keep, "sweep", "consolidation: the same fact as #1");
		const supersede = store.history(merged).find((entry) => entry.action === "supersede")!;

		const snapshot = api.apply([
			{ id: keep, body: "we use pnpm, never npm or yarn" },
			{ id: drop, remove: true },
			{ id: merged, undoAudit: supersede.id },
		]);
		expect(snapshot.memories.map((row) => [row.id, row.status])).toEqual([
			[merged, "active"],
			[drop, "deleted"],
			[keep, "active"],
		]);
		expect(snapshot.memories.find((row) => row.id === keep)!.body).toBe("we use pnpm, never npm or yarn");
	});

	it("a store with no embedding model says so, rather than reporting an empty index as a healthy one", async () => {
		const db = openTestDb();
		const store = new MemoryStore(db, noneEmbedder());
		await remember(store, "the deploy host is the small box");
		expect(memoryApi(store, db).snapshot().stats).toMatchObject({ indexRows: 0, indexStale: 0, embedModel: null });
	});

	it("reading the store never queues a job, not even when every vector is from another model", async () => {
		const { store, db, api } = fresh();
		await remember(store, "the deploy host is the small box");
		db.prepare("UPDATE memories SET embed_model = 'some-other-model' WHERE id = 1").run();
		expect(store.indexSummary().stale).toBe(1);
		api.snapshot();
		expect((db.prepare("SELECT count(*) AS n FROM jobs").get() as unknown as { n: number }).n).toBe(0);
		// The number is still reported — the browser says the index is stale, it does not fix it.
		expect(api.snapshot().stats).toMatchObject({ indexRows: 1, indexStale: 1 });
	});

	it("a process that holds the store read-only reads it and refuses to change it", async () => {
		const { store, db, api } = fresh();
		const id = await remember(store, "the deploy host is the small box");
		const reader = memoryApi(store, db, { readOnly: true });
		// The read is the whole point of a second process: the rows, the turns and the wiki are all there.
		expect(reader.snapshot().memories.map((row) => row.id)).toEqual([id]);
		// And the refusal is a sentence about which process may write, not SQLite's error about a connection.
		expect(() => reader.apply([{ id, body: "the deploy host is the tiny box" }])).toThrow(/open read-only .* is the one that can change it/);
		expect(store.memory(id)!.body).toBe("the deploy host is the small box");
	});

	it("the wiki is listed as it was last rendered, with its sections and its claim ids", async () => {
		const { store, db, api } = fresh();
		const id = await remember(store, "the deploy host is the small box", "Deploy targets");
		renderWiki(store, db);
		expect(api.snapshot().wiki).toEqual([
			{
				slug: "deploy-targets",
				title: "Deploy targets",
				topicKey: "Deploy targets",
				body: `# Deploy targets\n\n## deploy\n\n[#${id}] the deploy host is the small box`,
				claimIds: [id],
				model: null,
				generatedAt: expect.any(String),
				sections: [{ heading: "deploy", body: `[#${id}] the deploy host is the small box`, claimIds: [id] }],
			},
		]);
	});
});
