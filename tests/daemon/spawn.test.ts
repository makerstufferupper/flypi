/**
 * What the daemon asks an external command to do (`src/daemon/spawn.ts`, docs/architecture.md Phase 7 and
 * `.scratch/docs/deepening.md` §11.5 / T34): the argv of the pi switch, the `npm install -g` and the CLI
 * restart, whether each child is detached from this process, and how a command that never started is
 * reported.
 *
 * The argv rows go through the factory's injected `run`, which is the whole reason the spawner is injectable:
 * a test must read what `npm` would be told without the suite running `npm install -g` on the machine running
 * it. So the only children this file starts are `runCommand`'s own, with `process.execPath` or a name that
 * cannot exist: nothing here runs `npm install -g`, `npm root -g`, a restart or a pi switch — the factory's
 * default `global` is compared as a value, never called. The decisions behind those commands — which tarball
 * installs, when a restart is allowed — are `update-policy.ts` and asserted in
 * `tests/daemon/update-policy.test.ts`; this file owns the effects.
 *
 * The rows after those are the same seam from the other side: a daemon started with the spawner it was handed,
 * asked over its own socket to move pi and to install now. Asked to *install*, a checkout gets past the guards —
 * `installStaged` deliberately drops the `checkout` guard (`index.ts`) — so the install band is assertable here
 * and nowhere else in the suite: which tarball the daemon fetches, the one it hands `install`, the restart that
 * follows only a clean exit, the sentences it logs, and the refusal that latches. Asked to move pi, a checkout
 * refuses before the recorder is consulted (`pkg.checkout ||`, `index.ts`), so that row's `calls` assertion
 * proves nothing started — not that the recorder was reached.
 *
 * Those rows stub the registry instead of reaching it: every URL answers with the same tarball bytes and is
 * recorded, so "it fetched" and "it did not fetch" are counted requests for one URL. The recorder replaces every
 * command, which is what keeps the promise above true for them too — and the band is driven over a real socket
 * with `installUpdate`, the page's "install now", because that is the only route to it a checkout can reach.
 */
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flypiPaths } from "../../src/agent/paths.ts";
import { startFlypiDaemon } from "../../src/daemon/index.ts";
import { daemonSpawn, runCommand, type DaemonSpawn, type SpawnResult } from "../../src/daemon/spawn.ts";
import { isGlobalInstall, readUpdateCheck, writeUpdateCheck, type UpdateCheck, type UpdateDist } from "../../src/daemon/update.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import type { ClientCommand, ServerFrame } from "../../src/server/protocol.ts";
import { openRunStore } from "../../src/server/run-store.ts";
import { openTempFileDb, wordEmbedder } from "../helpers/memory-db.ts";
import { stubCreateSession, toolTurn } from "../helpers/flypi-harness.ts";
import { createTempFlypiRoot } from "../helpers/flypi-root.ts";

/** The package the daemon runs from — the same value `index.ts` hands the factory. */
const pkg = resolve(import.meta.dirname, "..", "..");

/** A daemon root with the one directory the pi child's log needs, which the real paths always create. */
const tempRoot = () => {
	const root = mkdtempSync(join(tmpdir(), "flypi-spawn-"));
	mkdirSync(join(root, ".flypi"), { recursive: true });
	return root;
};

/** One child the injected `run` was handed. */
type Call = { command: string; args: string[]; options?: { detached?: boolean; fd?: number; cwd?: string } };

/** A WS client small enough to read: connect, send a command, wait for the frame that answers it. */
async function connect(url: string, token: string) {
	const socket = new WebSocket(`${url}/?token=${encodeURIComponent(token)}`);
	const frames: ServerFrame[] = [];
	socket.on("message", (raw) => frames.push(JSON.parse(String(raw)) as ServerFrame));
	await new Promise<void>((settled, reject) => {
		socket.once("open", () => settled());
		socket.once("error", reject);
	});
	return {
		send: (command: ClientCommand) => socket.send(JSON.stringify(command)),
		next: (match: (frame: ServerFrame) => boolean, timeoutMs = 15_000) =>
			new Promise<ServerFrame>((settled, reject) => {
				const until = Date.now() + timeoutMs;
				const poll = () => {
					const found = frames.find(match);
					if (found) return settled(found);
					if (Date.now() > until) return reject(new Error(`no frame matched; saw ${JSON.stringify(frames.map((frame) => frame.type))}`));
					setTimeout(poll, 20);
				};
				poll();
			}),
		close: () =>
			new Promise<void>((settled) => {
				socket.once("close", () => settled());
				socket.close();
			}),
	};
}

