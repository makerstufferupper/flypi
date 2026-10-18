/**
 * The consolidation sweep (docs/memory.md Phase 6) — the part no per-turn pass can do.
 *
 * Why a sweep exists at all, when the write gate refuses near-copies and `search()` already collapses
 * same-fact rows at read time: read-time collapsing **hides** a duplicate, it does not remove it. Both rows
 * stay `active`, both keep taking a slot in the top-5 fetch every later write is judged against, and they
 * **split `use_count`/`cited_count` between them** — which is exactly what the promotion gates below read,
 * so a fact cited across three turns but split over two copies may never reach ≥ 3 on either. And nothing
 * else in the system ever looks at the store as a whole: the write gate sees five neighbours at insert time
 * and then never again.
 *
 * The LLM "reflect" phase this phase used to name is gone — Phase 4.8's review fork does that judging while
 * the context is warm, instead of re-reading conversations later. What is left here is deterministic, which
 * is also what makes it safe to run unattended: **cluster, gate, then write — and only the last step
 * writes**, so a sweep interrupted halfway has changed nothing. hermes is the precedent for the shape: its
 * curator runs the deterministic transitions always and leaves the model-driven half off by default
 * (`agent/curator.py`, `DEFAULT_CONSOLIDATE = False`).
 *
 * The safety story is one line and it lives in the store, not here: a sweep may supersede and it may not
 * delete (`UNATTENDED_ACTORS` in src/memory/store.ts).
 */
import { cosine } from "./embed.ts";
import {
	NEAR_DUPLICATE,
	sameFact,
	valueSwap,
	type MemoryRow,
	type MemoryStore,
	type OriginClass,
} from "./store.ts";

/** The queue kind the daemon registers a handler for (src/daemon/index.ts). */
export const CONSOLIDATE_JOB = "memory.consolidate";

/**
 * The trigger, on flypi's conditions rather than a 3am cron (docs/memory.md Phase 6): the store is idle
 * **and** (this many rows have arrived since the last sweep, **or** the last one is older than this). A
 * desktop app is off at 3am some nights, so a cron would simply not run.
 */
export const MIN_NEW_ROWS = 25;
export const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * The promotion gates: memory gets promoted because it kept being useful, not because it was written
 * confidently. `citations` counts turns whose answer actually cited the row, `queries` how many different
 * questions led to it (one question asked five times is one query), and `score` is the citation rate over
 * the turns it was retrieved for — a row that is always fetched and never used has earned nothing.
 */
export const GATE_CITATIONS = 3;
export const GATE_QUERIES = 3;
export const GATE_SCORE = 0.75;

export interface TurnEvidence {
	userText: string;
	retrieved: number[];
	cited: number[];
}

export interface MergePlan {
	survivor: number;
	merged: number[];
}

export interface SweepPlan {
	merges: MergePlan[];
	promotions: number[];
}

/** What one pass did, in the shape `job_runs.detail` prints and the tests read. */
export interface SweepReport extends SweepPlan {
	rowsBefore: number;
	rowsAfter: number;
}

/**
 * Authority order. A merge retires rows, so it must never retire the more authoritative copy: an `owner`
 * row (the user's own words) and an `agent` row that says the same thing collapse to the `owner` one, or
 * the sweep would quietly downgrade a fact the user stated into one the agent inferred.
 */
const AUTHORITY: Record<OriginClass, number> = { owner: 3, agent: 2, untrusted: 1, system: 0 };

/** Which copy of a duplicated fact survives: authority first, then what earned its place, then oldest. */
function compareSurvivor(a: MemoryRow, b: MemoryRow): number {
	return (
		AUTHORITY[b.origin_class] - AUTHORITY[a.origin_class] ||
		b.cited_count - a.cited_count ||
		b.use_count - a.use_count ||
		a.id - b.id
	);
}

/**
 * Are these two rows the same fact? Two signals, both deterministic:
 *
 * - the vectors say so (`NEAR_DUPLICATE`, the same threshold the write gate uses) — but only inside one
 *   index, which is why `activeVectors` hands back the current model's vectors and nothing else. This is
 *   also the pass that catches what a re-embed makes: a new vector space is a different set of near pairs.
 * - token containment says so (`sameFact`, the rule the read path already uses to hide a duplicate from
 *   the model). The sweep is where it stops being merely hidden.
 *
 * Two shapes are corrections, not copies, and merging one would retire whichever side the survivor rule
 * happened to prefer: a pair whose difference is one changed value (`valueSwap`), and a pair where one side
 * is negated and the other is not. The second is the one the vectors are worst at — measured, "we do not use
 * pnpm" against "we use pnpm" sits at 0.9835, above the duplicate threshold — so the guard runs before both
 * signals. Telling a contradiction from a copy in general is the NLI judge's job at the write gate
 * (src/memory/judge.ts); this is the part that needs no model.
 */
