/**
 * The always-on daemon (docs/architecture.md Phase 4.5): one process that holds the memory store, serves
 * the agent server and the memory MCP surface, keeps conversations alive with no client attached, and runs
 * the job queue. This is what makes dreaming possible later — and it is the process that knows, after a
 * crash, which turn was in flight.
 *
 * Two databases, one per component (docs/decisions.md): `store` is the memory component's, and `runs` is the
 * backend's. The daemon is the seam where they meet — it writes chat state to one and facts to the other, and
 * nothing joins across the two files. Each keeps its own single writer (risk 3): the memory store is opened by
 * the caller because opening it means loading the embedding and judgment models (~1.4 GB of RSS, docs/memory.md),
 * and so is the run store, which is a file either entrypoint can open in a millisecond. Everything that makes
 * it a *daemon* — the reconciliation, `/healthz`, `daemon.json`, the queue — lives here, and is tested here.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FlypiPaths } from "../agent/paths.ts";
import { applyConfigEdits, ensureAgentConfig, ensureMemoryEntry, memoryEndpoint } from "../agent/config-files.ts";
import { applyPackageEdits, checkPackageUpdates, dueForPackageCheck, readPackageCheck, writePackageCheck } from "../agent/packages.ts";
import { CONSOLIDATE_JOB, consolidate, sweepDue } from "../memory/consolidate.ts";
import { startMemoryServer, type MemoryServerHandle } from "../memory/mcp.ts";
import type { MemoryStore } from "../memory/store.ts";
import { WIKI_JOB, renderWiki } from "../memory/wiki.ts";
import { openSecretVault } from "../secrets/vault.ts";
import { REENCRYPT_JOB } from "../secrets/vault.ts";
import { memoryApi } from "../server/memory-api.ts";
import { secretsApi } from "../server/secrets-api.ts";
import { startFlypiServer, type FlypiServerHandle, type FlypiServerOptions } from "../server/index.ts";
import { SessionRegistry, type CreateSession } from "../server/session-registry.ts";
import type { RunStore } from "../server/run-store.ts";
import { JobQueue, startJobLoop, type JobHandler } from "./jobs.ts";
import { IDLE_BEFORE_INSTALL_MS, checkForUpdate, clearUpdateCheck, downloadUpdate, dueForCheck, installArgs, isGlobalInstall, isNewer, keepDownload, packageDir, packageInfo, readUpdateCheck, stagedUpdate, updateAvailable, writeUpdateCheck } from "./update.ts";

/** What `.flypi/daemon.json` holds: enough for `flypi status` to find a running daemon again. */
export interface DaemonInfo {
	pid: number;
	host: string;
	port: number;
	/** The token the UI needs. The file is 0600 for that reason. */
	token: string;
	/** Where the memory MCP surface answered, and the token its `mcp.json` entry must carry. */
	memoryPort: number;
	startedAt: string;
	version: string;
}

export const DAEMON_FILE = join(".flypi", "daemon.json");

export interface DaemonOptions {
	paths: FlypiPaths;
	db: DatabaseSync;
	store: MemoryStore;
	/** The backend's own store: which conversation had a turn in flight (docs/architecture.md Phase 4.5). */
	runs: RunStore;
	/** Only to swap in the stub model in tests; production uses the registry's own factory. */
	createSession?: CreateSession;
	/** How often the queue is asked what is due. Production leaves the loop's own interval alone. */
	jobIntervalMs?: number;
	token?: string;
	port?: number;
	/** When that `port` was carried over from an earlier start rather than named now, one someone else has
	 * taken is recoverable: bind another and say so. Absent means `port` is a demand — a container's published
	 * port is useless on another number, and moving it quietly is the dead URL this path exists to avoid. */
	portMayMove?: boolean;
	/** Interface to bind. Omitted means the server's loopback default; a container needs `0.0.0.0`, since a
	 * published Docker port never reaches the container's own loopback. The token is the auth either way. */
	host?: string;
	uiDir?: string;
	version?: string;
	/** Where a daemon says what it did. Defaults to the console, which is where `flypi start` collects it. */
	log?: (line: string) => void;
}

