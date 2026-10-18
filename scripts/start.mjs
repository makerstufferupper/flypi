#!/usr/bin/env node
/**
 * Phase 7 startup (docs/architecture.md): one command to bring up the **dev** instance on a machine
 * that has nothing but Node. `start.sh` (macOS/Linux) and `start.cmd` (Windows) exist only to check
 * that Node is there — everything below is one Node script, so all three OSes behave identically.
 *
 *   ./start.sh | start.cmd            # or: npm run start
 *   node scripts/start.mjs --skip-models --skip-verify --turn --root DIR
 *
 * In order, and never silently:
 *   1. Node >= 22.19 (pi 1.0.4 engines; 24+ recommended for `node:sqlite`)
 *   2. `npm install` when node_modules is missing or package-lock.json changed since the last install
 *   3. `.flypi/agent/` config: settings.json + models.json templates when absent, and the
 *      `flypi-memory` entry in mcp.json with a token generated once and kept (0600, gitignored)
 *   4. download the memory models into `.flypi/models` (`npm run models:warm`)
 *   5. verify: `npm run probe -- --no-turn` (config + isolation) always, and one real model turn on a
 *      fresh config, where a working endpoint is the thing that has just been wired up
 *   6. start both halves of the dev instance — the memory MCP server and Vite — and print the URL
 *
 * It runs *before* `npm install`, so it imports nothing from `src/` and needs no dependency: the agent
 * config is plain JSON, read and written here directly. `memoryEndpoint()` in src/agent/config-files.ts
 * stays the authority for a running app; this is only what makes that file exist the first time.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MIN_NODE = "22.19.0";
const MEMORY_PORT = 8790;
const DEV_AGENT_PORT = Number(process.env.FLYPI_DEV_PORT ?? 56789);
const DEV_UI_PORT = Number(process.env.FLYPI_UI_PORT ?? 5173);

/** The starting config for a machine with nothing configured: a local OpenAI-compatible endpoint. */
const SETTINGS_TEMPLATE = {
	defaultProvider: "lmstudio",
	defaultModel: "replace-with-your-model-id",
	defaultThinkingLevel: "low",
	defaultTools: ["read", "bash", "edit", "write"],
};
const MODELS_TEMPLATE = {
	providers: {
		lmstudio: {
			baseUrl: "http://127.0.0.1:1234/v1",
			api: "openai-completions",
			// A placeholder: pi accepts any value here, which is how a local server stays usable
			// without a credential (src/agent/onboarding.ts). Replace it for a real provider.
			apiKey: "lmstudio-local",
			compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
			models: [
				{
					id: "replace-with-your-model-id",
					input: ["text"],
					contextWindow: 32768,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			],
		},
	},
};

/** The Node check, apart from the process so it can be tested against a version string. */
export function nodeProblem(version = process.versions.node) {
	const want = MIN_NODE.split(".").map(Number);
	const have = version.split(".").map(Number);
	for (let i = 0; i < want.length; i++) {
		if ((have[i] ?? 0) < want[i]) {
			return `Node ${MIN_NODE} or newer is required (found ${version}) — install it from https://nodejs.org. 24+ is recommended: flypi uses the built-in node:sqlite.`;
		}
		if ((have[i] ?? 0) > want[i]) break;
	}
	return undefined;
}

function readJson(file, fallback) {
	if (!existsSync(file)) return fallback;
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new Error(`${file} is not valid JSON: ${error.message}`);
	}
}

/** 0600 like every other file flypi writes here: mcp.json holds the memory token. */
function writeJson(file, value) {
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	chmodSync(file, 0o600);
}

/**
 * Make `.flypi/agent/` exist and hold something that starts. Existing files are never rewritten: a
 * working `models.json` carries compat, cost and context windows this script has no idea about, and
 * clobbering one is worse than a fresh clone.
 *
 * The memory token is generated once and then read back from the file, so re-running the script does
 * not invalidate a store that already has memories. An entry already using `${FLYPI_MEMORY_TOKEN}` is
 * left alone — the token then comes from the environment, which `startDev` supplies either way.
 */
