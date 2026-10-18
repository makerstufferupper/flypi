#!/usr/bin/env node
/**
 * `flypi start | stop | restart | status | logs` — the daemon CLI (docs/architecture.md Phase 4.5).
 *
 * No dependency and no service manager needed, and no port arbitration either: the daemon picks its own
 * port, then says so in `.flypi/daemon.json` (0600 — it carries the token). The CLI's job is to start it
 * detached, wait until `/healthz` answers, and report the URL you would otherwise have to dig out of a log.
 *
 *   node scripts/flypi.mjs start [--foreground]   # or: npm run flypi -- start
 *   node scripts/flypi.mjs status | stop | restart | logs [-n 50] [-f]
 *   node scripts/flypi.mjs update [--check]        # the newest published flypi (docs/architecture.md Phase 7)
 *
 * `--root DIR` (or FLYPI_ROOT) picks which `.flypi/` the CLI owns; in a checkout it defaults to the cwd,
 * and the installed `bin/flypi.mjs` sets FLYPI_ROOT to the home directory before importing this.
 */
import { mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
// `--root DIR` is accepted anywhere in the line and taken out before the subcommand is read: children are
// handed `--root` explicitly, so a subcommand like `secret` must not see it twice.
const rootAt = argv.indexOf("--root");
const rootFlag = rootAt === -1 ? undefined : argv.splice(rootAt, 2)[1];
const root = resolve(rootFlag ?? process.env.FLYPI_ROOT ?? process.cwd());
// The checkout the script lives in, which is where `tsx` and the app's imports resolve from. `--root` is
// how the daemon is told which `.flypi/` to own: they are not the same directory when the CLI is run with
// FLYPI_ROOT from somewhere else.
const checkout = resolve(fileURLToPath(import.meta.url), "..", "..");
const serveDaemon = resolve(fileURLToPath(import.meta.url), "..", "serve-daemon.ts");
const secretCli = resolve(fileURLToPath(import.meta.url), "..", "secret.ts");
const updateCli = resolve(fileURLToPath(import.meta.url), "..", "update.ts");
const infoPath = resolve(root, ".flypi", "daemon.json");
const logPath = resolve(root, ".flypi", "daemon.log");
/**
 * The port and interface the last start was *named* with, kept next to the pid file and left there when the
 * daemon stops. A clean stop removes the pid file, so without this a bare `flypi start` after `flypi stop`
 * picks a new ephemeral port and invalidates the URL every bookmark and every published Docker port uses.
 * No token in it, so no `0600`.
 */
const flagsPath = resolve(root, ".flypi", "daemon-flags.json");

/**
 * A pid file is only evidence if the process is still there; `kill(pid, 0)` asks without stopping it. That
 * answer is not enough on its own: it succeeds on a zombie, and a container whose PID 1 does not reap
 * (`docker run` without `--init`) leaves a killed daemon's entry in the process table for the life of the
 * container — so `status` called it "running" and `start` called it "already running", forever, over a pid
 * file the daemon never got to remove. Where `/proc` is readable the state says whether it is a process or a
 * corpse; elsewhere (macOS, Windows) `kill(pid, 0)` is the only evidence there is, and launchd/Windows reap
 * what they orphan, so a lingering zombie is not the case there.
 */
const alive = (pid) => {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	try {
		// `<pid> (comm) <state> …`, and `comm` can hold spaces and parentheses — hence the last `)`, not the first.
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
	} catch {
		return true;
	}
};

/**
 * Flags `flypi start` hands to the daemon. `--port`/`--host` because a detached daemon is otherwise
 * unreachable by number or by interface: it picks an ephemeral port, and a published Docker port cannot
 * reach the container's own loopback. `--embeddings none`/`--judge none` because they are the difference
 * between a first run that downloads ~1 GB of ONNX models and one that comes up keyword-only in seconds.
 *
 * `carried` is the daemon that was just stopped, the stale pid file a crashed one left, or the flags file a
 * previous start wrote. A bare `flypi restart` or a bare `flypi start` means "that daemon again", so the port
 * and interface it was reached by carry over — forgetting them moves a container's daemon off its published
 * port with nothing to explain the dead URL.
 * The memory flags do not carry over: the settings file is the persistent place for those, and the flags
 * are the one-off override of it.
 */
const flagValue = (name) => {
	const i = argv.indexOf(name);
	return i === -1 ? undefined : argv[i + 1];
};
const daemonFlags = (carried) => {
	// A port named on this command line is a demand: a container's published port is useless on another
	// number, so the daemon has to fail loudly rather than move. A port carried over from an earlier start
	// is a preference, so `--port-may-move` lets it bind another one instead of dying on `EADDRINUSE`.
	const named = flagValue("--port");
	const port = named ?? carried?.port;
	const host = flagValue("--host") ?? carried?.host;
	return [
		...(port === undefined ? [] : ["--port", String(port), ...(named === undefined ? ["--port-may-move"] : [])]),
		...(host === undefined ? [] : ["--host", String(host)]),
		...["--embeddings", "--judge"].flatMap((name) => (flagValue(name) ? [name, flagValue(name)] : [])),
	];
};

const readJson = (file) => {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return null;
	}
};

