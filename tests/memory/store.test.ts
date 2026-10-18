import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { flypiPaths } from "../../src/agent/paths.ts";
import { EMBED_MODEL, JUDGE_MODEL } from "../../src/memory/config.ts";
import { createEmbedder, noneEmbedder, type Embedder } from "../../src/memory/embed.ts";
import { createJudge } from "../../src/memory/judge.ts";
import { applyTokenBudget, fuseRrf, MemoryStore, valueSwap, type ContradictionCandidate, type ContradictionVerdict, type NewMemory } from "../../src/memory/store.ts";
import { openMemoryDb, } from "../../src/memory/db.ts";
import { openTempFileDb, openTestDb, refusingEmbedder, wordEmbedder } from "../helpers/memory-db.ts";

const PNPM = "we use pnpm, never npm";
const provenance = { origin_class: "owner", session_kind: "interactive", actor: "test" } as const;

type Db = import("node:sqlite").DatabaseSync;

function storeWith(aliases: Record<string, string> = {}, identity?: { model: string; quantized: boolean }): { store: MemoryStore; db: Db } {
	const db = openTestDb();
	return { store: new MemoryStore(db, wordEmbedder(identity, aliases)), db };
}

const statuses = (db: Db) =>
	(db.prepare("SELECT status FROM memories ORDER BY id").all() as { status: string }[]).map((row) => row.status);
const openJobs = (db: Db) => (db.prepare("SELECT kind FROM jobs WHERE locked_by IS NULL").all() as { kind: string }[]).map((row) => row.kind);
const nextRunAt = (db: Db, id: number) => (db.prepare("SELECT next_run_at FROM jobs WHERE id = ?").get(id) as { next_run_at: string }).next_run_at;

async function remember(store: MemoryStore, body: string, extra: Partial<NewMemory> = {}) {
	return (await store.addMemory({ kind: "convention", body, tags: [], ...provenance, ...extra })).id;
}

describe("MemoryStore: hybrid retrieval", () => {
	it("finds a fact by its exact identifier", async () => {
		const { store } = storeWith();
		const id = await remember(store, PNPM, { tags: ["build"] });

		const { results, partial } = await store.search({ query: "pnpm" });
		expect(partial).toBe(false);
		expect(results.map((row) => row.id)).toEqual([id]);
		expect(results[0]!.tags).toEqual(["build"]);
		expect(results[0]!.matched_by).toBe("both");
	});

	it("finds the same fact when asked in different words, through the vectors", async () => {
		// The alias table is what makes the fake model semantic; what is under test is the mechanism:
		// a query with no keyword overlap at all still reaches the row.
		const { store } = storeWith({ "package manager": "pnpm" });
		const id = await remember(store, PNPM);

		const { results } = await store.search({ query: "which package manager" });
		expect(results.map((row) => row.id)).toEqual([id]);
		expect(results[0]!.matched_by).toBe("vector");
	});

	it("says which half found a hit, and leaves unrelated rows out", async () => {
		const { store } = storeWith();
		const shared = await remember(store, PNPM);
		await remember(store, "the registry port is 5432");

		const { results } = await store.search({ query: "pnpm" });
		expect(results.map((row) => row.id)).toEqual([shared]);
		expect(results[0]!.matched_by).toBe("both");
	});

	it("without embeddings it degrades to keywords and says so", async () => {
		const store = new MemoryStore(openTestDb(), noneEmbedder());
		const id = await remember(store, PNPM);

		const { results, partial } = await store.search({ query: "pnpm" });
		expect(partial).toBe(true);
		expect(results.map((row) => row.id)).toEqual([id]);
	});

	it("reports a query it could not embed as partial rather than pretending", async () => {
		const store = new MemoryStore(openTestDb(), refusingEmbedder("input is 9000 tokens, over the 8192-token window", { model: "flaky", quantized: false }));
		const id = await remember(store, PNPM);

		const { results, partial, note } = await store.search({ query: "pnpm" });
		expect(partial).toBe(true);
		expect(note).toMatch(/could not be embedded/);
		expect(results.map((row) => row.id)).toEqual([id]);
	});

	it("a keyword query with no words in it returns nothing, not everything", async () => {
		const store = new MemoryStore(openTestDb(), noneEmbedder());
		await remember(store, PNPM);
		expect((await store.search({ query: "!!! ??? ?!" })).results).toEqual([]);
	});
});

describe("MemoryStore: ranking is deterministic", () => {
	it("breaks an RRF tie the same way every time", () => {
		// All three are one fts hit and one vector hit apart from rank order, so the scores tie; the
		// order below is the documented tie-break (higher score, then higher id), not luck.
		const order = fuseRrf([[1, 2, 3], [3, 2, 1]]).map((hit) => hit.id);
		expect(order).toEqual([3, 1, 2]);
		for (let i = 0; i < 20; i += 1) {
			expect(fuseRrf([[1, 2, 3], [3, 2, 1]]).map((hit) => hit.id)).toEqual(order);
		}
	});

	it("the token budget drops the lowest-ranked blocks and never splits one", () => {
		const blocks = [1, 2, 3].map((n) => ({ id: n, body: "x".repeat(400) }));
		expect(applyTokenBudget(blocks, 100).map((block) => block.id)).toEqual([1]);
		expect(applyTokenBudget(blocks, 200).map((block) => block.id)).toEqual([1, 2]);
		// 120 tokens of budget holds one whole 400-char block, not one and a part of the next.
		expect(applyTokenBudget(blocks, 120).map((block) => block.body.length)).toEqual([400]);
	});

	it("search honours the token cap it was given", async () => {
		const { store } = storeWith();
		const pad = (label: string) => `${label} pnpm ${"z".repeat(300)}`; // ~78 tokens each
		for (const label of ["alpha", "beta", "gamma"]) await remember(store, pad(label));

		expect((await store.search({ query: "pnpm", maxTokens: 100 })).results).toHaveLength(1);
		expect((await store.search({ query: "pnpm", maxTokens: 200 })).results).toHaveLength(2);
	});
});

