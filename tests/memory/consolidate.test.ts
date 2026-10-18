/**
 * The consolidation sweep (docs/memory.md Phase 6): the promotion gates, the merge that carries citations,
 * the trigger, and the one rule that carries the whole safety story — an unattended pass may supersede and
 * may not delete. The decisions are tested as pure functions where they are pure (`planSweep`,
 * `promotionEvidence`, `sweepDue`) and against a real store where they write.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	GATE_CITATIONS,
	GATE_QUERIES,
	GATE_SCORE,
	MIN_NEW_ROWS,
	SWEEP_INTERVAL_MS,
	consolidate,
	planSweep,
	promotionEvidence,
	sweepDue,
	type TurnEvidence,
} from "../../src/memory/consolidate.ts";
import { MemoryStore, PROMOTED_STRENGTH, type MemoryRow, type NewMemory } from "../../src/memory/store.ts";
import { openTestDb, wordEmbedder } from "../helpers/memory-db.ts";

type Db = import("node:sqlite").DatabaseSync;

function fresh(): { store: MemoryStore; db: Db } {
	const db = openTestDb();
	return { store: new MemoryStore(db, wordEmbedder()), db };
}

const owner = { origin_class: "owner" as const, session_kind: "interactive" as const, actor: "user" };
const agent = { origin_class: "agent" as const, session_kind: "interactive" as const, actor: "agent" };

type Provenance = Pick<NewMemory, "origin_class" | "session_kind" | "actor">;
const remember = async (store: MemoryStore, body: string, provenance: Provenance = agent, kind = "note") =>
	(await store.addMemory({ kind, body, tags: [], ...provenance })).id;

/**
 * One turn of one conversation: what recall fetched for it, and what its answer cited — and the citation
 * *count* the memory server moves alongside the log (`memory_cite` → `markCited`, src/memory/mcp.ts), which
 * is the counter a merge has to carry.
 */
async function turn(store: MemoryStore, userText: string, retrieved: number[], cited: number[]): Promise<void> {
	store.ensureConversation({ id: "conv-1", cwd: "/tmp" });
	store.recordTurn("conv-1", { userText, retrieved, cited });
	for (const id of cited) store.markCited(id);
}

const statuses = (db: Db, id: number) =>
	(db.prepare("SELECT status FROM memories WHERE id = ?").get(id) as { status: string }).status;
const auditOf = (db: Db, id: number) =>
	(db.prepare("SELECT action, actor, pre_image, reason FROM memory_audit WHERE memory_id = ? ORDER BY id").all(id) as unknown as {
		action: string;
		actor: string;
		pre_image: string;
		reason: string | null;
	}[]);

/** A row for the pure planner: what the store would hand it, with only the fields the decision reads. */
function rowOf(id: number, body: string, extra: Partial<MemoryRow> = {}): MemoryRow {
	return {
		id,
		kind: "note",
		body,
		tags: [],
		status: "active",
		origin_class: "agent",
		session_kind: "interactive",
		supersedes: null,
		superseded_by: null,
		merged_from: [],
		strength: 1,
		use_count: 0,
		cited_count: 0,
		created_at: "2026-10-16T09:00:00.000Z",
		last_verified_at: null,
		session_id: null,
		turn_id: null,
		embed: null,
		modality: "text",
		media: null,
		...extra,
	};
}

