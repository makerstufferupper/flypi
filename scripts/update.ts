#!/usr/bin/env node
/**
 * `flypi update` (docs/architecture.md Phase 7): put the newest published flypi on this machine.
 *
 *   flypi update            # check, download, stop the daemon, install it, start the daemon again
 *   flypi update --check    # the answer only — touches nothing but the stamp
 *   flypi update --dry-run  # every step, none of them run
 *
 * The same package the daemon downloads on its own and installs while it is idle (`src/daemon/update.ts`);
 * this is the version of that you can ask for at a keyboard. The daemon is stopped before the install because
 * it replaces the files it is running from, and started again through this same CLI, which is what keeps the
 * port and interface it was reached by (`flypi restart`'s rule). If the install fails, the daemon is started
 * again on the version it had: a failed update leaves a running flypi, not a dead one.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { checkForUpdate, clearUpdateCheck, downloadUpdate, installArgs, isGlobalInstall, isNewer, keepDownload, packageDir, packageInfo, readUpdateCheck, updateAvailable, writeUpdateCheck } from "../src/daemon/update.ts";

const argv = process.argv.slice(2);
const rootAt = argv.indexOf("--root");
const root = resolve(rootAt === -1 ? process.env.FLYPI_ROOT ?? process.cwd() : (argv[rootAt + 1] ?? ""));
const checkOnly = argv.includes("--check");
const dryRun = argv.includes("--dry-run");
const pkg = packageInfo();

/** `remote: true` marks the steps that leave this machine, so the dry-run output says which is which. */
function run(command: string, args: string[], { remote = false } = {}): number {
	if (dryRun) {
		console.log(`flypi update: would run${remote ? " [remote]" : ""}: ${command} ${args.join(" ")}`);
		return 0;
	}
	return spawnSync(command, args, { stdio: "inherit" }).status ?? 1;
}
/** The daemon CLI, for the stop and the start — so the port/interface carry-over lives in one place. */
const cli = (...args: string[]) => run(process.execPath, [resolve(import.meta.dirname, "flypi.mjs"), "--root", root, ...args]);

if (pkg.checkout) {
	// The registry only knows what `npm publish` put there, and a checkout has the source in front of it.
	console.log(`flypi: ${pkg.version} is a checkout at ${packageDir()} — update it with git:`);
	console.log("flypi:   git pull --ff-only && npm install && npm run build, then `flypi restart`");
	process.exit(0);
}

const stamp = await checkForUpdate({ current: pkg.version, name: pkg.name });
// A package the daemon already downloaded stays staged; `--check` leaves the stamp as it is.
stamp.download = keepDownload(stamp, readUpdateCheck(root));
if (!dryRun) writeUpdateCheck(root, stamp);
if (stamp.error) {
	console.log(`flypi: no update check: ${stamp.error}`);
	process.exit(0);
}
const step = updateAvailable(stamp, pkg.version);
if (!step) {
	console.log(`flypi: ${pkg.version} is the newest published version of ${pkg.name}`);
	process.exit(0);
}
// One step, never a jump: flypi's databases migrate when the version that needs the migration starts, so
// 0.1.0 → 0.3.0 would skip what 0.2.0 would have done to the schema (src/daemon/update.ts).
const further = stamp.latest && isNewer(step, stamp.latest) ? ` — one step at a time; ${stamp.latest} is the newest published` : "";
console.log(`flypi: ${pkg.version} → ${step}${further}`);
if (checkOnly) {
	console.log(stamp.download ? `flypi: ${step} is downloaded; it installs the next time the daemon is idle` : "flypi: `flypi update` installs it");
	process.exit(0);
}
if (!stamp.dist?.tarball) {
	console.error(`flypi: the registry named no package for ${step} to download`);
	process.exit(1);
}
if (!isGlobalInstall()) console.log("flypi: note — this code is not the npm global package, so `npm install -g` may not replace it");

const downloaded = await downloadUpdate({ root, version: step, dist: stamp.dist });
if (dryRun) {
	console.log(`flypi update: would download ${stamp.dist.tarball}, verify it against the registry's checksum, then:`);
	cli("stop");
	run("npm", installArgs("<the downloaded package>"), { remote: true });
	cli("start");
	process.exit(0);
}
if (!downloaded.file) {
	console.error(`flypi: ${step} could not be downloaded: ${downloaded.error}`);
	process.exit(1);
}
stamp.download = { version: step, file: downloaded.file, at: new Date().toISOString() };
writeUpdateCheck(root, stamp);

cli("stop");
const installed = run("npm", installArgs(downloaded.file), { remote: true });
if (installed === 0) clearUpdateCheck(root);
cli("start");
if (installed !== 0) console.error("flypi: the install failed — the daemon is running the version it had");
else console.log(`flypi: ${pkg.name}@${step} installed${further}`);
process.exit(installed);
