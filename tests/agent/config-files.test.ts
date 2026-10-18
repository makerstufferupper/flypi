/**
 * The settings panel's half of the contract (docs/protocol.md `getConfig` / `saveConfig`): the files it
 * edits must survive a write with everything it does not show. That is what these tests are about —
 * `compat`, cost, extra headers, the other provider, the other server. The one thing the panel may never
 * do is rewrite these files from its own fields.
 */
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyConfigEdits, ensureAgentConfig, ensureMemoryEntry, memoryEndpoint, readConfig } from "../../src/agent/config-files.ts";
import { flypiPaths } from "../../src/agent/paths.ts";
import { createTempFlypiRoot } from "../helpers/flypi-root.ts";

interface Fixture {
	endpoints?: Record<string, unknown>;
	mcp?: Record<string, unknown>;
	settings?: Record<string, unknown>;
}

function agentRoot(fixture: Fixture = {}) {
	const root = createTempFlypiRoot();
	const paths = flypiPaths(root);
	if (fixture.endpoints) writeFileSync(paths.modelsPath, JSON.stringify({ providers: fixture.endpoints }, null, 2));
	if (fixture.mcp) writeFileSync(paths.mcpPath, JSON.stringify({ mcpServers: fixture.mcp }, null, 2));
	if (fixture.settings) writeFileSync(paths.settingsPath, JSON.stringify(fixture.settings, null, 2));
	return {
		root,
		paths,
		read: (file: "modelsPath" | "mcpPath" | "settingsPath") => JSON.parse(readFileSync(paths[file], "utf8")),
	};
}

/** An endpoint as the panel sends one, with nothing left out so each test changes it back. */
const endpoint = (name: string, fields: Record<string, unknown> = {}) => ({
	name,
	baseUrl: "https://chatgml.dev/v1",
	api: "openai-completions",
	apiKey: "$chatgml_API_KEY",
	models: ["gpt-4o-mini"],
	...fields,
});

const server = (name: string, fields: Record<string, unknown> = {}) => ({
	name,
	url: "http://127.0.0.1:8790/mcp",
	authorization: "Bearer ${FLYPI_MEMORY_TOKEN}",
	...fields,
});

