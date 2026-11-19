/**
 * Extension packages — pi's own mechanism (pi's docs/packages.md), pointed at flypi's agent dir so the
 * settings view can install and update them (docs/protocol.md `packages` / `savePackages`).
 *
 * Nothing here reimplements a package: pi's `DefaultPackageManager` owns the source forms (`npm:…`, a git
 * URL, a path), where the code lands (`<agentDir>/npm/node_modules`, a git checkout, or the path itself),
 * what counts as an update and how one is reconciled. `agentDir` is `.flypi/agent`, so an installed
 * extension never reaches the host `~/.pi` (docs/risks.md risk 1) — `assertFlypiOwned` is what guarantees
 * that, and it runs in `createFlypiSession` before any session loads these packages.
 *
 * The declaration lives in `.flypi/agent/settings.json` under `packages`, the same file the settings panel
 * edits the default model in. pi's `SettingsManager` writes only the field it changed, so a `defaultProvider`
 * or a `permissions` block survives an install — and it refuses to write at all when that file will not
 * parse, which is why `applyPackageEdits` checks for a load error before touching anything rather than
 * reporting an install that never landed. flypi keeps one key of its own in that file,
 * `flypi.packagesDeclined`: the sources the operator removed through this panel, so the default declaration
 * (`ensureSubagentDefaults`, src/agent/config-files.ts) never puts one back over their decision.
 *
 * **Updates are checked, not fetched, by the panel.** `checkForAvailableUpdates()` reaches the registry and
 * every git remote, so it runs on the daemon's daily rhythm (src/daemon/index.ts) and its answer is kept in
 * `.flypi/package-check.json` — the same shape as flypi's own update stamp (src/daemon/update.ts). The panel
 * reads the stamp; the daemon installs what it found during the same idle stretch it installs flypi with.
 * A source that names a version (`npm:x@1.2.0`) or a git ref is pinned, and pi leaves pinned sources where
 * they are: naming a version is asking for that version.
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { isNewer, published } from "../daemon/update.ts";
import { FlypiConfigError } from "./runtime.ts";
import { assertFlypiOwned, type FlypiPaths } from "./paths.ts";

/** How long the package answer stays good — the daemon's day, the same rhythm as flypi's own update check. */
export const PACKAGE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** The answer, next to flypi's own update stamp, so the panel reports it without reaching the network. */
export const PACKAGE_CHECK_FILE = join(".flypi", "package-check.json");
/**
 * Which declared sources failed to install, stamped by the session factory (`src/agent/runtime.ts`) and read
 * back by `readPackages` below. Flypi's own state dir, beside `PACKAGE_CHECK_FILE`: `<agentDir>` is pi's and
 * the operator's, and nothing on this path may add files to it.
 *
 * It exists because a declared source that cannot install no longer stops the conversation — it costs that one
 * extension — so the loss has to be written down somewhere the settings panel already reads. The file is
 * flypi's and is safe to delete by hand; the code deletes it when there is nothing left to say.
 */
export const PACKAGE_FAILURES_FILE = join(".flypi", "package-failures.json");
/** shortcut: the picker offers the 30 newest releases; going further back means editing the source by hand. */
export const PUBLISHED_LIST_MAX = 30;

/** One `packages` entry, as the panel shows it. */
export interface PackageRow {
	/** The source exactly as settings.json holds it — `npm:…`, a git URL, or a path. */
	source: string;
	/** `project` is an entry in `<root>/.pi/settings.json`; flypi's own edits are always `user`. */
	scope: "user" | "project";
	/** Declared, but the code is not on disk. A session would install it on start; the panel says so. */
	installed: boolean;
	/** Where the code is: `.flypi/agent/npm/node_modules/<name>`, a checkout, or the local path. */
	path: string;
	/** The version its own `package.json` says it is — what a rollback has to name (docs/pi-upgrades.md). */
	version?: string;
	/** A newer release is published (npm) or the remote moved (git). Only from the daemon's stamp. */
	update?: boolean;
	/** The npm package an `npm:` source names, version stripped — what a pin is written onto. Absent for a git URL or a path. */
	name?: string;
	/** The published releases the daemon's stamp knows, oldest first — what "install this version" offers. */
	versions?: string[];
	/** The newest of those that is newer than what is installed. Absent when nothing newer is published. */
	available?: string;
}

