/**
 * Stage 1 of the pi upgrade probe (docs/pi-upgrades.md Phase 8.2): does a candidate pi still offer the
 * surface flypi imports? Imports, deep paths and the Node floor, in a child process, with nothing restarted.
 *
 * Run: `npm run probe:pi -- --candidate DIR` — DIR is a tree built by `npm install --prefix` (Phase 8.3), or
 * this repo's own root to check the pi that is already installed. Exit 0 clean, 1 with one line per problem.
 *
 * A clean run means "nothing renamed, moved or raised a floor", not "flypi works on it". The behavioural
 * half of pi's API is only covered by `npm test` and `npm run smoke` (docs/risks.md risk 14).
 */
import { checkPiCompat } from "../src/agent/pi-compat.ts";

const argv = process.argv.slice(2);
const candidate = argv[argv.indexOf("--candidate") + 1] ?? process.cwd();
const failures = await checkPiCompat(candidate);
for (const failure of failures) console.error(`pi compat: ${failure}`);
console.log(failures.length ? `pi compat: ${failures.length} problem(s) in ${candidate}` : `pi compat: ok — ${candidate}`);
process.exit(failures.length ? 1 : 0);
