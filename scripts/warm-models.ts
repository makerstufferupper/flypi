#!/usr/bin/env node
/**
 * Fetch and load the two local memory models into `.flypi/models` before anything needs them, so the
 * download is one visible step rather than a stall inside the first chat turn (docs/memory.md Phase 3).
 * `npm run start` runs this; it is also the command to re-run after changing the model in
 * `.flypi/agent/settings.json`.
 *
 *   npm run models:warm
 *   npm run models:warm -- --embeddings none --judge none   # skip a model, keyword-only memory
 *
 * Exits 1 when the configured embedder cannot load. A keyword-only store is a supported state, but it
 * should be a decision made here, not a surprise discovered at chat time.
 */
import { resolve } from "node:path";
import { flypiPaths } from "../src/agent/paths.ts";
import { memoryConfig } from "../src/memory/config.ts";
import { createEmbedder } from "../src/memory/embed.ts";
import { modelProgress } from "../src/memory/progress.ts";
import { createJudge } from "../src/memory/judge.ts";

const argv = process.argv.slice(2);
const flagValue = (name: string): string | undefined => {
	const i = argv.indexOf(name);
	return i === -1 ? undefined : argv[i + 1];
};

const paths = flypiPaths(resolve(flagValue("--root") ?? process.cwd()));
const config = memoryConfig(paths);
for (const key of ["--embeddings", "--judge"] as const) {
	const value = flagValue(key);
	if (value) config[key === "--embeddings" ? "embeddings" : "judge"].provider = value === "none" ? "none" : "transformers";
}

console.log(`flypi models: cache ${config.embeddings.cacheDir}`);
const embedder = await createEmbedder(config.embeddings, modelProgress(config.embeddings.model));
console.log(`flypi models: embeddings ${embedder.identity ? `${embedder.identity.model} (${embedder.identity.quantized ? "q8" : "fp32"})` : `none — ${embedder.error ?? "configured off"}`}`);
// The judge only has candidates when there are vectors to find them with (scripts/serve-memory.ts).
const judge = embedder.identity ? await createJudge(config.judge, modelProgress(config.judge.model)) : {};
console.log(`flypi models: judge ${judge.classify ? config.judge.model : `none${judge.error ? ` — ${judge.error}` : " (no candidates without embeddings)"}`}`);

if (config.embeddings.provider !== "none" && !embedder.identity) process.exit(1);