describe("config files: reading", () => {
	it("reads the endpoints and servers as the panel shows them, with pi's defaults filled in", () => {
		const h = agentRoot({
			endpoints: {
				lmstudio: { baseUrl: "http://127.0.0.1:8000/v1", api: "openai-completions", models: [{ id: "qwen3" }, { id: 42 }, "not-an-object"] },
				"no-url": { models: [] },
			},
			mcp: {
				"flypi-memory": {
					url: "http://127.0.0.1:8790/mcp",
					headers: { Authorization: "Bearer ${FLYPI_MEMORY_TOKEN}", "X-Trace": "keep" },
					exposure: "direct",
					description: "memory store",
					// The counters flypi calls after a turn are hidden from the model this way (docs/memory.md), and
					// an env value here is a reference, not a secret — the panel must not resolve it.
					toolExposure: { memory_cite: "hidden", "read_*": "direct", not_a_level: "nope" },
					env: { FLYPI_MEMORY_TOKEN: "${VAULT_TOKEN}", COUNT: 7 },
					cwd: "./tools",
					oauth: { clientId: "cid", clientSecret: "${OAUTH_SECRET}", clientName: "keep", callbackPort: 8123 },
				},
				"stdio-one": { command: "npx", args: ["-y", "server-fs", 7], enabled: false },
				"junk": { transport: 3, args: "not a list" },
			},
			settings: { defaultProvider: "lmstudio", defaultModel: "qwen3", defaultThinkingLevel: "low", defaultTools: ["read"] },
		});

		// The default pair is read too: the panel has to show which endpoint a new conversation starts on.
		expect(readConfig(h.paths).defaults).toEqual({ provider: "lmstudio", model: "qwen3" });

		expect(readConfig(h.paths).endpoints).toEqual([
			{ name: "lmstudio", baseUrl: "http://127.0.0.1:8000/v1", api: "openai-completions", apiKey: "", models: ["qwen3"] },
			{ name: "no-url", baseUrl: "", api: "", apiKey: "", models: [] },
		]);
		// A missing `exposure`/`enabled` is pi's default, not "unknown", so the panel can show a row that
		// saving it again would not change. The maps come through in full — a row that showed only some of an
		// entry's `env` could not be written back without dropping what it did not show — but a value pi could
		// not read (an env value that is not a string, an exposure level it does not know) is not shown, and a
		// field the panel does not edit (`clientName`, `callbackPort`) is not in the row at all.
		expect(readConfig(h.paths).mcpServers).toEqual([
			{ name: "flypi-memory", url: "http://127.0.0.1:8790/mcp", command: "", args: [], authorization: "Bearer ${FLYPI_MEMORY_TOKEN}", env: { FLYPI_MEMORY_TOKEN: "${VAULT_TOKEN}" }, cwd: "./tools", description: "memory store", exposure: "direct", toolExposure: { memory_cite: "hidden", "read_*": "direct" }, oauth: { clientId: "cid", clientSecret: "${OAUTH_SECRET}", callbackUrl: "", scope: "" }, enabled: true },
			{ name: "stdio-one", url: "", command: "npx", args: ["-y", "server-fs"], authorization: "", env: {}, cwd: "", description: "", exposure: "codemode", toolExposure: {}, oauth: { clientId: "", clientSecret: "", callbackUrl: "", scope: "" }, enabled: false },
			{ name: "junk", url: "", command: "", args: [], authorization: "", env: {}, cwd: "", description: "", exposure: "codemode", toolExposure: {}, oauth: { clientId: "", clientSecret: "", callbackUrl: "", scope: "" }, enabled: true },
		]);
	});

	it("reports a file that will not parse instead of an empty config", () => {
		const h = agentRoot();
		writeFileSync(h.paths.mcpPath, "[1, 2]"); // valid JSON, wrong shape: still a file we refuse to read
		expect(readConfig(h.paths).errors.join(" ")).toContain("mcp.json must contain a JSON object");

		writeFileSync(h.paths.mcpPath, "{ mcpServers: ");
		const config = readConfig(h.paths);
		expect(config.endpoints).toEqual([]);
		expect(config.mcpServers).toEqual([]);
		// No settings.json is not an error to show: it means nothing is configured to start on yet.
		expect(config.defaults).toEqual({ provider: "", model: "" });
		expect(config.errors.join(" ")).toContain("mcp.json");
	});
});