describe("MemoryStore: the status rules live here", () => {
	it("superseding keeps both rows, writes the pre-image, and retires the old one from search", async () => {
		const { store } = storeWith();
		const old = await remember(store, PNPM);
		const next = await remember(store, "we use bun now");

		store.markSuperseded(old, next, "test", "corrected in session");

		const oldRow = store.memory(old)!;
		expect(oldRow.status).toBe("superseded");
		expect(oldRow.superseded_by).toBe(next);
		expect(store.memory(next)!.supersedes).toBe(old);

		expect((await store.search({ query: "pnpm" })).results.map((row) => row.id)).toEqual([]);
		expect((await store.search({ query: "bun" })).results.map((row) => row.id)).toEqual([next]);

		const history = store.history(old);
		expect(history.map((entry) => entry.action)).toEqual(["create", "supersede"]);
		expect(history[1]!.reason).toBe("corrected in session");
		expect(history[1]!.pre_image).toMatchObject({ body: PNPM, status: "active" });
	});

	it("only an active memory can be superseded", async () => {
		const { store } = storeWith();
		const old = await remember(store, PNPM);
		const next = await remember(store, "we use bun now");
		store.markSuperseded(old, next, "test");
		expect(() => store.markSuperseded(old, next, "test")).toThrow(/only an active memory/);
		expect(() => store.markSuperseded(9999, next, "test")).toThrow(/does not exist/);
	});

	it("nothing but an explicit forget reaches deleted", async () => {
		const { store, db } = storeWith();
		const kept = await remember(store, PNPM);
		const other = await remember(store, "the registry lives on 127.0.0.1:5432");

		// Retrieval, a queued job, and a supersession all leave every row in the table.
		await store.search({ query: "pnpm" });
		store.queueReembed("test");
		expect(statuses(db)).toEqual(["active", "active"]);

		const next = await remember(store, "we use bun now");
		store.markSuperseded(kept, next, "job:dream");
		expect(statuses(db)).toEqual(["superseded", "active", "active"]);

		store.forget(other, "user:browser");
		expect(store.memory(other)!.status).toBe("deleted");
		expect(store.history(other).map((entry) => entry.action)).toEqual(["create", "forget"]);
		// Forgetting twice is a no-op, not a second audit entry.
		store.forget(other, "user:browser");
		expect(store.history(other)).toHaveLength(2);
	});

	it("a deleted row is invisible to both halves of search", async () => {
		const { store } = storeWith({ "package manager": "pnpm" });
		const id = await remember(store, PNPM);
		store.forget(id, "user:browser");

		expect((await store.search({ query: "pnpm" })).results).toEqual([]);
		expect((await store.search({ query: "which package manager" })).results).toEqual([]);
	});
});

describe("MemoryStore: what may be put in front of a model that did not ask", () => {
	// Provenance is authority, and only code sets it (docs/memory.md Phase 4): "the user said so" inside a
	// body carries no weight, so what may be injected unasked is a property of the row, not of its text.
	it("searches every origin by default, and only the eligible ones when asked", async () => {
		const { store } = storeWith();
		const owner = await remember(store, "the release train leaves on tuesday", { origin_class: "owner" });
		const agent = await remember(store, "the release train cuts a tag first", { origin_class: "agent" });
		const scraped = await remember(store, "a scraped page says the release train slips often", { origin_class: "untrusted" });
		const noted = await remember(store, "the release train is tracked in jira", { origin_class: "system" });

		const every = await store.search({ query: "release train", limit: 10 });
		expect(new Set(every.results.map((row) => row.id))).toEqual(new Set([owner, agent, scraped, noted]));
		expect(new Set(every.results.map((row) => row.origin_class))).toEqual(new Set(["owner", "agent", "untrusted", "system"]));

		const eligible = await store.search({ query: "release train", limit: 10, injectableOnly: true });
		expect(new Set(eligible.results.map((row) => row.id))).toEqual(new Set([owner, agent]));
		expect(eligible.results.every((row) => row.origin_class === "owner" || row.origin_class === "agent")).toBe(true);
		// A row it chose not to offer is not a search that went wrong: no `partial`, no note.
		expect(eligible.partial).toBe(false);
		expect(eligible.note).toBeUndefined();
	});

	it("a row it will not inject neither spends the token budget nor earns a retrieval count", async () => {
		const { store } = storeWith();
		const kept = await remember(store, `pnpm ${"a".repeat(300)}`, { origin_class: "owner" });
		const dropped = await remember(store, `pnpm ${"z".repeat(300)}`, { origin_class: "untrusted" });

		// Filtered in the SQL of both halves, so the ineligible row never reaches the ranking, the budget or
		// the counters — it cannot crowd an eligible row out of a block the way a superseded row cannot.
		const budget = { query: "pnpm", maxTokens: 100 } as const;
		expect((await store.search({ ...budget, injectableOnly: true })).results.map((row) => row.id)).toEqual([kept]);
		expect(store.memory(dropped)!.use_count).toBe(0);
		expect(store.memory(kept)!.use_count).toBe(1);
		// The same budget without the filter: this is the row that would have taken the slot.
		expect((await store.search(budget)).results.map((row) => row.id)).toEqual([dropped]);
	});
});

describe("MemoryStore: the write-time dedup gate", () => {
	it("a repeated body points at the row that already exists", async () => {
		const { store, db } = storeWith();
		const first = await remember(store, PNPM);
		const again = await store.addMemory({ kind: "convention", body: PNPM, tags: [], ...provenance });

		expect(again).toEqual({ id: first, duplicateOf: first });
		expect(db.prepare("SELECT count(*) AS n FROM memories").get()).toEqual({ n: 1 });
	});

	it("a near copy is the same fact", async () => {
		// Same tokens, reordered: cosine 1 to the first row for the fixed embedder, which is what a reworded
		// duplicate looks like to it. The threshold branch is what is under test, not the model — that is
		// FLYPI_EMBED_TESTS.
		const { store, db } = storeWith();
		const first = await remember(store, PNPM);
		const near = await store.addMemory({ kind: "convention", body: "we use pnpm — never, npm", tags: [], ...provenance });
		expect(near.duplicateOf).toBe(first);
		expect(db.prepare("SELECT count(*) AS n FROM memories").get()).toEqual({ n: 1 });
	});

	it("a deliberate replacement is never swallowed by the gate", async () => {
		const { store } = storeWith();
		const old = await remember(store, PNPM);
		// Same facts in a different order: cosine 1 to the old row, so without the supersedes guard the gate
		// would answer with the old row instead of writing the update.
		const next = await remember(store, "npm never, we use pnpm", { supersedes: old });
		expect(next).not.toBe(old);
		expect(store.memory(next)!.supersedes).toBe(old);
	});
});

