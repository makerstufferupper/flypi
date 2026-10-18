#!/usr/bin/env node
/**
 * Start the flypi agent server (docs/protocol.md).
 *
 *   npm run serve                     # ephemeral port, generated token
 *   npm run serve -- --port 8787      # fixed port
 *   FLYPI_TOKEN=… npm run serve -- --token …
 */
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { flypiPaths } from "../src/agent/paths.ts";
import { memoryEndpoint } from "../src/agent/config-files.ts";
import { memoryConfig } from "../src/memory/config.ts";
import { openMemoryDbReadOnly } from "../src/memory/db.ts";
import { configuredIdentity } from "../src/memory/embed.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { memoryApi } from "../src/server/memory-api.ts";
import { SessionRegistry } from "../src/server/session-registry.ts";
import { openRunStore } from "../src/server/run-store.ts";
import { secretsApi } from "../src/server/secrets-api.ts";
import { openSecretVault, type SecretStore } from "../src/secrets/vault.ts";
import { startFlypiServer } from "../src/server/index.ts";

const argv = process.argv.slice(2);
const flagValue = (name: string): string | undefined => {
	const i = argv.indexOf(name);
	return i === -1 ? undefined : argv[i + 1];
};

const paths = flypiPaths(resolve(flagValue("--root") ?? process.cwd()));
// The backend's own database, and this process is its only writer (docs/risks.md risk 3): it is the process
// that runs pi sessions, so it is the process that knows whether a turn was in flight. The memory store is
// not opened here at all — this half has no business with it, and the agent reaches memory over MCP.
const runs = openRunStore(paths);
// One backend at a time owns this file, like any other flypi database: `flypi start` or `npm run serve`, not
// both. Whatever is left `running` belongs to a process that is gone, so say so before serving anyone a chat.
runs.reconcileInterrupted();
// The vault is in the memory database, which this process does not own. With the file present it is opened
// read-only, so a chat run here still redacts `[secret:x]` instead of repeating a credential into the
// transcript; with no file, or one this build has not migrated, the sessions simply have no secret tools and
// the Secrets tab says so (docs/secrets.md Phase 5.5). `flypi start` is the process that can write it.
let vault: SecretStore | undefined;
// The memory browser (docs/memory.md Phase 6) reads the same file. Read-only, like the vault: the Memory tab
// lists rows, turns and wiki pages from here, and a write is refused with the sentence that names the process
// that may write. The embedder is the configured model's *identity* and nothing more, so the index state the
// panel reports is true without this process loading ~100 MB of model it will never ask a vector of.
let memory: ReturnType<typeof memoryApi> | undefined;
try {
	if (existsSync(paths.memoryDbPath)) {
		const memoryDb = openMemoryDbReadOnly(paths.memoryDbPath);
		memory = memoryApi(new MemoryStore(memoryDb, await configuredIdentity(memoryConfig(paths).embeddings)), memoryDb, { readOnly: true });
	}
} catch (error) {
	console.log(`flypi: no memory store: ${(error as Error).message}`);
}
const registry = new SessionRegistry({
	root: paths.root,
	onRunStatus: (conversationId, status, info) => runs.setRunStatus(conversationId, status, info),
	vault,
});
const server = await startFlypiServer({
	registry,
	port: flagValue("--port") ? Number(flagValue("--port")) : undefined,
	token: flagValue("--token") ?? process.env.FLYPI_TOKEN,
	serverVersion: "dev",
	// An interrupted turn is a backend fact, so it is answered from the backend's store here too.
	interruptedRun: (sessionFile) => runs.interruptedFor(sessionFile),
	// Prod: the same server serves the built UI (docs/architecture.md: "Dev vs prod").
	uiDir: resolve(process.cwd(), "dist/ui"),
	secrets: vault ? secretsApi(vault, paths) : undefined,
	memory,
});

console.log(`flypi: listening ${server.url}`);
console.log(`flypi: token    ${server.token}`);
console.log(`flypi: connect  ${server.url}/?token=${server.token}`);
// Same check the daemon makes: an entry pointing at a token this process does not have is refused by the
// store, and the sessions here would simply have no memory tools (docs/risks.md risk 8).
const memoryNote = memoryEndpoint(paths).note;
if (memoryNote) console.log(`flypi: ${memoryNote}`);
console.log("flypi: Ctrl-C to stop");

const stop = () => {
	registry.dispose();
	runs.close();
	void server.close().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