describe("config files: writing", () => {
	it("adds an endpoint beside the existing ones and leaves the rest of the file alone", () => {
		const h = agentRoot({
			endpoints: {
				lmstudio: {
					baseUrl: "http://127.0.0.1:8000/v1",
					api: "openai-completions",
					headers: { "X-Local": "keep" },
					models: [{ id: "qwen3", name: "Qwen3", compat: { thinkingEffortMap: {} }, cost: { input: 0 } }],
				},
			},
		});

		applyConfigEdits(h.paths, { endpoints: [endpoint("chatgml")] });

		expect(h.read("modelsPath")).toEqual({
			providers: {
				lmstudio: {
					baseUrl: "http://127.0.0.1:8000/v1",
					api: "openai-completions",
					headers: { "X-Local": "keep" },
					models: [{ id: "qwen3", name: "Qwen3", compat: { thinkingEffortMap: {} }, cost: { input: 0 } }],
				},
				chatgml: { baseUrl: "https://chatgml.dev/v1", api: "openai-completions", apiKey: "$chatgml_API_KEY", models: [{ id: "gpt-4o-mini" }] },
			},
		});
	});

	it("changes only the fields an edit carries, and adds a model without disturbing the ones already defined", () => {
		const h = agentRoot({ endpoints: { lmstudio: { baseUrl: "http://127.0.0.1:8000/v1", api: "openai-completions", apiKey: "secret", models: [{ id: "qwen3", compat: { supportsTools: false } }] } } });

		applyConfigEdits(h.paths, { endpoints: [{ name: "lmstudio", baseUrl: "http://127.0.0.1:9000/v1", apiKey: "", models: ["qwen3", "qwen3-next"] }] });

		expect(h.read("modelsPath").providers.lmstudio).toEqual({
			baseUrl: "http://127.0.0.1:9000/v1",
			api: "openai-completions",
			// No apiKey: an empty one means "not in this file", which is how a credential moves to auth.json.
			models: [{ id: "qwen3", compat: { supportsTools: false } }, { id: "qwen3-next" }],
		});
		// A model id already defined is never duplicated, so saving the same row twice is the same file.
		applyConfigEdits(h.paths, { endpoints: [{ name: "lmstudio", models: ["qwen3-next"] }] });
		expect(h.read("modelsPath").providers.lmstudio.models).toHaveLength(2);
	});

	it("writes an MCP entry the way `pi mcp add` would, keeping the headers it does not show", () => {
		const h = agentRoot({ mcp: { "flypi-memory": { url: "http://127.0.0.1:8790/mcp", headers: { "X-Trace": "keep" }, env: { KEEP: "1" } } } });

		applyConfigEdits(h.paths, { mcpServers: [server("flypi-memory", { exposure: "direct", description: "memory store", enabled: true })] });

		expect(h.read("mcpPath").mcpServers["flypi-memory"]).toEqual({
			url: "http://127.0.0.1:8790/mcp",
			headers: { "X-Trace": "keep", Authorization: "Bearer ${FLYPI_MEMORY_TOKEN}" },
			env: { KEEP: "1" },
			exposure: "direct",
			description: "memory store",
		});

		// pi reads an absent `enabled`/`exposure` as true/codemode, so the panel leaves them out rather
		// than writing defaults into a file that did not need them.
		applyConfigEdits(h.paths, { mcpServers: [{ name: "flypi-memory", url: "http://127.0.0.1:8790/mcp", exposure: "codemode", enabled: true, authorization: "" }] });
		expect(h.read("mcpPath").mcpServers["flypi-memory"].enabled).toBeUndefined();
		expect(h.read("mcpPath").mcpServers["flypi-memory"].exposure).toBeUndefined();
		expect(h.read("mcpPath").mcpServers["flypi-memory"].headers).toEqual({ "X-Trace": "keep" });

		applyConfigEdits(h.paths, { mcpServers: [{ name: "flypi-memory", enabled: false, exposure: "hidden" }] });
		expect(h.read("mcpPath").mcpServers["flypi-memory"]).toMatchObject({ enabled: false, exposure: "hidden" });
	});

	it("leaves every field an edit does not name, including pi's two defaults", () => {
		// The daemon corrects a url when the port the file named turns out to be taken, and sends nothing
		// else. An edit that reset `exposure` to pi's `codemode` default there would take the memory tools
		// away from the model with nothing on screen to show it.
		const h = agentRoot({ mcp: { "flypi-memory": { url: "http://127.0.0.1:8790/mcp", headers: { Authorization: "Bearer t" }, exposure: "direct", enabled: false } } });

		applyConfigEdits(h.paths, { mcpServers: [{ name: "flypi-memory", url: "http://127.0.0.1:4123/mcp" }] });

		expect(h.read("mcpPath").mcpServers["flypi-memory"]).toEqual({
			url: "http://127.0.0.1:4123/mcp",
			headers: { Authorization: "Bearer t" },
			exposure: "direct",
			enabled: false,
		});
	});

	// The tail of the Phase 5 checklist: the fields a server needs only sometimes — the stdio environment and
	// working directory, per-tool exposure exceptions, and the OAuth client an HTTP server was pre-registered
	// with. They are written the same way as every other field: only what the edit carries, pi's defaults as
	// absent keys, and an empty value meaning "take that key out".
	it("writes an entry's environment, working directory, tool exceptions and OAuth fields", () => {
		const h = agentRoot({ mcp: { fs: { command: "npx", args: ["-y", "server-fs"], env: { KEEP: "1" }, oauth: { clientName: "keep", callbackPort: 8123 } } } });

		applyConfigEdits(h.paths, {
			mcpServers: [
				{
					name: "fs",
					env: { KEEP: "1", API_KEY: "!flypi secret print FS_KEY" },
					cwd: "/srv/docs",
					toolExposure: { read_directory: "direct", "write_*": "hidden" },
					oauth: { clientId: "cid", clientSecret: "${OAUTH_SECRET}" },
				},
			],
		});

		expect(h.read("mcpPath").mcpServers.fs).toEqual({
			command: "npx",
			args: ["-y", "server-fs"],
			env: { KEEP: "1", API_KEY: "!flypi secret print FS_KEY" },
			cwd: "/srv/docs",
			// This is the only way to hide `memory_cite` from the model while the server stays `direct`.
			toolExposure: { read_directory: "direct", "write_*": "hidden" },
			// Field by field: pi's other OAuth keys are not in the form, so they are not in the edit either.
			oauth: { clientName: "keep", callbackPort: 8123, clientId: "cid", clientSecret: "${OAUTH_SECRET}" },
		});

		// Reading the entry back and saving that row is the same file: the maps are written whole, which is
		// only safe because a row carries every entry the file has.
		const written = readFileSync(h.paths.mcpPath, "utf8");
		const { name, url, command, args, authorization, env, cwd, description, exposure, toolExposure, oauth, enabled } = readConfig(h.paths).mcpServers[0]!;
		applyConfigEdits(h.paths, { mcpServers: [{ name, url, command, args, authorization, env, cwd, description, exposure, toolExposure, oauth, enabled }] });
		expect(readFileSync(h.paths.mcpPath, "utf8")).toBe(written);

		// An emptied line drops that key, and a map left with nothing in it drops the key that held it — the
		// same rule as an emptied header, because pi reads an absent key as its default.
		applyConfigEdits(h.paths, { mcpServers: [{ name: "fs", env: { KEEP: "", API_KEY: "" }, cwd: "", toolExposure: {}, oauth: { clientId: "", clientSecret: "" } }] });
		expect(h.read("mcpPath").mcpServers.fs).toEqual({
			command: "npx",
			args: ["-y", "server-fs"],
			oauth: { clientName: "keep", callbackPort: 8123 },
		});
	});

	// An MCP entry with nothing left in it: the token was the only header, and args was emptied. pi reads
	// an absent key as its default, so an emptied field has to go away rather than become `[]` or `{}`.
	it("drops a header block whose only entry was the token, and an emptied args list", () => {
		const h = agentRoot({ mcp: { "one": { command: "npx", args: ["-y", "x"], headers: { Authorization: "Bearer old" } } } });

		applyConfigEdits(h.paths, { mcpServers: [{ name: "one", command: "npx", args: [], authorization: "" }] });

		expect(h.read("mcpPath").mcpServers["one"]).toEqual({ command: "npx" });
	});

	it("deletes one entry, and only that one", () => {
		const h = agentRoot({ endpoints: { a: { baseUrl: "http://a/v1", models: [{ id: "m" }] }, b: { baseUrl: "http://b/v1", models: [{ id: "m" }] } }, mcp: { one: { url: "http://1/v1" }, two: { url: "http://2/v1" } } });

		applyConfigEdits(h.paths, { endpoints: [{ name: "a", remove: true }], mcpServers: [{ name: "one", remove: true }] });

		expect(Object.keys(h.read("modelsPath").providers)).toEqual(["b"]);
		expect(Object.keys(h.read("mcpPath").mcpServers)).toEqual(["two"]);
	});

	it("keeps a vault or env reference as a reference, never as a resolved secret", () => {
		// docs/testing.md Phase 5: `"!flypi secret print NAME"` and `${ENV_VAR}` survive a round trip. pi
		// resolves both when it reads the file; a panel that resolved them for display would write the secret.
		const h = agentRoot();
		applyConfigEdits(h.paths, {
			endpoints: [endpoint("chatgml", { apiKey: "!flypi secret print CHATGML" })],
			mcpServers: [server("flypi-memory", { authorization: "!flypi secret print MEMORY_TOKEN", env: { MEMORY_TOKEN: "!flypi secret print MEMORY_TOKEN", BASE: "${OTHER_URL}" } })],
		});
		expect(h.read("modelsPath").providers.chatgml.apiKey).toBe("!flypi secret print CHATGML");
		expect(h.read("mcpPath").mcpServers["flypi-memory"].headers.Authorization).toBe("!flypi secret print MEMORY_TOKEN");
		// An `env` value is a reference like a header is: the vault it resolves through is Phase 5.5, and a
		// panel that "helpfully" expanded one would put the secret in a file.
		expect(h.read("mcpPath").mcpServers["flypi-memory"].env).toEqual({ MEMORY_TOKEN: "!flypi secret print MEMORY_TOKEN", BASE: "${OTHER_URL}" });
		expect(readConfig(h.paths).endpoints[0]!.apiKey).toBe("!flypi secret print CHATGML");
		expect(readConfig(h.paths).mcpServers[0]!.env).toEqual({ MEMORY_TOKEN: "!flypi secret print MEMORY_TOKEN", BASE: "${OTHER_URL}" });
		// A file that can hold a plaintext key is owner-only, like auth.json.
		expect(statSync(h.paths.modelsPath).mode & 0o777).toBe(0o600);
		expect(statSync(h.paths.mcpPath).mode & 0o777).toBe(0o600);
	});

	it("refuses an endpoint it cannot use, and an MCP entry that names neither a url nor a command", () => {
		const h = agentRoot();
		expect(() => applyConfigEdits(h.paths, { endpoints: [endpoint("chatgml", { baseUrl: "" })] })).toThrow(/baseUrl/);
		expect(() => applyConfigEdits(h.paths, { endpoints: [endpoint("chatgml", { models: [] })] })).toThrow(/no model/);
		expect(() => applyConfigEdits(h.paths, { mcpServers: [server("memory", { url: "" })] })).toThrow(/url|command/);
		expect(readConfig(h.paths).mcpServers).toEqual([]);
	});

	it("refuses a name that could not be a provider key or a tool name", () => {
		const h = agentRoot();
		for (const name of ["-mem", "flypi memory", "flypi.memory", ""]) {
			expect(() => applyConfigEdits(h.paths, { mcpServers: [server(name)] }), name).toThrow(/letters, digits/);
		}
	});

	it("leaves the file untouched when a later edit in the same request is rejected", () => {
		const h = agentRoot({ endpoints: { lmstudio: { baseUrl: "http://127.0.0.1:8000/v1", models: [{ id: "qwen3" }] } } });
		const before = readFileSync(h.paths.modelsPath, "utf8");

		expect(() => applyConfigEdits(h.paths, { endpoints: [endpoint("chatgml"), endpoint("bad name")] })).toThrow(/letters, digits/);
		expect(readFileSync(h.paths.modelsPath, "utf8")).toBe(before);
	});

	it("creates a config file that is not there yet", () => {
		const h = agentRoot();
		applyConfigEdits(h.paths, { mcpServers: [server("flypi-memory")] });
		expect(readConfig(h.paths).mcpServers).toEqual([
			{ name: "flypi-memory", url: "http://127.0.0.1:8790/mcp", command: "", args: [], authorization: "Bearer ${FLYPI_MEMORY_TOKEN}", env: {}, cwd: "", description: "", exposure: "codemode", toolExposure: {}, oauth: { clientId: "", clientSecret: "", callbackUrl: "", scope: "" }, enabled: true },
		]);
	});
});