const readInfo = () => readJson(infoPath);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function health(port) {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/healthz`);
		return response.ok ? await response.json() : null;
	} catch {
		return null;
	}
}

/**
 * Echo what the daemon has written since it was spawned. A first run fetches ~1 GB of memory models before
 * it is listening, and a silent wait is indistinguishable from a hang; `logFrom` is the log's size at spawn,
 * so an earlier run's lines are not replayed.
 */
const echoLog = (from) => {
	try {
		const text = readFileSync(logPath, "utf8");
		if (text.length > from) process.stdout.write(text.slice(from));
		return text.length;
	} catch {
		return from;
	}
};

// Generous, because the thing it waits on is a download: the models are ~1 GB on a machine that has never
// run flypi. A child that exits is reported immediately, so this only ever costs time on a real hang.
const STARTUP_TIMEOUT_MS = 15 * 60_000;
async function waitForStartup(stalePid, died, logFrom, timeoutMs = STARTUP_TIMEOUT_MS) {
	const until = Date.now() + timeoutMs;
	let shown = logFrom;
	while (Date.now() < until) {
		shown = echoLog(shown);
		const info = readInfo();
		if (info && info.pid !== stalePid && alive(info.pid)) {
			// The health page is the proof it is serving, not just spawned. Loading the memory models can
			// take a moment, so this is a poll rather than one attempt.
			const status = await health(info.port);
			if (status) return { info, status };
		}
		// A child that has already exited is not going to answer: report the log now, do not make the user
		// wait out the model-loading timeout to find out the process never started.
		if (died() !== null) return null;
		await sleep(200);
	}
	return null;
}

function report(info, status) {
	console.log(`flypi: running (pid ${info.pid}) — root ${root}`);
	console.log(`flypi: agent   http://${info.host}:${info.port}  (token ${info.token})`);
	console.log(`flypi: memory  http://127.0.0.1:${info.memoryPort}/mcp`);
	if (status) console.log(`flypi: started ${status.startedAt}, version ${status.version}, ${status.jobs} job(s) queued`);
	// The daemon's own daily answer (src/daemon/update.ts) — `status` does not reach the network itself.
	if (status?.updateAvailable) console.log(`flypi: ${status.updateAvailable} is available — \`flypi update\` installs it`);
	if (status?.updateReady) console.log(`flypi: ${status.updateReady} is downloaded — it installs once the daemon has been idle`);
}

async function start({ foreground = false, previous } = {}) {
	const existing = readInfo();
	if (existing && alive(existing.pid)) {
		report(existing, await health(existing.port));
		console.log("flypi: already running — `flypi restart` to restart it");
		return 0;
	}
	// A file left by a dead process would otherwise be mistaken for the daemon we are about to start.
	if (existing) rmSync(infoPath, { force: true });
	// Most recent word wins: the daemon being restarted, the stale pid file a crash left, then the flags a
	// previous start named and nothing has removed since.
	const carried = previous ?? existing ?? readJson(flagsPath);
	const flags = daemonFlags(carried);
	// The `.flypi/` directory is created here, not assumed: on a machine that has never run flypi, `--root`
	// has no `.flypi/` in it yet, and neither the log nor the flags file would open.
	mkdirSync(dirname(logPath), { recursive: true });
	// Only a start that names them writes the file — an ephemeral port the daemon picked is not worth making
	// sticky — and it merges, so naming just `--port` does not drop an `--host` that is still in force.
	const namedFlags = { ...(flagValue("--port") ? { port: Number(flagValue("--port")) } : {}), ...(flagValue("--host") ? { host: flagValue("--host") } : {}) };
	if (Object.keys(namedFlags).length > 0) writeFileSync(flagsPath, `${JSON.stringify({ ...readJson(flagsPath), ...namedFlags })}\n`);
	if (foreground) {
		const child = spawn(process.execPath, ["--import", "tsx", serveDaemon, "--root", root, ...flags], { cwd: checkout, stdio: "inherit" });
		return new Promise((done) => child.on("exit", (code) => done(code ?? 0)));
	}
	// The log's directory is created above, not assumed.
	const log = openSync(logPath, "a");
	const logFrom = statSync(logPath).size;
	const child = spawn(process.execPath, ["--import", "tsx", serveDaemon, "--root", root, ...flags], { cwd: checkout, detached: true, stdio: ["ignore", log, log] });
	child.unref();
	let exitCode = null;
	child.once("exit", (code) => {
		exitCode = code ?? 0;
	});
	console.log(`flypi: starting (pid ${child.pid}) — log: ${logPath}`);
	const started = await waitForStartup(existing?.pid, () => exitCode, logFrom);
	if (!started) {
		const why = exitCode === null ? `no /healthz within ${Math.round(STARTUP_TIMEOUT_MS / 60_000)} minutes` : `it exited (code ${exitCode}) before it was listening`;
		console.error(`flypi: ${why}. Last log lines:\n${tail(logPath, 20)}`);
		return 1;
	}
	report(started.info, started.status);
	return 0;
}