export function ensureConfig(root, env = process.env) {
	const dir = join(root, ".flypi", "agent");
	mkdirSync(dir, { recursive: true });
	const created = [];

	for (const [name, template] of [
		["settings.json", SETTINGS_TEMPLATE],
		["models.json", MODELS_TEMPLATE],
	]) {
		const file = join(dir, name);
		// Absent, or the empty pair the daemon writes for a root that has no config of its own: an empty
		// object holds nothing to lose, and a checkout that ran `flypi start` once still gets the template.
		if (!existsSync(file) || Object.keys(readJson(file, {})).length === 0) {
			writeJson(file, template);
			created.push(name);
		}
	}

	const mcpPath = join(dir, "mcp.json");
	const file = readJson(mcpPath, {});
	const servers = file.mcpServers ?? {};
	const entry = servers["flypi-memory"];
	let port = MEMORY_PORT;
	let token;
	if (!entry) {
		token = randomBytes(24).toString("hex");
		servers["flypi-memory"] = {
			url: `http://127.0.0.1:${MEMORY_PORT}/mcp`,
			description: "flypi memory store: memory_search, memory_write, memory_read, memory_supersede, memory_forget",
			headers: { Authorization: `Bearer ${token}` },
			exposure: "direct",
		};
		writeJson(mcpPath, { ...file, mcpServers: servers });
		created.push("mcp.json (flypi-memory entry, token generated)");
	} else {
		const bearer = /^Bearer\s+(.*)$/.exec(String(entry.headers?.Authorization ?? ""))?.[1];
		token = bearer && bearer !== "${FLYPI_MEMORY_TOKEN}" ? bearer : env.FLYPI_MEMORY_TOKEN || randomBytes(24).toString("hex");
		const url = entry.url ? new URL(entry.url) : undefined;
		if (url?.port) port = Number(url.port);
	}
	return { token, port, created };
}

/** Why an install is needed, or undefined when the tree already matches the lockfile. */
export function installReason(root) {
	if (!existsSync(join(root, "node_modules"))) return "no node_modules";
	const lock = join(root, "package-lock.json");
	if (!existsSync(lock)) return undefined;
	const hash = createHash("sha256").update(readFileSync(lock)).digest("hex");
	const stamp = join(root, ".flypi", "install-stamp");
	if (existsSync(stamp) && readFileSync(stamp, "utf8").trim() === hash) return undefined;
	return "package-lock.json changed since the last install";
}

/** True when something is already listening — the dev instance dies on EADDRINUSE, so say so first. */
export function portInUse(port, host = "127.0.0.1") {
	return new Promise((done) => {
		const socket = connect({ port, host });
		socket.setTimeout(500);
		socket.once("connect", () => {
			socket.destroy();
			done(true);
		});
		socket.once("timeout", () => {
			socket.destroy();
			done(false);
		});
		socket.once("error", () => done(false));
	});
}

/** npm on Windows is a .cmd, which Node refuses to spawn without a shell. The args here are fixed. */
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const SHELL = process.platform === "win32";

function runNpm(checkout, ...args) {
	return spawnSync(NPM, ["run", ...args], { cwd: checkout, stdio: "inherit", shell: SHELL }).status ?? 1;
}

