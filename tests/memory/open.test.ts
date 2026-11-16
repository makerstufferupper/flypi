/**
 * `openMemory` — the assembly rules in one body (`.scratch/docs/deepening.md` §11.6, T35).
 *
 * The table that file quotes was six scripts each re-deciding the same three questions in their own words.
 * What this file pins is the collapse of those answers into code:
 *   - `writes` picks the embedder loader (the model, or the configured identity) **and** the handle
 *     (`openMemoryDb`, or `openMemoryDbReadOnly`);
 *   - a judge loads only when all three hold: it was asked for, this process writes, and the embedder has
 *     an identity whose vectors could make a candidate set at all;
 *   - a missing model stays a reason rather than a throw, and travels out as `degraded` (`embed.ts`'s header).
 *
 * The loaders are injected — the house seam (`docs/testing.md`: two seams exist only to make features
 * testable, and there is no `vi.mock` in this repo) — so nothing here downloads a model. Case 7 is the one
 * call that uses the real defaults, with `provider: "none"`, which is the config that needs no weights.
 */
import { describe, expect, it } from "vitest";
import { flypiPaths } from "../../src/agent/paths.ts";
import { memoryConfig, parseMemoryConfig } from "../../src/memory/config.ts";
import { noneEmbedder } from "../../src/memory/embed.ts";
import { openMemory, type MemoryLoaders } from "../../src/memory/open.ts";
import type { ModelProgress } from "../../src/memory/progress.ts";
import type { ContradictionCandidate, MemoryStore } from "../../src/memory/store.ts";
import { openTempFileDb, wordEmbedder } from "../helpers/memory-db.ts";

const PNPM = "we use pnpm, never npm";
/** Close enough to be about the same thing, far enough that the vectors do not call it a duplicate. */
const SAME_FACT_OTHER_WORDS = "prefer bun over pnpm in this repo";
const provenance = { origin_class: "owner", session_kind: "interactive", actor: "test" } as const;

/** The model names never resolve here: every case below injects the loaders that would have read them. */
const config = memoryConfig(flypiPaths("/repo"));
/** `provider: "none"` is an escape hatch you may take, not a failure state (`config.ts`'s header). */
const offConfig = parseMemoryConfig({ memory: { embeddings: { provider: "none" }, judge: { provider: "none" } } }, flypiPaths("/repo"));

async function remember(store: MemoryStore, body: string): Promise<number> {
	return (await store.addMemory({ kind: "convention", body, tags: [], ...provenance })).id;
}

/** A file rather than `:memory:`, because `writes: false` is only interesting about a file someone wrote. */
async function withFileDb(run: (file: string) => Promise<void>): Promise<void> {
	const tmp = openTempFileDb();
	try {
		await run(tmp.file);
	} finally {
		tmp.dispose();
	}
}

/**
 * The seam, recorded. Each case asserts what a loader was *handed* as much as what it returned, because
 * "the judge loader never ran" and "the reader got the identity loader, not the model loader" are facts
 * that leave no mark on the handle.
 */
function recordingLoaders(overrides: Partial<MemoryLoaders> = {}) {
	type Handed = ((progress: ModelProgress) => void) | undefined;
	const calls = { embedderProgress: [] as Handed[], identity: 0, judgeProgress: [] as Handed[] };
	const words: MemoryLoaders["embedder"] = async () => wordEmbedder();
	const identityOnly: MemoryLoaders["identity"] = async () => wordEmbedder();
	const noJudge: MemoryLoaders["judge"] = async () => ({});
	const loaders: MemoryLoaders = {
		embedder: async (config, onProgress) => {
			calls.embedderProgress.push(onProgress);
			return (overrides.embedder ?? words)(config, onProgress);
		},
		identity: async (config) => {
			calls.identity += 1;
			return (overrides.identity ?? identityOnly)(config);
		},
		judge: async (config, onProgress) => {
			calls.judgeProgress.push(onProgress);
			return (overrides.judge ?? noJudge)(config, onProgress);
		},
	};
	return { loaders, calls };
}

/** Each progress callback is `modelProgress(<that model>)` (`progress.ts:26`): the model name is baked into
 * the closure, so the only way to tell the two callbacks apart is to make one report and read its line — and
 * `log` defaults to `console.log` *as it stands when `openMemory` builds the callback*, so the collector has
 * to be installed around the open, not just around the report. `report` returns what one callback printed.
 * `modelProgress` logs only a `progress_total` event that reaches 100 % (`progress.ts:30-37`), which is why
 * the event below is shaped like this. */
