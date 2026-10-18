#!/usr/bin/env node
/**
 * Phase 0 gate: prove the pi runtime is isolated to .flypi/ and can complete a turn.
 *
 *   npm run probe                 # config check + one real turn ("list files in cwd")
 *   npm run probe -- --no-turn    # config check only (offline / CI)
 *   npm run probe -- --root DIR   # check a different checkout
 *   npm run probe -- --model provider/id   # run that route instead of the settings default
 *
 * Exits 1 with a one-line message on any problem — never a stack trace.
 * The session wiring itself lives in src/agent/runtime.ts, which the server shares.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { assertFlypiOwned, flypiPaths } from "../src/agent/paths.ts";
import { createFlypiSession, FlypiConfigError, type FlypiModel } from "../src/agent/runtime.ts";
import { addUsage, emptyUsage, usageOf } from "../src/shared/transcript.ts";

function fail(message: string): never {
	console.error(`flypi probe: ${message}`);
	process.exit(1);
}

const argv = process.argv.slice(2);
const flagValue = (name: string): string | undefined => {
	const i = argv.indexOf(name);
	return i === -1 ? undefined : argv[i + 1];
};
const root = resolve(flagValue("--root") ?? process.cwd());
const noTurn = argv.includes("--no-turn");
const modelRef = flagValue("--model");
const paths = flypiPaths(root);

try {
	assertFlypiOwned(paths);
} catch (error) {
	fail((error as Error).message);
}

console.log(`config dir   ${paths.agentDir}`);
console.log(`sessions     ${paths.sessionsDir}`);

const modelRuntime = await ModelRuntime.create({ authPath: paths.authPath, modelsPath: paths.modelsPath });
let model: FlypiModel | undefined;
if (modelRef) {
	const slash = modelRef.indexOf("/");
	if (slash < 1) fail(`--model wants "provider/id", got "${modelRef}"`);
	model = modelRuntime.getModel(modelRef.slice(0, slash), modelRef.slice(slash + 1));
	if (!model) fail(`model "${modelRef}" is not defined in ${paths.modelsPath}`);
}

let session;
try {
	({ session } = await createFlypiSession({ root, tools: ["read", "bash"], modelRuntime, model }));
} catch (error) {
	if (!(error instanceof FlypiConfigError)) throw error;
	fail(error.message);
}

const tools = session.getActiveToolNames();
const mcp = (
	JSON.parse(readFileSync(paths.mcpPath, "utf8")) as { mcpServers?: Record<string, unknown> }
).mcpServers ?? {};

console.log(`model        ${session.model?.provider}/${session.model?.id}`);
console.log(`thinking     ${session.thinkingLevel}`);
console.log(`tools        ${tools.join(", ")}`);
console.log(`session file ${session.sessionFile ?? "(none)"}`);
console.log(`mcp servers  ${Object.keys(mcp).join(", ") || "(none configured)"} — connecting them is Phase 5`);

if (!tools.includes("read") || !tools.includes("bash")) {
	fail(`expected the read and bash tools to be active, got: ${tools.join(", ") || "(none)"}`);
}

if (!noTurn) {
	const used = new Set<string>();
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "tool_execution_start") used.add(event.toolName);
	});
	try {
		await session.prompt("List the files in the current directory.");
	} catch (error) {
		fail(`the turn failed: ${(error as Error).message}`);
	} finally {
		unsubscribe();
	}
	const answer = session.getLastAssistantText();
	console.log(`turn tools   ${[...used].join(", ") || "(none)"}`);
	console.log(`turn answer  ${answer ?? "(none)"}`);
	if (!answer) fail("the model returned no text");
	if (used.size === 0) fail("the turn completed without calling any tool");
	if (!session.sessionFile?.startsWith(paths.sessionsDir)) {
		fail(`session file ${session.sessionFile} is not inside ${paths.sessionsDir}`);
	}

	// Phase 4.6 A0 (docs/prompt-cache.md): whether the provider's cache numbers reach the session at all.
	// Printed, never asserted — a route that reports no cached tokens is the finding, not a probe failure.
	let total = emptyUsage();
	let calls = 0;
	for (const message of session.messages) {
		const usage = usageOf((message as { usage?: unknown }).usage);
		if (!usage) continue;
		calls++;
		total = addUsage(total, usage);
		console.log(
			`call ${calls}      in=${usage.input} out=${usage.output} cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite}`,
		);
	}
	console.log(`turn usage   in=${total.input} out=${total.output} cacheRead=${total.cacheRead} cacheWrite=${total.cacheWrite}`);
	console.log(
		`cache numbers ${
			total.cacheRead || total.cacheWrite ? "arrive" : "none — this route reported no cached tokens to the session"
		}`,
	);
}

session.dispose();
console.log("flypi probe: ok");