async function main() {
	const argv = process.argv.slice(2);
	const flagValue = (name) => {
		const i = argv.indexOf(name);
		return i === -1 ? undefined : argv[i + 1];
	};
	// The checkout this script lives in is where npm runs — that is where package.json, node_modules and
	// tsx are. `--root` says which `.flypi/` the instance owns, the same split scripts/flypi.mjs uses.
	const checkout = resolve(fileURLToPath(import.meta.url), "..", "..");
	const root = resolve(flagValue("--root") ?? checkout);

	const node = nodeProblem();
	if (node) {
		console.error(`flypi: ${node}`);
		process.exit(1);
	}
	console.log(`flypi: node ${process.versions.node}, root ${root}`);

	const why = installReason(checkout);
	if (why) {
		console.log(`flypi: npm install (${why})`);
		if (spawnSync(NPM, ["install"], { cwd: checkout, stdio: "inherit", shell: SHELL }).status !== 0) {
			console.error("flypi: npm install failed — nothing else can run until it succeeds");
			process.exit(1);
		}
		const stamp = join(checkout, ".flypi", "install-stamp");
		mkdirSync(join(stamp, ".."), { recursive: true });
		writeFileSync(stamp, createHash("sha256").update(readFileSync(join(checkout, "package-lock.json"))).digest("hex"));
	}

	const config = ensureConfig(root);
	for (const name of config.created) console.log(`flypi: wrote ${join(root, ".flypi", "agent", name)}`);
	if (config.created.includes("models.json")) {
		console.log("flypi: models.json is a template — set the provider, baseUrl and model id your server actually serves (the settings gear in the UI edits the same file)");
	}

	if (!argv.includes("--skip-models")) {
		console.log("flypi: fetching the memory models into .flypi/models (first run downloads them, later runs are instant)");
		if (runNpm(checkout, "models:warm", "--", "--root", root) !== 0) {
			console.error("flypi: the embedding model did not load. Memory search would fall back to keywords; re-run with --skip-models to start anyway, or fix the network and run again.");
			process.exit(1);
		}
	}

	if (!argv.includes("--skip-verify")) {
		console.log("flypi: verifying the config (probe --no-turn)");
		if (runNpm(checkout, "probe", "--", "--no-turn", "--root", root) !== 0) {
			console.error("flypi: the config does not start a session — fix what probe says above");
			process.exit(1);
		}
		// A real turn only on a config that was just created: that is the thing worth proving, and on
		// every later start it would spend tokens and a local server's time to prove nothing new.
		if (config.created.length > 0 || argv.includes("--turn")) {
			console.log("flypi: running one real turn through the configured model");
			if (runNpm(checkout, "probe", "--", "--root", root) !== 0) {
				console.error("flypi: the config is wired, but the model did not answer. Start the model server, or fix .flypi/agent/models.json — the UI and its settings gear will still come up.");
			}
		}
	}

	for (const [what, port] of [
		["memory server", config.port],
		["dev agent server", DEV_AGENT_PORT],
		["dev UI (Vite)", DEV_UI_PORT],
	]) {
		if (await portInUse(port)) {
			console.error(`flypi: something is already listening on ${port} (${what}). Stop it first — for flypi's own daemon: node scripts/flypi.mjs stop`);
			process.exit(1);
		}
	}

	startDev(checkout, root, config);
}

/**
 * Both halves of dev in one command: the memory MCP server (a separate process by design — the store
 * has one writer) and Vite, which starts the agent server in its own process. Ctrl-C stops all three;
 * they share the terminal's process group, which is also how Windows delivers it.
 * shortcut: no restart-on-crash, dev is a foreground thing; if a half needs to survive, that is the
 * daemon (`node scripts/flypi.mjs start`), not this.
 */
function startDev(checkout, root, config) {
	const env = { ...process.env, FLYPI_MEMORY_TOKEN: config.token };
	const children = [
		spawn(NPM, ["run", "memory", "--", "--root", root, "--port", String(config.port), "--token", config.token], { cwd: checkout, stdio: "inherit", shell: SHELL, env }),
		// --strictPort so the URL printed below is the URL Vite is on: without it Vite silently takes the
		// next free port and the line the user clicks would be a guess.
		spawn(NPM, ["run", "dev", "--", "--port", String(DEV_UI_PORT), "--strictPort"], { cwd: checkout, stdio: "inherit", shell: SHELL, env }),
	];
	console.log(`flypi: UI http://localhost:${DEV_UI_PORT} — agent server on port ${DEV_AGENT_PORT}, memory MCP on ${config.port}`);
	let stopping = false;
	const stop = () => {
		if (stopping) return;
		stopping = true;
		for (const child of children) child.kill("SIGTERM");
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	for (const child of children) {
		child.on("exit", (code) => {
			// One half dying is a broken dev instance, so neither stays up: the UI without memory is a
			// chat that silently forgets, and memory without the UI has nobody to talk to.
			if (!stopping) {
				console.error(`flypi: a half of the dev instance exited (code ${code}) — stopping the other`);
				stop();
			}
		});
	}
}

// Run when invoked directly, import as a module when a test wants the helpers (tests/scripts/start.test.ts).
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	await main();
}