describe("the promotion gates", () => {
	/** Cited by `citations` turns over `queries` distinct questions, fetched for `retrieved` of them. */
	const evidence = (citations: number, queries: number, retrieved: number) => {
		const turns: TurnEvidence[] = [];
		for (let index = 0; index < retrieved; index += 1) {
			const cited = index < citations;
			turns.push({ userText: `question ${index < queries ? index : 0}`, retrieved: [1], cited: cited ? [1] : [] });
		}
		return promotionEvidence(turns, [1]);
	};

	it("clears on citations, distinct questions and a citation rate that means something", () => {
		expect(evidence(GATE_CITATIONS, GATE_QUERIES, GATE_CITATIONS)).toMatchObject({ citations: 3, queries: 3, score: 1 });
	});

	it("fails one criterion short on each gate, and passes at each threshold", () => {
		// Two turns is not three, however often the same question was asked.
		expect(evidence(2, 2, 2).citations).toBeLessThan(GATE_CITATIONS);
		// Three turns that were all the same question is one fact being asked for, not three uses.
		expect(evidence(3, 2, 3).queries).toBeLessThan(GATE_QUERIES);
		// Fetched five times, used three: 0.6, under the rate gate — a row that is always fetched and rarely
		// used has not earned promotion, it has earned a habit.
		expect(evidence(3, 3, 5).score).toBeLessThan(GATE_SCORE);
		// And each gate passes at exactly its number, so the boundary is the number and not near it.
		expect(evidence(3, 3, 4).score).toBe(GATE_SCORE);
		expect(evidence(3, 3, 3).citations).toBe(GATE_CITATIONS);
		expect(evidence(3, 3, 3).queries).toBe(GATE_QUERIES);
	});

	it("writes nothing for a row one criterion short, and a `verify` row for one that clears", async () => {
		const { store, db } = fresh();
		const short = await remember(store, "the build cache lives on the nvme disk");
		await turn(store, "where is the cache", [short], [short]);
		await turn(store, "and the cache?", [short], [short]);
		const clears = await remember(store, "the deploy target is the small box");
		await turn(store, "where do we deploy", [clears], [clears]);
		await turn(store, "deploy target?", [clears], [clears]);
		await turn(store, "which host gets it", [clears], [clears]);

		const report = consolidate(store);
		expect(report.promotions).toEqual([clears]);
		expect(store.memory(clears)!.strength).toBe(PROMOTED_STRENGTH);
		expect(store.memory(short)!.strength).toBe(1);
		// Promotion is audited like every other automated write, so "why is this one ranked higher" has an answer.
		expect(auditOf(db, clears).at(-1)).toMatchObject({ action: "verify", actor: "sweep" });
		expect(auditOf(db, short)).toHaveLength(1);
	});

	it("carries the citations of merged copies onto the survivor, so two half-gated copies are not short forever", async () => {
		const { store, db } = fresh();
		// Two copies of one fact, each cited by two turns — one citation short of the gate each, and read-time
		// collapsing would have hidden the pair from the model while leaving both counters where they were.
		const first = await remember(store, "the deploy target is 10.0.0.7", owner);
		const second = await remember(store, "the deploy target is 10.0.0.7 for the api", owner);
		await turn(store, "where does the api go", [first], [first]);
		await turn(store, "deploy host for the api", [first], [first]);
		await turn(store, "which box runs it", [second], [second]);
		await turn(store, "the deploy machine", [second], [second]);

		const report = consolidate(store);
		expect(report.merges).toEqual([{ survivor: first, merged: [second] }]);
		// The survivor's evidence is the union: four citations over four questions, so it clears in the same
		// pass that merged the copies.
		expect(report.promotions).toEqual([first]);
		// The counters move onto the survivor: two citations each, four on the row that absorbed them. What the
		// gates read is the turn log (four citations over four questions), which is the same union either way.
		// `use_count` stays 0 because these turns were recorded, not searched — a retrieval count comes from
		// `search()`, never from the turn log.
		expect(store.memory(first)).toMatchObject({ cited_count: 4, use_count: 0, merged_from: [second], strength: PROMOTED_STRENGTH });
		expect(statuses(db, second)).toBe("superseded");
	});
});

