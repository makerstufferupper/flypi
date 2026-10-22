/**
 * Which pi a flypi runs, and how it gets moved (docs/pi-upgrades.md Phase 8.1 and 8.3).
 *
 * The version is read off the module that was **loaded**, never off flypi's own `package.json`: the whole
 * point of the field is that those two can disagree. A checkout resolves pi from its lockfile, an installed
 * flypi resolves it from its own `node_modules`, and a pin chooses a third tree that is neither. It cannot be
 * read off a specifier either — pi's `exports` map does not publish `package.json`, so
 * `import.meta.resolve("…/package.json")` throws (docs/pi-upgrades.md C1); it is the entry's directory, twice
 * up.
 *
 * How the move works: `.flypi/pi/<version>/` holds a complete npm tree (npm resolved pi's sibling packages
 * and their dependencies, so Node resolves them the way the process that would run them does), and
 * `<package dir>/node_modules/@earendil-works` is a **symlink** at the chosen tree's scope directory. That
 * is why nothing in the resolution path has to change: `flypi start`, `npm run daemon`, the Docker `CMD`,
 * `probe` and the tests all resolve bare specifiers from the package dir and get the chosen pi with no flag,
 * no env var and no loader. The tree flypi shipped with is moved to `.flypi/pi/bundled/` the first time a
 * pin is applied — `.flypi/` is state, so a flypi upgrade neither erases it nor touches the pin.
 *
 * The switch is **provisional until the new process answers**: the link flips, the daemon restarts, and the
 * switch is kept only if `/healthz` reports the candidate version. Otherwise the link goes back and the
 * daemon starts again. This cannot be a web-UI feature — the page is served by the process being replaced
 * (docs/risks.md risk 13) — so the automatic half lives here, in the CLI restart path.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { checkPiCompat } from "../agent/pi-compat.ts";
import { CHECK_INTERVAL_MS, isGlobalInstall, packageDir } from "./update.ts";

/** The chosen pi, next to the trees it points at (`.flypi/pi/<version>/`). Written by `flypi pi use`. */
export const PI_PIN_FILE = join(".flypi", "pi", "pin.json");
/** The daemon's daily answer about published pi versions, next to the trees. The UI reads this stamp. */
export const PI_CHECK_FILE = join(".flypi", "pi-check.json");

/** What the daily check wrote. Shaped like flypi's own stamp (src/daemon/update.ts) on purpose. */
export interface PiCheck {
	checkedAt: string;
	latest: string | null;
	next: string | null;
	error?: string;
}

export function readPiCheck(root: string): PiCheck | null {
	try {
		return JSON.parse(readFileSync(join(root, PI_CHECK_FILE), "utf8")) as PiCheck;
	} catch {
		return null;
	}
}

export function writePiCheck(root: string, check: PiCheck): void {
	mkdirSync(join(root, PI_DIR), { recursive: true });
	writeFileSync(join(root, PI_CHECK_FILE), JSON.stringify(check, null, "	"));
}

/** Is the published answer stale? The daemon's day, the same rhythm as flypi's own and the extensions'. */
export function dueForPiCheck(check: PiCheck | null, now = Date.now()): boolean {
	if (!check?.checkedAt) return true;
	const at = Date.parse(check.checkedAt);
	return Number.isNaN(at) || now - at >= CHECK_INTERVAL_MS;
}

/** Where the trees live, and where the tree flypi shipped with goes when a pin takes over. */
export const PI_DIR = join(".flypi", "pi");
export const PI_BUNDLED = join(PI_DIR, "bundled");
/** The npm name of the pi family. The whole `@earendil-works` scope moves together, never one package. */
export const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/** What `.flypi/pi/pin.json` holds. `.flypi/` is state, so a flypi upgrade never touches it. */
export interface PiPin {
	/** The pi version the pin asks for. */
	version: string;
	/** The version the tree flypi shipped with held before the pin moved it — the way back. */
	from: string | null;
	pinnedAt: string;
	/** The candidate answered `/healthz` reporting this version, so the switch committed. */
	verified: boolean;
}

/** What `/healthz`, `hello` and `flypi status` say about pi. */
export interface PiInfo {
	/** The version of the pi module this process actually loaded. */
	version: string;
	/** A pin chose it, rather than the tree flypi was installed with. */
	pinned: boolean;
	/** What the tree flypi shipped with holds — present only when that is not what is running. */
	bundled?: string;
}

