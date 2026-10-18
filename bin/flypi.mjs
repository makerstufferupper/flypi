#!/usr/bin/env node
/**
 * The installed entry point (`bin: flypi`). Its only job is the default state directory: a published app
 * keeps its `.flypi/` in the home directory, so `npx flypi` from anywhere finds the same memories and the
 * same vault, instead of one per cwd. `--root DIR` or `FLYPI_ROOT` override it.
 *
 * A checkout is unchanged: `scripts/flypi.mjs` still defaults to cwd, which is what `npm run flypi`,
 * `./start.sh` and the tests rely on. So the two defaults live in two files, deliberately.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Checked before anything is imported, so an old Node gets this sentence rather than a tsx stack trace.
// Read from package.json rather than repeated here: this floor is pi's own, and start.mjs cannot import
// anything (it runs before npm install), so the two entry points would otherwise drift.
const pkg = resolve(import.meta.dirname, "..", "package.json");
const min = /(\d+\.\d+\.\d+)/.exec(JSON.parse(readFileSync(pkg, "utf8")).engines.node)?.[1] ?? "0.0.0";
const compare = (a, b) => a.split(".").reduce((diff, part, i) => diff || Math.sign(Number(part) - Number(b.split(".")[i] ?? 0)), 0);
if (compare(process.versions.node, min) < 0) {
	console.error(`flypi needs Node >= ${min}; this is ${process.versions.node}. Install a newer Node (24+ recommended for node:sqlite).`);
	process.exit(1);
}

// `??=` so an explicit FLYPI_ROOT, or `--root`, still wins inside scripts/flypi.mjs.
process.env.FLYPI_ROOT ??= homedir();
await import("../scripts/flypi.mjs");
