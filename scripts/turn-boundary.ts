/**
 * C1's instrument for real conversations (docs/prompt-cache.md Phase 4.7): what the turn boundary cost, in
 * tokens, in the conversations flypi actually ran.
 *
 *   npm run probe:boundary            # every .flypi/sessions/*.jsonl
 *   npm run probe:boundary -- path    # one session file, or another sessions dir
 *
 * It reads the provider's own numbers out of pi's session log — the same accounting `turns.usage_json` holds
 * (Phase 4.6 A1), summed per turn there — and splits the model calls at the only place the prompt cache is
 * allowed to break: the first call of a turn. Nothing here asks a model anything, so it re-runs on any
 * machine that has the session files.
 *
 * `probe:turn` is the other half: it runs one two-turn conversation on a live route, and `--no-memory` runs
 * it with nothing transient injected, which is how you tell the break apart from the route forgetting its
 * cache anyway.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { flypiPaths } from "../src/agent/paths.ts";
import { modelCalls, spread, summarise, type ModelCall } from "../src/shared/turn-boundary.ts";

const sessionsDir = flypiPaths(process.cwd()).sessionsDir;
const target = resolve(process.argv[2] ?? sessionsDir);
if (!existsSync(target)) {
	console.error(`no session files at ${target} — flypi keeps them in ${sessionsDir}`);
	process.exit(1);
}
const files = statSync(target).isDirectory()
	? readdirSync(target).filter((name) => name.endsWith(".jsonl")).sort().map((name) => `${target}/${name}`)
	: [target];

for (const file of files) {
	const calls = modelCalls(readFileSync(file, "utf8"));
	const summary = summarise(calls);
	if (summary.boundaries === 0) continue; // one-turn conversations have no boundary to price
	console.log(`${file.split("/").pop()}  ${calls[0]?.model ?? "?"}  model calls=${calls.length}`);
	for (const call of calls.filter((c: ModelCall) => c.firstCallOfTurn && c.carry > 0)) {
		console.log(
			`  boundary  prompt=${call.prompt} reused=${call.reused} repaid=${call.repaid} could_reuse=${call.carry}`,
		);
	}
}

const all = summarise(files.flatMap((file) => modelCalls(readFileSync(file, "utf8"))));
console.log(
	[
		`turn boundaries after the first turn: ${all.boundaries}`,
		`  re-paid (min/median/max tokens):        ${spread(all.paid)}  total=${all.paid.reduce((a, b) => a + b, 0)}`,
		`  the prefix that was there to reuse:     ${spread(all.carry)}`,
		`  inside a turn, the same conversations:  n=${all.withinTurn.length} re-paid ${spread(all.withinTurn)}`,
	].join("\n"),
);
