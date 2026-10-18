/**
 * Keeping flypi up to date (docs/architecture.md Phase 7): is a newer flypi published, is it downloaded
 * already, and when may it be installed?
 *
 * `npm run release` is the only thing that publishes, and package.json is the version it bumps, the version
 * `/healthz` reports and the version `flypi status` prints — so the registry's `latest` is the single answer
 * to "is there a new package", with no second version file to keep in step.
 *
 * The daemon **downloads** the new package (once a day at most, ~0.4 MB, verified against the checksum the
 * registry published with it) and **installs it only while the daemon is idle** — no page attached and no
 * turn in flight, held for a stretch, the same idle the memory sweep uses. Installing replaces the files the
 * daemon is running from, so it is followed by a restart through the CLI; a restart while someone is reading
 * an answer would be the one thing this must not do.
 *
 * **One version at a time.** The version to move to is the next one published above the running one — never
 * the newest. flypi's own databases (the memory store, the run record) carry a schema, and a schema upgrade
 * is code that runs when the version that needs it starts: 0.1.0 → 0.3.0 would run 0.3.0's migration against
 * 0.1.0's schema and skip whatever 0.2.0 would have done to it. So the ladder is walked one published release
 * per install, each step starting on its own and migrating what it finds, and the stamp is cleared after a
 * step so the next one is taken from a fresh look rather than from the same answer. When a package has
 * skipped numbers, the next published release is the step — that is the ladder npm still has.
 *
 * A checkout is not an installed package: it has `.git` next to the code, it updates with git, and the
 * registry has nothing to compare it against. Every entry point here says so rather than checking anyway.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

/** How long an answer stays good — the same day-long rhythm the memory sweep keeps. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** How long the daemon must have been idle before a downloaded update installs. The job loop passes once a
 * minute, so this is measured in passes; a lull shorter than this is not a restart. */
export const IDLE_BEFORE_INSTALL_MS = 10 * 60_000;
/** The answer, kept next to the pid file so `flypi status` can report it without a network round trip. */
export const UPDATE_CHECK_FILE = join(".flypi", "update-check.json");
/** Where a downloaded package waits. One version at a time — `downloadUpdate` clears the rest. */
export const UPDATE_DIR = join(".flypi", "updates");

export interface UpdateDist {
	tarball: string;
	/** `sha512-<base64>`, what npm publishes; `shasum` is the older sha1 hex form it also publishes. */
	integrity?: string;
	shasum?: string;
}

export interface UpdateCheck {
	checkedAt: string;
	/** The version installed when the answer was written. `current` in an old stamp is not today's version. */
	current: string;
	/** The newest published version — information only; nothing here installs it. */
	latest: string | null;
	/** The version to move to: the next one published above `current`. Null when there is none. */
	next: string | null;
	error?: string;
	/** The package for `next` — what gets downloaded and installed. */
	dist?: UpdateDist;
	/** The package already downloaded and verified, waiting for an idle moment to install. */
	download?: { version: string; file: string; at: string };
}

/** The directory the running code ships in — not `paths.root`, which is the state directory. */
export function packageDir(): string {
	return resolve(import.meta.dirname, "..", "..");
}

/** What the installed package is called, and which version of it this is. */
export function packageInfo(dir = packageDir()): { name: string; version: string; checkout: boolean } {
	const pkg = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")) as { name?: string; version?: string };
	// A checkout updates with `git pull`; the registry only knows what `npm publish` put there.
	return { name: pkg.name ?? "", version: pkg.version ?? "dev", checkout: existsSync(resolve(dir, ".git")) };
}

/**
 * Version order, by number: 0.10.0 is newer than 0.9.0, so the parts are not text. A prerelease suffix sorts
 * as its base version — npm keeps those under the `next` tag, and `published()` filters them out anyway.
 */
