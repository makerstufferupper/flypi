/**
 * The daemon's external commands, in one place (docs/architecture.md Phase 7, docs/pi-upgrades.md Phase 8.4,
 * `.scratch/docs/deepening.md` §11.5 / T34): the pi version switch, the `npm install -g` of a package it
 * already downloaded, the CLI restart that follows it, and the one question npm has to answer before any of
 * them — is this process the global package at all.
 *
 * Each command used to be a `spawn` call written inside the request handler that needed it, so nothing could
 * say what a child was asked to do without starting it. That mattered because a checkout has `.git` next to
 * the code, so `packageInfo().checkout` is true and `updatePolicy` never emits an install in a test: the
 * install band had no caller the suite could reach, and a change to *which tarball installs* left every test
 * green (T33's mutation P4, `tests/daemon/update-policy.test.ts`). Here the argv is a value a test reads, and
 * the effect is one function that can be replaced.
 *
 * `runCommand` exists for the `error` listener: a command that is not on a launchd/systemd PATH emits an
 * `error` event and no `exit`, and an unhandled one takes the daemon down in the middle of an update — the
 * exact failure the comment on the old npm child warned about. So a command that never started is a
 * `SpawnResult` like any other, and the caller keeps its process and says what happened.
 *
 * `run` and `global` are overridable for the same reason `PiSwitchDeps` carries `install`, `probe` and
 * `global` (`pi.ts`): the suite must read what `npm install -g` would be told without running it on the
 * machine running the tests, and a checkout and a container both refuse while the test suite is a checkout.
 * What the children are *for* stays where it was decided; this module only starts them.
 */
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { resolve } from "node:path";
import { installArgs, isGlobalInstall } from "./update.ts";

/** How an external command ended: the code it exited with, or why it never started. */
export interface SpawnResult {
	code: number | null;
	error?: string;
}

/** How the child is started: detached from this process's group so it survives the shutdown it causes, its
 *  output appended to an already-open log fd, and the directory it runs from. */
export interface RunOptions {
	detached?: boolean;
	fd?: number;
	cwd?: string;
}

/** One child, run to the end. The `error` listener is the whole point: a command that is not on this
 *  process's PATH is a result, not an unhandled `error` event, which would take the daemon down. */
export function runCommand(command: string, args: string[], options: RunOptions = {}): Promise<SpawnResult> {
	return new Promise((settled) => {
		const child = spawn(command, args, {
			...(options.detached ? { detached: true } : {}),
			...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
			stdio: options.fd !== undefined ? ["ignore", options.fd, options.fd] : "ignore",
		});
		child.on("error", (error) => settled({ code: null, error: error.message }));
		child.on("exit", (code) => settled({ code }));
		// A detached child is the one that outlives this process; keeping it referenced would keep the CLI
		// that is trying to restart the daemon waiting on a child that has nothing left to say it.
		if (options.detached) child.unref();
	});
}

/** The daemon's commands, one method each. */
export interface DaemonSpawn {
	/** Is the running code the global package `npm install -g` would replace? Nothing installs when it is not. */
	global(): boolean;
	/** Move pi to a published version and restart, through the same CLI path `flypi pi use` takes. */
	usePi(version: string): Promise<SpawnResult>;
	/** Install a package the daemon already downloaded and verified. */
	install(file: string): Promise<SpawnResult>;
	/** Ask the CLI to restart the daemon, so the port and interface carry over. */
	restart(): Promise<SpawnResult>;
}

export interface DaemonSpawnOptions {
	/** The daemon's root — where `.flypi/daemon.log` and the child's `--root` argument come from. */
	root: string;
	/** The installed package the child scripts are run from: `scripts/pi.ts`, `scripts/flypi.mjs`. */
	packageDir: string;
	/** Overridable so a test reads the argv without the suite running `npm install -g` on this machine. */
	run?: (command: string, args: string[], options?: RunOptions) => Promise<SpawnResult>;
	/** Overridable because a checkout and a container both refuse, and the test suite is a checkout. */
	global?: () => boolean;
}

/** The real one: the daemon's commands, built from the root it owns and the package it runs from. */
export function daemonSpawn(options: DaemonSpawnOptions): DaemonSpawn {
	const run = options.run ?? runCommand;
	const { root, packageDir } = options;
	return {
		global: options.global ?? isGlobalInstall,
		usePi: (version) =>
			run(
				process.execPath,
				["--import", "tsx", resolve(packageDir, "scripts", "pi.ts"), "--root", root, "use", version],
				// From the package, so the child picks the tsx and the module graph this package installed;
				// into the daemon's own log, which is where a candidate that did not start is read back from.
				{ cwd: packageDir, detached: true, fd: openSync(resolve(root, ".flypi", "daemon.log"), "a") },
			),
		// Not detached: the daemon reads this one's exit code and only restarts once it exited cleanly.
		install: (file) => run("npm", installArgs(file)),
		restart: () => run(process.execPath, [resolve(packageDir, "scripts", "flypi.mjs"), "--root", root, "restart"], { detached: true }),
	};
}