/** The pin, or null when there is none — which is every machine that has never run `flypi pi use`. */
export function readPiPin(root: string): PiPin | null {
	try {
		const pin = JSON.parse(readFileSync(join(root, PI_PIN_FILE), "utf8")) as PiPin;
		return typeof pin.version === "string" ? pin : null;
	} catch {
		return null;
	}
}

export function writePiPin(root: string, pin: PiPin): void {
	mkdirSync(join(root, PI_DIR), { recursive: true });
	writeFileSync(join(root, PI_PIN_FILE), JSON.stringify(pin, null, "\t"));
}

/** The loaded pi, and what chose it. */
export function loadedPi(root: string): PiInfo {
	const version = (JSON.parse(readFileSync(join(getPackageDir(), "package.json"), "utf8")) as { version: string }).version;
	const pin = readPiPin(root);
	const pinned = pin?.version === version;
	// The tree on disk is the truth; the pin's `from` is the record of what was moved aside.
	const bundled = bundledPiVersion(root) ?? pin?.from ?? null;
	return { version, pinned, ...(bundled && bundled !== version ? { bundled } : {}) };
}

/** The scope directory of the running flypi — the thing the link replaces. */
export function piScope(): string {
	return join(packageDir(), "node_modules", "@earendil-works");
}

export function piTreeDir(root: string, version: string): string {
	return join(root, PI_DIR, version);
}

/** The `@earendil-works` directory inside a tree — what the link points at. */
function scopeOf(treeDir: string): string {
	return join(treeDir, "node_modules", "@earendil-works");
}

/** The version a tree holds, or null when it is not a pi tree. */
export function treeVersion(treeDir: string): string | null {
	try {
		return (JSON.parse(readFileSync(join(scopeOf(treeDir), "pi-coding-agent", "package.json"), "utf8")) as { version: string }).version;
	} catch {
		return null;
	}
}

/** What the package's own `@earendil-works` holds right now — linked or real, that is what a process resolves. */
export function scopeVersion(scope: string): string | null {
	try {
		return (JSON.parse(readFileSync(join(scope, "pi-coding-agent", "package.json"), "utf8")) as { version: string }).version;
	} catch {
		return null;
	}
}

/** The version the tree flypi shipped with holds — the way back when nothing was pinned. */
export function bundledPiVersion(root: string): string | null {
	return treeVersion(join(root, PI_BUNDLED));
}

/** The pi versions with a tree on disk, newest first. The bundled tree is not one of them. */
export function piTrees(root: string): string[] {
	try {
		return readdirSync(join(root, PI_DIR))
			.filter((name) => name !== "bundled" && treeVersion(piTreeDir(root, name)) !== null)
			.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
	} catch {
		return [];
	}
}

/**
 * A complete npm tree for one pi version. npm does the resolution — pi's sibling packages, their ranges and
 * the integrity checking — for free; the one-line `package.json` only names the three specifiers flypi
 * imports (docs/pi-upgrades.md C3: `pi-mcp` and `pi-ai` are not flypi dependencies, so a tree that names
 * only `pi-coding-agent` would leave the smoke script and the test stub unable to resolve them).
 */
export function installPiTree(root: string, version: string): { ok: boolean; error?: string } {
	const dir = piTreeDir(root, version);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "package.json"),
		`${JSON.stringify({ name: "flypi-pi-tree", private: true, dependencies: { [PI_PACKAGE]: version, "@earendil-works/pi-mcp": version, "@earendil-works/pi-ai": version } }, null, "\t")}\n`,
	);
	const npm = spawnSync("npm", ["install", "--prefix", dir, "--no-audit", "--no-fund"], { encoding: "utf8" });
	if (npm.status !== 0) return { ok: false, error: npm.stderr?.trim() || `npm exited ${npm.status}` };
	const got = treeVersion(dir);
	if (got !== version) return { ok: false, error: `npm installed ${got ?? "nothing"}, not ${version}` };
	return { ok: true };
}

/** Delete the trees nothing can go back to, keeping the named ones. The bundled tree is never touched. */
export function gcPiTrees(root: string, keep: string[]): string[] {
	return piTrees(root)
		.filter((version) => !keep.includes(version))
		.filter((version) => {
			rmSync(piTreeDir(root, version), { recursive: true, force: true });
			return true;
		});
}

