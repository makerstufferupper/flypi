/**
 * The daemon CLI (`node scripts/flypi.mjs …`, docs/architecture.md Phase 4.5). These run the real script
 * in a throwaway root, because the whole point of it is the process boundary: start it detached, find it
 * again through `/healthz` rather than a guessed port, and stop it cleanly enough that it removes its own
 * pid file.
 */
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DAEMON_FILE } from "../../src/daemon/index.ts";

const repo = resolve(import.meta.dirname, "../..");
const cli = join(repo, "scripts", "flypi.mjs");
const bin = join(repo, "bin", "flypi.mjs");

/** FTS-only memory: the daemon must come up in seconds, without downloading a model, for a test to wait on it. */
function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "flypi-cli-"));
	mkdirSync(join(root, ".flypi", "agent"), { recursive: true });
	writeFileSync(join(root, ".flypi", "agent", "settings.json"), JSON.stringify({ memory: { embeddings: { provider: "none" }, judge: { provider: "none" } } }));
	return root;
}

function flypi(root: string, ...args: string[]) {
	const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, env: { ...process.env, FLYPI_ROOT: root }, encoding: "utf8", timeout: 60_000 });
	return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** A pid no process can have: `kill(pid, 0)` says it is gone, which is what a dead daemon looks like. */
const DEAD_PID = 2_147_483_647;

/** A port nothing holds at that moment — the number a test can ask a daemon to bind and later squat on. */
async function freePort(): Promise<number> {
	const probe = createServer();
	probe.listen(0, "127.0.0.1");
	await once(probe, "listening");
	const port = (probe.address() as { port: number }).port;
	probe.close();
	return port;
}

/** The env without FLYPI_ROOT, so a test can tell the default from the override. */
const noRootEnv = () => {
	const env = { ...process.env };
	delete env.FLYPI_ROOT;
	return env;
};

/** The same shape as `flypi` above, for the cases that must control cwd and env themselves. */
function sh(script: string, cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) {
	const result = spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: "utf8", timeout: 30_000 });
	return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