describe("valueSwap: the contradiction that needs no model", () => {
	// Every pair here was measured with EG2 q8 on 2026-10-11 at 0.95–0.98 cosine — above the
	// near-duplicate gate. That is the finding behind this rule: a changed value is the most similar
	// kind of pair there is, so no threshold can tell it from a copy. `valueSwap` decides it on the
	// frame instead, with no model in the path.
	it("names the value that changed", () => {
		const pairs: [string, string, string[], string[]][] = [
			["the deploy port is 8080", "the deploy port is 9090", ["8080"], ["9090"]],
			["the api url is https://api.internal/v1", "the api url is https://api.internal/v2", ["v1"], ["v2"]],
			["the vault key lives in .flypi/secret.key", "the vault key lives in ~/.config/flypi/key", ["secret"], ["config"]],
			// A polarity flip is a value change too (measured 0.9835 — the pair the old gate swallowed deepest).
			["we use pnpm, never npm", "we do not use pnpm", ["never", "npm"], ["do", "not"]],
			["the ci runner is ubuntu-latest", "the ci runner is macos-latest", ["ubuntu"], ["macos"]],
		];
		for (const [stored, incoming, was, now] of pairs) {
			const swap = valueSwap(incoming, stored);
			expect(swap?.was.sort()).toEqual([...was].sort());
			expect(swap?.now.sort()).toEqual([...now].sort());
		}
	});

	it("leaves an extension alone: one row containing all the other's words is not a conflict", () => {
		expect(valueSwap(PNPM, "we use pnpm, never npm; commit the lockfile")).toBeUndefined();
	});

	it("leaves a different key alone: same shape, different fact", () => {
		// 0.8990 apart, and both sides would change too much to be one value.
		expect(valueSwap("the deploy port is 8080", "the deploy host is 10.0.0.5")).toBeUndefined();
	});

	it("leaves a paraphrase alone: that is meaning, and the judge's work", () => {
		// Shares no frame (0.8853). The rule is honest about its own limit rather than widening its
		// thresholds until it says something false.
		expect(valueSwap("we use pnpm, never npm", "prefer bun over pnpm in this repo")).toBeUndefined();
		expect(valueSwap("never commit generated files", "generated files are committed by the build")).toBeUndefined();
	});

	it("leaves a reworded copy alone: a long span of different words is not one changed value", () => {
		// Both of these measured above the near-duplicate gate (0.9403 and 0.9528) and both differ by three
		// tokens on a side — the shape a paraphrase makes. They were false supersedes until VALUE_TOKENS
		// came down to 2; every real value swap in the measured set differs by 1–2 tokens.
		expect(valueSwap("the deploy target is the small box", "deployments go to the small box")).toBeUndefined();
		expect(valueSwap("the staging database is postgres 15", "staging runs postgres version 15")).toBeUndefined();
	});

	it("leaves a row with no shared frame alone", () => {
		expect(valueSwap(PNPM, "the ci runner is ubuntu-latest")).toBeUndefined();
	});

	it("treats case and punctuation as the same words, not as a changed value", () => {
		expect(valueSwap(PNPM, "We use PNPM. NEVER npm!")).toBeUndefined();
	});
});

describe("MemoryStore: a changed value is a correction, not a duplicate", () => {
	it("writes the new value and retires the row it replaces", async () => {
		const { store, db } = storeWith();
		const old = await remember(store, "the deploy port is 8080");
		const written = await store.addMemory({ kind: "convention", body: "the deploy port is 9090", tags: [], ...provenance });

		// Before this rule the write was refused as a near-duplicate and the new fact never landed.
		expect(written.duplicateOf).toBeNull();
		expect(written.contradicted).toEqual({ id: old, body: "the deploy port is 8080" });
		expect(db.prepare("SELECT count(*) AS n FROM memories").get()).toEqual({ n: 2 });
		expect(statuses(db)).toEqual(["superseded", "active"]);
		expect(store.memory(written.id)!.supersedes).toBe(old);
		// The reason says which token was the value, so the browser can show why the row was retired.
		const superseded = store.history(old).find((entry) => entry.action === "supersede");
		expect(superseded?.reason).toBe("same fact, new value: 8080 → 9090");
		expect((superseded?.pre_image as { body?: string } | undefined)?.body).toBe("the deploy port is 8080");
	});

	it("takes a polarity flip as a correction even when the words barely overlap", async () => {
		const { store, db } = storeWith();
		const old = await remember(store, PNPM);
		const written = await remember(store, "we do not use pnpm");
		expect(store.memory(written)!.status).toBe("active");
		expect((db.prepare("SELECT status FROM memories WHERE id = ?").get(old) as { status: string }).status).toBe("superseded");
	});

	it("does not retire anything for a row that only adds to the old one", async () => {
		const { store, db } = storeWith();
		const old = await remember(store, PNPM);
		const written = await remember(store, "we use pnpm, never npm, and never yarn");
		expect(statuses(db)).toEqual(["active", "active"]);
		expect(store.memory(written)!.supersedes).toBeNull();
		expect(store.memory(old)!.supersedes).toBeNull();
	});

	it("does not retire a row that differs in its key, not its value", async () => {
		const { store, db } = storeWith();
		const port = await remember(store, "the deploy port is 8080");
		const host = await remember(store, "the deploy host is 10.0.0.5");
		expect(statuses(db)).toEqual(["active", "active"]);
		expect(store.memory(host)!.supersedes).toBeNull();
		expect(store.memory(port)!.supersedes).toBeNull();
	});

	it("still calls the model when the frame says nothing", async () => {
		// The two rules are ordered, not merged: the deterministic one only speaks when it can, and the
		// judge keeps the paraphrases it was built for.
		const passes: string[][] = [];
		const db = openTestDb();
		const store = new MemoryStore(db, wordEmbedder(), {
			classify: async (_body, candidates) => {
				passes.push(candidates.map((candidate) => candidate.body));
				return { verdict: "new" };
			},
		});
		await remember(store, PNPM);
		await remember(store, "prefer bun over pnpm in this repo");
		expect(passes.length).toBeGreaterThan(0);
	});
});

