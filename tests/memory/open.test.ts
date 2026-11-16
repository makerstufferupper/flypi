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
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { flypiPaths } from "../../src/agent/paths.ts";
import { EMBED_MODEL, memoryConfig, parseMemoryConfig } from "../../src/memory/config.ts";
import { configuredIdentity, createEmbedder, noneEmbedder } from "../../src/memory/embed.ts";
import { createJudge } from "../../src/memory/judge.ts";
import { defaultLoaders, loadMemoryModels, openMemory, type MemoryLoaders } from "../../src/memory/open.ts";
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

	it("provider: \"none\" opens with no download and no degradation", async () => {
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

	it("the default loaders are the three real ones", () => {
		// Pinned by identity, not behaviour: `provider: "none"` answers `noneEmbedder()` for both
		// `createEmbedder` and `configuredIdentity`, and `provider: "transformers"` would download ~1.1 GB.
		// Swapping the two is the failure `writes` exists to prevent — a reader that fetches the model, or a
		// writer that stores every row without a vector — and nothing else in the suite can see it.
		expect(defaultLoaders.embedder).toBe(createEmbedder);
		expect(defaultLoaders.identity).toBe(configuredIdentity);
		expect(defaultLoaders.judge).toBe(createJudge);
	});

	it("the reader's embedder knows the index it cannot write", async () => {
		// `memory.md`'s read-only half, and `embed.ts`'s own header: the second process knows which vector
		// space the rows are in without loading the model, and every embed refuses — which is what stops it
		// quietly adding a vector it could not reproduce. No network: `configuredIdentity` never loads.
		const embedder = await defaultLoaders.identity(config.embeddings);
		expect(embedder.identity).toEqual({ model: EMBED_MODEL, quantized: true });
		await expect(embedder.embedQuery(PNPM)).resolves.toMatchObject({ ok: false });
		await expect(embedder.embedDocument(PNPM)).resolves.toMatchObject({ ok: false });
	});
});

/**
 * The models half on its own, because `scripts/warm-models.ts` calls *this* function and never `openMemory`
 * (`open.ts`'s decision 4 in `.scratch/plans/t35-plan.md`: a download step must not create
 * `.flypi/memory/flypi.db`). Its row of the table would otherwise be proven only transitively, through the
 * store cases above — and there is no db and no store here, nothing for a wrong loader to hide behind.
 */
describe("loadMemoryModels: the models half, with no store", () => {
	it("a writer gets one judge and a progress line per model, a reader gets the identity and no judge", async () => {
		// The writer's row, exactly as `npm run models:warm` asks for it.
		const { loaders, calls } = recordingLoaders({ judge: aJudgeThatSaysNew });
		await withProgressLog(async (report) => {
			const models = await loadMemoryModels(config, { writes: true, judge: true, progress: true, loaders });
			expect(models.embedder.identity).not.toBeNull();
			expect(models.judge.classify).toBeDefined();
			expect(models.degraded).toBeUndefined();
			// One judge load, and each callback reports *its own* model — the two downloads are ~1.1 GB and
			// ~90 MB, so blaming the wrong one in a first-run log is a user waiting for the wrong number.
			expect(calls.judgeProgress.length).toBe(1);
			expect(typeof calls.embedderProgress[0]).toBe("function");
			const embedderLine = report(calls.embedderProgress[0]!);
			expect(embedderLine).toContain(config.embeddings.model);
			expect(embedderLine).not.toContain(config.judge.model);
			expect(report(calls.judgeProgress[0]!)).toContain(config.judge.model);
		});

		// The reader's row: `writes: false` must not fetch the model, and a judge nobody could feed a
		// candidate set stays in the cache.
		const reader = recordingLoaders({ judge: aJudgeThatMustNotRun("a reader has no candidate set to judge") });
		const models = await loadMemoryModels(config, { writes: false, judge: true, progress: true, loaders: reader.loaders });
		expect(reader.calls.identity).toBe(1);
		expect(reader.calls.embedderProgress.length).toBe(0);
		expect(reader.calls.judgeProgress.length).toBe(0);
		expect(models.judge).toEqual({});
	});
});