describe("config files: the empty pair a fresh install has neither of", () => {
	it("writes both when they are missing, and never touches one that exists", () => {
		const h = agentRoot();
		// The shared fixture root starts with an empty `settings.json` (tests/helpers/flypi-root.ts); this is
		// the state of an install that has never written either file.
		for (const file of [h.paths.settingsPath, h.paths.modelsPath]) rmSync(file, { force: true });
		expect(existsSync(h.paths.settingsPath)).toBe(false);

		expect(ensureAgentConfig(h.paths)).toEqual([h.paths.settingsPath, h.paths.modelsPath]);
		expect(h.read("settingsPath")).toEqual({});
		expect(h.read("modelsPath")).toEqual({});
		// They hold a key as soon as the panel adds an endpoint, so they are never group-readable.
		for (const file of [h.paths.settingsPath, h.paths.modelsPath]) expect(statSync(file).mode & 0o777).toBe(0o600);
		// Why write them at all: the panel reads an empty config instead of an error, and a new conversation
		// says which half is missing instead of reporting a file the install never had.
		expect(readConfig(h.paths).errors).toEqual([]);
		expect(ensureAgentConfig(h.paths)).toEqual([]);

		// A file that exists is left alone — even one that will not parse, which is the operator's to fix.
		writeFileSync(h.paths.modelsPath, "{ not json");
		expect(ensureAgentConfig(h.paths)).toEqual([]);
		expect(readFileSync(h.paths.modelsPath, "utf8")).toBe("{ not json");
		expect(readConfig(h.paths).errors.join("\n")).toMatch(/models\.json/);
	});
});