describe("MemoryStore: the contradiction micro-call", () => {
	/** Seven unrelated active rows, so "at most five candidates" is a real cap and not an empty store. */
	const SEEDS = [
		"the wiki lives at wiki/internal",
		"the daemon writes daemon.json",
		"the vault key is aes-256-gcm",
		"the plan tab mirrors the todo tool",
		"reconnect replays two thousand events",
		"attachments need image input support",
		"packaging ships prebuilt web output",
	];

	/** A classifier seam that records every pass, so the bounds are observable rather than asserted away. */
	function scriptedClassifier(verdict: (index: number, candidates: ContradictionCandidate[]) => { verdict: ContradictionVerdict; target?: number }) {
		const passes: { body: string; candidates: ContradictionCandidate[] }[] = [];
		return {
			passes,
			store: () => {
				const db = openTestDb();
				return { store: new MemoryStore(db, wordEmbedder(), { classify: async (body, candidates) => { passes.push({ body, candidates }); return verdict(passes.length - 1, candidates); } }), db };
			},
		};
	}

	it("runs once per write, over at most five candidates", async () => {
		const spy = scriptedClassifier(() => ({ verdict: "new" }));
		const { store, db } = spy.store();
		for (const body of SEEDS) await remember(store, body);
		const active = (db.prepare("SELECT count(*) AS n FROM memories WHERE status = 'active'").get() as { n: number }).n;
		const passesBefore = spy.passes.length;
		await remember(store, "the release tag is v9");
		// One write, one pass — and the pass sees the cap, not the whole store.
		expect(spy.passes.length - passesBefore).toBe(1);
		expect(active).toBeGreaterThan(5);
		expect(spy.passes.at(-1)!.candidates.length).toBeLessThanOrEqual(5);
	});

	it("retires the row it contradicts and keeps what was believed before", async () => {
		// The first write has nothing near it, so the micro-call is never asked about it; the pass under
		// test is the one with a candidate to judge. The body is a paraphrase on purpose: a row whose value
		// only changed is answered by `valueSwap` before the model is asked anything (block above), and what
		// is under test here is the half the token frame cannot see.
		const spy = scriptedClassifier((_index, candidates) => (candidates.length ? { verdict: "contradict", target: candidates[0]!.id } : { verdict: "new" }));
		const { store, db } = spy.store();
		const old = await remember(store, PNPM);
		const written = await store.addMemory({ kind: "convention", body: "prefer bun over pnpm in this repo", tags: [], ...provenance });

		// Both bodies come back: the model can say what it changed, and the user can see it.
		expect(written.contradicted).toEqual({ id: old, body: PNPM });
		expect(store.memory(written.id)!.status).toBe("active");
		expect(store.memory(written.id)!.supersedes).toBe(old);
		expect((db.prepare("SELECT status FROM memories WHERE id = ?").get(old) as { status: string }).status).toBe("superseded");
		// The pre-image survives: "what did we believe before this" stays answerable.
		const supersede = store.history(old).find((entry) => entry.action === "supersede");
		expect(supersede?.reason).toBe("contradiction micro-call");
		expect((supersede?.pre_image as { body?: string } | undefined)?.body).toBe(PNPM);
		// Never recursive: superseding the old row did not send another write through the classifier.
		expect(spy.passes).toHaveLength(1);
	});

	it("a verdict naming a row it was not shown is not a verdict", async () => {
		const spy = scriptedClassifier(() => ({ verdict: "contradict", target: 999 }));
		const { store } = spy.store();
		const old = await remember(store, PNPM);
		const written = await remember(store, "the release tag is v9");
		expect(store.memory(written)!.supersedes).toBeNull();
		expect(store.memory(old)!.status).toBe("active");
	});

	it("a classifier that throws does not lose the fact", async () => {
		const spy = scriptedClassifier(() => { throw new Error("the model is down"); });
		const { store } = spy.store();
		await remember(store, PNPM);
		const written = await remember(store, "prefer bun over pnpm in this repo");
		// Nothing half-written: the row is there, active, contradicting nothing.
		expect(store.memory(written)!.status).toBe("active");
		expect(store.memory(written)!.body).toBe("prefer bun over pnpm in this repo");
	});

	it("an explicit replacement skips the micro-call", async () => {
		const spy = scriptedClassifier(() => ({ verdict: "new" }));
		const { store } = spy.store();
		const old = await remember(store, PNPM);
		const passesBefore = spy.passes.length;
		await remember(store, "we use pnpm, never npm, and never yarn", { supersedes: old });
		// The caller already said what it replaces; asking the model again would be a second opinion on a
		// decision that has been made.
		expect(spy.passes.length).toBe(passesBefore);
	});
});

/**
 * The judge is not a second opinion that overrules everything: it is one signal with two guards around
 * it, and both guards are deterministic. Measured (`scripts/benchmark-nli.ts`), the model reads every
 * contradiction in the pair set correctly at 0.87–1.00 — and calls two rows about different keys a
 * contradiction at 1.00. These are the tests for the guards, not for the model.
 */