export interface DaemonHandle {
	port: number;
	memoryPort: number;
	token: string;
	url: string;
	jobs: JobQueue;
	close(): Promise<void>;
}

/** Read a running daemon's pid file, or null when it is missing, unreadable or holds something unusable. */
export function readDaemonInfo(root: string): DaemonInfo | null {
	try {
		const info = JSON.parse(readFileSync(join(root, DAEMON_FILE), "utf8")) as DaemonInfo;
		if (typeof info.pid !== "number" || typeof info.port !== "number" || typeof info.token !== "string") return null;
		return info;
	} catch {
		return null;
	}
}

export async function startFlypiDaemon(options: DaemonOptions): Promise<DaemonHandle> {
	const log = options.log ?? ((line: string) => console.log(line));
	// Named once: it goes in the health page, the pid file and the server's own version banner, and a
	// daemon that reported three different versions would be a bug nobody could see.
	const version = options.version ?? "dev";
	const paths = options.paths;
	const queue = new JobQueue(options.db);

	// A claim still held at startup belongs to a process that is gone; leaving it locked would keep that
	// kind of job out of the queue forever (`queueJob` will not re-queue an open one).
	const reclaimed = queue.releaseStaleClaims();
	if (reclaimed > 0) log(`flypi: released ${reclaimed} job claim(s) left by a dead process`);

	// The other half of crash recovery: a turn left `running` finished nowhere. Say which ones. That is the
	// backend's record, not the memory store's — see src/server/run-store.ts.
	const interrupted = options.runs.reconcileInterrupted();
	if (interrupted.length > 0) log(`flypi: ${interrupted.length} turn(s) were interrupted by the previous shutdown: ${interrupted.join(", ")}`);

	// A stale index is queued as a job by reading it, which is the point: the daemon fixes it when idle.
	const identity = options.store.indexIdentity();
	if (identity.stale > 0) log(`flypi: ${identity.stale} stored vectors are not from ${identity.expected?.model ?? "the configured model"} — memory.reembed is queued`);

	// A fresh install has no agent dir at all, and a missing config file reads as a broken install
	// (`could not read …: ENOENT`) rather than as what it is: no model configured yet. Writing the empty pair
	// turns that into the answer the settings panel can act on — an empty list with an add button — and a new
	// conversation then names the half that is still missing.
	const blank = ensureAgentConfig(paths);
	if (blank.length > 0) log(`flypi: wrote ${blank.join(" and ")} — no model is configured yet (the Settings tab adds one)`);

	const endpoint = memoryEndpoint(paths);
	// The vault is in the memory database, so the daemon — the process that already owns that file — is the
	// process that can write it: `flypi secret put` from another process only reads the same tables, and the
	// sessions started here redact against what is in them (docs/secrets.md Phase 5.5). `write: true` on the
	// handle it already holds is what lets a `saveSecrets` from the web UI land here rather than being refused
	// as a read-only process; without it the Secrets tab can list and redact and never store.
	const vault = openSecretVault(paths, { db: options.db, write: true });
	const drift = vault.keyDrift();
	if (drift.stale > 0 && !drift.reencryptQueued) {
		options.store.queueJob(REENCRYPT_JOB, { payload: { reason: `${drift.stale} secret(s) sealed under an older key` } });
		log(`flypi: ${drift.stale} secret(s) are still sealed under an older key — secrets.reencrypt is queued`);
	}
	// The port and token the agent's own `mcp.json` names, so the daemon cannot be listening on one port
	// while `recall()` connects to another. Absent in the file means the server picks its own.
	const memoryOptions = { store: options.store, token: endpoint.token, principal: "daemon" };
	let memory: MemoryServerHandle;
	// Naming the port in that file makes a later run bind that port again, and an ephemeral port can be
	// someone else's by then. That one failure is recoverable — and an entry pointing at a port nothing
	// answers on is exactly the silent breakage this path exists to prevent, so the file is corrected too.
	let moved = false;
	try {
		memory = await startMemoryServer({ ...memoryOptions, port: endpoint.port });
	} catch (error) {
		if (endpoint.port === undefined || (error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
		log(`flypi: ${paths.mcpPath} names port ${endpoint.port}, which something else already holds — binding another port`);
		memory = await startMemoryServer(memoryOptions);
		moved = true;
	}
	// The port and token above live only in this process until they are in the file the agent reads, so a
	// fresh install — which has no agent dir at all — gets one here, after the bind, saying where the server
	// actually is. An existing entry is left alone: the file is the source of truth, not this process.
	let adopted = false;
	try {
		adopted = ensureMemoryEntry(paths, memory.port, memory.token);
		// Only the url, and only when the port it named was taken: the token, the exposure and everything
		// else in the entry are the operator's, and rewriting one of those is how a `${VAR}` reference
		// becomes a plaintext secret.
		if (moved) applyConfigEdits(paths, { mcpServers: [{ name: "flypi-memory", url: `http://127.0.0.1:${memory.port}/mcp` }] });
	} catch (error) {
		// A file that will not parse belongs to the operator to fix; the daemon still serves everything else.
		log(`flypi: cannot write the flypi-memory entry: ${(error as Error).message}`);
	}
	if (adopted) log(`flypi: wrote the flypi-memory entry in ${paths.mcpPath} — the agent will see the memory tools`);
	// Anything else the file gets wrong is not ours to fix, and the note says which half is missing.
	if (endpoint.note && !adopted) log(`flypi: ${endpoint.note}`);

	const registry = new SessionRegistry({
		root: paths.root,
		createSession: options.createSession,
		onRunStatus: (conversationId, status, info) => options.runs.setRunStatus(conversationId, status, info),
		vault,
	});

	const startedAt = new Date().toISOString();
	const serverOptions: FlypiServerOptions = {
		registry,
		...(options.host ? { host: options.host } : {}),
		token: options.token,
		uiDir: options.uiDir,
		serverVersion: version,
		health: () => {
			// The stamp, not a fresh check: `/healthz` is polled by launchd/systemd and must not reach the
			// network, and it is how `flypi status` and the page report an update without a round trip.
			const stamp = readUpdateCheck(paths.root);
			const newer = updateAvailable(stamp, version);
			const ready = stagedUpdate(stamp, version);
			return {
				pid: process.pid,
				startedAt: startedAt,
				version,
				memoryPort: memory.port,
				jobs: queue.queued(),
				...(newer ? { updateAvailable: newer } : {}),
				...(ready ? { updateReady: ready } : {}),
			};
		},
		scheduler: () => queue.snapshot(),
		secrets: secretsApi(vault, paths),
		// The Memory tab (docs/memory.md Phase 6). This process owns the memory database, so it is the one
		// that can write what the browser edits — the same reason the vault is opened here with `write: true`.
		memory: memoryApi(options.store, options.db),
		interruptedRun: (sessionFile) => options.runs.interruptedFor(sessionFile),
		// The page's "install now": the same path the idle rule takes, without the wait.
		installUpdate: () => installStaged(),
	};
	let server: FlypiServerHandle;
	// The same rule as the memory port above, and the reason the pid file is written after the bind rather
	// than from the requested flags: what the file names has to be the port that is actually answering.
	try {
		server = await startFlypiServer({ ...serverOptions, port: options.port });
	} catch (error) {
		if (!options.portMayMove || options.port === undefined || (error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
		log(`flypi: port ${options.port} — the one an earlier start used — is already taken; binding another, and \`flypi status\` says where`);
		server = await startFlypiServer(serverOptions);
	}

	const infoPath = join(paths.root, DAEMON_FILE);
	const info: DaemonInfo = {
		pid: process.pid,
		host: server.host,
		port: server.port,
		token: server.token,
		memoryPort: memory.port,
		startedAt,
		version,
	};
	// 0600: the file carries the token that guards the agent server.
	writeFileSync(infoPath, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });

	// Is a newer flypi published, and is its package downloaded? After the bind, so a daemon that is not
	// listening yet is not waiting on a network it may not have, and fire-and-forget, because a registry that
	// cannot be reached is never a startup failure. A checkout is not an installed package: it updates with
	// git, and the registry has never heard of it. Downloading is not installing — see `updatePass`.
	const pkg = packageInfo();
	// One check at a time: the job loop's first pass runs immediately, while the start-of-daemon check is
	// still waiting on the registry.
	let checking = false;
	const checkUpdates = async () => {
		if (checking) return;
		checking = true;
		try {
			const previous = readUpdateCheck(paths.root);
			const stamp = await checkForUpdate({ current: version, name: pkg.name });
			// A package already on disk stays unless the step it was fetched for has changed.
			stamp.download = keepDownload(stamp, previous);
			if (stamp.next && stamp.dist && !stamp.download) {
				const downloaded = await downloadUpdate({ root: paths.root, version: stamp.next, dist: stamp.dist });
				if (downloaded.file) stamp.download = { version: stamp.next, file: downloaded.file, at: new Date().toISOString() };
				else log(`flypi: ${stamp.next} is available but could not be downloaded: ${downloaded.error}`);
			}
			writeUpdateCheck(paths.root, stamp);
			const step = updateAvailable(stamp, version);
			if (step) {
				// One step, and the reader is told when more than one is waiting: the ladder is walked a release
				// at a time so each version's own schema upgrade runs against the schema it expects.
				const further = stamp.latest && isNewer(step, stamp.latest) ? `; one step at a time — ${stamp.latest} is the newest published` : "";
				log(`flypi: ${step} is available — this is ${version}; ${stamp.download ? "downloaded, and it installs the next time the daemon is idle (`flypi update` does it now)" : "not downloaded — `flypi update` installs it"}${further}`);
			} else if (stamp.error) log(`flypi: no update check: ${stamp.error}`);
		} finally {
			checking = false;
		}
	};

	// Install the downloaded package and restart through the CLI — the same path `flypi restart` takes, so the
	// port and interface carry over and the shutdown is the normal one (pid file removed, sockets closed, a
	// turn that was running left interrupted). The CLI stops this process, so the daemon does not exit here.
	let installRefused = false;
	const installPackage = (to: string, file: string): string | null => {
		if (installRefused) return "this process is not the npm global package — install it yourself";
		if (!isGlobalInstall()) {
			// Say it once: the running code is not what `npm install -g` would replace, so installing would
			// land somewhere else and the restart would come back on this version.
			installRefused = true;
			return "this process is not the npm global package — install it yourself";
		}
		log(`flypi: installing ${to} from ${file} — it restarts itself to run it`);
		const npm = spawn("npm", installArgs(file), { stdio: "ignore" });
		// Both listeners, or a missing `npm` on a launchd/systemd PATH is an unhandled `error` event — which
		// would take the daemon down on the spot, the one thing an update attempt must never do.
		npm.on("error", (error) => log(`flypi: the install could not start: ${error.message} — staying on ${version}`));
		npm.on("exit", (code) => {
			if (code !== 0) {
				log(`flypi: the install failed (npm exited ${code}) — staying on ${version}, and it will try again after the next idle stretch`);
				return;
			}
			const cli = spawn(process.execPath, [resolve(packageDir(), "scripts", "flypi.mjs"), "--root", paths.root, "restart"], { detached: true, stdio: "ignore" });
			cli.on("error", (error) => log(`flypi: ${to} is installed, but the restart could not start: ${error.message}`));
			cli.unref();
			// Forget the answer: the version that comes back builds its own ladder from where it now stands,
			// so the next step is one step, not the rest of an older answer.
			clearUpdateCheck(paths.root);
		});
		return null;
	};

	// What the page's "install now" asks for: the staged package, or the newest published one if the daily
	// check has not fetched it yet. Same guards, no idle wait — someone is attached, which is exactly the state
	// the idle rule will not restart in, so this restart is asked for rather than stumbled into.
	const installStaged = async (): Promise<string | null> => {
		let stamp = readUpdateCheck(paths.root);
		if (stamp?.next && stamp.dist && !stagedUpdate(stamp, version)) {
			// "Now" can arrive before the daily check has fetched the package: fetch the step, not the top of
			// the ladder.
			const downloaded = await downloadUpdate({ root: paths.root, version: stamp.next, dist: stamp.dist });
			if (downloaded.file) {
				stamp = { ...stamp, download: { version: stamp.next, file: downloaded.file, at: new Date().toISOString() } };
				writeUpdateCheck(paths.root, stamp);
			}
		}
		const staged = stagedUpdate(stamp, version);
		if (!staged) return "there is nothing downloaded to install — and the registry named no package to fetch";
		if (!stamp?.download?.file) return "the downloaded update is not on disk any more";
		return installPackage(staged, stamp.download.file);
	};

	// One pass of the update rule, from the job loop: re-check when the answer is stale, and install when the
	// package is on disk and the daemon has been idle for a stretch — the sweep's idle (no page attached, no
	// turn in flight) held for IDLE_BEFORE_INSTALL_MS, so a brief lull is never a restart.
	let idleSince = 0;
	// The same idle stretch installs extension packages (src/agent/packages.ts). They need no restart — the code
	// is loaded per conversation — so the one difference is what happens afterwards: the conversations that are
	// open are reloaded instead of the process.
	let updatingPackages = false;
	const updatePackages = async (sources: string[]) => {
		if (updatingPackages) return;
		updatingPackages = true;
		try {
			await applyPackageEdits(paths, { update: sources });
			// The stamp is emptied for what was applied; the next day's check answers again from scratch. A source
			// pi refuses to move (a pinned version, a registry that is down) stays recorded and is tried again.
			writePackageCheck(paths.root, { checkedAt: new Date().toISOString(), updates: [] });
			await registry.reloadExtensions();
			log(`flypi: updated ${sources.length} extension package(s): ${sources.join(", ")}`);
		} catch (error) {
			log(`flypi: the extension update failed: ${(error as Error).message} — it will try again after the next idle stretch`);
		} finally { updatingPackages = false; }
	};
	const checkPackages = async () => {
		const check = await checkPackageUpdates(paths);
		writePackageCheck(paths.root, check);
		if (check.error) log(`flypi: no extension update check: ${check.error}`);
		else if (check.updates.length) log(`flypi: ${check.updates.length} extension package(s) have updates — ${check.updates.join(", ")}; they install the next time the daemon is idle`);
	};
	const updatePass = (idle: boolean) => {
		const stamp = readUpdateCheck(paths.root);
		const pkgStamp = readPackageCheck(paths.root);
		// A checkout is not an installed package, but the extensions it loads are: only flypi's own ladder is
		// skipped there.
		if (!pkg.checkout && dueForCheck(stamp)) void checkUpdates();
		if (dueForPackageCheck(pkgStamp)) void checkPackages();
		const staged = pkg.checkout ? null : stagedUpdate(stamp, version);
		const pending = pkgStamp?.updates ?? [];
		if ((!staged && pending.length === 0) || !idle) {
			idleSince = 0;
			return;
		}
		if (!idleSince) idleSince = Date.now();
		if (Date.now() - idleSince < IDLE_BEFORE_INSTALL_MS) return;
		// Packages first: they need no restart, and the flypi install below may take this process away.
		if (pending.length) void updatePackages(pending);
		if (staged && stamp?.download?.file) installPackage(staged, stamp.download.file);
		// Start the clock again either way: a failed install retries after another idle stretch, not every pass.
		idleSince = 0;
	};
	if (!pkg.checkout) void checkUpdates();
	if (dueForPackageCheck(readPackageCheck(paths.root))) void checkPackages();

	const handlers: Record<string, JobHandler> = {
		// The kinds this build can run. `secrets.reencrypt` landed in Phase 5.5; `memory.consolidate` and
		// `wiki.render` are Phase 6 — one line each in this map, and the queue needs nothing else.
		"memory.reembed": async () => {
			const result = await options.store.reembed();
			// A new vector space is a different set of near pairs, so the merge pass runs again over it
			// (docs/memory.md Phase 6: "re-run the merge pass after every `memory.reembed`"). Queued, not run
			// inline: a sweep belongs to the same idle moment the re-embed did.
			options.store.queueJob(CONSOLIDATE_JOB, { payload: { reason: "the vectors changed: near pairs are a different set now" } });
			return `re-embedded ${result.embedded.length}, skipped ${result.skipped.length}${result.skipped.length ? `: ${result.skipped.map((row) => `#${row.id} ${row.why}`).join("; ")}` : ""}`;
		},
		"memory.consolidate": () => {
			const sweep = consolidate(options.store);
			// The wiki is a projection of what the sweep left behind, so it is re-rendered after a sweep and
			// not on every write (docs/memory.md Phase 6).
			options.store.queueJob(WIKI_JOB);
			// The operator-facing line (`job_runs.detail` is what a person reads when a sweep ran), so a pass
			// that found nothing to do says that instead of "merged 0 cluster(s) into nothing".
			return `${sweep.merges.length ? `merged ${sweep.merges.length} cluster(s) into ${sweep.merges.map((merge) => `#${merge.survivor}`).join(", ")}` : "nothing to merge"}; promoted ${sweep.promotions.length}; rows ${sweep.rowsBefore} → ${sweep.rowsAfter}`;
		},
		"wiki.render": () => {
			const wiki = renderWiki(options.store, options.db);
			return `rendered ${wiki.pages} page(s), ${wiki.sections} section(s)`;
		},
		"secrets.reencrypt": async () => {
			const result = vault.reencrypt();
			return `re-sealed ${result.rows} secret(s) under v${result.keyVersion}`;
		},
	};
	// A job is bookkeeping: it runs while nothing else is happening, and a pass that throws is a
	// `failed` row in `job_runs`, not a restarted daemon.
	const stopJobs = startJobLoop(queue, handlers, {
		intervalMs: options.jobIntervalMs,
		// The sweep's trigger, on flypi's conditions rather than a 3am cron (docs/memory.md Phase 6): the
		// daemon is idle — no page attached and no turn in flight — and either enough rows have arrived since
		// the last pass or the last one is a day old. A desktop app is off at 3am some nights, so a cron
		// would simply not run.
		beforePass: () => {
			// The update rule and the sweep's trigger ask the same question — is the daemon idle? — so one
			// answer per pass. The update installs only after a stretch of that idle (src/daemon/update.ts).
			const idle = server.clients() === 0 && options.runs.runningTurns() === 0;
			updatePass(idle);
			const state = options.store.sweepState();
			if (!sweepDue({ ...state, at: new Date().toISOString(), idle })) return;
			options.store.queueJob(CONSOLIDATE_JOB, { payload: { reason: `${state.newRows} row(s) since the last sweep${state.lastSweepAt ? `, last ${state.lastSweepAt}` : ", never swept"}` } });
		},
		onPass: (ran) => ran.forEach((attempt) => log(`flypi: job ${attempt.kind} ${attempt.status}${attempt.detail ? `: ${attempt.detail}` : ""}`)),
	});

	return {
		port: server.port,
		memoryPort: memory.port,
		token: server.token,
		url: server.url,
		jobs: queue,
		close: async () => {
			stopJobs();
			// The vault shares this database handle, so its redaction wiring goes with it.
			vault.close();
			registry.dispose();
			await server.close();
			await memory.close();
			rmSync(infoPath, { force: true });
		},
	};
}

/** Is the built UI there? `npm run build` first; a daemon without it is headless, which is allowed. */
export function builtUi(root: string): string | undefined {
	const dir = join(root, "dist", "ui");
	return existsSync(dir) ? dir : undefined;
}
