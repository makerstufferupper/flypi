#!/usr/bin/env node
/**
 * The always-on daemon (docs/architecture.md Phase 4.5): the agent server, the built UI, the memory MCP
 * surface and the job queue in one process. Foreground here; `flypi start` is what puts it in the
 * background and writes `.flypi/daemon.log`.
 *
 *   npm run daemon                              # ports and token from .flypi/agent/mcp.json
 *   npm run daemon -- --port 8787               # override the agent server
 *   npm run daemon -- --host 0.0.0.0            # bind every interface (a container: a published port
 *                                               # cannot reach the container's own loopback)
 *   npm run daemon -- --embeddings none         # FTS-only memory, no model download
 *
 * Unlike `npm run serve`, this is the process that keeps conversations alive with no client attached,
 * records which turn was running when it died, and runs `memory.reembed` while idle. It holds both
 * databases — the memory store's and the backend's run record — because it is the one process that is both
 * halves at once; `npm run serve` holds only the second.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { flypiPaths } from "../src/agent/paths.ts";
import { builtUi, startFlypiDaemon } from "../src/daemon/index.ts";
import { memoryConfig } from "../src/memory/config.ts";
import { openMemoryDb } from "../src/memory/db.ts";
import { createEmbedder } from "../src/memory/embed.ts";
import { modelProgress } from "../src/memory/progress.ts";
import { createJudge } from "../src/memory/judge.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { openRunStore } from "../src/server/run-store.ts";

const argv = process.argv.slice(2);
const flagValue = (name: string): string | undefined => {
	const i = argv.indexOf(name);
	return i === -1 ? undefined : argv[i + 1];
};

const paths = flypiPaths(resolve(flagValue("--root") ?? process.cwd()));
const config = memoryConfig(paths);
if (flagValue("--embeddings")) config.embeddings.provider = flagValue("--embeddings") === "none" ? "none" : "transformers";
if (flagValue("--judge")) config.judge.provider = flagValue("--judge") === "none" ? "none" : "transformers";

// The download is ~1 GB on a machine that has never run flypi, and the daemon is not listening until it
// finishes — so both loaders report what they are fetching, into the log `flypi start` echoes back.
const embedder = await createEmbedder(config.embeddings, modelProgress(config.embeddings.model));
if (embedder.error) console.log(`flypi: ${embedder.error} — memory search will be keyword-only`);
// A second resident model (~400 MB next to the embedder, docs/decisions.md). Not loading it is supported:
// the store judges what tokens can judge and says so. With no embedder there is no candidate set.
const judge = embedder.identity ? await createJudge(config.judge, modelProgress(config.judge.model)) : { classify: undefined };
if (judge.error) console.log(`flypi: ${judge.error}`);

const db = openMemoryDb(paths.memoryDbPath);
const store = new MemoryStore(db, embedder, { classify: judge.classify });
// The backend's own database: which conversation had a turn in flight. Separate file, separate writer.
const runs = openRunStore(paths);

const token = flagValue("--token") ?? process.env.FLYPI_TOKEN;
// The package the code ships in — not `paths.root`, which is the state directory (`~/.flypi`'s parent for
// an installed app, the checkout in a dev tree).
const pkgDir = resolve(fileURLToPath(import.meta.url), "..", "..");
// The built UI ships next to the code, not next to the state: `--root` says which `.flypi/` the daemon owns,
// and for the installed app that is the home directory, which has no dist/ui in it.
const uiDir = builtUi(pkgDir);
// The version the health page and `flypi status` report. Read from the package rather than from npm's
// environment: the CLI spawns this directly, so npm_package_version is only set when it came through a script.
const version = (JSON.parse(readFileSync(resolve(pkgDir, "package.json"), "utf8")).version ?? "dev") as string;
const daemon = await startFlypiDaemon({
	paths,
	db,
	store,
	runs,
	...(flagValue("--port") ? { port: Number(flagValue("--port")) } : {}),
	// Set by `flypi start` when the port came from an earlier start rather than from this command line: a port
	// nobody named today is a preference, so the daemon binds another one instead of dying on `EADDRINUSE`.
	...(argv.includes("--port-may-move") ? { portMayMove: true } : {}),
	...(flagValue("--host") ? { host: flagValue("--host") } : {}),
	...(token ? { token } : {}),
	...(uiDir ? { uiDir } : {}),
	version,
});
console.log(`flypi: daemon pid ${process.pid}`);
console.log(`flypi: agent server ${daemon.url}`);
console.log(`flypi: memory MCP   http://127.0.0.1:${daemon.memoryPort}/mcp`);
console.log(`flypi: embeddings   ${embedder.identity ? embedder.identity.model : "none (FTS-only)"}`);
console.log(`flypi: judge        ${judge.classify ? config.judge.model : "none (token rule only)"}`);
if (!uiDir) console.log("flypi: dist/ui is not built — running headless (`npm run build` for the UI)");
console.log("flypi: `flypi stop`, or Ctrl-C, to stop`");

// The plan's rule: an interrupted turn is not re-run, because the tools may already have written to the
// world. So shutdown only has to stop the loop, close the sockets and leave the record.
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		if (stopping) return;
		stopping = true;
		void daemon.close().then(() => {
			db.close();
			runs.close();
			process.exit(0);
		});
	});
}