export interface PackageSnapshot {
	packages: PackageRow[];
	/** When the daemon last asked the registries; absent until it has. */
	checkedAt?: string;
	/** A `settings.json` pi could not read — said, rather than shown as "no packages". */
	errors: string[];
}

export interface PackageEdits {
	install?: string[];
	remove?: string[];
	update?: string[];
}

/** One source whose install failed, as the panel sees it. */
export interface PackageFailure {
	/** When the reload that failed ran. */
	failedAt: string;
	/**
	 * Why the code is not there, on one line the panel can print: the install's own error (npm prints a usage
	 * block and git prints a hint, so it arrives collapsed) or, for a source pi never reached, that it did not run.
	 */
	reason: string;
}

/** What the session factory stamped: which declared sources have no code on disk, and what to tell the operator about each. */
export interface PackageFailures {
	[source: string]: PackageFailure;
}

/** What the daemon wrote: which sources have an update waiting. */
export interface PackageCheck {
	checkedAt: string;
	/** The `packages` entries, exactly as settings.json holds them. */
	updates: string[];
	/** Published releases per npm source, oldest first — the rollback list the panel offers (docs/pi-upgrades.md). */
	versions?: Record<string, string[]>;
	error?: string;
}

/**
 * The npm package an `npm:` source names, with any version or range it pins stripped: `npm:foo@^1.2` and
 * `npm:foo` are both `foo`, and `npm:@scope/foo@1.0.0` is `@scope/foo`. Undefined for a git URL or a path,
 * which have no registry to ask. This is also what tells a reader the source is pinned — a source that names
 * a version is not `npm:<name>` any more.
 */
export function npmName(source: string): string | undefined {
	if (!source.startsWith("npm:")) return undefined;
	const name = source.slice("npm:".length).trim().replace(/@[^/@]*$/, "");
	return name || undefined;
}

/** pi's package manager, on flypi's own agent dir, plus the settings file it writes through. */
function packages(paths: FlypiPaths): { manager: DefaultPackageManager; settings: SettingsManager } {
	const settings = SettingsManager.create(paths.root, paths.agentDir);
	return { manager: new DefaultPackageManager({ cwd: paths.root, agentDir: paths.agentDir, settingsManager: settings }), settings };
}

/** The version an installed extension's own `package.json` claims. Null when it cannot be read. */
function installedVersion(path: string): string | undefined {
	try {
		return (JSON.parse(readFileSync(join(path, "package.json"), "utf8")) as { version?: string }).version;
	} catch {
		return undefined;
	}
}

/**
 * `updates` in `.flypi/agent/settings.json`: may the daemon install an extension update by itself, on the
 * same idle stretch it installs flypi with? Default true — the behaviour that predates the key. It is the
 * path an incompatible change arrives by, so it is now something a user can turn off; pi itself has no
 * equivalent and never updates unattended (docs/pi-upgrades.md).
 */
export function autoExtensions(paths: FlypiPaths): boolean {
	try {
		const settings = JSON.parse(readFileSync(paths.settingsPath, "utf8")) as { updates?: { autoExtensions?: unknown } };
		return settings.updates?.autoExtensions !== false;
	} catch {
		return true;
	}
}

/** What pi could not read or write, named by file — a settings.json it cannot parse is never silently "empty". */
function settingsErrors(settings: SettingsManager): string[] {
	return settings.drainErrors().map((failure) => `${failure.path ?? failure.scope}: ${failure.error.message}`);
}

