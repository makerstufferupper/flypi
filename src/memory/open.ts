/**
 * One assembly for the memory store (`.scratch/docs/deepening.md` §11.6 / T35).
 *
 * `serve-daemon.ts`, `serve.ts`, `serve-memory.ts`, `reembed-memory.ts`, both smokes, `vite.config.ts` and
 * `warm-models.ts` each restated the same ritual and each re-decided whether a judge existed; §11.6's table
 * (entrypoint × embedder × judge × readOnly) was kept honest only by a comment beside each copy. This file is
 * that table as code:
 *
 *   - `writes` picks the embedder — a writer loads the model, a reader gets the configured identity
 *     (`configuredIdentity`: no download, and every embed refuses) — and the same flag picks the handle,
 *     `openMemoryDb` or `openMemoryDbReadOnly`.
 *   - a judge loads only when all three hold: it was asked for, this process writes, and the embedder has an
 *     identity at all. A judge with no candidate set is ~400 MB for a call that cannot happen.
 *     A store with no judge is a supported state, not a failure: it keeps judging what tokens can judge, and the
 *     reason it has no model travels to the log as `judge.error` (`judge.ts`; `docs/decisions.md` owns the model).
 *   - a missing model stays a reason and never becomes a throw: it comes back as `degraded`, so recall can
 *     say it degraded instead of pretending it did not (`embed.ts`'s header).
 *
 * **Do not decide any of those three rules at a call site again.** A script that picks its own embedder,
 * guards `createJudge` on `embedder.identity`, or chooses its own `openMemoryDb*` has stopped being a caller
 * of this file; ask for `writes` / `judge` / `progress` and print what comes back. Each caller keeps its own
 * flag parsing, its own wording and its own shutdown — `degraded` is one string precisely so it can be.
 */
import type { DatabaseSync } from "node:sqlite";
import type { EmbeddingsConfig, JudgeConfig, MemoryConfig } from "./config.ts";
import { openMemoryDb, openMemoryDbReadOnly } from "./db.ts";
import { configuredIdentity, createEmbedder, type Embedder } from "./embed.ts";
import { createJudge } from "./judge.ts";
import { modelProgress, type ModelProgress } from "./progress.ts";
import { MemoryStore, type ContradictionClassifier } from "./store.ts";

/** The three things that can be loaded, as a seam: the store's behaviour is testable without 1.2 GB of weights. */
export interface MemoryLoaders {
	/** The writer's embedder: loads the model (~1.1 GB cached, reports download progress). */
	embedder: (config: EmbeddingsConfig, onProgress?: (progress: ModelProgress) => void) => Promise<Embedder>;
	/** The reader's embedder: the configured identity, nothing loaded (`embed.ts`'s `configuredIdentity`). */
	identity: (config: EmbeddingsConfig) => Promise<Embedder>;
	/** The contradiction judge, or the reason there is none (`judge.ts`'s `createJudge`). */
	judge: (config: JudgeConfig, onProgress?: (progress: ModelProgress) => void) => Promise<{ classify?: ContradictionClassifier; error?: string }>;
}

export interface MemoryModels {
	embedder: Embedder;
	judge: { classify?: ContradictionClassifier; error?: string };
	/** Why there are no vectors — a reason, never a throw. `undefined` when nothing is degraded. */
	degraded?: string;
}

export interface MemoryHandle extends MemoryModels {
	store: MemoryStore;
	db: DatabaseSync;
}

/**
 * The real three, so no caller has to know the seam above exists. Exported for the identity pin in
 * `tests/memory/open.test.ts`: the only offline way to tell `configuredIdentity` from `createEmbedder` is the
 * function's identity — behaviourally they differ by a 1.1 GB download, which is not a test.
 */
export const defaultLoaders: MemoryLoaders = { embedder: createEmbedder, identity: configuredIdentity, judge: createJudge };

/** The models half, for a caller that warms weights and builds no store (`scripts/warm-models.ts`). */
export async function loadMemoryModels(
	config: MemoryConfig,
	options: { writes: boolean; judge?: boolean; progress?: boolean; loaders?: MemoryLoaders },
): Promise<MemoryModels> {
	const loaders = options.loaders ?? defaultLoaders;
	const embedder = await (options.writes
		? loaders.embedder(config.embeddings, options.progress ? modelProgress(config.embeddings.model) : undefined)
		: loaders.identity(config.embeddings));
	// Three conditions, none of them optional at the call site: asked for, writing, and a candidate set possible.
	const judge =
		options.judge && options.writes && embedder.identity
			? await loaders.judge(config.judge, options.progress ? modelProgress(config.judge.model) : undefined)
			: {};
	return { embedder, judge, degraded: embedder.error };
}

/** The store half: the models above, plus the handle this process is allowed to hold and the store over it. */
export async function openMemory(
	config: MemoryConfig,
	options: { writes: boolean; judge?: boolean; progress?: boolean; dbPath: string; loaders?: MemoryLoaders },
): Promise<MemoryHandle> {
	const models = await loadMemoryModels(config, options);
	const db = options.writes ? openMemoryDb(options.dbPath) : openMemoryDbReadOnly(options.dbPath);
	return { ...models, db, store: new MemoryStore(db, models.embedder, { classify: models.judge.classify }) };
}