/**
 * Point the package's `@earendil-works` at a tree. The installed scope is moved to `.flypi/pi/bundled/`
 * first, once, so the way back does not need the network. On Windows this is a junction — a symlink there
 * needs developer mode or admin — and if neither can be made the answer is a refusal, not a 100 MB copy.
 */
export function linkPiScope(root: string, version: string, scope: string): { ok: boolean; message: string } {
	const target = scopeOf(piTreeDir(root, version));
	if (treeVersion(piTreeDir(root, version)) !== version) return { ok: false, message: `there is no pi ${version} tree on disk` };
	const link = lstatSync(scope, { throwIfNoEntry: false })?.isSymbolicLink();
	if (link && realpathSync(scope) === realpathSync(target)) return { ok: true, message: `pi already resolves to ${version}` };

	const bundled = scopeOf(join(root, PI_BUNDLED));
	let replaced = false;
	if (!link && existsSync(scope)) {
		// Only the first pin moves it; after that the installed scope is already a link. A real directory here
		// with a bundled copy already kept means an upgrade replaced the package directory and brought a fresh
		// installed pi with it — that one is the baseline now, and the copy we kept is the version the pin has
		// already moved past.
		if (existsSync(bundled)) {
			rmSync(bundled, { recursive: true, force: true });
			replaced = true;
		}
		try {
			mkdirSync(join(bundled, ".."), { recursive: true });
			renameSync(scope, bundled);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EXDEV") return { ok: false, message: `could not move the installed pi aside: ${(error as Error).message}` };
			// Different volume: copy it instead. Slow, and only happens when `.flypi/` and the global
			// node_modules are on different filesystems.
			cpSync(scope, bundled, { recursive: true });
			rmSync(scope, { recursive: true, force: true });
		}
	}

	const temp = `${scope}.link`;
	rmSync(temp, { force: true });
	try {
		symlinkSync(target, temp, process.platform === "win32" ? "junction" : "dir");
		renameSync(temp, scope);
	} catch (error) {
		rmSync(temp, { force: true });
		restoreBundledScope(root, scope);
		return { ok: false, message: `could not point ${scope} at ${target}: ${(error as Error).message} — the installed pi has been put back` };
	}
	return { ok: true, message: replaced ? `pi now resolves to ${version}; the pi the upgrade installed is kept as the way back` : `pi now resolves to ${version}` };
}

/** Put the tree flypi shipped with back where npm installed it, and drop the link. */
export function restoreBundledScope(root: string, scope: string): { ok: boolean; message: string } {
	const bundled = scopeOf(join(root, PI_BUNDLED));
	if (lstatSync(scope, { throwIfNoEntry: false })?.isSymbolicLink()) rmSync(scope, { force: true });
	if (existsSync(scope)) return { ok: true, message: "the installed pi is already in place" };
	if (!existsSync(bundled)) return { ok: false, message: "there is no bundled pi tree to put back — `npm install -g` is the way back from here" };
	renameSync(bundled, scope);
	return { ok: true, message: "the installed pi is back in place" };
}

/**
 * The startup self-heal, beside the other ones (rewriting `mcp.json` when the port moved, releasing stale
 * job claims): a flypi upgrade can replace the package directory and take the link with it, so a pin whose
 * tree exists gets re-applied. Returns a line for the log, or null when there was nothing to say.
 */
export function relinkFromPin(root: string, scope: string): string | null {
	const pin = readPiPin(root);
	if (!pin) return null;
	const target = scopeOf(piTreeDir(root, pin.version));
	if (!existsSync(target)) return `the pin asks for pi ${pin.version}, but its tree is not on disk — running the pi flypi was installed with`;
	if (lstatSync(scope, { throwIfNoEntry: false })?.isSymbolicLink() && realpathSync(scope) === realpathSync(target)) return null;
	const link = linkPiScope(root, pin.version, scope);
	return link.ok ? `pi re-pointed at the pinned ${pin.version}` : `the pi pin could not be applied: ${link.message}`;
}

