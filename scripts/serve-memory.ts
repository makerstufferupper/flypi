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
import { startMemoryServer } from "../src/memory/mcp.ts";
import { openMemory } from "../src/memory/open.ts";
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

// The loaders and the handle are `openMemory`'s call; this script owns only the wording its reasons print in.
const { db, store, embedder, judge, degraded } = await openMemory(config, { writes: true, judge: true, dbPath: flagValue("--db") ?? paths.memoryDbPath });
if (degraded) console.log(`flypi memory: ${degraded} — search will be keyword-only`);
if (judge.error) console.log(`flypi memory: ${judge.error}`);

// The vault lives in this same file, so this process is the one that can write it — and opening it here is
// what makes `redactSecrets` real when a memory body is stored (docs/secrets.md Phase 5.5). A memory server
// with no vault open would accept `sk-…` into a memory row and never know.
// This process owns the write handle, so the vault may record uses and changes against it.
openSecretVault(paths, { db, write: true });
const index = store.indexSummary();
if (index.stale > 0 && index.expected) {
	console.log(`flypi memory: ${index.stale} stored vectors are not from ${index.expected.model} — the daemon queues memory.reembed when it starts (\`flypi restart\` if one is already running)`);
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