/** A daemon that runs its external commands through the recorder instead of starting them, minus the models —
 *  the same shape `daemon.test.ts` starts one with. `version` is named by every install row: left to itself it is
 *  `"dev"`, which `compareVersions` reads as `0.0.0` (`update.ts`), and then the ladder in a stamp stops meaning
 *  anything. What the daemon logged comes back as `log`, because four rows are about those sentences. It does not
 *  close what it was handed, so this file closes the stores and the root it opened. */
async function daemonWith(over: { spawn?: DaemonSpawn; version?: string } = {}) {
	const root = createTempFlypiRoot();
	const db = openTempFileDb();
	const runs = openRunStore(flypiPaths(root));
	const log: string[] = [];
	const started = await startFlypiDaemon({
		paths: flypiPaths(root),
		db: db.db,
		store: new MemoryStore(db.db, wordEmbedder()),
		runs,
		jobIntervalMs: 5,
		version: over.version,
		log: (line) => {
			log.push(line);
		},
		spawn: over.spawn,
		createSession: stubCreateSession(root, toolTurn(), { authPath: join(root, ".flypi", "agent", "auth.json") }),
	});
	return {
		root,
		log,
		...started,
		dispose: async () => {
			await started.close();
			runs.close();
			db.dispose();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/** The real factory with its child-runner replaced, so the argv is readable and nothing is started. */
const spawner = (over: { result?: SpawnResult; global?: () => boolean } = {}) => {
	const root = tempRoot();
	const calls: Call[] = [];
	const spawned = daemonSpawn({
		root,
		packageDir: pkg,
		run: async (command, args, options) => {
			calls.push({ command, args, options });
			return over.result ?? { code: 0 };
		},
		...(over.global ? { global: over.global } : {}),
	});
	return { root, calls, spawn: spawned, done: () => rmSync(root, { recursive: true, force: true }) };
};

/** What the daemon's spawner was asked to do, in the order it was asked, and with which file. Every command is
 *  answered here, so nothing starts: `DaemonOptions.spawn` exists precisely so `npm install -g` is recorded. */
const recorder = (over: { global?: boolean; install?: SpawnResult; restart?: SpawnResult } = {}) => {
	const calls: string[] = [];
	/** The file each `install` was handed, so which tarball installs is asserted rather than inferred. */
	const files: string[] = [];
	const spawn: DaemonSpawn = {
		global: () => {
			calls.push("global");
			return over.global ?? true;
		},
		usePi: async (version) => {
			calls.push(`usePi ${version}`);
			return { code: 0 };
		},
		install: async (file) => {
			calls.push("install");
			files.push(file);
			return over.install ?? { code: 0 };
		},
		restart: async () => {
			calls.push("restart");
			return over.restart ?? { code: 0 };
		},
	};
	return { spawn, calls, files };
};

/** One tarball's bytes, and the sha1 a registry would have published with them. `downloadUpdate` refuses a
 *  manifest with no checksum to verify against (`update.ts`), so a row that wants a download to land has to
 *  answer that gate with its own checksum rather than by leaving it out. */
const TARBALL = Buffer.from("the flypi package, as the registry served it\n");
const SHASUM = createHash("sha1").update(TARBALL).digest("hex");

/** The registry, answering every URL with those bytes and recording each URL it was asked for — so "it fetched"
 *  and "it did not fetch" are counted requests for one tarball, not an inference.
 *
 *  A row that expects none is not trusting luck: the job loop's `stagePackages` pass runs in these daemons and
 *  reaches the same global `fetch` through `publishedVersions` (`packages.ts`), but that asks only about
 *  *configured* extension sources and a fresh root configures none — measured: one call per daemon, zero URLs
 *  recorded. The day a default config names an npm extension, the empty-`urls` rows would have to filter this
 *  list to the tarball host instead. */
function stubRegistry(): string[] {
	const urls: string[] = [];
	vi.stubGlobal("fetch", (url: string | URL) => {
		urls.push(String(url));
		return Promise.resolve({ ok: true, arrayBuffer: async () => TARBALL } as unknown as Response);
	});
	return urls;
}

/** The stub is per-row, because it replaces the `fetch` the daemon's own checks would otherwise use. Nothing in
 *  these rows asks `/healthz`, which is the one read a stubbed `fetch` would answer wrongly; the socket is a
 *  different transport and is unaffected. */
afterEach(() => {
	vi.unstubAllGlobals();
});

/** The `dist` npm publishes for one version, named by the URL that tarball is fetched from. */
const dist = (version: string): UpdateDist => ({
	tarball: `https://registry.npmjs.org/@makerstufferupper/flypi/-/flypi-${version}.tgz`,
	shasum: SHASUM,
});

/** The stamp the daily check leaves behind, so a row names only the rung it is about. */
const stampWith = (over: Partial<UpdateCheck> = {}): UpdateCheck => ({
	checkedAt: new Date().toISOString(),
	current: "0.1.0",
	latest: "0.2.0",
	next: "0.2.0",
	dist: dist("0.2.0"),
	...over,
});

/** Where `downloadUpdate` writes a fetched tarball: `.flypi/updates`, under the tarball URL's own basename. */
const fetched = (root: string, version: string) => join(root, ".flypi", "updates", `flypi-${version}.tgz`);

/** A package already on disk, with the stamp entry that names it — what the daily check would have left. */
function stagedOnDisk(root: string, version: string): { version: string; file: string; at: string } {
	mkdirSync(join(root, ".flypi", "updates"), { recursive: true });
	const file = fetched(root, version);
	writeFileSync(file, TARBALL);
	return { version, file, at: new Date().toISOString() };
}

/** Poll for what the ack precedes. The recorder's `install` resolves at once, so the restart and the forgotten
 *  stamp land a microtask after the socket's reply; a bare `expect` there passes only on a fast machine. */
async function waitFor(done: () => boolean, what: string) {
	const until = Date.now() + 1_000;
	while (!done()) {
		if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
		await new Promise((settled) => setTimeout(settled, 10));
	}
}

describe("one child, run to the end", () => {
	it("reports a command that is not on this PATH instead of dying on it", async () => {
		// The crash the npm child's `error` listener exists to prevent: an ENOENT with no listener is an
		// unhandled `error` event, which would take the daemon down in the middle of an update.
		const result = await runCommand("flypi-not-a-command-zz", []);
		expect(result.code).toBeNull();
		expect(result.error).toContain("ENOENT");
	});

	it("answers with the code the child exited with, and nothing else", async () => {
		// Only `code`: every child this daemon runs has its stdio switched off, so a `stdout` field would be
		// a string no caller could ever read.
		expect(await runCommand(process.execPath, ["-e", "process.exit(7)"])).toEqual({ code: 7 });
	});

	it("still answers for a child detached from this process", async () => {
		// The restart and the pi switch are detached — they are the processes that survive this one — and the
		// caller that logs what happened still needs the answer.
		expect(await runCommand(process.execPath, ["-e", "process.exit(0)"], { detached: true })).toEqual({ code: 0 });
	});

	it("appends the child's output to the log fd it was given", async () => {
		// The pi switch's own output belongs in `.flypi/daemon.log`: that is the file `flypi pi use` reads
		// back when a candidate does not come up — and a crash, a tsx load failure and pi's own refusal all
		// arrive on stderr, so both streams have to reach the fd.
		const root = tempRoot();
		try {
			const file = join(root, ".flypi", "daemon.log");
			const fd = openSync(file, "a");
			expect(await runCommand(process.execPath, ["-e", "console.log('flypi: pi moved'); console.error('flypi: the candidate did not come up')"], { fd })).toEqual({ code: 0 });
			closeSync(fd);
			const text = readFileSync(file, "utf8");
			expect(text).toContain("flypi: pi moved");
			expect(text).toContain("flypi: the candidate did not come up");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("runs the child in the directory it was given", async () => {
		// The pi switch runs from the installed package — that is where its tsx and its module graph are.
		const root = tempRoot();
		try {
			const dir = mkdtempSync(join(tmpdir(), "flypi-spawn-cwd-"));
			const file = join(root, ".flypi", "daemon.log");
			const fd = openSync(file, "a");
			expect(await runCommand(process.execPath, ["-e", "console.log(process.cwd())"], { cwd: dir, fd })).toEqual({ code: 0 });
			closeSync(fd);
			// macOS keeps temp dirs behind `/private`, so compare what the child resolved rather than the string.
			expect(realpathSync(readFileSync(file, "utf8").trim())).toBe(realpathSync(dir));
			rmSync(dir, { recursive: true, force: true });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("the commands the daemon runs", () => {
	it("moves pi through the same CLI path `flypi pi use` takes, from the package, into the daemon log", async () => {
		const s = spawner();
		try {
			// The log a failed candidate is read back from already holds what came before, so the fd the switch
			// is handed has to be opened for append — opened for write it truncates it on every pi switch.
			const log = join(s.root, ".flypi", "daemon.log");
			appendFileSync(log, "flypi: an earlier candidate\n");
			await s.spawn.usePi("1.5.0");
			expect(s.calls).toHaveLength(1);
			const call = s.calls[0]!;
			expect(call.command).toBe(process.execPath);
			expect(call.args).toEqual(["--import", "tsx", resolve(pkg, "scripts", "pi.ts"), "--root", s.root, "use", "1.5.0"]);
			// The child resolves `scripts/pi.ts` and its own tsx from the package it runs from.
			expect(call.options?.cwd).toBe(pkg);
			// The fd is the daemon's log, built from the root it was given.
			const fd = call.options?.fd;
			if (typeof fd !== "number") throw new Error(`the pi child writes to the daemon log, saw ${String(fd)}`);
			writeSync(fd, "flypi: pi moved\n");
			closeSync(fd);
			const text = readFileSync(log, "utf8");
			expect(text).toContain("flypi: pi moved");
			expect(text).toContain("flypi: an earlier candidate");
		} finally {
			s.done();
		}
	});

	it("installs the file it just verified, not a version string it re-resolves", async () => {
		const s = spawner();
		try {
			await s.spawn.install("/root/.flypi/updates/flypi-0.2.0.tgz");
			expect(s.calls[0]!.command).toBe("npm");
			expect(s.calls[0]!.args).toEqual(["install", "-g", "--no-audit", "--no-fund", "/root/.flypi/updates/flypi-0.2.0.tgz"]);
		} finally {
			s.done();
		}
	});

	it("restarts through the CLI, so the port and interface carry over", async () => {
		const s = spawner();
		try {
			await s.spawn.restart();
			expect(s.calls[0]!.command).toBe(process.execPath);
			expect(s.calls[0]!.args).toEqual([resolve(pkg, "scripts", "flypi.mjs"), "--root", s.root, "restart"]);
		} finally {
			s.done();
		}
	});

	it("detaches the children that outlive it, and not the one whose exit code it reads", async () => {
		// `npm` must stay in this process's group — the daemon is the one that decides whether to restart from
		// its exit code — while the pi switch and the restart have to survive the shutdown they cause.
		const s = spawner();
		try {
			await s.spawn.usePi("1.5.0");
			await s.spawn.install("/root/.flypi/updates/flypi-0.2.0.tgz");
			await s.spawn.restart();
			expect(s.calls.map((call) => call.options?.detached)).toEqual([true, undefined, true]);
		} finally {
			s.done();
		}
	});

	it("answers with how the command ended, so the caller can say what happened", async () => {
		// The daemon's three sentences are made of this value (`the install could not start: …`).
		const s = spawner({ result: { code: null, error: "spawn npm ENOENT" } });
		try {
			expect(await s.spawn.install("/root/.flypi/updates/flypi-0.2.0.tgz")).toEqual({ code: null, error: "spawn npm ENOENT" });
		} finally {
			s.done();
		}
	});

	it("answers npm's global-package question through the default `global`", () => {
		// The wiring, not npm's answer: `isGlobalInstall()` is false for four different reasons — no npm, a
		// non-zero exit, an empty output, or genuinely not the global package (`update.ts:228-231`) — so
		// asserting `false` here passed on a machine with no npm and would go red the day this suite runs from
		// a real global install. What this file owns is that the default *is* that function, and that the
		// override replaces it — the way `PiSwitchDeps` carries `global` for the same reason (`pi.ts`).
		expect(daemonSpawn({ root: "/flypi-not-a-root", packageDir: pkg }).global).toBe(isGlobalInstall);
		const s = spawner({ global: () => true });
		try {
			expect(s.spawn.global).not.toBe(isGlobalInstall);
			expect(s.spawn.global()).toBe(true);
		} finally {
			s.done();
		}
	});
});

describe("the daemon asked to move pi", () => {
	it("refuses in a checkout, and starts nothing through the spawner it was given", async () => {
		// The seam from the outside: a daemon built with `DaemonOptions.spawn` answers the page's pi switch
		// with the refusal a checkout gives — the sentence a person reads (docs/pi-upgrades.md Phase 8.4),
		// unchanged by the child moving into `spawn.ts`. The accepted path needs `checkout: false`, which is
		// T41's seam, so this row stops at the refusal and says that nothing started — `pkg.checkout` is guarded
		// before the spawner's `usePi` is called.
		const { spawn, calls } = recorder();
		const d = await daemonWith({ spawn });
		const client = await connect(d.url, d.token);
		try {
			client.send({ type: "usePi", version: "1.5.0", requestId: "r1" });
			const refused = await client.next((frame) => (frame.type === "result" || frame.type === "error") && frame.requestId === "r1");
			expect(refused).toMatchObject({
				type: "error",
				message: "this flypi is not the npm global package — in a checkout, `npm install @earendil-works/pi-coding-agent@X && npm test && npm run smoke`; in a container, rebuild the image",
			});
			expect(calls).toEqual([]);
		} finally {
			await client.close();
			await d.dispose();
		}
	});
});
/** One row of the install band: a daemon running `version` whose external commands are the recorder, the stamp
 *  written into its own root, the registry stubbed, and a socket open for the page's "install now". */
async function band(over: { version: string; stamp: (root: string) => UpdateCheck | null; global?: boolean; install?: SpawnResult; restart?: SpawnResult }) {
	const urls = stubRegistry();
	const rec = recorder(over);
	const d = await daemonWith({ spawn: rec.spawn, version: over.version });
	const stamp = over.stamp(d.root);
	if (stamp) writeUpdateCheck(d.root, stamp);
	const client = await connect(d.url, d.token);
	return { d, rec, urls, log: d.log, client, close: async () => { await client.close(); await d.dispose(); } };
}

/** The page's "install now", asked over the socket, and the frame that answers it. `installUpdate` is the only
 *  route to the install band that a checkout can reach — `updatePolicy` will not emit an install where `.git`
 *  sits next to the code — and the ack goes out before the restart closes this socket. */
async function installNow(client: Awaited<ReturnType<typeof connect>>, requestId: string) {
	client.send({ type: "installUpdate", requestId });
	return client.next((frame) => (frame.type === "result" || frame.type === "error") && frame.requestId === requestId);
}

describe("the daemon asked to install now", () => {
	it("answers that nothing is downloaded when the stamp names no package to fetch", async () => {
		// `next` without a `dist` is a step with nothing to download, so there is neither a fetch nor an install
		// and the person asking gets the sentence rather than a restart.
		const { rec, urls, client, close } = await band({ version: "0.1.0", stamp: () => stampWith({ dist: undefined }) });
		try {
			expect(await installNow(client, "r1")).toMatchObject({ type: "error", requestId: "r1", message: "there is nothing downloaded to install — and the registry named no package to fetch" });
			expect(urls).toEqual([]);
			expect(rec.calls).toEqual([]);
		} finally {
			await close();
		}
	});

	it("installs the package it fetched, restarts, and forgets the answer", async () => {
		// `latest` is deliberately a rung above `next`: what gets fetched is the step above this version, never the
		// top of the ladder, and an answer that fetched `latest` would ask for a different tarball and fail below.
		const { d, rec, urls, log, client, close } = await band({ version: "0.1.0", stamp: () => stampWith({ latest: "0.3.0", download: undefined }) });
		try {
			expect(await installNow(client, "r1")).toMatchObject({ type: "result", requestId: "r1" });
			// The ack precedes the restart, and the recorder's `install` resolves at once, so what follows the
			// reply is a microtask deep and has to be polled for.
			await waitFor(() => rec.calls.includes("restart"), "the restart that follows a clean install");
			expect(urls).toEqual([dist("0.2.0").tarball]);
			expect(rec.calls).toEqual(["global", "install", "restart"]);
			// The file, not a version string the install would re-resolve: what was verified is what installs.
			const file = fetched(d.root, "0.2.0");
			expect(rec.files).toEqual([file]);
			expect(log).toContain(`flypi: installing 0.2.0 from ${file} — it restarts itself to run it`);
			// The answer is forgotten: the version that comes back builds its own ladder from where it stands.
			await waitFor(() => readUpdateCheck(d.root) === null, "the stamp to be forgotten after the step");
		} finally {
			await close();
		}
	});

	it("fetches the rung the registry named when the download on disk is not a step", async () => {
		// The ladder as an effect. This process runs 0.2.0 and 0.2.0 is what sits on disk, so that package is not
		// a step at all and 0.3.0 — the rung the registry named — is what "install now" has to fetch. The rule
		// this replaced asked only "is there some tarball" and so fetched nothing here, answering "there is
		// nothing downloaded to install" while the registry had named a package one rung up. `packageToFetch`
		// asks whether the one on disk is a step, which is a question about `current`.
		const { d, rec, urls, client, close } = await band({
			version: "0.2.0",
			stamp: (root) => stampWith({ latest: "0.3.0", next: "0.3.0", dist: dist("0.3.0"), download: stagedOnDisk(root, "0.2.0") }),
		});
		try {
			expect(await installNow(client, "r1")).toMatchObject({ type: "result", requestId: "r1" });
			await waitFor(() => rec.calls.includes("install"), "the install of the fetched 0.3.0");
			expect(urls).toEqual([dist("0.3.0").tarball]);
			expect(rec.files).toEqual([fetched(d.root, "0.3.0")]);
		} finally {
			await close();
		}
	});

	it("installs the step already on disk instead of refetching it", async () => {
		// The same stamp one rung lower: here the 0.2.0 on disk IS a step above 0.1.0, so nothing is fetched for a
		// restart and the registry's 0.3.0 stays unrequested — one rung at a time (`update-policy.ts`), as an
		// effect rather than as data.
		const { d, rec, urls, client, close } = await band({
			version: "0.1.0",
			stamp: (root) => stampWith({ latest: "0.3.0", next: "0.3.0", dist: dist("0.3.0"), download: stagedOnDisk(root, "0.2.0") }),
		});
		try {
			expect(await installNow(client, "r1")).toMatchObject({ type: "result", requestId: "r1" });
			await waitFor(() => rec.calls.includes("install"), "the install of the staged 0.2.0");
			expect(urls).toEqual([]);
			expect(rec.files).toEqual([fetched(d.root, "0.2.0")]);
		} finally {
			await close();
		}
	});

	it("does not restart after an install that failed", async () => {
		const { d, rec, log, client, close } = await band({ version: "0.1.0", install: { code: 1 }, stamp: () => stampWith({ download: undefined }) });
		try {
			expect(await installNow(client, "r1")).toMatchObject({ type: "result", requestId: "r1" });
			// Either answer ends the install: the sentence, or the restart that only a clean exit is allowed. Waiting
			// for both means a daemon that restarted anyway says so below instead of merely running out of patience.
			await waitFor(() => rec.calls.includes("restart") || log.some((line) => line.startsWith("flypi: the install failed")), "a failed install to be answered");
			// A restart onto the code a failed install left half-written is what the sentence exists to promise will
			// not happen.
			expect(rec.calls).toEqual(["global", "install"]);
			const file = fetched(d.root, "0.2.0");
			expect(log).toContain(`flypi: installing 0.2.0 from ${file} — it restarts itself to run it`);
			expect(log).toContain("flypi: the install failed (npm exited 1) — staying on 0.1.0, and it will try again after the next idle stretch");
			// And the download is not forgotten: the next idle stretch tries it again.
			expect(readUpdateCheck(d.root)?.download?.version).toBe("0.2.0");
		} finally {
			await close();
		}
	});

	it("does not restart after an install that never started", async () => {
		// `npm` missing from a launchd/systemd PATH is an `error` on the child, not a crash and not an exit: the
		// daemon stays where it was and says so (`spawn.ts`'s `runCommand` is what turns it into this answer).
		const { rec, log, client, close } = await band({ version: "0.1.0", install: { code: null, error: "spawn npm ENOENT" }, stamp: () => stampWith({ download: undefined }) });
		try {
			expect(await installNow(client, "r1")).toMatchObject({ type: "result", requestId: "r1" });
			// Both sentences begin the same way, and either one means the daemon reached the install's answer; the
			// assertion below is about which of the two it was.
			await waitFor(() => log.some((line) => line.startsWith("flypi: the install ")), "the install to be answered");
			expect(log).toContain("flypi: the install could not start: spawn npm ENOENT — staying on 0.1.0");
			expect(rec.calls).toEqual(["global", "install"]);
		} finally {
			await close();
		}
	});

	it("says the install worked when only the restart failed", async () => {
		const { rec, log, client, close } = await band({ version: "0.1.0", restart: { code: null, error: "spawn node ENOENT" }, stamp: () => stampWith({ download: undefined }) });
		try {
			expect(await installNow(client, "r1")).toMatchObject({ type: "result", requestId: "r1" });
			await waitFor(() => log.some((line) => line.startsWith("flypi: 0.2.0 is installed, but the restart could not start:")), "the restart-failed sentence");
			expect(rec.calls).toEqual(["global", "install", "restart"]);
			// Two different failures, two different sentences: the new code is installed and the person has to
			// know the running process is still the old one.
			expect(log).toContain("flypi: 0.2.0 is installed, but the restart could not start: spawn node ENOENT");
		} finally {
			await close();
		}
	});

	it("refuses twice, and asks the global-package question once", async () => {
		const { rec, urls, client, close } = await band({ version: "0.1.0", global: false, stamp: () => stampWith({ download: undefined }) });
		try {
			expect(await installNow(client, "r1")).toMatchObject({ type: "error", requestId: "r1", message: "this process is not the npm global package — install it yourself" });
			expect(rec.calls).toEqual(["global"]);
			expect(rec.files).toEqual([]);
			// The latch, and the recorder is what proves it: the second ask answered the same sentence without
			// asking the question again. And this is the row that proves `options.spawn` is the spawner in use —
			// with the real one the recorder would be silent, because a checkout is not the global package.
			expect(await installNow(client, "r2")).toMatchObject({ type: "error", requestId: "r2", message: "this process is not the npm global package — install it yourself" });
			expect(rec.calls).toEqual(["global"]);
		} finally {
			await close();
		}
	});

	it("leaves no raw child in the daemon's own file, or anywhere but the spawner", () => {
		// `grep -c 'spawn(' src/daemon/index.ts` as an assertion: the daemon's children all go through
		// `src/daemon/spawn.ts` now. `daemonSpawn(` and `spawnSync(` do not match `spawn(` at all — the first is
		// capitalised, the second is a different call — so what is left is the one raw child in the module.
		const dir = resolve(import.meta.dirname, "..", "..", "src", "daemon");
		const code = (file: string) =>
			readFileSync(join(dir, file), "utf8")
				.split("\n")
				// Comment lines are prose about the shape the code used to have: `update-policy.ts`'s header still
				// names the `spawn("npm", …)` callback this band came out of, in the past tense.
				.filter((line) => line.includes("spawn(") && !/^\s*(?:\/\/|\/?\*)/.test(line));
		expect(code("index.ts")).toEqual([]);
		const files = [...new Set(readdirSync(dir).filter((name) => name.endsWith(".ts")).flatMap((name) => (code(name).length ? [name] : [])))];
		expect(files).toEqual(["spawn.ts"]);
	});
});
