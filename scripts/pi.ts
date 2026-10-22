/**
 * `flypi pi …` — which pi this flypi runs, and how to move it (docs/pi-upgrades.md Phase 8.3).
 *
 *   flypi pi list                       the loaded version, the pin, and the trees on disk
 *   flypi pi available                  what the registry publishes, one rung at a time
 *   flypi pi use <version>              probe it, flip the pointer, restart, keep it only if it answers
 *   flypi pi rollback                   back to the pinned predecessor or the tree flypi shipped with
 *   flypi pi unpin                      put the installed pi back where npm put it
 *   flypi pi relink                     re-apply the pin after an upgrade dropped the link (run by `start`)
 *
 * Run through the CLI (`scripts/flypi.mjs` spawns this the way it spawns `update.ts`), because the flip has
 * to happen in a process that has not imported pi yet — the daemon resolves its module graph at import, so
 * it cannot re-pick its own pi.
 */
import { readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { readDaemonInfo } from "../src/daemon/index.ts";
import {
	bundledPiVersion,
	loadedPi,
	piTrees,
	readPiPin,
	piScope,
	scopeVersion,
	restoreBundledScope,
	relinkFromPin,
	switchPiVersion,
	PI_PACKAGE,
} from "../src/daemon/pi.ts";
import { checkForUpdate } from "../src/daemon/update.ts";

const argv = process.argv.slice(2);
const rootAt = argv.indexOf("--root");
const root = resolve(rootAt === -1 ? process.env.FLYPI_ROOT ?? process.cwd() : argv.splice(rootAt, 2)[1]!);
const command = argv[0] ?? "list";
const cli = resolve(import.meta.dirname, "flypi.mjs");

/**
 * Stop and start the daemon through the CLI, so the port and interface carry over as they always do — but
 * only when one is running. `flypi restart` on a stopped daemon *starts* it, which would turn "move pi" into
 * a first run: a new `.flypi/`, a model download, a server on a port nobody asked for.
 */
const restart = async (): Promise<void> => {
	if (!(await piFromHealth())) return;
	await new Promise<void>((done) => {
		const child = spawn(process.execPath, [cli, "--root", root, "restart"], { stdio: "inherit" });
		child.on("exit", () => done());
	});
};

/** What `/healthz` says about pi — null when no daemon is answering. */
const piFromHealth = async () => {
	const info = readDaemonInfo(root);
	if (!info) return null;
	try {
		return ((await (await fetch(`http://127.0.0.1:${info.port}/healthz`)).json()) as { pi?: { version: string; pinned: boolean; bundled?: string } }).pi ?? null;
	} catch {
		return null;
	}
};

/**
 * What the switch should believe about what is running: the daemon's own answer when one is up, and otherwise
 * what the pointer now says — the version the next process will load. Without the second half a switch made
 * while the daemon was stopped would be judged a failure and reverted.
 */
const piAfterSwitch = async (): Promise<{ version: string; pinned: boolean; bundled?: string } | null> => {
	const health = await piFromHealth();
	if (health) return health;
	const loaded = scopeVersion(piScope());
	return loaded ? { version: loaded, pinned: true } : null;
};

const logTail = () => {
	try {
		return readFileSync(resolve(root, ".flypi", "daemon.log"), "utf8").trimEnd().split("\n").slice(-20).join("\n");
	} catch {
		return "";
	}
};

const report = async ({ ok, message }: { ok: boolean; message: string }): Promise<number> => {
	console.log(message);
	return ok ? 0 : 1;
};

switch (command) {
	case "relink": {
		// `flypi start` runs this before it spawns the daemon: the daemon resolves pi at import, so the link
		// has to be right before it starts, not after.
		// Silent when there is nothing to say: `flypi start` runs this every time, and a line about a pin that
		// did nothing would be noise on every start of every machine that never pinned pi.
		const line = relinkFromPin(root, piScope());
		if (line) console.log(`flypi: ${line}`);
		break;
	}
	case "list": {
		const pi = loadedPi(root);
		const pin = readPiPin(root);
		console.log(`flypi: pi ${pi.version}${pi.pinned ? " (pinned)" : ""}${pi.bundled ? `, installed tree holds ${pi.bundled}` : ""}`);
		console.log(`flypi: trees on disk: ${piTrees(root).join(", ") || "none"}${bundledPiVersion(root) ? `; bundled ${bundledPiVersion(root)}` : ""}`);
		if (pin) console.log(`flypi: pinned to ${pin.version} since ${pin.pinnedAt}${pin.verified ? "" : " — never confirmed to have started"}`);
		break;
	}
	case "available": {
		// The same registry answer flypi's own ladder is built from, pointed at pi's package name: one rung at
		// a time, because a jump runs one version's session/config format change over a file the intermediate
		// version would have stepped.
		const current = loadedPi(root).version;
		const check = await checkForUpdate({ current, name: PI_PACKAGE });
		if (check.error) {
			console.log(`flypi: ${check.error}`);
			break;
		}
		console.log(`flypi: pi ${current} is running; the newest published is ${check.latest}`);
		console.log(`flypi: one rung at a time — ${check.next ? `flypi pi use ${check.next}` : "nothing newer than what is running"}`);
		break;
	}
	case "use": {
		const version = argv[1];
		if (!version) {
			console.log("flypi: `flypi pi use <version>` — `flypi pi available` lists what is published");
			process.exit(2);
		}
		process.exit(await report(await switchPiVersion(version, { root, scope: piScope(), restart, pi: piFromHealth, logTail })));
	}
	case "rollback": {
		const pin = readPiPin(root);
		const back = pin?.from ?? bundledPiVersion(root);
		if (!back) {
			console.log("flypi: nothing to roll back to — no pin, and the tree flypi was installed with is not on disk");
			process.exit(1);
		}
		process.exit(await report(await switchPiVersion(back, { root, scope: piScope(), restart, pi: piFromHealth, logTail })));
	}
	case "unpin": {
		const restored = restoreBundledScope(root, piScope());
		if (!restored.ok) {
			console.log(`flypi: ${restored.message}`);
			process.exit(1);
		}
		if (await piFromHealth()) spawnSync(process.execPath, [cli, "--root", root, "restart"], { stdio: "inherit" });
		console.log(`flypi: ${restored.message}; the pin is gone`);
		break;
	}
	default:
		console.log("usage: flypi pi [list | available | use <version> | rollback | unpin]");
		process.exit(2);
}