/**
 * The directories of the declared sources whose code is on disk — what `checkPiCompat` scans for pi imports
 * (src/agent/pi-compat.ts, T46.2.4). One copy because the probe's two callers, the pi switch and
 * `scripts/probe-pi.ts`, have to ask about exactly the same packages.
 */
export function installedExtensionPaths(paths: FlypiPaths): string[] {
	return readPackages(paths).packages.filter((row) => row.installed).map((row) => row.path);
}

/** The list, merged with the daemon's answer. Reaches no network, so the panel can ask on every open. */
export function readPackages(paths: FlypiPaths): PackageSnapshot {
	const { manager, settings } = packages(paths);
	const check = readPackageCheck(paths.root);
	const failures = readPackageFailures(paths.root);
	const rows = manager.listConfiguredPackages().map((entry) => {
		const name = npmName(entry.source);
		const version = entry.installedPath ? installedVersion(entry.installedPath) : undefined;
		const versions = check?.versions?.[entry.source];
		const available = versions?.filter((v) => !version || isNewer(version, v)).at(-1);
		return {
			source: entry.source,
			scope: entry.scope,
			installed: entry.installedPath !== undefined,
			path: entry.installedPath ?? "",
			...(version ? { version } : {}),
			...(check?.updates.includes(entry.source) ? { update: true } : {}),
			...(name ? { name } : {}),
			...(versions?.length ? { versions } : {}),
			...(available ? { available } : {}),
		};
	});
	return {
		packages: rows,
		...(check ? { checkedAt: check.checkedAt } : {}),
		// A source that failed to install is a problem to say, not an empty list — the same channel the
		// unreadable `settings.json` uses. It is reported while the code is still missing (`installed`), which
		// is what makes the sentence disappear by itself once the install works; reading writes nothing.
		errors: [
			...settingsErrors(settings),
			// A stamp whose reason is not a sentence is flypi's own state gone bad, and this read runs on every
			// panel open (src/server/resources-server.ts): say nothing rather than crash or print `undefined`.
			// The next reload that worked rewrites it (`prunePackageFailures`).
			...rows.flatMap((row) => {
				const reason = row.installed ? undefined : failures[row.source]?.reason;
				return typeof reason === "string" ? [`${row.source} did not install: ${reason}`] : [];
			}),
		],
	};
}

/**
 * The stamps, or none: an unreadable stamp file is flypi's own state missing, not a configuration error — and
 * so is one that parses to something that is not the map this writes, which is what a half-written or edited
 * file looks like from here.
 */
function readPackageFailures(root: string): PackageFailures {
	try {
		const value: unknown = JSON.parse(readFileSync(join(root, PACKAGE_FAILURES_FILE), "utf8"));
		return value !== null && typeof value === "object" ? (value as PackageFailures) : {};
	} catch {
		return {};
	}
}

/**
 * Write the stamps, and remove the file when there are none left — a root with nothing wrong has no file.
 *
 * The failure to write it is swallowed, the way the read swallows its own: this file is advice for the panel,
 * not a precondition for starting a conversation, and it sits inside the `catch` that is about to report an
 * install error. An `EISDIR` from here would replace that error and the degrade would never happen.
 */
