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
 * reporting an install that never landed.
 *
 * **Updates are checked, not fetched, by the panel.** `checkForAvailableUpdates()` reaches the registry and
 * every git remote, so it runs on the daemon's daily rhythm (src/daemon/index.ts) and its answer is kept in
 * `.flypi/package-check.json` — the same shape as flypi's own update stamp (src/daemon/update.ts). The panel
 * reads the stamp; the daemon installs what it found during the same idle stretch it installs flypi with.
 * A source that names a version (`npm:x@1.2.0`) or a git ref is pinned, and pi leaves pinned sources where
 * they are: naming a version is asking for that version.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { isNewer, published } from "../daemon/update.ts";
import { FlypiConfigError } from "./runtime.ts";
import type { FlypiPaths } from "./paths.ts";

/** How long the package answer stays good — the daemon's day, the same rhythm as flypi's own update check. */
export const PACKAGE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** The answer, next to flypi's own update stamp, so the panel reports it without reaching the network. */
export const PACKAGE_CHECK_FILE = join(".flypi", "package-check.json");
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

/** The list, merged with the daemon's answer. Reaches no network, so the panel can ask on every open. */
export function readPackages(paths: FlypiPaths): PackageSnapshot {
	const { manager, settings } = packages(paths);
	const check = readPackageCheck(paths.root);
	return {
		packages: manager.listConfiguredPackages().map((entry) => {
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
		}),
		...(check ? { checkedAt: check.checkedAt } : {}),
		errors: settingsErrors(settings),
	};
}

/**
 * Install, remove or update, then hand back the list as it is now. Applied in order and one at a time:
 * pi's own npm/git calls are what fail, and a later edit in the same request still runs against what the
 * earlier ones wrote. A `settings.json` that will not parse is refused up front — pi would install the code
 * and then decline to record it, which is an install that never lands.
 */
export async function applyPackageEdits(paths: FlypiPaths, edits: PackageEdits): Promise<PackageSnapshot> {
	const { manager, settings } = packages(paths);
	const unreadable = settingsErrors(settings);
	if (unreadable.length > 0) throw new FlypiConfigError(unreadable.join("; "));
	for (const source of edits.install ?? []) await manager.installAndPersist(source);
	for (const source of edits.remove ?? []) await manager.removeAndPersist(source);
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