describe("which .flypi/ a command owns", () => {
	it("defaults the checkout CLI to the cwd and the installed one to the home directory", () => {
		const root = tempRoot();
		writeFileSync(join(root, DAEMON_FILE), JSON.stringify({ pid: DEAD_PID, host: "127.0.0.1", port: 8787, token: "t", memoryPort: 8790, startedAt: "2026-10-12T09:00:00.000Z", version: "dev" }));
		try {
			// The checkout script, run from elsewhere: it found the cwd's root, not the home one.
			const cwd = sh(cli, root, noRootEnv(), "status");
			expect(cwd.code).toBe(1);
			expect(cwd.out).toMatch(/not running \(pid 2147483647 is gone/);

			// The published shim, run from the checkout: the same pid file is only reachable through the home
			// directory, so this is the new default being applied, not the cwd leaking through.
			const home = sh(bin, repo, { ...noRootEnv(), HOME: root, USERPROFILE: root }, "status");
			expect(home.code).toBe(1);
			expect(home.out).toMatch(/not running \(pid 2147483647 is gone/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("lets --root override both the default and FLYPI_ROOT", () => {
		const root = tempRoot();
		const other = tempRoot();
		writeFileSync(join(root, DAEMON_FILE), JSON.stringify({ pid: DEAD_PID, host: "127.0.0.1", port: 8787, token: "t", memoryPort: 8790, startedAt: "2026-10-12T09:00:00.000Z", version: "dev" }));
		try {
			// FLYPI_ROOT points at a root that has a pid file; --root points at one that has never run, and
			// the message names that second path.
			const flag = sh(cli, root, { ...noRootEnv(), FLYPI_ROOT: root }, "--root", other, "status");
			expect(flag.code).toBe(1);
			expect(flag.out).toContain(join(other, DAEMON_FILE));
			expect(flag.out).toMatch(/never started/);

			// Same through the shim, whose default the flag has to beat.
			const viaBin = sh(bin, repo, noRootEnv(), "--root", other, "status");
			expect(viaBin.code).toBe(1);
			expect(viaBin.out).toContain(join(other, DAEMON_FILE));
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(other, { recursive: true, force: true });
		}
	});
});

describe("the daemon CLI", () => {
	it("says which pi it runs, and refuses to move pi in a checkout", () => {
		const root = tempRoot();
		try {
			const listed = flypi(root, "pi", "list");
			expect(listed.code).toBe(0);
			expect(listed.out).toMatch(/pi \d+\.\d+\.\d+/);
			// A checkout has no pointer to move: it changes pi with npm and the suite, not with a symlink.
			const moved = flypi(root, "pi", "use", "9.9.9");
			expect(moved.code).toBe(1);
			expect(moved.out).toContain("not the npm global package");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("says what is not running, and why", () => {
		const root = tempRoot();
		try {
			// Never started: the honest answer is that there is nothing to read.
			const never = flypi(root, "status");
			expect(never.code).toBe(1);
			expect(never.out).toMatch(/no .*daemon\.json.* never started/);

			// A pid file whose process is gone: the file stays so you can see where it was listening.
			writeFileSync(join(root, DAEMON_FILE), JSON.stringify({ pid: DEAD_PID, host: "127.0.0.1", port: 8787, token: "t", memoryPort: 8790, startedAt: "2026-10-12T09:00:00.000Z", version: "dev" }));
			const dead = flypi(root, "status");
			expect(dead.code).toBe(1);
			expect(dead.out).toMatch(/not running \(pid 2147483647 is gone/);

			// `stop` on something that is not running is not an error.
			const stop = flypi(root, "stop");
			expect(stop.code).toBe(0);
			expect(stop.out).toMatch(/not running/);

			// Anything else is the usage, not a silent no-op.
			const unknown = flypi(root, "flibbertigibbet");
			expect(unknown.code).toBe(2);
			expect(unknown.out).toMatch(/usage: flypi \[--root DIR\] start/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("starts a daemon, finds it by health rather than by port, and stops it", async () => {
		const root = tempRoot();
		let started = false;
		try {
			const start = flypi(root, "start");
			started = true;
			// It waits for the daemon's own report instead of returning as soon as a child spawned.
			expect(start.code, start.out).toBe(0);
			expect(start.out).toMatch(/flypi: starting \(pid \d+\)/);
			const url = /flypi: agent\s+http:\/\/127\.0\.0\.1:(\d+)/.exec(start.out)?.[1];
			expect(url, start.out).toBeTruthy();

			const info = JSON.parse(readFileSync(join(root, DAEMON_FILE), "utf8")) as { pid: number; port: number; token: string; memoryPort: number; jobs?: number };
			expect([info.port, info.token.length > 0, info.memoryPort > 0]).toEqual([Number(url), true, true]);
			// It carries the agent server's token, so it is not world-readable.
			expect(statSync(join(root, DAEMON_FILE)).mode & 0o777).toBe(0o600);

			const status = flypi(root, "status");
			expect(status.code).toBe(0);
			expect(status.out).toContain(`pid ${info.pid}`);
			// The health page's own numbers, not the file's: version and what the queue holds.
			expect(status.out).toMatch(/version [\w.]+, \d+ job\(s\) queued/);

			// The log is where a detached daemon's output goes; `logs` is how you read it.
			const logs = flypi(root, "logs", "-n", "20");
			expect(logs.out).toContain("flypi: agent server");
			expect(logs.out).toContain("embeddings   none (FTS-only)");

			const stop = flypi(root, "stop");
			expect(stop.code, stop.out).toBe(0);
			expect(stop.out).toMatch(/flypi: stopped/);
			// Stopped means gone: no pid file, and nothing answering on that port.
			expect(() => readFileSync(join(root, DAEMON_FILE), "utf8")).toThrow();
			await expect(fetch(`http://127.0.0.1:${info.port}/healthz`)).rejects.toThrow();
		} finally {
			if (started) flypi(root, "stop");
			rmSync(root, { recursive: true, force: true });
		}
	}, 120_000);

	it("forwards --port and --host to the daemon, which is how a container reaches it", async () => {
		// A detached daemon otherwise picks an ephemeral port on loopback, and a published Docker port cannot
		// reach a container's loopback — so both have to be settable through the CLI.
		const root = mkdtempSync(join(tmpdir(), "flypi-bind-"));
		const port = await freePort();
		let started = false;
		try {
			const start = flypi(root, "start", "--port", String(port), "--host", "0.0.0.0", "--embeddings", "none", "--judge", "none");
			started = true;
			expect(start.code, start.out).toBe(0);
			const info = JSON.parse(readFileSync(join(root, DAEMON_FILE), "utf8")) as { port: number; host: string };
			expect(info.port).toBe(port);
			// The pid file carries the interface, so `status` reports the bind rather than the loopback default.
			expect(info.host).toBe("0.0.0.0");
			// 0.0.0.0 still answers loopback, which proves the bind without depending on this machine's networks.
			await expect(fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok)).resolves.toBe(true);
		} finally {
			if (started) flypi(root, "stop");
			rmSync(root, { recursive: true, force: true });
		}
	}, 120_000);

	it("start --foreground forwards a signal to the daemon, which is how a container stops it", async () => {
		// `docker stop` signals PID 1 — the CLI in foreground mode — not the daemon. If the wrapper does not
		// pass it on, the container is torn down around a daemon that never ran its own shutdown.
		const root = tempRoot();
		const port = await freePort();
		const child = spawn(process.execPath, [cli, "start", "--foreground", "--port", String(port), "--host", "127.0.0.1"], {
			cwd: root,
			env: { ...process.env, FLYPI_ROOT: root },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const out: string[] = [];
		child.stdout.on("data", (chunk) => out.push(String(chunk)));
		child.stderr.on("data", (chunk) => out.push(String(chunk)));
		try {
			const until = Date.now() + 60_000;
			while (Date.now() < until && !(await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok).catch(() => false))) {
				await new Promise((done) => setTimeout(done, 200));
			}
			// Foreground output goes to the terminal (`docker logs`), not to .flypi/daemon.log.
			expect(out.join(""), out.join("")).toContain("flypi: daemon pid");
			child.kill("SIGTERM");
			const [code] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
			expect(code).toBe(0);
			// The daemon removed its own pid file on the way out: the proof it got the signal rather than being
			// killed with the container.
			expect(() => readFileSync(join(root, DAEMON_FILE), "utf8")).toThrow();
			await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
		} finally {
			child.kill("SIGKILL");
			flypi(root, "stop");
			rmSync(root, { recursive: true, force: true });
		}
	}, 120_000);

	it("restart keeps the port and interface the last start asked for", async () => {
		// A bare `flypi restart` otherwise drops --port and --host, and in a container that moves the daemon
		// off the published port: the URL in the browser stops working and nothing on screen says why.
		const root = tempRoot(); // the settings file holds the memory models off, so both starts are fast
		const port = await freePort();
		let started = false;
		try {
			const start = flypi(root, "start", "--port", String(port), "--host", "0.0.0.0");
			started = true;
			expect(start.code, start.out).toBe(0);

			const restart = flypi(root, "restart");
			expect(restart.code, restart.out).toBe(0);
			const info = JSON.parse(readFileSync(join(root, DAEMON_FILE), "utf8")) as { port: number; host: string };
			expect([info.port, info.host]).toEqual([port, "0.0.0.0"]);
			await expect(fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok)).resolves.toBe(true);
		} finally {
			if (started) flypi(root, "stop");
			rmSync(root, { recursive: true, force: true });
		}
	}, 120_000);

	it("a bare start after a clean stop keeps the port and interface it was named with", async () => {
		// `restart` can read the pid file, but a clean stop removes it, so the flags have to live somewhere
		// that survives being stopped. Without that, `flypi stop` then `flypi start` moves the daemon to a new
		// ephemeral port and every bookmark — and every published Docker port — points at nothing.
		const root = tempRoot();
		const port = await freePort();
		let started = false;
		try {
			expect(flypi(root, "start", "--port", String(port), "--host", "0.0.0.0").code).toBe(0);
			started = true;
			expect(flypi(root, "stop").code).toBe(0);

			const again = flypi(root, "start");
			expect(again.code, again.out).toBe(0);
			const info = JSON.parse(readFileSync(join(root, DAEMON_FILE), "utf8")) as { port: number; host: string };
			expect([info.port, info.host]).toEqual([port, "0.0.0.0"]);
			await expect(fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok)).resolves.toBe(true);
		} finally {
			if (started) flypi(root, "stop");
			rmSync(root, { recursive: true, force: true });
		}
	}, 120_000);

	it("moves off a carried-over port someone else took, and fails loudly on one named today", async () => {
		// The port is sticky after a crash and after a stop, so the number in the flags file can belong to
		// another process by the next start. That is recoverable. A `--port` on this command line is not: a
		// container's published port is useless on a different number, so it has to fail rather than move.
		const root = tempRoot();
		const port = await freePort();
		const squatter = createServer();
		let started = false;
		try {
			expect(flypi(root, "start", "--port", String(port)).code).toBe(0);
			started = true;
			expect(flypi(root, "stop").code).toBe(0);
			await new Promise<void>((done) => squatter.listen(port, "127.0.0.1", () => done()));

			const moved = flypi(root, "start");
			expect(moved.code, moved.out).toBe(0);
			expect(moved.out).toMatch(/is already taken/);
			const info = JSON.parse(readFileSync(join(root, DAEMON_FILE), "utf8")) as { port: number };
			expect(info.port).not.toBe(port);
			// The pid file names the port that is really answering, which is what `status` and the UI use.
			await expect(fetch(`http://127.0.0.1:${info.port}/healthz`).then((r) => r.ok)).resolves.toBe(true);
			expect(flypi(root, "stop").code).toBe(0);

			const demanded = flypi(root, "start", "--port", String(port));
			expect(demanded.code, demanded.out).toBe(1);
			expect(demanded.out).toMatch(/EADDRINUSE/);
		} finally {
			squatter.close();
			if (started) flypi(root, "stop");
			rmSync(root, { recursive: true, force: true });
		}
	}, 120_000);

	it("reports a stop by the record the daemon removed, not by the process table", async () => {
		// A container whose PID 1 does not reap (`docker run` without `--init`) leaves a cleanly shut-down
		// daemon as a zombie, and `kill(pid, 0)` — what `alive()` asks — succeeds on a zombie. `flypi stop` used
		// to ask only that, so it told the user the daemon was still running and to kill it by hand, for a
		// daemon that had already closed everything and removed its own record.
		const root = tempRoot();
		const pidFile = join(root, DAEMON_FILE);
		// Stands in for that daemon: on SIGTERM it removes the record and stays in the process table.
		const holdout = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => require("node:fs").rmSync(process.argv[1], { force: true })); setInterval(() => {}, 1000);', pidFile], { detached: true, stdio: "ignore" });
		holdout.unref();
		writeFileSync(pidFile, JSON.stringify({ pid: holdout.pid, host: "127.0.0.1", port: 8787, token: "t", memoryPort: 8790, startedAt: "2026-10-17T09:00:00.000Z", version: "dev" }));
		const at = Date.now();
		try {
			const stop = flypi(root, "stop");
			expect(stop.code, stop.out).toBe(0);
			expect(stop.out).toMatch(/flypi: stopped/);
			// It answered on the record rather than waiting out the 10 s poll for a process that never leaves it.
			expect(Date.now() - at).toBeLessThan(5_000);
			expect(() => readFileSync(pidFile, "utf8")).toThrow();
		} finally {
			holdout.kill("SIGKILL");
			rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);

	it("starts on a root that has never been used, which is the first run of an installed package", async () => {
		// No `.flypi/` at all: the log's directory has to be created rather than assumed, and the memory models
		// have to be switchable off from the CLI — otherwise the first run downloads ~1 GB before it prints a URL.
		const root = mkdtempSync(join(tmpdir(), "flypi-first-"));
		let started = false;
		try {
			const start = flypi(root, "start", "--embeddings", "none", "--judge", "none");
			started = true;
			expect(start.code, start.out).toBe(0);
			expect(JSON.parse(readFileSync(join(root, DAEMON_FILE), "utf8")).pid).toBeGreaterThan(0);
			expect(flypi(root, "logs", "-n", "20").out).toContain("embeddings   none (FTS-only)");
		} finally {
			if (started) flypi(root, "stop");
			rmSync(root, { recursive: true, force: true });
		}
	}, 120_000);

	it("update refuses on a checkout, which is what this test runs from, and asks the registry nowhere", () => {
		// `.git` next to the code is the rule (src/daemon/update.ts): a checkout updates with git, and the
		// registry only knows what `npm publish` put there — so nothing is stopped and nothing is asked.
		const root = tempRoot();
		try {
			const answer = flypi(root, "update", "--check");
			expect(answer.code, answer.out).toBe(0);
			expect(answer.out).toMatch(/is a checkout at .* — update it with git/);
			expect(answer.out).toContain("git pull --ff-only");
			expect(existsSync(join(root, ".flypi", "update-check.json"))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("status reports the newer package the daemon found, from its stamp and not from the network", async () => {
		const root = tempRoot();
		let started = false;
		try {
			const start = flypi(root, "start");
			started = true;
			expect(start.code, start.out).toBe(0);
			// The stamp the daemon writes once a day, written by hand here: `status` has to report it without
			// reaching the registry itself, and `/healthz` is the only thing between the two.
			writeFileSync(join(root, ".flypi", "update-check.json"), JSON.stringify({ checkedAt: new Date().toISOString(), current: "0.1.0", latest: "99.9.9", next: "99.9.9", download: { version: "99.9.9", file: join(root, ".flypi", "updates", "flypi-99.9.9.tgz"), at: new Date().toISOString() } }));
			const status = flypi(root, "status").out;
			expect(status).toMatch(/99\.9\.9 is available — `flypi update` installs it/);
			expect(status).toMatch(/99\.9\.9 is downloaded — it installs once the daemon has been idle/);
		} finally {
			if (started) flypi(root, "stop");
			rmSync(root, { recursive: true, force: true });
		}
	}, 120_000);
});