describe("the merge", () => {
	it("collapses near-duplicates into one active row, keeps every row, and audits every change", async () => {
		const { store, db } = fresh();
		const rows = (JSON.parse(readFileSync(new URL("../fixtures/sweep/sweep.json", import.meta.url), "utf8")) as {
			rows: { kind: string; body: string; tags: string[]; origin_class: "owner" | "agent"; age_days?: number }[];
		}).rows;
		const ids: number[] = [];
		for (const row of rows) {
			const id = (await store.addMemory({ kind: row.kind, body: row.body, tags: row.tags, origin_class: row.origin_class, session_kind: "interactive", actor: "user" })).id;
			if (row.age_days) db.prepare("UPDATE memories SET last_verified_at = ? WHERE id = ?").run(new Date(Date.now() - row.age_days * 86_400_000).toISOString(), id);
			ids.push(id);
		}
		const [pnpm, pnpmCopy, deployHost, apiUrl, docker, notDocker] = ids as [number, number, number, number, number, number];
		const before = store.memoryRowCount();

		const report = consolidate(store);

		// The paraphrase pair merges; the rest stand on their own.
		expect(report.merges).toEqual([{ survivor: pnpm, merged: [pnpmCopy] }]);
		// The survivor is the `owner` copy: a merge retires rows, so it must never retire the more
		// authoritative one — that would downgrade a fact the user stated into one the agent inferred.
		expect(store.memory(pnpm)!.origin_class).toBe("owner");
		expect(store.memory(pnpmCopy)).toMatchObject({ status: "superseded", superseded_by: pnpm });
		expect(store.memory(pnpm)!.merged_from).toEqual([pnpmCopy]);

		// A contradiction is not a duplicate. "we deploy with docker" against "we do not deploy with docker"
		// is the pair the vectors are worst at (0.98 measured), and merging it would pick a side.
		expect(statuses(db, docker)).toBe("active");
		expect(statuses(db, notDocker)).toBe("active");
		expect(statuses(db, deployHost)).toBe("active");

		// Nothing disappears, and the stale row is still in the store: age lowers rank, it never removes a row.
		expect(store.memoryRowCount(), "a sweep made a row disappear").toBe(before);
		expect(report.rowsAfter).toBe(before);
		expect((await store.search({ query: "api url staging" })).results.map((row) => row.id)).toContain(apiUrl);

		// Every mutation has a pre-image (risk 9): the retired row's own, and the survivor's before it absorbed.
		expect(auditOf(db, pnpmCopy).at(-1)).toMatchObject({ action: "supersede", actor: "sweep" });
		expect(JSON.parse(auditOf(db, pnpmCopy).at(-1)!.pre_image)).toMatchObject({ body: "we use pnpm, never npm, for every install", status: "active" });
		const survivorAudit = auditOf(db, pnpm).at(-1)!;
		expect(survivorAudit).toMatchObject({ action: "edit", actor: "sweep" });
		expect(JSON.parse(survivorAudit.pre_image)).toMatchObject({ merged_from: [], status: "active" });
	});

	it("leaves a value swap alone: a correction is two facts, not one to be collapsed", () => {
		// The store's write gate normally retires one of these the moment the other is written, so the pair is
		// handed to the planner directly: what is under test is the sweep's decision, not the gate's.
		const rows = [rowOf(1, "the deploy port is 8080 on the small box"), rowOf(2, "the deploy port is 9090 on the small box")];
		expect(planSweep(rows, new Map(), [])).toEqual({ merges: [], promotions: [] });
		// And the same shape with a changed value in the other direction, and a pair that differs by a whole
		// clause (which is a different fact, not a value): neither merges.
		const versioned = [rowOf(1, "the api is at /v1/deploys on the small box"), rowOf(2, "the api is at /v2/deploys on the small box")];
		expect(planSweep(versioned, new Map(), []).merges).toEqual([]);
	});

	it("joins a reworded chain into one cluster even when the ends share no tokens", () => {
		// Same-fact containment is not transitive in one hop, so a single-anchor grouping would leave the ends
		// of this chain both active forever.
		const rows = [
			rowOf(1, "the deploy target is the small box at 10.0.0.7"),
			rowOf(2, "the deploy target is the small box at 10.0.0.7, over ssh"),
			rowOf(3, "the deploy target is the small box at 10.0.0.7, over ssh, as mats"),
		];
		expect(planSweep(rows, new Map(), []).merges).toEqual([{ survivor: 1, merged: [2, 3] }]);
	});

	it("is a plan before it is a write: the pass that changes nothing writes nothing", async () => {
		const { store, db } = fresh();
		const only = await remember(store, "the only fact here is the build cache");
		const report = consolidate(store);
		expect(report).toMatchObject({ merges: [], promotions: [], rowsBefore: 1, rowsAfter: 1 });
		expect(auditOf(db, only)).toHaveLength(1);
	});
});

