/**
 * C1's instrument (docs/prompt-cache.md): one real conversation, two turns, on a real route. A turn boundary
 * is where the prompt cache is allowed to break (Phase 4.7), and `npm run probe` runs one turn, so it never
 * measures that. This prints what the provider reported per model call and per turn — the same accounting
 * `src/memory/recall.ts` writes into the `turns` row — plus the size of the block each turn injected and the
 * session prompt it carries.
 *
 *   npm run probe:turn -- local/llama_a
 *
 * Needs the memory MCP service up and FLYPI_MEMORY_TOKEN set, or recall degrades to the short "unreachable"
 * note and nothing is persisted — which since C2 means the boundary is clean for the wrong reason, so a run
 * without the token measures nothing about the block.
 *
 * What a healthy run looks like since C2 (docs/prompt-cache.md): the block's message appears once, after the
 * turn that retrieved it, with the same hash in every later request, and the first call of turn 2 re-pays only the
 * new user message (18–19 tokens on the routes configured here) where C1 measured thousands.
 *
 * `FLYPI_CACHE_PROBE=1` adds the request half of the picture: one line per model request, and one per message
 * inside it, hashed (src/shared/cache-probe.ts). Two runs of the same command then answer the question the
 * usage numbers cannot on their own — the 0-vs-1462 at a boundary is either the request bytes changing
 * (diff shows where) or the route dropping a prefix it was given (diff is empty).
 *
 * `--no-memory` runs the same two turns with no memory server configured, which is C1's control: nothing
 * transient is injected, so the prefix is byte-identical across the boundary and whatever the route still
 * re-pays is its own forgetting, not the block's. `probe:boundary` prices the block case from the
 * conversations that really ran.
 *
 * `--goal` puts a goal on the session and turns the round driver on (docs/goals.md 9.3), which is how the
 * per-round boundary cost gets re-taken on the route you actually run: turn 1 ends at the settle boundary,
 * the round prompt is appended there, and one continuation follows. `maxRounds: 1` keeps it to that one
 * round — this prices a boundary, not a goal that runs to 16.
 */
import { createHash } from "node:crypto";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { GOAL_ENTRY } from "../src/agent/goals.ts";
import { flypiPaths } from "../src/agent/paths.ts";
import { createFlypiSession } from "../src/agent/runtime.ts";
import { cacheProbeEnabled, cacheProbeLines } from "../src/shared/cache-probe.ts";
import { addUsage, emptyUsage, usageOf } from "../src/shared/transcript.ts";

const PROMPTS = ["List the files in the current directory.", "How many of those are markdown files?"];
const args = process.argv.slice(2);
const control = args.includes("--no-memory");
const goalRound = args.includes("--goal");
const modelRef = args.find((arg) => !arg.startsWith("--"));
const probing = cacheProbeEnabled();
let blockChars = 0;
let requests = 0;

const paths = flypiPaths(process.cwd());
if (control) console.log("memory: off — no recalled block, no memory instruction in the prompt (C1's control)");
const modelRuntime = await ModelRuntime.create({ authPath: paths.authPath, modelsPath: paths.modelsPath });
const model = modelRef ? modelRuntime.getModel(modelRef.slice(0, modelRef.indexOf("/")), modelRef.slice(modelRef.indexOf("/") + 1)) : undefined;
if (modelRef && !model) throw new Error(`no such model: ${modelRef}`);
const { session } = await createFlypiSession({
	root: paths.root,
	tools: ["read", "bash"],
	// The control takes the memory server out of *this session's* config rather than out of the file: the
	// same "no memory server configured" the app gets when mcp.json is absent, and nothing on disk changes,
	// so a SIGKILL or a second overlapping run cannot leave the real config disabled. `blockChars=0` in the
	// output below is the proof the control really ran.
	...(control ? { mcpConfig: { servers: [], errors: [] } } : {}),
	// The driver is opt-in per process; a probe that wants the round boundary asks for it explicitly.
	...(goalRound ? { goalDriver: true } : {}),
	...(model ? { model } : {}),
	onMemoryBlock: (block) => {
		blockChars = block.length;
	},
});

// pi's own seam for looking at a request without changing it: `onPayload` is called with the body the
// provider is about to get, and returning undefined keeps it. This is the only view of the bytes a prefix
// cache actually keys on — pi's internal context still carries timestamps and other fields the adapter drops.
if (probing) {
	session.agent.onPayload = (payload) => {
		requests += 1;
		console.log([`request ${requests}`, ...cacheProbeLines(payload)].join("\n"));
	};
	console.log(`FLYPI_CACHE_PROBE=1: hashing every request; diff two runs to see what the route could not reuse`);
}

if (goalRound) {
	// The goal is a session entry, so this is what a conversation that already holds one looks like: the entry
	// is the whole state, and `maxRounds: 1` means turn 1 pays exactly one round before the cap blocks it.
	session.sessionManager.appendCustomEntry(GOAL_ENTRY, {
		id: "probe-round",
		objective: PROMPTS[1],
		phase: "active",
		maxRounds: 1,
		revision: 1,
		at: new Date().toISOString(),
	});
	console.log("goal: active, maxRounds=1 — turn 1 ends at the settle boundary and one round prompt follows");
}
let turn = 0;
for (const prompt of PROMPTS) {
	turn += 1;
	const before = session.messages.length;
	blockChars = 0;
	const sys = session.systemPrompt ?? "";
	console.log(`turn ${turn} systemPrompt chars=${sys.length} sha=${createHash("sha256").update(sys).digest("hex").slice(0, 12)}`);
	await session.prompt(prompt);
	let total = emptyUsage();
	let calls = 0;
	for (const message of session.messages.slice(before)) {
		const usage = usageOf((message as { usage?: unknown })?.usage);
		if (!usage) continue;
		calls += 1;
		total = addUsage(total, usage);
		console.log(
			`turn ${turn} call ${calls}  prompt=${usage.input + usage.cacheRead + usage.cacheWrite} in=${usage.input} out=${usage.output} cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite}`,
		);
	}
	console.log(`turn ${turn} TOTAL    in=${total.input} out=${total.output} cacheRead=${total.cacheRead} cacheWrite=${total.cacheWrite} blockChars=${blockChars}`);
}
session.dispose();
// shortcut: the MCP client keeps a socket open after the last turn, so the process would outlive its
// output; exiting from the write callback is the smallest way to make this usable in a pipeline.
process.stdout.write("done\n", () => process.exit(0));