describe("MemoryStore: what a judge may and may not do to a write", () => {
	/** A store whose classifier says whatever the test needs, once per write. */
	function judged(verdict: (candidates: ContradictionCandidate[]) => { verdict: ContradictionVerdict; target?: number }) {
		const db = openTestDb();
		let asked = 0;
		const store = new MemoryStore(db, wordEmbedder(), {
			classify: async (_body, candidates) => {
				asked += 1;
				return verdict(candidates);
			},
		});
		return { store, db, asked: () => asked };
	}

	it("lets the model veto the token rule when it reads the pair as the same fact", async () => {
		// Two tokens differ, so `valueSwap` fires and would retire the first row. The model reading it as
		// one fact said in two ways is the only thing that can stop that — measured, reworded copies are
		// exactly where the token rule gets it wrong.
		const { store, db, asked } = judged(() => ({ verdict: "extend", target: 1 }));
		const first = await remember(store, "always run npm test before pushing");
		const written = await remember(store, "always run npm test before you push");
		expect(asked()).toBeGreaterThan(0);
		expect(statuses(db)).toEqual(["active", "active"]);
		expect(store.memory(written)!.supersedes).toBeNull();
		expect(store.memory(first)!.status).toBe("active");
	});

	it("refuses the write when the model says it restates one", async () => {
		// Below the cosine gate, so the near-duplicate rule said nothing; `entailment` is what refuses it.
		const { store, db } = judged((candidates) => ({ verdict: "duplicate", target: candidates[0]!.id }));
		const first = await remember(store, PNPM);
		const written = await store.addMemory({ kind: "convention", body: "pnpm is the package manager we use", ...provenance });
		expect(written.duplicateOf).toBe(first);
		expect(statuses(db)).toEqual(["active"]);
	});

	it("never lets a model retire two facts that are about different keys", async () => {
		// The measured failure: contradiction, confidence 1.00, cosine 0.8990 — and two separate facts.
		// The frame test is the guard, because NLI was never asked this question.
		const { store, db } = judged((candidates) => ({ verdict: "contradict", target: candidates[0]!.id }));
		const port = await remember(store, "the deploy port is 8080");
		const host = await remember(store, "the deploy host is 10.0.0.5");
		expect(statuses(db)).toEqual(["active", "active"]);
		expect(store.memory(host)!.supersedes).toBeNull();
		expect(store.memory(port)!.status).toBe("active");
	});

	it("writes the fact and says so when the judge does not answer in time", async () => {
		// A hang is not a licence to lose a fact. The budget is injectable so this test does not take
		// the two seconds the real one allows.
		const db = openTestDb();
		const store = new MemoryStore(db, wordEmbedder(), {
			classify: () => new Promise<{ verdict: ContradictionVerdict }>(() => undefined),
			judgeBudgetMs: 20,
		});
		await remember(store, PNPM);
		const written = await store.addMemory({ kind: "convention", body: "prefer bun over pnpm in this repo", ...provenance });
		expect(written.notJudged).toContain("20 ms");
		expect(store.memory(written.id)!.status).toBe("active");
	});

	it("says why nothing was judged when the judge threw", async () => {
		// "Nothing contradicts this" and "nothing was asked" are different answers, and a caller can only
		// act on the difference if the store states it (risk 8).
		const { store } = judged(() => { throw new Error("the model is down"); });
		await remember(store, PNPM);
		const written = await store.addMemory({ kind: "convention", body: "prefer bun over pnpm in this repo", ...provenance });
		expect(written.notJudged).toContain("the model is down");
	});
});

/**
 * The same two behaviours against the shipped model (docs/testing.md: `FLYPI_EMBED_TESTS=1 npm test`,
 * warm `.flypi/models`). The fake embedder above proves the store acts on the frame; this proves the
 * pairs really do sit above the cosine gate, which is the whole reason the frame is consulted at all —
 * and it fails loudly if a future embedding model moves that band.
 */
describe.skipIf(!process.env.FLYPI_EMBED_TESTS)("a value swap with the chosen model", () => {
	const real = async () =>
		new MemoryStore(
			openTestDb(),
			await createEmbedder({ provider: "transformers", model: EMBED_MODEL, quantized: true, cacheDir: flypiPaths(process.cwd()).modelsDir }),
		);

	it("keeps the correction the near-duplicate gate used to swallow", async () => {
		const store = await real();
		const old = await remember(store, "the deploy port is 8080");
		const written = await remember(store, "the deploy port is 9090");
		expect(store.memory(written)!.status).toBe("active");
		expect(store.memory(old)!.status).toBe("superseded");
	});

	it("still refuses the same fact worded differently", async () => {
		const store = await real();
		const first = await remember(store, PNPM);
		const again = await remember(store, "the project uses pnpm and not npm");
		expect(again).toBe(first);
	});
});

/**
 * The judge against the checkpoint it will actually run (docs/memory.md Phase 4). These two pairs are the
 * design in one place: the first is a correction no token rule can see (0.9114 apart, one shared token —
 * the model is the only thing that can retire the old row), and the second is the same model answering
 * `contradiction` at confidence 1.00 about two different facts (0.8990), which the token frame stops.
 * A fake classifier proves the store acts on a verdict; this proves the verdict is worth acting on.
 */
describe.skipIf(!process.env.FLYPI_EMBED_TESTS)("the contradiction judge, with the chosen model", () => {
	const judged = async () => {
		const cacheDir = flypiPaths(process.cwd()).modelsDir;
		const judge = await createJudge({ provider: "transformers", model: JUDGE_MODEL, quantized: true, cacheDir });
		if (judge.error) throw new Error(judge.error); // the flag means the weights are expected to be here
		return new MemoryStore(
			openTestDb(),
			await createEmbedder({ provider: "transformers", model: EMBED_MODEL, quantized: true, cacheDir }),
			{ classify: judge.classify },
		);
	};

	it("retires a correction the token frame cannot see", async () => {
		const store = await judged();
		const old = await remember(store, "we use pnpm, never npm");
		const written = await remember(store, "pnpm is not allowed in this repo");
		expect(store.memory(written)!.supersedes).toBe(old);
		expect(store.memory(old)!.status).toBe("superseded");
	});

	it("does not retire a fact that is about a different key", async () => {
		const store = await judged();
		const port = await remember(store, "the deploy port is 8080");
		const host = await remember(store, "the deploy host is 10.0.0.5");
		expect(store.memory(host)!.supersedes).toBeNull();
		expect(store.memory(port)!.status).toBe("active");
	});
});

