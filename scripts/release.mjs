#!/usr/bin/env node
/**
 * `npm run release [patch|minor|major] [--dry-run]` — the version bump *is* the release.
 *
 * package.json is the single version: the daemon reports it on `/healthz`, `flypi status` prints it, and the
 * update check compares against it. So the increment is `npm version`, which bumps it, commits, and tags
 * `v<version>` — and refuses to run on a dirty tree, which is the gate that makes a tag mean something.
 * Then push the tag and publish; npm runs `prepublishOnly` (typecheck, tests, the UI build) on the way to
 * the registry, so anything that gets published has passed the gates.
 *
 * `--dry-run` prints every step and runs none of them.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const kind = argv.find((a) => ["patch", "minor", "major", "preminor", "premajor"].includes(a)) ?? "patch";

/** `remote: true` marks the two steps that leave this machine, so the dry-run output says which is which. */
function run(command, args, { remote = false } = {}) {
	if (dryRun) {
		console.log(`flypi release: would run${remote ? " [remote]" : ""}: ${command} ${args.join(" ")}`);
		return 0;
	}
	const result = spawnSync(command, args, { stdio: "inherit" });
	if (result.status !== 0) process.exit(result.status ?? 1);
	return result.status;
}

run("npm", ["version", kind, "-m", "release %s"]);
const version = JSON.parse(readFileSync("package.json", "utf8")).version;
run("git", ["push", "--follow-tags"], { remote: true });
run("npm", ["publish", "--access", "public"], { remote: true });
console.log(dryRun ? `flypi release: dry run only - a ${kind} bump from ${version}; nothing committed, pushed or published` : `flypi release: ${version} published`);
