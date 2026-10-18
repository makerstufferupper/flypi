/**
 * `memory` in `.flypi/agent/settings.json` (docs/memory.md Phase 3). Defaults are chosen to work on
 * a machine with nothing installed, which is why `provider: "none"` is an escape hatch you can take
 * and not a failure state: search then runs FTS-only and says so.
 *
 * `consolidation` and `wiki` are Phase 6 and absent here on purpose.
 */
import { readFileSync } from "node:fs";
import type { FlypiPaths } from "../agent/paths.ts";

/**
 * CHOSEN (2026-10-11, docs/decisions.md): EmbeddingGemma 2 — text, images and audio in one vector
 * space, 8,192-token window. The `onnx-community` mirror, not `google/`: the upstream repo ships
 * safetensors only and could not be loaded here. Non-English is covered (100+ languages).
 */
export const EMBED_MODEL = "onnx-community/embeddinggemma-2-ONNX";

/**
 * CHOSEN (2026-10-11, docs/decisions.md): the contradiction judge is `nli-deberta-v3-xsmall` — an NLI
 * cross-encoder, not a chat model. Chosen on measurement (`scripts/benchmark-nli.ts`): the smallest
 * checkpoint that read every contradiction in the pair set correctly, 87 MB at q8, ~6 ms a pair.
 */
export const JUDGE_MODEL = "Xenova/nli-deberta-v3-xsmall";

export interface EmbeddingsConfig {
	provider: "transformers" | "none";
	model: string;
	/** Part of the index identity key: two quantizations are two vector spaces (risk 7). */
	quantized: boolean;
	cacheDir: string;
}

/**
 * The contradiction judge (docs/memory.md Phase 4). On by default: switched off, the store can only
 * judge what tokens can judge, and the measured cost is 87 MB of weights and ~6 ms per pair. It shares
 * the cache directory with the embeddings because it shares the runtime that reads them.
 */
export interface JudgeConfig {
	provider: "transformers" | "none";
	model: string;
	quantized: boolean;
	cacheDir: string;
}

export interface MemoryConfig {
	embeddings: EmbeddingsConfig;
	judge: JudgeConfig;
	/**
	 * The review fork (docs/memory.md Phase 4.8): how many delivered answers between forks, `0` = off. It is
	 * a config key with an off switch for the same reason the judge is — a fork is a whole model run over the
	 * conversation, ~30K tokens on a route that does not serve it from cache, with no human in the loop.
	 */
	review: { interval: number };
}

export function memoryConfig(paths: FlypiPaths): MemoryConfig {
	let settings: unknown;
	try {
		settings = JSON.parse(readFileSync(paths.settingsPath, "utf8"));
	} catch {
		settings = {}; // no settings file yet: the defaults have to work
	}
	return parseMemoryConfig(settings, paths);
}

export function parseMemoryConfig(settings: unknown, paths: FlypiPaths): MemoryConfig {
	const memory = (settings as { memory?: Record<string, unknown> } | undefined)?.memory;
	const raw = memory?.embeddings as Record<string, unknown> | undefined;
	const judge = memory?.judge as Record<string, unknown> | undefined;
	const provider = (value: unknown): "transformers" | "none" => (value === "none" || value === false ? "none" : "transformers");
	const model = (value: unknown, fallback: string) => (typeof value === "string" && value.length > 0 ? value : fallback);
	// A number of turns, so a non-number is the default rather than a fork every turn: `true` in the file must
	// not become `1`, and a negative one must not become "fire on every turn" through a modulo.
	const interval = (value: unknown, fallback: number) => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback);
	return {
		embeddings: {
			provider: provider(raw?.provider),
			model: model(raw?.model, EMBED_MODEL),
			quantized: raw?.quantized !== false,
			cacheDir: model(raw?.cacheDir, paths.modelsDir),
		},
		judge: {
			provider: provider(judge?.provider),
			model: model(judge?.model, JUDGE_MODEL),
			quantized: judge?.quantized !== false,
			cacheDir: model(judge?.cacheDir, paths.modelsDir),
		},
		review: { interval: interval(memory?.reviewInterval, 10) },
	};
}