async function withProgressLog<T>(run: (report: (callback: (progress: ModelProgress) => void) => string) => Promise<T>): Promise<T> {
	const lines: string[] = [];
	const log = console.log;
	console.log = (line?: unknown) => void lines.push(String(line));
	try {
		return await run((callback) => {
			lines.length = 0;
			callback({ status: "progress_total", progress: 100, loaded: 1, total: 1 });
			return lines.join("");
		});
	} finally {
		console.log = log;
	}
}

const aJudgeThatSaysNew: MemoryLoaders["judge"] = async () => ({ classify: async () => ({ verdict: "new" as const }) });
const aJudgeThatMustNotRun = (reason: string): MemoryLoaders["judge"] => async () => {
	throw new Error(reason);
};

describe("openMemory: who gets loaded", () => {
	it("a writer gets a judge, and the store is the thing that calls it", async () => {
		// Rule: `writes: true` + `judge: true` + an embedder with an identity ⇒ the classifier reaches
		// `new MemoryStore`, not only the returned handle.
		const seen: string[][] = [];
		const classify = async (_body: string, candidates: ContradictionCandidate[]) => {
			seen.push(candidates.map((candidate) => candidate.body));
			return { verdict: "new" as const };
		};
		const { loaders, calls } = recordingLoaders({ judge: async () => ({ classify }) });
		await withFileDb(async (file) => {
			const handle = await openMemory(config, { writes: true, judge: true, dbPath: file, loaders });
			expect(handle.judge.classify).toBe(classify);
			// Exactly one judge load: a second load is a second ~90 MB model resident, and the daemon keeps
			// this process alive for days.
			expect(calls.judgeProgress.length).toBe(1);
			expect(handle.degraded).toBeUndefined();
			await remember(handle.store, PNPM);
			// The assertion the handle cannot fake: this is how tests/memory/store.test.ts proves a
			// classifier was wired in, and `openMemory` passing `{}` instead of `{ classify }` dies here.
			await remember(handle.store, SAME_FACT_OTHER_WORDS);
			expect(seen.length).toBeGreaterThan(0);
			handle.db.close();
		});
	});

	it("a writer still opens when the judge cannot load", async () => {
		// Rule: a judge that says why it is absent is a supported state (`judge.ts:97`), and the row is
		// written whatever the judge does.
		const { loaders } = recordingLoaders({ judge: async () => ({ error: "no contradiction judgment: weights missing" }) });
		await withFileDb(async (file) => {
			const handle = await openMemory(config, { writes: true, judge: true, dbPath: file, loaders });
			expect(handle.judge.classify).toBeUndefined();
			expect(handle.judge.error).toBe("no contradiction judgment: weights missing");
			const id = await remember(handle.store, PNPM);
			expect(handle.store.memory(id)?.body).toBe(PNPM);
			handle.db.close();
		});
	});

	it("loads no judge when the embedder has no identity, and none when none was asked for", async () => {
		// Rule (`serve-memory.ts:42`): with no embedder there is no candidate set, so a judge would be
		// 400 MB for a call that cannot happen — and the reason for the missing model is the output.
		const noEmbedder = recordingLoaders({
			embedder: async () => noneEmbedder("embeddings unavailable: no model on disk"),
			judge: aJudgeThatMustNotRun("the judge must not load when there is no candidate set"),
		});
		await withFileDb(async (file) => {
			const handle = await openMemory(config, { writes: true, judge: true, dbPath: file, loaders: noEmbedder.loaders });
			expect(noEmbedder.calls.judgeProgress.length).toBe(0);
			expect(handle.judge).toEqual({});
			expect(handle.degraded).toBe("embeddings unavailable: no model on disk");
			handle.db.close();

			// The other side of the same `&&`, both directions being what `docs/testing.md` asks of a seam:
			// a real embedder still loads no judge nobody asked for (`reembed-memory` never judges).
			const notAsked = recordingLoaders({ judge: aJudgeThatMustNotRun("no caller asked for a judge") });
			const writer = await openMemory(config, { writes: true, dbPath: file, loaders: notAsked.loaders });
			expect(notAsked.calls.judgeProgress.length).toBe(0);
			expect(writer.judge).toEqual({});
			writer.db.close();
		});
	});

	it("writes: false takes the identity loader, no judge, and a handle that refuses to write", async () => {
		// Rule: the reader's row of the table — identity only, no judge even when asked, read-only handle.
		// (`tests/server/serve.test.ts` cannot prove this: it skips the block when no db file exists.)
		await withFileDb(async (file) => {
			const writer = await openMemory(config, { writes: true, dbPath: file, loaders: recordingLoaders().loaders });
			const id = await remember(writer.store, PNPM);
			writer.db.close();

			const { loaders, calls } = recordingLoaders({ judge: aJudgeThatSaysNew });
			const reader = await openMemory(config, { writes: false, judge: true, dbPath: file, loaders });
			expect(calls.identity).toBe(1);
			expect(calls.embedderProgress.length).toBe(0);
			expect(calls.judgeProgress.length).toBe(0);
			// The read is the whole point of the second process. `count: false` because counting a
			// retrieval moves `use_count`, which is a write.
			const { results } = await reader.store.search({ query: "pnpm", count: false });
			expect(results.map((row) => row.id)).toEqual([id]);
			expect(() => reader.store.forget(id, "test")).toThrow(/readonly/i);
			reader.db.close();
		});
	});

	it("the same file reopened with writes: true takes the write the reader was refused", async () => {
		// Rule: `writes` is what picks `openMemoryDb`; nothing about the file decides it.
		await withFileDb(async (file) => {
			const first = await openMemory(config, { writes: true, dbPath: file, loaders: recordingLoaders().loaders });
			const id = await remember(first.store, PNPM);
			first.db.close();

			const again = await openMemory(config, { writes: true, dbPath: file, loaders: recordingLoaders().loaders });
			again.store.forget(id, "test");
			expect(again.store.memory(id)?.status).toBe("deleted");
			again.db.close();
		});
	});

	it("progress hands each loader a callback for its own model, and without it each loader is handed undefined", async () => {
		// Rule: `modelProgress(model)` (`progress.ts:26`, whose line already reads `flypi: downloading …`)
		// is built here or not passed at all — a caller never imports it.
		const on = recordingLoaders({ judge: aJudgeThatSaysNew });
		await withFileDb(async (file) => {
			await withProgressLog(async (report) => {
				const handle = await openMemory(config, { writes: true, judge: true, progress: true, dbPath: file, loaders: on.loaders });
				try {
					expect(on.calls.judgeProgress.length).toBe(1);
					expect(typeof on.calls.embedderProgress[0]).toBe("function");
					expect(typeof on.calls.judgeProgress[0]).toBe("function");
					// And each callback names *its own* model: the first-run container log is the only place
					// either line is ever read, and a callback built from the other model's name would blame
					// the wrong download for the wait there.
					const embedderLine = report(on.calls.embedderProgress[0]!);
					expect(embedderLine).toContain(config.embeddings.model);
					expect(embedderLine).not.toContain(config.judge.model);
					expect(report(on.calls.judgeProgress[0]!)).toContain(config.judge.model);
				} finally {
					handle.db.close();
				}
			});
		});

		const off = recordingLoaders({ judge: aJudgeThatSaysNew });
		await withFileDb(async (file) => {
			const handle = await openMemory(config, { writes: true, judge: true, dbPath: file, loaders: off.loaders });
			expect(off.calls.embedderProgress).toEqual([undefined]);
			expect(off.calls.judgeProgress).toEqual([undefined]);
			handle.db.close();
		});
	});

	it("the default loaders are the real ones, and provider none needs no download", async () => {
		// Rule: `loaders` is a test seam, not a caller's job — and `provider: "none"` is a decision, so it
		// degrades into nothing. No `loaders` here covers the default-parameter branch offline.
		await withFileDb(async (file) => {
			const handle = await openMemory(offConfig, { writes: true, judge: true, dbPath: file });
			expect(handle.embedder.identity).toBeNull();
			expect(handle.judge).toEqual({});
			expect(handle.degraded).toBeUndefined();
			const id = await remember(handle.store, PNPM);
			expect(handle.store.memory(id)?.body).toBe(PNPM);
			handle.db.close();
		});
	});
});
