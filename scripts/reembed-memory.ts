#!/usr/bin/env node
/**
 * Re-embed the memories the current index cannot represent. Run this after changing the embedding model
 * (docs/decisions.md): the old vectors are not comparable to the new ones, so until they are rewritten
 * those memories are reachable by keywords only.
 *
 *   npm run reembed:memory
 *   npm run reembed:memory -- --db /path/to/flypi.db
 */
import { resolve } from "node:path";
import { flypiPaths } from "../src/agent/paths.ts";
import { memoryConfig } from "../src/memory/config.ts";
import { openMemory } from "../src/memory/open.ts";

const argv = process.argv.slice(2);
const flagValue = (name: string): string | undefined => {
	const i = argv.indexOf(name);
	return i === -1 ? undefined : argv[i + 1];
};

const paths = flypiPaths(resolve(flagValue("--root") ?? process.cwd()));
const config = memoryConfig(paths);
if (flagValue("--embeddings")) config.embeddings.provider = flagValue("--embeddings") === "none" ? "none" : "transformers";

// No judge: re-embedding a vector never asks one, and loading it would be 400 MB for a call that cannot happen.
const { db, store, degraded } = await openMemory(config, { writes: true, dbPath: flagValue("--db") ?? paths.memoryDbPath });
if (degraded) console.log(`flypi reembed: ${degraded}`);

const before = store.indexSummary();
console.log(`flypi reembed: ${before.rows} stored vectors, ${before.stale} not from ${before.expected?.model ?? "anything we can produce"}`);

const { embedded, skipped } = await store.reembed({ actor: "cli" });
console.log(`flypi reembed: rewrote ${embedded.length} ${embedded.length === 1 ? "memory" : "memories"}${embedded.length ? `: ${embedded.join(", ")}` : ""}`);
for (const row of skipped) console.log(`flypi reembed: #${row.id} stays keyword-only: ${row.why}`);

const after = store.indexSummary();
console.log(`flypi reembed: index now holds ${after.rows} vectors, ${after.stale} from another model`);
db.close();
