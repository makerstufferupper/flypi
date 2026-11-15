/**
 * What the daemon asks an external command to do (`src/daemon/spawn.ts`, docs/architecture.md Phase 7 and
 * `.scratch/docs/deepening.md` §11.5 / T34): the argv of the pi switch, the `npm install -g` and the CLI
 * restart, whether each child is detached from this process, and how a command that never started is
 * reported.
 *
 * The argv rows go through the factory's injected `run`, which is the whole reason the spawner is injectable:
 * a test must read what `npm` would be told without the suite running `npm install -g` on the machine running
 * it. Only `runCommand` itself starts a real child, and only with `process.execPath` or a name that cannot
 * exist. The decisions behind those commands — which tarball installs, when a restart is allowed — are
 * `update-policy.ts` and asserted in `tests/daemon/update-policy.test.ts`; this file owns the effects.
 *
 * The last row is the seam from the other side: a daemon started with the spawner it was handed, asked over its
 * own socket to move pi — the one command of the three a checkout can be asked for, and it answers with the
 * refusal rather than with a child.
 */
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import { flypiPaths } from "../../src/agent/paths.ts";
import { startFlypiDaemon } from "../../src/daemon/index.ts";
import { daemonSpawn, runCommand, type DaemonSpawn, type SpawnResult } from "../../src/daemon/spawn.ts";
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
 *  the same shape `daemon.test.ts` starts one with. It does not close what it was handed, so this file closes
 *  the stores and the root it opened. */
async function daemonWith(spawn: DaemonSpawn) {
	const root = createTempFlypiRoot();
	const db = openTempFileDb();
	const runs = openRunStore(flypiPaths(root));
	const started = await startFlypiDaemon({
		paths: flypiPaths(root),
		db: db.db,
		store: new MemoryStore(db.db, wordEmbedder()),
		runs,
		jobIntervalMs: 5,
		log: () => {},
		spawn,
		createSession: stubCreateSession(root, toolTurn(), { authPath: join(root, ".flypi", "agent", "auth.json") }),
	});
	return {
		root,
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
		// back when a candidate does not come up.
		const root = tempRoot();
		try {
			const file = join(root, ".flypi", "daemon.log");
			const fd = openSync(file, "a");
			expect(await runCommand(process.execPath, ["-e", "console.log('flypi: pi moved')"], { fd })).toEqual({ code: 0 });
			closeSync(fd);
			expect(readFileSync(file, "utf8")).toContain("flypi: pi moved");
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
			expect(readFileSync(join(s.root, ".flypi", "daemon.log"), "utf8")).toContain("flypi: pi moved");
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

	it("asks npm whether this process is the global package, so a checkout refuses", () => {
		// The suite runs in a checkout, which is the answer a checkout gives (`update.test.ts` pins the same
		// fact about `isGlobalInstall`), and the override is how a test says yes — the way `PiSwitchDeps`
		// carries `global` for the same reason (`pi.ts`).
		const s = spawner({ global: () => true });
		try {
			expect(daemonSpawn({ root: "/flypi-not-a-root", packageDir: pkg }).global()).toBe(false);
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
		// T41's seam, so this row stops at the refusal and says that the recorder saw nothing at all.
		const calls: string[] = [];
		const recorder: DaemonSpawn = {
			global: () => {
				calls.push("global");
				return true;
			},
			usePi: async () => {
				calls.push("usePi");
				return { code: 0 };
			},
			install: async () => {
				calls.push("install");
				return { code: 0 };
			},
			restart: async () => {
				calls.push("restart");
				return { code: 0 };
			},
		};
		const d = await daemonWith(recorder);
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