const NEGATION = /\b(?:not|never|no|none|without|don'?t|doesn'?t|didn'?t|isn'?t|aren'?t|won'?t|cannot|can'?t)\b/;
const polarityMismatch = (a: string, b: string): boolean => NEGATION.test(a) !== NEGATION.test(b);

function sameStoredFact(a: MemoryRow, b: MemoryRow, vectors: Map<number, Float32Array>): boolean {
	if (valueSwap(a.body, b.body) !== undefined || polarityMismatch(a.body, b.body)) return false;
	const left = vectors.get(a.id);
	const right = vectors.get(b.id);
	if (left && right && cosine(left, right) >= NEAR_DUPLICATE) return true;
	return sameFact(a.body, b.body);
}

/**
 * Connected components over the same-fact relation, in id order. Union-find rather than one anchor per
 * cluster because the relation is not transitive in one hop: a reworded chain A~B~C has to land in one
 * cluster even when A and C share no tokens, or the copies at the ends of it stay active forever.
 * shortcut: every pair is compared, like `vectorSearch`'s full scan — fine to a few tens of thousands of
 * rows, and the same place a vector index would plug in.
 */
export function clusterRows(rows: MemoryRow[], vectors: Map<number, Float32Array>): number[][] {
	const parent = new Map<number, number>(rows.map((row) => [row.id, row.id]));
	const find = (id: number): number => {
		const above = parent.get(id)!;
		if (above === id) return id;
		const root = find(above);
		parent.set(id, root);
		return root;
	};
	for (let i = 0; i < rows.length; i += 1) {
		for (let j = i + 1; j < rows.length; j += 1) {
			if (sameStoredFact(rows[i]!, rows[j]!, vectors)) parent.set(find(rows[i]!.id), find(rows[j]!.id));
		}
	}
	const clusters = new Map<number, number[]>();
	for (const row of rows) {
		const root = find(row.id);
		clusters.set(root, [...(clusters.get(root) ?? []), row.id]);
	}
	return [...clusters.values()];
}

/**
 * What the gates read for one row — over the turns that cited **it or any row it absorbed**. That is the
 * whole point of carrying citations through a merge: two copies one criterion short of a gate each must not
 * stay permanently short, and `turns.cited_json` is an immutable record of what a turn actually wrote, so
 * the citations are followed at read time rather than rewritten into history.
 */
export function promotionEvidence(turns: TurnEvidence[], ids: number[]): { citations: number; queries: number; retrieved: number; score: number } {
	const wanted = new Set(ids);
	let citations = 0;
	let retrieved = 0;
	const queries = new Set<string>();
	for (const turn of turns) {
		if (turn.retrieved.some((id) => wanted.has(id))) retrieved += 1;
		if (turn.cited.some((id) => wanted.has(id))) {
			citations += 1;
			queries.add(turn.userText);
		}
	}
	return { citations, queries: queries.size, retrieved, score: retrieved === 0 ? 0 : citations / retrieved };
}

export function passesGates(evidence: { citations: number; queries: number; score: number }): boolean {
	return evidence.citations >= GATE_CITATIONS && evidence.queries >= GATE_QUERIES && evidence.score >= GATE_SCORE;
}

/**
 * The plan, with nothing written: clusters of two or more collapse to one row, and the rows that survive a
 * merge are gated on evidence that includes the citations of the rows they absorbed.
 */
export function planSweep(rows: MemoryRow[], vectors: Map<number, Float32Array>, turns: TurnEvidence[]): SweepPlan {
	const byId = new Map(rows.map((row) => [row.id, row]));
	const merges: MergePlan[] = [];
	for (const cluster of clusterRows(rows, vectors)) {
		if (cluster.length < 2) continue;
		const survivor = cluster.map((id) => byId.get(id)!).reduce((best, row) => (compareSurvivor(row, best) < 0 ? row : best)).id;
		merges.push({ survivor, merged: cluster.filter((id) => id !== survivor) });
	}
	const absorbed = new Map<number, number[]>(merges.map((merge) => [merge.survivor, merge.merged]));
	const retired = new Set(merges.flatMap((merge) => merge.merged));
	const promotions = rows
		.map((row) => row.id)
		.filter((id) => !retired.has(id))
		.filter((id) => passesGates(promotionEvidence(turns, [id, ...(absorbed.get(id) ?? [])])));
	return { merges, promotions };
}

/**
 * Is a sweep due? Idle first — a sweep reorganises the store a conversation is being answered from, so it
 * waits for the same quiet the re-embed job waits for. Then either enough new rows to be worth a pass, or a
 * day since the last one. A store that has never been swept is not due until it has the rows: an empty store
 * has nothing to consolidate, and a daemon that swept on start-up would queue work for every fresh checkout.
 */
export function sweepDue(state: { newRows: number; lastSweepAt: string | null; at: string; idle: boolean }): boolean {
	if (!state.idle) return false;
	if (state.newRows >= MIN_NEW_ROWS) return true;
	if (state.lastSweepAt === null) return false;
	return Date.parse(state.at) - Date.parse(state.lastSweepAt) >= SWEEP_INTERVAL_MS;
}

/**
 * One pass, end to end: read, plan, then apply. The apply half is four store calls and nothing else, which
 * is what makes "a sweep can be interrupted without half-applying" true rather than asserted.
 */
export function consolidate(store: MemoryStore, options: { actor?: string } = {}): SweepReport {
	const actor = options.actor ?? "sweep";
	const rowsBefore = store.memoryRowCount();
	const plan = planSweep(store.activeMemories(), store.activeVectors(), store.citationEvidence());
	for (const merge of plan.merges) store.applyMerge(merge, actor);
	for (const id of plan.promotions) store.applyPromotion(id, actor);
	return { ...plan, rowsBefore, rowsAfter: store.memoryRowCount() };
}