function writePackageFailures(root: string, failures: PackageFailures): void {
	try {
		const file = join(root, PACKAGE_FAILURES_FILE);
		if (Object.keys(failures).length === 0) {
			rmSync(file, { force: true });
			return;
		}
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${JSON.stringify(failures, null, 2)}\n`);
	} catch {
		// The row itself still says the source has no code on disk, which is the fact; only the reason for it is
		// lost, and the next start tries to write it again.
	}
}

/**
 * The sources the operator took out through the settings panel, so a default is never put back over their
 * decision (the seed that reads this is `ensureSubagentDefaults`, src/agent/config-files.ts). They live in a
 * flypi-owned key of pi's own file — `"flypi": { "packagesDeclined": […] }` — because `permissions` is the
 * precedent for exactly that: pi does not know that key either, and its `persistScopedSettings` re-reads the
 * file and rewrites only the field it was asked to set
 * (`@earendil-works/pi-coding-agent/dist/core/settings-manager.js:449-470`), so an install, an `updates` block
 * and this list all keep each other.
 *
 * Nothing here is a precondition for anything: a file that will not parse, a key that is not a list and a
 * root with no `settings.json` all answer "nothing has been declined", because the packages panel still has
 * to open over a broken file — the same channel `readPackages` uses for its `errors`.
 */
export function readDeclinedPackages(paths: FlypiPaths): string[] {
	try {
		const file = JSON.parse(readFileSync(paths.settingsPath, "utf8")) as { flypi?: { packagesDeclined?: unknown } };
		const declined = file.flypi?.packagesDeclined;
		return Array.isArray(declined) ? declined.filter((source): source is string => typeof source === "string") : [];
	} catch {
		return [];
	}
}

/**
 * Remember (or forget) that the operator removed one source. Written where the uninstall happens, in
 * `applyPackageEdits` below, because that is the only place the panel's Remove is observable; re-installing
 * the same source clears it, which is the operator changing their mind.
 *
 * Every removed source is recorded, default or not — this module does not know which sources flypi declares,
 * and deciding that is the reader's job. A file this cannot parse is left exactly as it is, the way the
 * failure stamp's writer leaves an unwritable one (`writePackageFailures` above): this is advice for the next
 * daemon start, not a reason to break an install that already succeeded.
 */
export function recordPackageDecline(paths: FlypiPaths, source: string, declined: boolean): void {
	try {
		const file = JSON.parse(readFileSync(paths.settingsPath, "utf8")) as Record<string, unknown>;
		const flypi = typeof file.flypi === "object" && file.flypi !== null && !Array.isArray(file.flypi) ? file.flypi as Record<string, unknown> : {};
		const list = (Array.isArray(flypi.packagesDeclined) ? flypi.packagesDeclined : []).filter((item): item is string => typeof item === "string");
		// Clearing something never declined writes nothing at all: an install of an ordinary source must not put a
		// flypi key in the operator's file that says nothing.
		if (!declined && !list.includes(source)) return;
		const next = declined ? [...new Set([...list, source])] : list.filter((item) => item !== source);
		flypi.packagesDeclined = next;
		file.flypi = flypi;
		// 0600 and its directory created, like every other file flypi writes in the agent dir (`writeJson`,
		// src/agent/config-files.ts) — and, like that one, the mode is set as well as asked for, because
		// `writeFileSync` only applies it when the file is new.
		mkdirSync(dirname(paths.settingsPath), { recursive: true });
		writeFileSync(paths.settingsPath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
		chmodSync(paths.settingsPath, 0o600);
	} catch {
		// The uninstall itself already happened; the next start adds the default back over it, which is the
		// hand-edit limit the seed's own doc block states.
	}
}

/** One line a panel can render: pi's own message is the npm/git error, multi-line and with its usage block. */
function oneLine(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/\s+/g, " ").trim().slice(0, 300);
}

/**
 * Stamp the sources a failed reload can be blamed on, and hand them back: every declared source with no code
 * on disk. A source that is on disk loaded, so it is not to be blamed for someone else's npm error — and an
 * empty answer is how the caller learns the failure was not a package's fault.
 *
 * Only the first of them carries the caught error: pi's `resolvePackageSources` is a sequential loop that
 * throws at the first source it cannot install (`core/package-manager.js:1001`), so the sources behind it were
 * never attempted and naming the git remote in the message would send the operator to fix something that has
 * nothing to do with their blocker. "First" is the order `settings.json` declares them in
 * (`listConfiguredPackages` keeps it), because that is the order the operator reads.
 *
 * shortcut: keyed by source and written whole, so two conversations failing at once are last-writer-wins on
 * the same content. Upgrade to a per-write lock if a stamp is ever more than one line of advice.
 */
export function recordPackageFailure(paths: FlypiPaths, error: unknown): string[] {
	const sources = packages(paths)
		.manager.listConfiguredPackages()
		.filter((entry) => entry.installedPath === undefined)
		.map((entry) => entry.source);
	if (sources.length === 0) return sources;
	const failures = readPackageFailures(paths.root);
	const failedAt = new Date().toISOString();
	sources.forEach((source, index) => {
		failures[source] = { failedAt, reason: index === 0 ? oneLine(error) : "not attempted (an earlier declared source failed to install)" };
	});
	writePackageFailures(paths.root, failures);
	return sources;
}

/**
 * Settle the stamps after a reload that worked: a source installed again, and one the operator took out of
 * `settings.json`, stop being something to tell anybody — a failure that is no longer declared has nobody left
 * to tell, and `readPackages` stopped reporting it the moment the row went away. A source still missing keeps
 * its stamp, which is the session that came up without it saying so.
 *
 * A source that is missing with nothing stamped about it got there by another road: pi never throws in offline
 * mode (`isOfflineModeEnabled`, `core/package-manager.js:38`; the resolve path returns before the install at
 * `:1015`), so an operator who exported `PI_OFFLINE=1` has a reload that succeeds over a source nobody ever
 * attempted. That is said, or the conversation loses a tool in total silence — but only when the process is
 * actually offline. A missing local-path source in a process that is not offline is pi's own "does not exist"
 * diagnostic to report, and blaming offline mode for a directory the operator deleted would be a wrong sentence
 * about the one thing this file is here to say correctly.
 *
 * This is also where a stamp file that is not the map this writes gets repaired: it reads as empty and is
 * rewritten from what is declared, so one bad byte does not survive the start it was noticed at.
 */
/** Whether pi would skip an install right now — its own rule, mirrored rather than loosened. */
function piOffline(): boolean {
	const value = process.env.PI_OFFLINE;
	return value !== undefined && ["1", "true", "yes"].includes(value.toLowerCase());
}

export function prunePackageFailures(paths: FlypiPaths): void {
	const failures = readPackageFailures(paths.root);
	const missing = new Set(
		packages(paths)
			.manager.listConfiguredPackages()
			.filter((entry) => entry.installedPath === undefined)
			.map((entry) => entry.source),
	);
	for (const source of Object.keys(failures)) {
		if (!missing.has(source)) delete failures[source];
	}
	const failedAt = new Date().toISOString();
	if (piOffline()) {
		for (const source of missing) {
			if (typeof failures[source]?.reason !== "string") failures[source] = { failedAt, reason: "install not attempted (pi offline mode)" };
		}
	}
	writePackageFailures(paths.root, failures);
}

/**
 * Install, remove or update, then hand back the list as it is now. Applied in order and one at a time:
 * pi's own npm/git calls are what fail, and a later edit in the same request still runs against what the
 * earlier ones wrote. A `settings.json` that will not parse is refused up front — pi would install the code
 * and then decline to record it, which is an install that never lands.
 *
 * A `remove` also records the source as declined (`recordPackageDecline`), and an `install` clears that:
 * this is the one place the panel's decision is observable, so it is the one place it gets written down.
 */
export async function applyPackageEdits(paths: FlypiPaths, edits: PackageEdits): Promise<PackageSnapshot> {
	// The panel's install writes the agent-dir files too — pi's package manager puts the code under
	// `<agentDir>/npm` and the declaration in `<agentDir>/settings.json` — so risk 1 is enforced here as well,
	// before the first npm/git call lands anything. docs/risks.md risk 1.
	assertFlypiOwned(paths);
	const { manager, settings } = packages(paths);
	const unreadable = settingsErrors(settings);
	if (unreadable.length > 0) throw new FlypiConfigError(unreadable.join("; "));
	for (const source of edits.install ?? []) {
		await manager.installAndPersist(source);
		// Re-installing is the operator changing their mind, and it is the only thing that clears a decline.
		recordPackageDecline(paths, source, false);
	}
	for (const source of edits.remove ?? []) {
		await manager.removeAndPersist(source);
		// Every removed source, default or not: this module does not know which sources flypi declares, and it
		// must not import what it does not need to (src/agent/config-files.ts imports this one, not the other way).
		recordPackageDecline(paths, source, true);
	}
	for (const source of edits.update ?? []) await manager.update(source);
	// pi queues settings writes; the file has to be on disk before the snapshot re-reads it.
	await settings.flush();
	const errors = settingsErrors(settings);
	const snapshot = readPackages(paths);
	return { ...snapshot, errors: [...errors, ...snapshot.errors] };
}

/**
 * The published releases of each npm source, for the panel's "install this version" — the way back for an
 * extension is pi's own pin form, and a pin has to name a version to name (docs/pi-upgrades.md). One
 * registry document per npm source per day, on the same rhythm as the update check below.
 *
 * A source with nothing to offer is simply absent from the answer: a package the registry has never heard of
 * (404), an offline box, and a git URL or a path all leave the row with no list rather than failing the check.
 */
export async function publishedVersions(paths: FlypiPaths, fetchImpl?: typeof fetch): Promise<Record<string, string[]>> {
	const out: Record<string, string[]> = {};
	for (const entry of packages(paths).manager.listConfiguredPackages()) {
		const name = npmName(entry.source);
		if (!name) continue;
		try {
			// The scoped form is `@scope%2Fname`; an unscoped name needs no escaping at all.
			const response = await (fetchImpl ?? fetch)(`https://registry.npmjs.org/${name.replace("/", "%2F")}`, {
				signal: AbortSignal.timeout(5_000),
				headers: { accept: "application/json" },
			});
			if (!response.ok) continue;
			const doc = (await response.json()) as { versions?: Record<string, unknown> };
			// Released only, oldest first — the same rule flypi's own version ladder reads.
			const list = published(doc.versions ?? {}).slice(-PUBLISHED_LIST_MAX);
			if (list.length > 0) out[entry.source] = list;
		} catch {
			// Nothing to say: the row offers no version until a later check reaches the registry.
		}
	}
	return out;
}

