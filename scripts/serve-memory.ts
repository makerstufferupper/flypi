#!/usr/bin/env node
/**
 * Start the memory store as an MCP server over HTTP (docs/memory.md Phase 3).
 *
 *   npm run memory                                  # ephemeral port, generated token
 *   npm run memory -- --port 8790 --token …         # fixed
 *   npm run memory -- --embeddings none             # FTS-only, no model download
 *   npm run memory -- --judge none                  # no contradiction model (token rule only)
 *
 * Point an MCP client at it with:
 *   { "name": "flypi-memory", "url": "http://127.0.0.1:<port>/mcp", "headers": { "Authorization": "Bearer <token>" } }
 *
 * Two mounts, one store: `/mcp` is an ordinary caller, `/mcp/background` is an unattended writer — same token,
 * same database, and the store refuses it `memory_supersede`/`memory_forget`/`memory_capture`
 * (src/memory/mcp.ts, docs/memory.md Phase 4.8). flypi points a review fork's entry at the second one.
 */
import { resolve } from "node:path";
import { flypiPaths } from "../src/agent/paths.ts";
import { memoryConfig } from "../src/memory/config.ts";
import { openMemoryDb } from "../src/memory/db.ts";
import { createEmbedder } from "../src/memory/embed.ts";
import { createJudge } from "../src/memory/judge.ts";
import { startMemoryServer } from "../src/memory/mcp.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { openSecretVault } from "../src/secrets/vault.ts";

const argv = process.argv.slice(2);
const flagValue = (name: string): string | undefined => {
	const i = argv.indexOf(name);
	return i === -1 ? undefined : argv[i + 1];
};

const paths = flypiPaths(resolve(flagValue("--root") ?? process.cwd()));
const config = memoryConfig(paths);
if (flagValue("--embeddings")) config.embeddings.provider = flagValue("--embeddings") === "none" ? "none" : "transformers";
if (flagValue("--judge")) config.judge.provider = flagValue("--judge") === "none" ? "none" : "transformers";

const embedder = await createEmbedder(config.embeddings);
if (embedder.error) console.log(`flypi memory: ${embedder.error} — search will be keyword-only`);
// A second resident model (~400 MB of RSS next to the embedder, docs/decisions.md). Refusing to load it
// is a supported state, not a failure: the store keeps judging what tokens can judge and says so.
// With no embedder there is no candidate set, so a judge would be 400 MB for a call that cannot happen.
const judge = embedder.identity ? await createJudge(config.judge) : { classify: undefined };
if (judge.error) console.log(`flypi memory: ${judge.error}`);

const db = openMemoryDb(flagValue("--db") ?? paths.memoryDbPath);
const store = new MemoryStore(db, embedder, { classify: judge.classify });
// The vault lives in this same file, so this process is the one that can write it — and opening it here is
// what makes `redactSecrets` real when a memory body is stored (docs/secrets.md Phase 5.5). A memory server
// with no vault open would accept `sk-…` into a memory row and never know.
// This process owns the write handle, so the vault may record uses and changes against it.
openSecretVault(paths, { db, write: true });
const identity = store.indexIdentity();
if (identity.stale > 0 && identity.expected) {
	console.log(`flypi memory: ${identity.stale} stored vectors are not from ${identity.expected?.model} — queued memory.reembed`);
}

const server = await startMemoryServer({
	store,
	port: flagValue("--port") ? Number(flagValue("--port")) : undefined,
	token: flagValue("--token") ?? process.env.FLYPI_MEMORY_TOKEN,
	principal: "mcp",
});

console.log(`flypi memory: listening ${server.url}`);
console.log(`flypi memory: token     ${server.token}`);
console.log(`flypi memory: embeddings ${embedder.identity ? embedder.identity.model : "none (FTS-only)"}`);
console.log(`flypi memory: judge      ${judge.classify ? config.judge.model : embedder.identity ? "none (token rule only)" : "none (no candidates without embeddings)"}`);
console.log("flypi memory: Ctrl-C to stop");

const stop = () => {
	void server.close().then(() => {
		db.close();
		process.exit(0);
	});
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