export function compareVersions(a: string, b: string): number {
	const parts = (v: string) => (v.split("-")[0] ?? v).split(".").map((p) => Number(p) || 0);
	const [left, right] = [parts(a), parts(b)];
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const diff = (left[i] ?? 0) - (right[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

/** Newest first, by number. */
export function isNewer(installed: string, latest: string): boolean {
	return compareVersions(latest, installed) > 0;
}

/**
 * The published versions of a package, released ones only: a prerelease is not a rung anyone should be
 * stepped up through, and npm does not put one in `dist-tags.latest` either.
 */
export function published(versions: Record<string, unknown>): string[] {
	return Object.keys(versions).filter((v) => !v.includes("-")).sort(compareVersions);
}

/**
 * The one step above `current` — the whole point of the ladder (see the note at the top of this file). Null
 * when nothing newer has been published, and when the registry gave no version list to build a ladder from:
 * guessing a jump is exactly what this rule exists to prevent.
 */
export function nextVersion(versions: Record<string, unknown>, current: string): string | null {
	return published(versions).find((v) => isNewer(current, v)) ?? null;
}

/**
 * The step to take, from a stamp written by any install: null when there is nothing newer to move to. A stamp
 * written by an older install names a step that has since been taken, and `next` is re-checked against the
 * version running now for that reason.
 */
export function updateAvailable(check: UpdateCheck | null, current: string): string | null {
	return check?.next && isNewer(current, check.next) ? check.next : null;
}

/**
 * The version sitting on disk ready to install — only when it is newer than what is running. A stamp left by
 * an older install still names a tarball that was already applied, and installing it again would be a
 * restart for nothing.
 */
export function stagedUpdate(check: UpdateCheck | null, current: string): string | null {
	return check?.download?.version && isNewer(current, check.download.version) ? check.download.version : null;
}

/** Is the answer too old to trust (or absent)? */
export function dueForCheck(check: UpdateCheck | null, now = Date.now()): boolean {
	const at = Date.parse(check?.checkedAt ?? "");
	return Number.isNaN(at) || now - at >= CHECK_INTERVAL_MS;
}

/**
 * Ask the registry for the package document — `dist-tags.latest` and every published version with its
 * `dist` — in one request, because the ladder needs the version list, not just the top of it.
 *
 * `fetchImpl` is injectable because a test must not reach the network, and a registry that is down, offline
 * or has never heard of this package (404 — where this one is until `npm run release` publishes it) is an
 * answer, not a crash.
 */
export async function checkForUpdate(options: { current: string; name: string; fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<UpdateCheck> {
	const at = new Date().toISOString();
	const fail = (error: string): UpdateCheck => ({ checkedAt: at, current: options.current, latest: null, next: null, error });
	const url = `https://registry.npmjs.org/${encodeURIComponent(options.name)}`;
	try {
		const response = await (options.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 5_000), headers: { accept: "application/json" } });
		if (!response.ok) return fail(`the registry answered ${response.status} for ${options.name}`);
		const doc = (await response.json()) as { "dist-tags"?: { latest?: unknown }; versions?: Record<string, { dist?: UpdateDist }> };
		const versions = doc.versions ?? {};
		if (Object.keys(versions).length === 0) return fail(`the registry named no published versions of ${options.name} to step through`);
		const latest = typeof doc["dist-tags"]?.latest === "string" ? doc["dist-tags"].latest : published(versions).at(-1) ?? null;
		const next = nextVersion(versions, options.current);
		return {
			checkedAt: at,
			current: options.current,
			latest,
			next,
			...(next && versions[next]?.dist?.tarball ? { dist: versions[next].dist } : {}),
		};
	} catch (error) {
		return fail(`the registry could not be reached: ${(error as Error).message}`);
	}
}

/**
 * Fetch the package and keep it for the idle moment. The checksum the registry published with the manifest
 * is the only proof the bytes are the ones it described, and these bytes become code that runs with the
 * user's home directory in front of it — so a mismatch is deleted rather than staged, and a manifest with no
 * checksum to verify against is refused rather than trusted.
 *
 * The tarball is flypi's own code (~0.4 MB); npm still resolves its dependencies at install time.
 */
export async function downloadUpdate(options: { root: string; version: string; dist: UpdateDist; fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<{ file?: string; error?: string }> {
	if (!options.dist.integrity?.startsWith("sha512-") && !options.dist.shasum) return { error: "the registry published no checksum to verify the download against" };
	let bytes: Buffer;
	try {
		const response = await (options.fetchImpl ?? fetch)(options.dist.tarball, { signal: AbortSignal.timeout(options.timeoutMs ?? 120_000) });
		if (!response.ok) return { error: `the registry answered ${response.status} for the package` };
		bytes = Buffer.from(await response.arrayBuffer());
	} catch (error) {
		return { error: `the package could not be downloaded: ${(error as Error).message}` };
	}
	if (options.dist.integrity?.startsWith("sha512-")) {
		const got = createHash("sha512").update(bytes).digest("base64");
		if (got !== options.dist.integrity.slice("sha512-".length)) return { error: "the downloaded package does not match the registry's sha512" };
	} else if (createHash("sha1").update(bytes).digest("hex") !== options.dist.shasum) {
		return { error: "the downloaded package does not match the registry's sha1" };
	}
	const dir = resolve(options.root, UPDATE_DIR);
	mkdirSync(dir, { recursive: true });
	// One version waiting at a time: the old tarball is code that is no longer going to run.
	for (const old of readdirSync(dir)) if (!old.includes(options.version)) rmSync(join(dir, old), { force: true });
	const file = join(dir, basename(options.dist.tarball));
	writeFileSync(file, bytes);
	return { file };
}

export function readUpdateCheck(root: string): UpdateCheck | null {
	try {
		return JSON.parse(readFileSync(resolve(root, UPDATE_CHECK_FILE), "utf8")) as UpdateCheck;
	} catch {
		return null;
	}
}

export function writeUpdateCheck(root: string, check: UpdateCheck): void {
	// The `.flypi/` directory is created here, not assumed: `flypi update --check` works on a root that has
	// never run a daemon, where neither the stamp nor the directory exists yet.
	const file = resolve(root, UPDATE_CHECK_FILE);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(check, null, 2)}\n`);
}

/** What installs the downloaded tarball. Pinned to the file that was just verified, so what installs is
 * what was checked; `--no-audit --no-fund` because this runs in front of a person, not in CI. */
export function installArgs(file: string): string[] {
	return ["install", "-g", "--no-audit", "--no-fund", file];
}

/**
 * Is the running code the global package `npm install -g` would replace? flypi installed through pnpm, bun,
 * npx or a second prefix would leave the install landing somewhere else, and the restart would come back on
 * the old code while the log said it had updated.
 */
export function isGlobalInstall(dir = packageDir()): boolean {
	const out = spawnSync("npm", ["root", "-g"], { encoding: "utf8" });
	if (out.status !== 0) return false;
	const root = out.stdout.trim();
	if (!root) return false;
	const here = resolve(dir);
	return here === root || here.startsWith(root + sep);
}

/** A download is only worth keeping when it is still the step this version should take. */
export function keepDownload(check: UpdateCheck, previous: UpdateCheck | null): UpdateCheck["download"] {
	return previous?.download && previous.download.version === check.next ? previous.download : undefined;
}

/**
 * Forget the answer after a step has been taken. The next version looks again — a fresh ladder from the
 * version that is now running, and the next single step — rather than installing the rest of what an older
 * answer had already picked out.
 */
export function clearUpdateCheck(root: string): void {
	rmSync(resolve(root, UPDATE_CHECK_FILE), { force: true });
}