describe("MemoryStore: images and recordings", () => {
	const image = (path: string) => ({ kind: "image" as const, path, mime: "image/png", bytes: new Uint8Array([1, 2, 3, 4]) });

	it("keeps the bytes, and a typed query reaches them through the shared space", async () => {
		const { store } = storeWith();
		const written = await store.addMemory({
			kind: "note",
			body: "the office cat, at her desk",
			tags: ["office"],
			...provenance,
			media: image("photos/cat-on-sofa.png"),
		});
		expect(written.notIndexed).toBeUndefined();

		const row = store.memory(written.id)!;
		expect(row.modality).toBe("image");
		expect(row.media).toMatchObject({ kind: "image", mime: "image/png", path: "photos/cat-on-sofa.png", bytes_size: 4 });
		expect([...store.mediaBytes(written.id)!.bytes]).toEqual([1, 2, 3, 4]);

		// "sofa" appears in neither the caption nor the query's own words: the image's vector is what
		// answers it, which is the whole point of one space for text and media.
		const { results } = await store.search({ query: "sofa" });
		expect(results.map((hit) => hit.id)).toEqual([written.id]);
		expect(results[0]!.matched_by).toBe("vector");
	});

	it("never treats two different files as the same memory", async () => {
		// Both files embed identically here — cosine 1 — so the near-duplicate gate would swallow the
		// second write if it were applied to media. That threshold is tuned on text.
		const { store, db } = storeWith();
		await store.addMemory({ kind: "note", body: "photo of the desk", ...provenance, media: image("desk-a.png") });
		const second = await store.addMemory({ kind: "note", body: "another photo of the desk", ...provenance, media: image("desk-a.png") });
		expect(second.duplicateOf).toBeNull();
		expect(db.prepare("SELECT count(*) AS n FROM memories").get()).toEqual({ n: 2 });
	});

	it("keeps a memory the embedder refused, says why, and still finds it by keyword", async () => {
		const reason = "input is 9000 tokens, over the 8192-token window — split it into two memories";
		const store = new MemoryStore(openTestDb(), refusingEmbedder(reason));
		const written = await store.addMemory({ kind: "convention", body: PNPM, ...provenance });

		expect(written.notIndexed).toBe(reason);
		expect(store.memory(written.id)!.embed).toBeNull();
		// Not a stale index: there is no vector to disagree with, and no re-embed job is queued for it.
		expect(store.indexIdentity()).toMatchObject({ rows: 0, stale: 0, reembedQueued: false });

		const { results, partial, note } = await store.search({ query: "pnpm" });
		expect(results.map((hit) => hit.id)).toEqual([written.id]);
		expect(partial).toBe(true);
		expect(note).toMatch(/over the 8192-token window/);
	});
});

describe("MemoryStore: counters mean what they say", () => {
	it("retrieval moves use_count; only a citation moves cited_count", async () => {
		const { store } = storeWith();
		const id = await remember(store, PNPM);

		await store.search({ query: "pnpm" });
		expect(store.memory(id)!.use_count).toBe(1);
		expect(store.memory(id)!.cited_count).toBe(0);

		store.markCited(id);
		expect(store.memory(id)!.cited_count).toBe(1);
		expect(store.memory(id)!.use_count).toBe(1);
		expect(store.memory(id)!.last_verified_at).not.toBeNull();
	});

	it("a search can be asked not to count", async () => {
		const { store } = storeWith();
		const id = await remember(store, PNPM);
		await store.search({ query: "pnpm", count: false });
		expect(store.memory(id)!.use_count).toBe(0);
	});
});