describe("the sweep cannot delete", () => {
	it("refuses `forget` for an unattended actor, and leaves the row active", async () => {
		const { store, db } = fresh();
		const id = await remember(store, "the deploy host is the small box");
		expect(() => store.forget(id, "sweep")).toThrow(/may supersede a row, never delete one/);
		expect(() => store.forget(id, "fork")).toThrow(/may supersede a row, never delete one/);
		expect(statuses(db, id)).toBe("active");
		// A human in a live conversation still can, and that is the whole difference.
		store.forget(id, "ui");
		expect(statuses(db, id)).toBe("deleted");
	});

	it("supersedes rather than removes, whatever it merges", async () => {
		const { store, db } = fresh();
		await remember(store, "we use pnpm, never npm", owner);
		await remember(store, "we use pnpm, never npm, for every install");
		consolidate(store);
		const counts = db.prepare("SELECT status, count(*) AS n FROM memories GROUP BY status").all() as unknown as { status: string; n: number }[];
		expect(counts.find((row) => row.status === "deleted")).toBeUndefined();
		expect(counts.reduce((total, row) => total + row.n, 0)).toBe(2);
	});
});

describe("the trigger", () => {
	const at = "2026-10-16T12:00:00.000Z";
	const dayAgo = new Date(Date.parse(at) - SWEEP_INTERVAL_MS).toISOString();

	it("waits for the quiet, then goes on rows or on age", () => {
		expect(sweepDue({ newRows: MIN_NEW_ROWS, lastSweepAt: null, at, idle: false })).toBe(false);
		expect(sweepDue({ newRows: MIN_NEW_ROWS, lastSweepAt: null, at, idle: true })).toBe(true);
		expect(sweepDue({ newRows: MIN_NEW_ROWS - 1, lastSweepAt: dayAgo, at, idle: true })).toBe(true);
		expect(sweepDue({ newRows: MIN_NEW_ROWS - 1, lastSweepAt: at, at, idle: true })).toBe(false);
		// A store that has never been swept is not due until it has the rows: a fresh checkout has nothing to
		// consolidate, and a daemon that swept on start-up would queue work for every one it starts.
		expect(sweepDue({ newRows: 3, lastSweepAt: null, at, idle: true })).toBe(false);
	});

	it("reads its own state out of the store: rows since the last sweep, and when that was", async () => {
		const { store, db } = fresh();
		expect(store.sweepState()).toEqual({ newRows: 0, lastSweepAt: null });
		await remember(store, "the deploy host is the small box");
		expect(store.sweepState().newRows).toBe(1);
		// A sweep that ran is the clock; a sweep that failed is not.
		db.prepare("INSERT INTO job_runs (job_id, kind, started_at, finished_at, status) VALUES (NULL, 'memory.consolidate', '2026-01-01T00:00:00.000Z', ?, 'failed')").run(dayAgoIso());
		expect(store.sweepState()).toEqual({ newRows: 1, lastSweepAt: null });
		db.prepare("INSERT INTO job_runs (job_id, kind, started_at, finished_at, status) VALUES (NULL, 'memory.consolidate', '2026-01-01T00:00:00.000Z', ?, 'ok')").run(dayAgoIso());
		expect(store.sweepState().lastSweepAt).toBe(dayAgoIso());
	});
});

const dayAgoIso = () => new Date(Date.now() - SWEEP_INTERVAL_MS).toISOString();
