/**
 * Vite + Svelte 5 for the browser UI (docs/architecture.md Phase 2).
 *
 * `npm run dev` starts both halves in one command: Vite serves the UI, and a plugin starts the
 * agent server in the same process on a fixed port. The UI always talks to its own origin, so the
 * same client code works in dev (through the proxy below) and in prod (`npm run serve`).
 */
import { defineConfig, type Plugin } from "vite";
import { existsSync } from "node:fs";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { flypiPaths } from "./src/agent/paths.ts";
import { memoryEndpoint } from "./src/agent/config-files.ts";
import { memoryConfig } from "./src/memory/config.ts";
import { openMemoryDbReadOnly } from "./src/memory/db.ts";
import { configuredIdentity } from "./src/memory/embed.ts";
import { MemoryStore } from "./src/memory/store.ts";
import { memoryApi } from "./src/server/memory-api.ts";
import { openSecretVault, type SecretStore } from "./src/secrets/vault.ts";
import { secretsApi } from "./src/server/secrets-api.ts";
import { startFlypiServer } from "./src/server/index.ts";
import { SessionRegistry } from "./src/server/session-registry.ts";
import { openRunStore, type RunStore } from "./src/server/run-store.ts";

const DEV_AGENT_PORT = Number(process.env.FLYPI_DEV_PORT ?? 56789);

/**
 * The agent server runs inside the Vite process, on a fixed port, so the UI reaches it through the
 * proxy below. It does not hot-reload: a `src/` edit restarts it with an empty registry and the UI
 * reconnects to that — conversations and event logs do not survive a server-side edit, which is what
 * HMR does cover for the UI.
 */
// Vite re-evaluates this config file when src/ changes, so a module variable would forget the agent that
// is still holding the port; globalThis is the one thing that survives the restart.
const dev = globalThis as typeof globalThis & {
	__flypiDevAgent?: Awaited<ReturnType<typeof startFlypiServer>>;
	__flypiDevRuns?: RunStore;
	__flypiDevVault?: SecretStore | undefined;
	__flypiDevMemory?: ReturnType<typeof memoryApi> | null;
};

function devAgentServer(): Plugin {
	return {
		name: "flypi-dev-agent",
		apply: "serve",
		async configureServer() {
			// Vite re-runs this while the agent it is replacing is still listening, and a second bind on the
			// fixed port is EADDRINUSE — an unhandled error that takes the whole dev command down. Hand the
			// port over instead. No shutdown hook: at Ctrl-C the process exits and the port goes with it.
			await dev.__flypiDevAgent?.close();
			// The backend's own database, same file and same rules as `npm run serve`: dev behaves like prod.
			// It is opened once and kept — a fresh connection on every src/ edit would leak handles.
			const paths = flypiPaths(process.cwd());
			dev.__flypiDevRuns ??= openRunStore(paths);
			const runs = dev.__flypiDevRuns;
			// Same as `npm run serve` and the daemon: a `running` row can only be a leftover from the dev server
			// that was just Ctrl-C'd (one backend owns this file), and marking it is what lets the chat say so.
			runs.reconcileInterrupted();
			// The vault, exactly as `npm run serve` opens it (scripts/serve.ts): read-only when the memory file is
			// there, so a chat run here still redacts `[secret:x]` and the Secrets tab has something to show, while
			// `flypi start` stays the process that can write it. Opened once and kept, like the run store.
			if (dev.__flypiDevVault === undefined) {
				try {
					if (existsSync(paths.memoryDbPath)) dev.__flypiDevVault = openSecretVault(paths);
				} catch (error) {
					console.log(`flypi: no vault: ${(error as Error).message}`);
				}
			}
			// The memory browser, read-only like the vault: dev can look at the store, the wiki and the turn
			// log, and a write says which process may do it. Opened once and kept, like the run store.
			if (dev.__flypiDevMemory === undefined) {
				try {
					if (existsSync(paths.memoryDbPath)) {
						const memoryDb = openMemoryDbReadOnly(paths.memoryDbPath);
						dev.__flypiDevMemory = memoryApi(new MemoryStore(memoryDb, await configuredIdentity(memoryConfig(paths).embeddings)), memoryDb, { readOnly: true });
					} else dev.__flypiDevMemory = null;
				} catch (error) {
					console.log(`flypi: no memory store: ${(error as Error).message}`);
					dev.__flypiDevMemory = null;
				}
			}
			const vault = dev.__flypiDevVault;
			dev.__flypiDevAgent = await startFlypiServer({
				registry: new SessionRegistry({
					root: paths.root,
					onRunStatus: (conversationId, status, info) => runs.setRunStatus(conversationId, status, info),
					vault,
				}),
				port: DEV_AGENT_PORT,
				serverVersion: "dev",
				interruptedRun: (sessionFile) => runs.interruptedFor(sessionFile),
				secrets: vault ? secretsApi(vault, paths) : undefined,
				memory: dev.__flypiDevMemory ?? undefined,
			});
			console.log(`flypi: agent server on ${dev.__flypiDevAgent.url} — the UI reads its token from /__flypi.json`);
			// The one memory failure a dev restart can introduce: an agent started without the token mcp.json
			// names. Say it here, or the only report of it is a model saying the memory tools are missing.
			const memoryNote = memoryEndpoint(paths).note;
			if (memoryNote) console.log(`flypi: ${memoryNote}`);
		},
	};
}

export default defineConfig({
	root: "ui",
	plugins: [svelte(), devAgentServer()],
	build: { outDir: "../dist/ui", emptyOutDir: true },
	server: {
		proxy: {
			"/ws": { target: `ws://127.0.0.1:${DEV_AGENT_PORT}`, ws: true },
			"/__flypi.json": { target: `http://127.0.0.1:${DEV_AGENT_PORT}` },
			// The page reads the update answer here (ui/App.svelte). In dev the agent is not a daemon, so this
			// answers 404 and the page says nothing; without the proxy it would get Vite's index.html instead.
			"/healthz": { target: `http://127.0.0.1:${DEV_AGENT_PORT}` },
		},
	},
});