// The ranking factors (docs/memory.md): the merge decides relevance, these decide worth among it. Each is
// shown by taking one row, whose position in the merge cannot change, and moving only the factor.
describe("MemoryStore: ranking weighs what the store has learned", () => {
	const scoreOf = async (store: MemoryStore, id: number) =>
		(await store.search({ query: "pnpm", count: false })).results.find((row) => row.id === id)?.score ?? 0;
	const aged = (db: Db, id: number, days: number) =>
		db.prepare("UPDATE memories SET last_verified_at = ? WHERE id = ?").run(new Date(Date.now() - days * 86_400_000).toISOString(), id);

	it("a citation lifts a row; age and low strength lower it — and never remove it", async () => {
		const { store, db } = storeWith();
		// A situational kind: `convention` is one of the kinds that never ages (the per-kind freshness bands
		// below), so the row this test ages has to be one that is allowed to.
		const id = await remember(store, PNPM, { kind: "note" });
		const before = await scoreOf(store, id);
		// At the defaults (strength 1.0, verified now, never cited) the factors are exactly 1.0: the merge
		// alone decided this score, and nothing here moved it.
		expect(before).toBeGreaterThan(0);

		store.markCited(id);
		expect(await scoreOf(store, id)).toBeGreaterThan(before);

		aged(db, id, 400);
		const stale = await scoreOf(store, id);
		expect(stale).toBeLessThan(before);
		// Staleness lowers rank and never deletes a memory (docs/memory.md): it is still returned.
		expect((await store.search({ query: "pnpm" })).results.map((row) => row.id)).toEqual([id]);

		db.prepare("UPDATE memories SET strength = 0.3 WHERE id = ?").run(id);
		expect(await scoreOf(store, id)).toBeLessThan(stale);
	});

	it("freshness bands are per-kind: a convention keeps its rank, a situational fact loses it — and neither disappears", async () => {
		const { store, db } = storeWith();
		const rule = await remember(store, "pnpm is the package manager we use");
		const situational = await remember(store, "pnpm runs the deploy on 10.0.0.5", { kind: "note" });
		const before = [await scoreOf(store, rule), await scoreOf(store, situational)] as [number, number];
		aged(db, rule, 400);
		aged(db, situational, 400);
		const after = [await scoreOf(store, rule), await scoreOf(store, situational)] as [number, number];
		// A convention does not go stale by sitting in the store; a situational fact is at half its rank by the
		// half-life and keeps going down from there (docs/memory.md Phase 6).
		expect(after[0]).toBeCloseTo(before[0], 10);
		expect(after[1]).toBeLessThan(before[1]);
		// Age lowers position, it never removes a row.
		const ids = (await store.search({ query: "pnpm", count: false })).results.map((row) => row.id);
		expect(ids).toEqual(expect.arrayContaining([rule, situational]));
	});

	it("a cited fact outranks one the search merely happened to match first", async () => {
		const { store } = storeWith();
		// The merge, on its own, puts the first row ahead of the second.
		const first = await remember(store, "pnpm installs the dependencies");
		const second = await remember(store, "pnpm is the package manager here");
		expect((await store.search({ query: "pnpm" })).results.map((row) => row.id)).toEqual([first, second]);

		// Two replies that cited the second row are enough to overtake it: usefulness the store has
		// evidence for beats a marginally better keyword match.
		store.markCited(second);
		store.markCited(second);
		expect((await store.search({ query: "pnpm" })).results.map((row) => row.id)).toEqual([second, first]);
	});

	// The write gate refuses bodies that embed alike; this is the half it cannot see — a paraphrase far
	// enough in the vectors to be a new row, and the same fact nonetheless.
	it("returns one copy of a fact the store holds twice", async () => {
		const { store } = storeWith();
		const short = await remember(store, "the deploy target is the small box");
		await remember(store, "the deploy target is the small box running ubuntu 24.04");

		const results = await store.search({ query: "deploy target" });
		expect(results.results).toHaveLength(1);
		expect(results.results[0]!.id).toBe(short);
	});

	// Two facts that differ in their *key* are different facts: the store keeps both, and recall must not
	// collapse them. Rows differing only in a value no longer reach here — the write gate retires the old
	// one as a correction (see "a changed value is a correction, not a duplicate").
	it("keeps two rows that differ in what they are about", async () => {
		const { store } = storeWith();
		await remember(store, "the deploy port is 8080");
		await remember(store, "the deploy host is 10.0.0.5");
		expect((await store.search({ query: "deploy" })).results).toHaveLength(2);
	});
});

describe("MemoryStore: one vector space at a time", () => {
	it("refuses to compare vectors from another model or quantization", async () => {
		const { store, db } = storeWith();
		const id = await remember(store, PNPM);

		const swapped = new MemoryStore(db, wordEmbedder({ model: "other-model", quantized: false }));
		expect(swapped.indexIdentity()).toMatchObject({ rows: 1, stale: 1, reembedQueued: true });
		const result = await swapped.search({ query: "which package manager" });
		// The old vectors are not silently compared against the new query embedding.
		expect(result.results.map((row) => row.id)).not.toContain(id);
	});

	it("queues memory.reembed once per open job", async () => {
		const { store, db } = storeWith();
		await remember(store, PNPM);
		const swapped = new MemoryStore(db, wordEmbedder({ model: "other-model", quantized: true }));

		expect(swapped.indexIdentity().reembedQueued).toBe(true);
		expect(openJobs(db)).toEqual(["memory.reembed"]);
		swapped.queueReembed("again");
		expect(openJobs(db)).toEqual(["memory.reembed"]);
	});

	it("an index built by the configured model is not stale", async () => {
		const { store } = storeWith();
		await remember(store, PNPM);
		expect(store.indexIdentity()).toMatchObject({ rows: 1, stale: 0, reembedQueued: false });
	});

	/** Switching embedding models is what this exists for: the old vectors stop being comparable. */
	it("reembed rewrites what a model change left behind, then closes the job it was fixing", async () => {
		const { store, db } = storeWith();
		const text = await remember(store, PNPM);
		const photo = await store.addMemory({
			kind: "note",
			body: "photo of the desk",
			...provenance,
			media: { kind: "image", path: "desk.png", mime: "image/png", bytes: new Uint8Array([1, 2, 3, 4]) },
		});

		const swapped = new MemoryStore(db, wordEmbedder({ model: "other-model", quantized: true }));
		expect(swapped.indexIdentity()).toMatchObject({ rows: 2, stale: 2, reembedQueued: true });

		const { embedded, skipped } = await swapped.reembed();
		expect(embedded).toEqual([text, photo.id]); // the media row re-embeds from its stored bytes
		expect(skipped).toEqual([]);
		expect(swapped.indexIdentity()).toMatchObject({ rows: 2, stale: 0, reembedQueued: false });
		expect(openJobs(db)).toEqual([]);
		expect(swapped.history(photo.id).some((entry) => entry.action === "reembed")).toBe(true);
	});

	// A media row can exist without the bytes next to it (crash between the two inserts), and the bytes
	// can be there and still not decode. Both are a reason the index did not move, and the job has to say
	// which one, or the answer to "why is my index short" is a guess.
	it("reembed says why it skipped a media row it could not read", async () => {
		const { store, db } = storeWith();
		const orphan = await store.addMemory({
			kind: "note",
			body: "photo of the desk",
			...provenance,
			media: { kind: "image", path: "desk.png", mime: "image/png", bytes: new Uint8Array([1, 2, 3]) },
		});
		const unreadable = await store.addMemory({
			kind: "note",
			body: "voice memo",
			...provenance,
			media: { kind: "audio", path: "voice.wav", mime: "audio/wav", bytes: new Uint8Array([1, 2, 3]) },
		});
		db.prepare("DELETE FROM media WHERE memory_id = ?").run(orphan.id); // the half-written row

		const cannotDecode: Embedder = {
			...wordEmbedder({ model: "other-model", quantized: true }),
			embedMedia: async () => {
				throw new Error("cannot decode a 3-byte wav");
			},
		};
		const swapped = new MemoryStore(db, cannotDecode);
		expect(swapped.indexIdentity()).toMatchObject({ rows: 2, stale: 2, reembedQueued: true });

		const { embedded, skipped } = await swapped.reembed();
		expect(embedded).toEqual([]);
		expect(skipped).toEqual([
			{ id: orphan.id, why: "no media row is attached to it" },
			{ id: unreadable.id, why: "its stored bytes could not be decoded: cannot decode a 3-byte wav" },
		]);
		expect(swapped.memory(orphan.id)!.embed).not.toBeNull(); // the old vector survives, as everywhere else
		expect(openJobs(db)).toEqual(["memory.reembed"]); // nothing was fixed, so the job stays open
	});

	it("reembed does not invent a vector for input the model refuses", async () => {
		const { store, db } = storeWith();
		const id = await remember(store, PNPM);
		const reason = "input is 9000 tokens, over the 8192-token window";
		const refusing = new MemoryStore(db, refusingEmbedder(reason));
		expect(refusing.indexIdentity().reembedQueued).toBe(true); // what the model change looks like from here

		const { embedded, skipped } = await refusing.reembed();
		expect(embedded).toEqual([]);
		expect(skipped).toEqual([{ id, why: reason }]);
		// The old vector is kept, not dropped: it is outside the new index either way, and it becomes
		// useful again if the model does. The open job stays open, because nothing was fixed.
		expect(refusing.memory(id)!.embed).not.toBeNull();
		expect(openJobs(db)).toEqual(["memory.reembed"]);
	});

	it("new work makes an open job due again, not an hour from now", () => {
		const { store, db } = storeWith();
		// The state after a pass that ran: one open row, pushed out to whenever it is next wanted.
		const id = store.queueJob("memory.reembed", { runAt: "2030-01-01T00:00:00.000Z" })[0]!;
		expect(nextRunAt(db, id)).toBe("2030-01-01T00:00:00.000Z");

		// Asking for the same job again is a second row doing nothing; it is the existing row that has to
		// become due, because a write that needs the index must not wait out the idle wait.
		expect(store.queueJob("memory.reembed")).toEqual([id]);
		expect(openJobs(db)).toEqual(["memory.reembed"]);
		expect(new Date(nextRunAt(db, id)).getTime()).toBeLessThan(Date.parse("2030-01-01T00:00:00.000Z"));
	});
});