/** What moving pi needs from the caller: the restart, the answer, and the log for when it does not come back. */
export interface PiSwitchDeps {
	root: string;
	/** Stop the daemon and start it again, waiting until it answers. */
	restart: () => Promise<void>;
	/** What `/healthz` says about pi — null when nothing answered in time. */
	pi: () => Promise<PiInfo | null>;
	/** The last lines of the daemon log, printed when the candidate did not start. */
	logTail?: () => string;
	/** Overridable so the whole rule is testable without a network, a restart or a second daemon. */
	install?: (root: string, version: string) => { ok: boolean; error?: string };
	probe?: (treeDir: string) => Promise<string[]>;
	log?: (line: string) => void;
	/** Overridable because a checkout and a container both refuse, and the test suite is a checkout. */
	global?: () => boolean;
	/** The package's `@earendil-works` directory — the thing the pointer moves. Required, not defaulted:
	 *  a test that let it fall back to the running package would move that package's own pi. */
	scope: string;
}

/**
 * Move to a published pi version, or back to an older one. Stage 1 (the compat probe) runs before anything
 * moves; the flip is provisional and stage 2 (the restarted daemon answering with the candidate version)
 * decides whether it is kept. Nothing here asks a human to notice a failed start — by then the page would be
 * gone with the process it would click (risk 13).
 */
export async function switchPiVersion(version: string, deps: PiSwitchDeps): Promise<{ ok: boolean; message: string }> {
	const log = deps.log ?? (() => {});
	const current = loadedPi(deps.root);
	if (version === current.version) return { ok: false, message: `pi ${version} is what is already running` };
	if (!(deps.global ?? isGlobalInstall)()) {
		return {
			ok: false,
			message: "this flypi is not the npm global package, so there is no pointer to move — in a checkout run `npm install @earendil-works/pi-coding-agent@X && npm test && npm run smoke`; in a container the package dir is read-only, so rebuild the image",
		};
	}

	const tree = piTreeDir(deps.root, version);
	if (treeVersion(tree) !== version) {
		log(`installing pi ${version} into ${tree} …`);
		const installed = (deps.install ?? installPiTree)(deps.root, version);
		if (!installed.ok) return { ok: false, message: `pi ${version} could not be installed: ${installed.error}` };
	}

	const failures = await (deps.probe ?? checkPiCompat)(tree);
	if (failures.length > 0) return { ok: false, message: `pi ${version} does not offer what flypi imports:\n  ${failures.join("\n  ")}` };

	// Where to go back to: the pinned version if one is pinned, otherwise what the package's own scope holds
	// — the tree flypi was installed with, which the link is about to move aside.
	const previous = current.pinned ? current.version : (scopeVersion(deps.scope) ?? bundledPiVersion(deps.root) ?? current.version);
	writePiPin(deps.root, { version, from: previous, pinnedAt: new Date().toISOString(), verified: false });
	const link = linkPiScope(deps.root, version, deps.scope);
	if (!link.ok) {
		const pin = readPiPin(deps.root);
		if (pin) writePiPin(deps.root, { version: previous, from: version, pinnedAt: new Date().toISOString(), verified: true });
		return { ok: false, message: link.message };
	}

	await deps.restart();
	const after = await deps.pi();
	if (after?.version === version) {
		writePiPin(deps.root, { version, from: previous, pinnedAt: new Date().toISOString(), verified: true });
		const removed = gcPiTrees(deps.root, [version, previous]);
		return { ok: true, message: `pi ${version} is running${removed.length ? ` (dropped ${removed.join(", ")})` : ""}` };
	}

	// It did not come back on the candidate. Go back, start again, and say what the log said — this is the
	// failure with no UI, so it cannot wait for someone to notice.
	const why = after ? `it came back reporting pi ${after.version}` : "it did not answer after the restart";
	log(`pi ${version} did not start (${why}) — going back to ${previous}`);
	if (previous === (bundledPiVersion(deps.root) ?? previous)) {
		restoreBundledScope(deps.root, deps.scope);
		rmSync(join(deps.root, PI_PIN_FILE), { force: true });
	} else {
		linkPiScope(deps.root, previous, deps.scope);
		writePiPin(deps.root, { version: previous, from: version, pinnedAt: new Date().toISOString(), verified: true });
	}
	await deps.restart();
	const back = await deps.pi();
	const tail = deps.logTail?.() ?? "";
	return {
		ok: false,
		message: `pi ${version} did not start (${why}); back on pi ${previous}${back?.version === previous ? " and it answers" : " — and it did not answer either"}.${tail ? `\nLast log lines:\n${tail}` : ""}`,
	};
}