/**
 * Ask the registries and remotes which configured sources have something newer, and what each npm source has
 * ever published. An unreachable registry is the answer, not a crash — the daemon asks this on a machine that
 * may be offline.
 */
export async function checkPackageUpdates(paths: FlypiPaths, fetchImpl?: typeof fetch): Promise<PackageCheck> {
	const { manager } = packages(paths);
	try {
		const updates = (await manager.checkForAvailableUpdates()).map((entry) => entry.source);
		const versions = await publishedVersions(paths, fetchImpl);
		return { checkedAt: new Date().toISOString(), updates, ...(Object.keys(versions).length > 0 ? { versions } : {}) };
	} catch (error) {
		return { checkedAt: new Date().toISOString(), updates: [], error: (error as Error).message };
	}
}

/** Is the answer too old to trust (or absent)? */
export function dueForPackageCheck(check: PackageCheck | null, now = Date.now()): boolean {
	const at = Date.parse(check?.checkedAt ?? "");
	return Number.isNaN(at) || now - at >= PACKAGE_CHECK_INTERVAL_MS;
}

export function readPackageCheck(root: string): PackageCheck | null {
	try {
		return JSON.parse(readFileSync(join(root, PACKAGE_CHECK_FILE), "utf8")) as PackageCheck;
	} catch {
		return null;
	}
}

export function writePackageCheck(root: string, check: PackageCheck): void {
	const file = join(root, PACKAGE_CHECK_FILE);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(check, null, 2)}\n`);
}