describe("MemoryStore: turns", () => {
	it("records a turn and links a memory to it", async () => {
		const db = openTestDb();
		const store = new MemoryStore(db, noneEmbedder());
		store.createConversation({ id: "c1", cwd: "/tmp" });
		const turnId = store.recordTurn("c1", {
			userText: "remember: the key is sk-test-1234",
			assistantText: "noted",
			toolCalls: [{ name: "bash" }],
			usage: { input: 10 },
		});
		const id = await remember(store, "the key is sk-test-1234", { turn_id: turnId });

		expect(store.memory(id)!.turn_id).toBe(turnId);
		const turn = db.prepare("SELECT * FROM turns WHERE id = ?").get(turnId) as Record<string, string>;
		// redactSecrets is the identity function until Phase 5.5 — the call site is what Phase 3 owes.
		expect(turn.user_text).toBe("remember: the key is sk-test-1234");
		expect(JSON.parse(turn.tool_calls_json!)).toEqual([{ name: "bash" }]);
	});

	// The hit-rate metrics are the difference between "a fact was injected" and "a fact was used", and
	// nothing but a per-turn record can tell them apart (docs/memory.md Phase 4).
	it("keeps retrieval and citation apart, because retrieval is not citation", async () => {
		const db = openTestDb();
		const store = new MemoryStore(db, noneEmbedder());
		// A turn is the first thing the memory server ever hears about a conversation, so it creates the row
		// it points at — and doing that twice is normal, not an error.
		store.ensureConversation({ id: "c1", cwd: "/tmp" });
		store.ensureConversation({ id: "c1", cwd: "/elsewhere" });
		expect((db.prepare("SELECT cwd FROM conversations WHERE id = 'c1'").get() as { cwd: string }).cwd).toBe("/tmp");

		store.recordTurn("c1", { userText: "which package manager?", retrieved: [1, 2], cited: [1] });
		store.recordTurn("c1", { userText: "and the deploy target?", retrieved: [3], cited: [] });
		store.recordTurn("c1", { userText: "no memories here" });

		const turns = db.prepare("SELECT retrieved_json, cited_json FROM turns ORDER BY id").all() as Record<string, string | null>[];
		const read = (value: string | null | undefined) => (value == null ? null : JSON.parse(value));
		expect(turns.map((row) => [read(row.retrieved_json), read(row.cited_json)])).toEqual([
			[[1, 2], [1]],
			[[3], []],
			// A turn that was shown nothing says so by leaving it absent, which is not the same as an empty list.
			[null, null],
		]);

		expect(store.memoryHitRate()).toEqual({
			turns: 3,
			turns_shown_memories: 2,
			turns_citing: 1,
			memories_retrieved: 3,
			memories_cited: 1,
			rate: 0.5,
		});
	});

	it("reports a zero hit rate instead of dividing by nothing, on a store with no turns", () => {
		const store = new MemoryStore(openTestDb(), noneEmbedder());
		expect(store.memoryHitRate()).toEqual({
			turns: 0,
			turns_shown_memories: 0,
			turns_citing: 0,
			memories_retrieved: 0,
			memories_cited: 0,
			rate: 0,
		});
	});

	it("a write on a closed file is recoverable, i.e. WAL mode is real", async () => {
		const handle = openTempFileDb();
		try {
			const store = new MemoryStore(handle.db, noneEmbedder());
			const id = await remember(store, PNPM);
			handle.db.close();

			const reopened = openMemoryDb(handle.file);
			expect(new MemoryStore(reopened).memory(id)!.body).toBe(PNPM);
			reopened.close();
		} finally {
			rmSync(join(handle.file, ".."), { recursive: true, force: true });
		}
	});
});