describe("config files: the default a new conversation starts on", () => {
	it("writes defaultProvider and defaultModel and leaves the rest of settings.json alone", () => {
		const h = agentRoot({
			endpoints: { lmstudio: { baseUrl: "http://127.0.0.1:8000/v1", models: [{ id: "qwen3" }, { id: "qwen3-next" }] } },
			settings: { defaultProvider: "other", defaultModel: "whatever", defaultThinkingLevel: "low", defaultTools: ["read", "bash"], customKey: { keep: 1 } },
		});

		applyConfigEdits(h.paths, { defaults: { provider: "lmstudio", model: "qwen3-next" } });

		// Only the two keys flypi owns are touched; the thinking level, the tool list and a key this app
		// does not know about stay exactly as they were (src/agent/runtime.ts reads the two it needs).
		expect(h.read("settingsPath")).toEqual({
			defaultProvider: "lmstudio",
			defaultModel: "qwen3-next",
			defaultThinkingLevel: "low",
			defaultTools: ["read", "bash"],
			customKey: { keep: 1 },
		});
		expect(readConfig(h.paths).defaults).toEqual({ provider: "lmstudio", model: "qwen3-next" });
		// It can name a model, so it is owner-only like the other two.
		expect(statSync(h.paths.settingsPath).mode & 0o777).toBe(0o600);
	});

	it("refuses a default that would make the next conversation unresolvable", () => {
		const h = agentRoot({
			endpoints: { lmstudio: { baseUrl: "http://127.0.0.1:8000/v1", models: [{ id: "qwen3" }] } },
			settings: { defaultProvider: "lmstudio", defaultModel: "qwen3" },
		});

		// An endpoint that is not there, and a model that endpoint does not define: both are a
		// `resolveConfiguredModel()` failure waiting for the next new session, so they are refused here
		// where the message can name what to fix.
		expect(() => applyConfigEdits(h.paths, { defaults: { provider: "nowhere", model: "qwen3" } })).toThrow(/names no endpoint/);
		expect(() => applyConfigEdits(h.paths, { defaults: { provider: "lmstudio", model: "gpt-4o" } })).toThrow(/it defines qwen3/);
		expect(h.read("settingsPath")).toEqual({ defaultProvider: "lmstudio", defaultModel: "qwen3" });
	});

	it("accepts a default pointing at a model id the same request just added", () => {
		// The default is checked against the files as they are after the endpoint edits, not before them.
		const h = agentRoot({ endpoints: { llama_d: { baseUrl: "http://127.0.0.1:8000/v1", models: [{ id: "llama_d" }] } } });

		applyConfigEdits(h.paths, {
			endpoints: [{ name: "llama_d", models: ["llama_d_pro"] }],
			defaults: { provider: "llama_d", model: "llama_d_pro" },
		});

		expect(readConfig(h.paths).defaults).toEqual({ provider: "llama_d", model: "llama_d_pro" });
	});

	it("creates settings.json when there is none, and leaves the other files untouched", () => {
		const h = agentRoot({ endpoints: { llama_d: { baseUrl: "http://127.0.0.1:8000/v1", models: [{ id: "m" }] } } });
		const before = readFileSync(h.paths.modelsPath, "utf8");

		applyConfigEdits(h.paths, { defaults: { provider: "llama_d", model: "m" } });

		expect(readFileSync(h.paths.modelsPath, "utf8")).toBe(before);
		expect(h.read("settingsPath")).toEqual({ defaultProvider: "llama_d", defaultModel: "m" });
	});
});