/**
 * T35's other half: the copy stays gone.
 *
 * Swept from the tree rather than asserted per script, because the failure this pins is a *new* copy: the
 * judge rule was restated three times (`serve-memory.ts`, `serve-daemon.ts`, `warm-models.ts`) and each copy
 * was kept honest by a comment beside it, so an assertion naming the files that exist today would say
 * nothing about the script someone adds tomorrow. `.scratch/plans/t35-plan.md`'s `Done when` states the same
 * claim as a grep nobody runs; this is that grep as a test. Paths are resolved from `import.meta.url` for the
 * same reason `tests/memory/recall-corpus.test.ts:19` resolves its fixture — the case must not depend on
 * which directory vitest was started from.
 *
 * `tests/` is not swept: a test builds its own `MemoryStore` on purpose (`tests/helpers/memory-db.ts`).
 */
const root = fileURLToPath(new URL("../..", import.meta.url));
/** Runnable code only — `ui/public/*.jpeg` has no store to assemble. */
const RUNNABLE = /\.(ts|mjs|js|svelte)$/;

/** Generated trees hold no decision of ours; a minified bundle under `ui/` must not make this red on build output. */
const SKIPPED = new Set(["node_modules", "coverage", "dist", ".flypi", ".git"]);

/** Every runnable file below a directory, recursively, in a stable order. */
function walk(dir: string): string[] {
	return readdirSync(join(root, dir), { withFileTypes: true })
		.filter((entry) => !SKIPPED.has(entry.name))
		.flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : RUNNABLE.test(entry.name) ? [join(dir, entry.name)] : []))
		.sort();
}

/** The swept surface: the plan's `scripts src` grep, plus `ui`, `bin` and `vite.config.ts` — the file that
 * grep cannot see and which is exactly why the wider sweep exists (plan D2). */
const SWEPT = ["src", "scripts", "ui", "bin"].flatMap(walk).concat("vite.config.ts").sort();

/** The files that hold `needle`, with their count — so the diff names the paths that went rogue. */
function copies(needle: string): [string, number][] {
	return SWEPT.flatMap((file) => {
		const hits = readFileSync(join(root, file), "utf8").split(needle).length - 1;
		return hits > 0 ? ([[file, hits]] as [string, number][]) : [];
	});
}

describe("the assembly ritual stays copied nowhere", () => {
	it("leaves `new MemoryStore` to open.ts and the judge rule to one caller", () => {
		// One body for the store assembly in runnable code — including `vite.config.ts`, which is named in the
		// swept list rather than ignored precisely because it assembled its own store there (plan D2).
		expect(copies("new MemoryStore("), "a MemoryStore assembled outside src/memory/open.ts").toEqual([
			["src/memory/open.ts", 1],
		]);
		// One body for the judge rule. `open.ts` is the rule's only caller and passes `createJudge` to
		// `defaultLoaders` by name, so it scores 0 for the parenthesised form; if it ever calls it directly it
		// belongs in this list.
		expect(copies("createJudge("), "a judge loaded outside src/memory").toEqual([
			["src/memory/judge.ts", 1], // the definition
		]);
	});

	// `.scratch/plans/t35-plan.md`'s fourth `Done when` grep: no entrypoint decides on its own which embedder to
	// load. `writes` is that decision, so both loaders it picks between belong to `open.ts`.
	it("leaves the choice of embedder loader to open.ts", () => {
		// The two definitions live in `embed.ts`, and `open.ts` passes both to `defaultLoaders` by name, so it
		// scores 0 for the parenthesised form — the same shape `createJudge` has above.
		expect(copies("createEmbedder("), "an embedder loaded outside src/memory").toEqual([
			// The declared exception, plan decision 8: the measurement tool `.scratch/docs/memory.md` and
			// `config.ts` cite for the model choice. It hand-builds an `EmbeddingsConfig` from `--cacheDir` with no
			// `FlypiPaths`, loads no judge and builds no store, so it stays a direct caller — one call, no more.
			["scripts/benchmark-nli.ts", 1],
			["src/memory/embed.ts", 1], // the definition
		]);
		expect(copies("configuredIdentity("), "a reader's identity built outside src/memory").toEqual([
			["src/memory/embed.ts", 1], // the definition
		]);
	});

	// `docs/risks.md` risk 3: one writer per file. The second process gets a read-only handle precisely so it
	// cannot become a second writer of the memory database, so which callers ask for `writes: false` is the rule.
	it("keeps the agent server and the dev server readers", () => {
		expect(copies("writes: false"), "a process holding the memory db read-only").toEqual([
			["scripts/serve.ts", 1],
			["vite.config.ts", 1],
		]);
		for (const reader of ["scripts/serve.ts", "vite.config.ts"]) {
			expect(readFileSync(join(root, reader), "utf8"), `${reader} asks for a write handle too`).not.toContain("writes: true");
		}
	});
});