const tail = (file, lines) => {
	try {
		return readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-lines).join("\n");
	} catch {
		return "(no log yet)";
	}
};

async function stop() {
	const info = readInfo();
	if (!info || !alive(info.pid)) {
		console.log("flypi: not running");
		return 0;
	}
	// SIGTERM, and the daemon's own shutdown: stop the loop, close the sockets, remove its pid file. A
	// turn that was running is left as `interrupted` for the next start to report — never re-run.
	process.kill(info.pid, "SIGTERM");
	// The proof it stopped is the record it removes on the way out, not the process table: `kill(pid, 0)`
	// succeeds on a zombie, and a container whose PID 1 does not reap (`docker run` without `--init`) leaves a
	// cleanly-shut-down daemon sitting there — so the old check called a clean stop a failure.
	const stopped = () => !alive(info.pid) || readInfo() === null;
	for (let waited = 0; waited < 10_000 && !stopped(); waited += 100) await sleep(100);
	console.log(stopped() ? "flypi: stopped" : `flypi: pid ${info.pid} did not stop — kill it if you must`);
	return 0;
}

async function status() {
	const info = readInfo();
	if (!info) {
		console.log(`flypi: no ${infoPath} — never started, or it stopped and cleaned up after itself`);
		return 1;
	}
	if (!alive(info.pid)) {
		console.log(`flypi: not running (pid ${info.pid} is gone; it died or was killed) — the file is left so you can see where`);
		return 1;
	}
	report(info, await health(info.port));
	return 0;
}

function logs({ lines = 40, follow = false } = {}) {
	console.log(tail(logPath, lines));
	if (!follow) return 0;
	const child = spawn("tail", ["-f", logPath], { stdio: "inherit" });
	return new Promise((done) => child.on("exit", (code) => done(code ?? 0)));
}

/**
 * `flypi secret …` (docs/secrets.md Phase 5.5). Run as a child for the same reason `start --foreground`
 * is: the app is TypeScript, and this script is plain node so the daemon CLI works without a build.
 * stdio is inherited so a value can be piped in and never appear in the argument list.
 */
async function secret(args) {
	const child = spawn(process.execPath, ["--import", "tsx", secretCli, "--root", root, ...args], { cwd: checkout, stdio: "inherit" });
	return new Promise((done) => child.on("exit", (code) => done(code ?? 0)));
}

/**
 * `flypi update` (docs/architecture.md Phase 7): the newest published flypi, installed. Run as a child for
 * the same reason `secret` is — the app is TypeScript and this script is plain node. The child stops and
 * starts the daemon through this CLI, so the port/interface carry-over stays in one place.
 */
async function update(args) {
	const child = spawn(process.execPath, ["--import", "tsx", updateCli, "--root", root, ...args], { cwd: checkout, stdio: "inherit" });
	return new Promise((done) => child.on("exit", (code) => done(code ?? 0)));
}

const command = argv[0] ?? "status";
const flagNumber = (name) => {
	const i = argv.indexOf(name);
	return i === -1 ? undefined : Number(argv[i + 1]);
};
const result = await {
	start: () => start({ foreground: argv.includes("--foreground") }),
	stop,
	restart: async () => {
		// Read the pid file before stopping: the daemon removes it on the way out, and the port and interface
		// it was reached by are what a bare `flypi restart` has to reuse.
		const previous = readInfo();
		await stop();
		return start({ foreground: argv.includes("--foreground"), previous });
	},
	status,
	logs: () => logs({ ...(flagNumber("-n") ? { lines: flagNumber("-n") } : {}), follow: argv.includes("-f") || argv.includes("--follow") }),
	secret: () => secret(argv.slice(1)),
	update: () => update(argv.slice(1)),
}[command]?.();
if (result === undefined) {
	console.log("usage: flypi [--root DIR] start [--foreground] [--port N] [--host H] [--embeddings none] [--judge none] | stop | restart | status | logs [-n N] [-f] | update [--check] | secret …");
	process.exit(2);
}
process.exit(result);