describe("config files: the daemon's own memory entry", () => {
	it("writes the entry a fresh install has none of, and never touches one that exists", () => {
		const h = agentRoot({ mcp: { "other-server": { command: "npx", args: ["-y", "something"] } } });

		expect(ensureMemoryEntry(h.paths, 4123, "tok-1")).toBe(true);
		// One entry added; the server nobody asked about is byte-for-byte what it was.
		expect(h.read("mcpPath")).toEqual({
			mcpServers: {
				"other-server": { command: "npx", args: ["-y", "something"] },
				"flypi-memory": {
					url: "http://127.0.0.1:4123/mcp",
					description: "flypi memory store: memory_search, memory_write, memory_read, memory_supersede, memory_forget",
					headers: { Authorization: "Bearer tok-1" },
					exposure: "direct",
				},
			},
		});
		// It holds the token that guards the memory store, so it is not group-readable.
		expect(statSync(h.paths.mcpPath).mode & 0o777).toBe(0o600);
		// What was written is what the agent-side reader finds — the point of writing it at all.
		expect(memoryEndpoint(h.paths)).toEqual({ port: 4123, token: "tok-1" });

		// A later start, and an entry someone else wrote or edited: neither rewrites it. Its token may be a
		// `${VAR}` or a vault reference, and its port is the one the server is told to bind.
		const before = readFileSync(h.paths.mcpPath, "utf8");
		expect(ensureMemoryEntry(h.paths, 9999, "tok-2")).toBe(false);
		expect(readFileSync(h.paths.mcpPath, "utf8")).toBe(before);
	});
});

describe("config files: the raw editor", () => {
	it("reads both files as their exact text, and as empty when one is not there", () => {
		const h = agentRoot({ endpoints: { lmstudio: { baseUrl: "http://127.0.0.1:8000/v1", api: "openai-completions", models: [{ id: "qwen3", contextWindow: 32768 }] } }, settings: { thinkingLevel: "high" } });
		expect(readConfig(h.paths).files).toEqual([
			{ name: "models", text: readFileSync(h.paths.modelsPath, "utf8") },
			// The text, not a re-serialisation: what the box shows is what a save would write back.
			{ name: "settings", text: JSON.stringify({ thinkingLevel: "high" }, null, 2) },
		]);

		rmSync(h.paths.modelsPath);
		expect(readConfig(h.paths).files.find((file) => file.name === "models")?.text).toBe("");
	});

	it("writes the file exactly as typed, and leaves the other one alone", () => {
		const h = agentRoot({ endpoints: { lmstudio: { baseUrl: "http://127.0.0.1:8000/v1", models: [{ id: "qwen3" }] } }, settings: { thinkingLevel: "high" } });
		const typed = `{\n\t"providers": { "lmstudio": { "baseUrl": "http://127.0.0.1:8000/v1", "models": [{ "id": "qwen3", "input": ["text", "image"], "compat": { "supportsStore": false } }] } }\n}\n`;
		applyConfigEdits(h.paths, { files: [{ name: "models", text: typed, base: readFileSync(h.paths.modelsPath, "utf8") }] });

		// Byte for byte, tabs and all: this is the operator's file, not something to re-format.
		expect(readFileSync(h.paths.modelsPath, "utf8")).toBe(typed);
		expect(readFileSync(h.paths.settingsPath, "utf8")).toBe(JSON.stringify({ thinkingLevel: "high" }, null, 2));
		// It can hold a plaintext key, so the mode is the same as every other agent-dir file's.
		expect(statSync(h.paths.modelsPath).mode & 0o777).toBe(0o600);
		// And the panel's lists read the new file, not a stale one.
		expect(readConfig(h.paths).endpoints[0]?.models).toEqual(["qwen3"]);
	});

	it("refuses a file pi could not read, and one that moved since the editor loaded it", () => {
		const h = agentRoot({ endpoints: { lmstudio: { baseUrl: "http://127.0.0.1:8000/v1", models: [{ id: "qwen3" }] } } });
		const before = readFileSync(h.paths.modelsPath, "utf8");

		// A syntax error and a file that parses as something else than an object: both would break every new
		// conversation, so they are refused here rather than at the next `newSession`.
		for (const text of ["{ not json", '["lmstudio"]', ""]) {
			expect(() => applyConfigEdits(h.paths, { files: [{ name: "models", text, base: before }] })).toThrow();
			expect(readFileSync(h.paths.modelsPath, "utf8")).toBe(before);
		}

		// The file changed under the editor — a list edit in the same panel, another tab, the CLI. The raw write
		// replaces the whole file, credentials included, so it is refused rather than quietly won.
		writeFileSync(h.paths.modelsPath, '{"providers":{}}');
		expect(() => applyConfigEdits(h.paths, { files: [{ name: "models", text: '{"providers":{"x":{}}}', base: before }] })).toThrow(/changed since/);
		expect(readFileSync(h.paths.modelsPath, "utf8")).toBe('{"providers":{}}');
	});

	it("checks a default in the same request against the file the raw editor just wrote", () => {
		const h = agentRoot({ endpoints: { lmstudio: { baseUrl: "http://127.0.0.1:8000/v1", models: [{ id: "qwen3" }] } } });
		const typed = JSON.stringify({ providers: { lmstudio: { baseUrl: "http://127.0.0.1:8000/v1", models: [{ id: "qwen3-vl" }] } } });
		applyConfigEdits(h.paths, {
			files: [{ name: "models", text: typed, base: readFileSync(h.paths.modelsPath, "utf8") }],
			defaults: { provider: "lmstudio", model: "qwen3-vl" },
		});
		expect(h.read("settingsPath")).toEqual({ defaultProvider: "lmstudio", defaultModel: "qwen3-vl" });
	});
});

describe("config files: the default follows the endpoints", () => {
	it("names the first endpoint as the default when settings.json has none", () => {
		const h = agentRoot({ endpoints: { other: { baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "m1" }] } } });
		applyConfigEdits(h.paths, { endpoints: [endpoint("chatgml", { models: ["gpt-4o-mini", "gpt-4o"] })] });
		// The pair, both halves: a provider on its own is a conversation that cannot start. The first model
		// id is the one named, and nothing else in settings.json moves.
		expect(h.read("settingsPath")).toEqual({ defaultProvider: "chatgml", defaultModel: "gpt-4o-mini" });
	});

	it("does not move a default that is already set, and never picks an endpoint with no model", () => {
		const h = agentRoot({
			endpoints: { lmstudio: { baseUrl: "http://127.0.0.1:8000/v1", models: [{ id: "qwen3" }] } },
			settings: { defaultProvider: "lmstudio", defaultModel: "qwen3", thinkingLevel: "high" },
		});
		applyConfigEdits(h.paths, { endpoints: [endpoint("chatgml")] });
		expect(h.read("settingsPath")).toEqual({ defaultProvider: "lmstudio", defaultModel: "qwen3", thinkingLevel: "high" });

		// A provider entry naming no model id is legal — pi's built-ins can supply them — but it cannot start
		// a conversation, so the first endpoint that does name one is picked even when it is second in the file.
		const h2 = agentRoot({ endpoints: { builtins: { baseUrl: "http://127.0.0.1:1/v1" } } });
		applyConfigEdits(h2.paths, { endpoints: [endpoint("chatgml")] });
		expect(h2.read("settingsPath")).toEqual({ defaultProvider: "chatgml", defaultModel: "gpt-4o-mini" });
	});

	it("moves the default to another endpoint when its endpoint is deleted, and clears it when none is left", () => {
		const h = agentRoot({
			endpoints: {
				chatgml: { baseUrl: "https://chatgml.dev/v1", models: [{ id: "gpt-4o-mini" }] },
				lmstudio: { baseUrl: "http://127.0.0.1:8000/v1", models: [{ id: "qwen3" }] },
			},
			settings: { defaultProvider: "chatgml", defaultModel: "gpt-4o-mini", thinkingLevel: "high" },
		});
		applyConfigEdits(h.paths, { endpoints: [{ name: "chatgml", remove: true }] });
		expect(h.read("settingsPath")).toEqual({ defaultProvider: "lmstudio", defaultModel: "qwen3", thinkingLevel: "high" });

		// Nothing left that can start a conversation: the pair goes away rather than pointing at a provider
		// that is not in the file, and the rest of settings.json stays.
		applyConfigEdits(h.paths, { endpoints: [{ name: "lmstudio", remove: true }] });
		expect(h.read("settingsPath")).toEqual({ thinkingLevel: "high" });
	});

	it("leaves a default naming a built-in provider alone when an unrelated endpoint goes away", () => {
		// `anthropic` is pi's own provider, never a key in models.json. Deleting an endpoint must not read as
		// "the default is dangling" and quietly move the conversation to a local server.
		const h = agentRoot({
			endpoints: { lmstudio: { baseUrl: "http://127.0.0.1:8000/v1", models: [{ id: "qwen3" }] } },
			settings: { defaultProvider: "anthropic", defaultModel: "claude-sonnet-4-5" },
		});
		applyConfigEdits(h.paths, { endpoints: [{ name: "lmstudio", remove: true }] });
		expect(h.read("settingsPath")).toEqual({ defaultProvider: "anthropic", defaultModel: "claude-sonnet-4-5" });
	});
});
