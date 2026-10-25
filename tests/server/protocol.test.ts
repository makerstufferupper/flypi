import { describe, expect, it } from "vitest";
import {
	checkServerFrame,
	encodeFrame,
	parseClientCommand,
	PROTOCOL_VERSION,
	type ClientCommand,
	type EventFrame,
} from "../../src/server/protocol.ts";
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from "../../src/shared/attachments.ts";

const commands: ClientCommand[] = [
	{ type: "prompt", conversationId: "c1", text: "hello" },
	{ type: "prompt", conversationId: "c1", text: "steer me", mode: "steer" },
	{ type: "prompt", conversationId: "c1", text: "later", mode: "followUp", requestId: "r2" },
	// A pasted image with no text at all is a prompt: the attachment is the question.
	{ type: "prompt", conversationId: "c1", text: "", attachments: [{ name: "shot.png", mimeType: "image/png", data: "aGVsbG8=" }] },
	{ type: "prompt", conversationId: "c1", text: "read this", attachments: [{ name: "report.pdf", mimeType: "application/pdf", data: "aGVsbG8=" }], mode: "steer" },
	{ type: "abort", conversationId: "c1", requestId: "r3" },
	{ type: "newSession", requestId: "r4" },
	{ type: "newSession", cwd: "/tmp/somewhere" },
	{ type: "switchSession", sessionPath: "/x/.flypi/sessions/a.jsonl" },
	{ type: "fork", conversationId: "c1", messageSeq: 4 },
	{ type: "setModel", conversationId: "c1", provider: "lmstudio", modelId: "qwen3" },
	{ type: "setThinkingLevel", conversationId: "c1", level: "high" },
	{ type: "resume", conversationId: "c1", afterSeq: 12 },
	// Letting go of one conversation's stream while others stay attached: the frame is conversation-scoped, so
	// a page with several open chats can stop following an idle one without touching the rest.
	{ type: "unsubscribe", conversationId: "c1" },
	{ type: "listSessions", requestId: "r11" },
	{ type: "renameSession", conversationId: "c1", name: "afternoon session" },
	{ type: "deleteSession", sessionPath: "/x/.flypi/sessions/a.jsonl", requestId: "r13" },
	{ type: "debug", conversationId: "c1", requestId: "r12" },
	// The settings view asks the servers what they are doing. No conversation is involved, and there is
	// nothing to name: what is asked for is whatever `mcp.json` holds right now.
	{ type: "mcpStatus", requestId: "r16" },
	// The settings panel: read the agent dir's config files, and edit them one entry at a time.
	{ type: "getConfig", requestId: "r14" },
	{
		type: "saveConfig",
		endpoints: [{ name: "chatgml", baseUrl: "https://chatgml.dev/v1", api: "openai-completions", apiKey: "$chatgml_API_KEY", models: ["gpt-4o-mini"] }],
		mcpServers: [
			{ name: "flypi-memory", url: "http://127.0.0.1:8790/mcp", authorization: "Bearer ${FLYPI_MEMORY_TOKEN}", exposure: "direct", description: "memory store", toolExposure: { memory_cite: "hidden", "read_*": "direct" }, oauth: { clientId: "cid", clientSecret: "${OAUTH_SECRET}" } },
			{ name: "fs", command: "npx", args: ["-y", "server-fs", "."], env: { KEEP: "1" }, cwd: "/srv/docs" },
			{ name: "old-one", remove: true },
		],
		// Which endpoint a new conversation starts on: both halves, because one endpoint can define several
		// models (src/agent/runtime.ts reads `defaultProvider` and `defaultModel`).
		defaults: { provider: "chatgml", model: "gpt-4o-mini" },
		requestId: "r15",
	},
	// The Secrets tab (docs/secrets.md Phase 5.5): the list never carries a value; only a reveal does.
	{ type: "secrets", requestId: "r17" },
	{
		type: "saveSecrets",
		secrets: [
			{ name: "github_token", kind: "password", value: "ghp_x" },
			{ name: "old_key", kind: "yaml", value: "sk-new-value" },
			{ name: "gone", remove: true },
			{ name: "mistake", restore: true },
		],
		requestId: "r18",
	},
	{ type: "revealSecret", name: "github_token", requestId: "r19" },
	// The MCP sign-in (docs/architecture.md Phase 5, risk 5): the request stays open while the browser is
	// opened, and the redirect comes back as a paste — an empty one cancels.
	{ type: "mcpSignIn", name: "sentry", requestId: "r20" },
	{ type: "mcpRedirect", name: "sentry", url: "http://127.0.0.1:4123/callback?code=x&state=y" },
	{ type: "mcpRedirect", name: "sentry", url: "", requestId: "r21" },
];

describe("protocol: client commands round-trip through the schemas", () => {
	it("parses every documented command back to the same object", () => {
		for (const command of commands) {
			const parsed = parseClientCommand(JSON.stringify(command));
			expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
			if (parsed.ok) expect(parsed.command).toEqual(command);
		}
	});

	it("rejects non-JSON with a message, not a throw", () => {
		const parsed = parseClientCommand("{not json");
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) expect(parsed.message).toContain("not JSON");
	});

	it("rejects unknown commands and missing fields", () => {
		for (const raw of ['{"type":"nope"}', '{"type":"prompt"}', '{"type":"resume","conversationId":"c1"}', '{"type":"fork","conversationId":"c1"}', '"a string"', "{}"]) {
			expect(parseClientCommand(raw).ok, raw).toBe(false);
		}
	});

	it("rejects an unknown queue mode instead of guessing it", () => {
		expect(parseClientCommand('{"type":"prompt","conversationId":"c1","text":"x","mode":"yolo"}').ok).toBe(false);
	});

	it("rejects a config edit it cannot apply — no name, no model id, an unknown exposure", () => {
		// `models` and `exposure` are what an entry needs to be worth writing; a name with a dot or a space
		// would break `mcp__<server>__<tool>`, so it is refused rather than escaped.
		for (const raw of [
			'{"type":"saveConfig","endpoints":[{"baseUrl":"https://chatgml.dev/v1"}]}',
			'{"type":"saveConfig","endpoints":[{"name":"chatgml","models":[""]}]}',
			'{"type":"saveConfig","mcpServers":[{"name":"flypi memory","url":"http://127.0.0.1:8790/mcp"}]}',
			'{"type":"saveConfig","mcpServers":[{"name":"memory","exposure":"everything"}]}',
			// A per-tool exception is a level too: pi knows four, and a typo there is a server whose tools
			// quietly stop being offered.
			'{"type":"saveConfig","mcpServers":[{"name":"memory","toolExposure":{"memory_cite":"everywhere"}}]}',
			// An `env` value stays a reference; a number is not something the file holds.
			'{"type":"saveConfig","mcpServers":[{"name":"memory","env":{"TOKEN":7}}]}',
			// A default needs both halves and a name that could be a provider key: half a pair is a
			// `resolveConfiguredModel()` failure for the next conversation.
			'{"type":"saveConfig","defaults":{"provider":"chat gml","model":"gpt-4o-mini"}}',
			'{"type":"saveConfig","defaults":{"provider":"chatgml"}}',
			'{"type":"saveConfig","defaults":{"provider":"chatgml","model":""}}',
			// The raw editor takes one of the two files whole. `mcp.json` is not one of them — its form holds
			// every field — and a write with no text would empty a file that holds credentials.
			'{"type":"saveConfig","files":[{"name":"mcp","text":"{}"}]}',
			'{"type":"saveConfig","files":[{"name":"models"}]}',
			'{"type":"getConfig","requestId":{}}',
		]) {
			expect(parseClientCommand(raw).ok, raw).toBe(false);
		}
		// An empty edit list is the no-op it looks like, and a `{name, remove:true}` is a whole edit.
		expect(parseClientCommand('{"type":"saveConfig","endpoints":[]}').ok).toBe(true);
		// A raw write carries the whole file, and the text the editor was loaded with as its guard.
		expect(parseClientCommand('{"type":"saveConfig","files":[{"name":"models","text":"{}","base":"{}\\n"}]}').ok).toBe(true);
	});

	it("rejects an attachment over the size limit, and more attachments than the limit", () => {
		const oversized = { type: "prompt", conversationId: "c1", text: "x", attachments: [{ name: "big.png", mimeType: "image/png", data: "A".repeat(MAX_ATTACHMENT_BYTES * 2) }] };
		const tooMany = { type: "prompt", conversationId: "c1", text: "x", attachments: Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => ({ name: `f${i}`, mimeType: "image/png", data: "aGk=" })) };
		const unnamed = { type: "prompt", conversationId: "c1", text: "x", attachments: [{ name: "", mimeType: "image/png", data: "aGk=" }] };
		for (const command of [oversized, tooMany, unnamed]) expect(parseClientCommand(JSON.stringify(command)).ok, JSON.stringify(command).slice(0, 80)).toBe(false);
	});
});

describe("protocol: server frames are checked before they are sent", () => {
	it("accepts an event frame carrying a real pi event payload", () => {
		const event = {
			type: "message_update",
				message: { role: "assistant", content: [], api: "faux", provider: "flypi-stub", usage: {}, stopReason: "stop", timestamp: 0 },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi", partial: {} },
		};
		const frame: EventFrame = { type: "event", conversationId: "c1", seq: 7, event };
		expect(checkServerFrame(frame).ok).toBe(true);
		expect(JSON.parse(encodeFrame(frame))).toEqual(frame);
	});

	it("accepts hello, result and error frames", () => {
		expect(checkServerFrame({ type: "hello", protocolVersion: PROTOCOL_VERSION, serverVersion: "dev" }).ok).toBe(true);
		// `pi` is optional so an older server still parses, and present on every server from here on.
		expect(checkServerFrame({ type: "hello", protocolVersion: PROTOCOL_VERSION, serverVersion: "dev", pi: { version: "1.4.0", pinned: true, bundled: "1.0.4" } }).ok).toBe(true);
		expect(checkServerFrame({ type: "result", requestId: "r1", conversationId: "c1" }).ok).toBe(true);
		expect(checkServerFrame({ type: "error", message: "boom", code: "replay_gap" }).ok).toBe(true);
	});

	it("carries an MCP sign-in's URL, and refuses one with no URL or a name that is not a server key", () => {
		expect(checkServerFrame({ type: "mcpAuth", name: "sentry", url: "https://example.com/authorize?state=x" }).ok).toBe(true);
		// A name with a space could never be the key of an `mcp.json` entry, and an empty URL is a frame the
		// page would render as an empty link.
		for (const frame of [
			{ type: "mcpAuth", name: "sentry mcp", url: "https://example.com/authorize" },
			{ type: "mcpAuth", name: "sentry", url: "" },
		]) {
			expect(checkServerFrame(frame).ok, JSON.stringify(frame)).toBe(false);
		}
	});

	it("accepts the sidebar's and debug panel's result payloads", () => {
		expect(
			checkServerFrame({
				type: "result",
				requestId: "r11",
				sessions: [{ path: "/x/.flypi/agent/sessions/a.jsonl", name: "Fix the sort", modified: "2026-01-01T00:00:00.000Z", messageCount: 4, firstMessage: "fix the sort" }],
			}).ok,
		).toBe(true);
		// A session without a name is the normal case, so `name` really is optional.
		expect(
			checkServerFrame({ type: "result", requestId: "r11", sessions: [{ path: "/a.jsonl", modified: "2026-01-01T00:00:00.000Z", messageCount: 0, firstMessage: "" }] }).ok,
		).toBe(true);
		expect(
			checkServerFrame({
				type: "result",
				requestId: "r12",
				conversationId: "c1",
				debug: { systemPrompt: "you are flypi", activeTools: ["read"], commands: [], models: [], thinkingLevel: "off", memoryBlock: null },
			}).ok,
		).toBe(true);
		// A model row carries pi's own `input` list: it is what lets the chat say "this model cannot see what
		// you pasted" instead of letting the paste vanish. A row without it is a snapshot that cannot be trusted.
		expect(
			checkServerFrame({
				type: "result",
				requestId: "r12",
				debug: {
					systemPrompt: "p",
					activeTools: [],
					commands: [],
					models: [{ provider: "lmstudio", modelId: "qwen3", input: ["text", "image"] }],
					model: { provider: "lmstudio", modelId: "qwen3", input: ["text", "image"] },
					thinkingLevel: "off",
					memoryBlock: null,
				},
			}).ok,
		).toBe(true);
		expect(
			checkServerFrame({
				type: "result",
				requestId: "r12",
				debug: {
					systemPrompt: "p",
					activeTools: [],
					commands: [],
					models: [{ provider: "lmstudio", modelId: "qwen3" }],
					model: { provider: "lmstudio", modelId: "qwen3" },
					thinkingLevel: "off",
					memoryBlock: null,
				},
			}).ok,
		).toBe(false);
		// Phase 4 fills the same field with the block it injected; the schema already allows it.
		expect(
			checkServerFrame({
				type: "result",
				requestId: "r12",
				debug: { systemPrompt: "p", activeTools: [], commands: [], models: [], thinkingLevel: "off", memoryBlock: "<relevant_memories>…</relevant_memories>" },
			}).ok,
		).toBe(true);
		// The chat's context gauge. `tokens`/`percent` are null when pi cannot know yet — just after a
		// compaction — and the UI has to be able to tell "0%" from "unknown", so the null is on the wire.
		expect(
			checkServerFrame({
				type: "result",
				requestId: "r12",
				debug: { systemPrompt: "p", activeTools: [], commands: [], models: [], thinkingLevel: "off", memoryBlock: null, context: { tokens: 24_000, contextWindow: 200_000, percent: 12 } },
			}).ok,
		).toBe(true);
		expect(
			checkServerFrame({
				type: "result",
				requestId: "r12",
				debug: { systemPrompt: "p", activeTools: [], commands: [], models: [], thinkingLevel: "off", memoryBlock: null, context: { tokens: null, contextWindow: 200_000, percent: null } },
			}).ok,
		).toBe(true);
		expect(
			checkServerFrame({
				type: "result",
				requestId: "r12",
				debug: { systemPrompt: "p", activeTools: [], commands: [], models: [], thinkingLevel: "off", memoryBlock: null, context: { contextWindow: 200_000 } },
			}).ok,
		).toBe(false);
	});

	it("rejects a session row or debug snapshot missing a field", () => {
		expect(checkServerFrame({ type: "result", requestId: "r11", sessions: [{ path: "/a.jsonl" }] }).ok).toBe(false);
		expect(checkServerFrame({ type: "result", requestId: "r12", debug: { systemPrompt: "p" } }).ok).toBe(false);
	});

	it("accepts the settings panel's config snapshot", () => {
		// What readConfig answers: every row filled in, pi's defaults spelled out, and `errors` for a file
		// that will not parse — the panel shows those instead of an empty list.
		expect(
			checkServerFrame({
				type: "result",
				requestId: "r14",
				config: {
					endpoints: [{ name: "lmstudio", baseUrl: "http://127.0.0.1:8000/v1", api: "openai-completions", apiKey: "$MODEL_API_KEY", models: ["qwen3"] }],
					mcpServers: [
						{ name: "flypi-memory", url: "http://127.0.0.1:8790/mcp", command: "", args: [], authorization: "Bearer ${FLYPI_MEMORY_TOKEN}", env: { KEEP: "1" }, cwd: "/srv/docs", description: "", exposure: "direct", toolExposure: { memory_cite: "hidden" }, oauth: { clientId: "", clientSecret: "", callbackUrl: "", scope: "" }, enabled: true },
					],
					defaults: { provider: "lmstudio", model: "qwen3" },
					files: [{ name: "models", text: "{}\n" }, { name: "settings", text: "{}\n" }],
					errors: [],
				},
			}).ok,
		).toBe(true);
		// A row is complete or the snapshot is not trustworthy: `enabled` decides whether the panel says
		// "disabled", and `models` is the only thing that shows which endpoint can be picked.
		expect(checkServerFrame({ type: "result", requestId: "r14", config: { endpoints: [{ name: "a" }], mcpServers: [], errors: [] } }).ok).toBe(false);
		expect(checkServerFrame({ type: "result", requestId: "r14", config: { endpoints: [], mcpServers: [{ name: "a", enabled: "yes" }], errors: [] } }).ok).toBe(false);
		expect(checkServerFrame({ type: "result", requestId: "r14", config: { endpoints: [], mcpServers: [] } }).ok).toBe(false);
		// Half a default pair is not a snapshot either: the panel would show a default that cannot start.
		expect(checkServerFrame({ type: "result", requestId: "r14", config: { endpoints: [], mcpServers: [], errors: [], defaults: { provider: "a" } } }).ok).toBe(false);
		// Having no default at all is a real state — an agent dir with no settings.json — and it reads as
		// empty strings, which the panel spells out instead of pretending a model is set.
		expect(checkServerFrame({ type: "result", requestId: "r14", config: { endpoints: [], mcpServers: [], errors: [], defaults: { provider: "", model: "" }, files: [{ name: "models", text: "" }, { name: "settings", text: "{}" }] } }).ok).toBe(true);
	// The raw editor's boxes are filled from the snapshot, so one missing them — or offering a file it has no
	// business replacing — is not a snapshot the panel can render.
	expect(checkServerFrame({ type: "result", requestId: "r14", config: { endpoints: [], mcpServers: [], errors: [], defaults: { provider: "", model: "" } } }).ok).toBe(false);
	expect(checkServerFrame({ type: "result", requestId: "r14", config: { endpoints: [], mcpServers: [], errors: [], defaults: { provider: "", model: "" }, files: [{ name: "auth", text: "{}" }] } }).ok).toBe(false);
	});

	it("accepts what the MCP probe answers, and refuses a state it does not know", () => {
		expect(
			checkServerFrame({
				type: "result",
				requestId: "r16",
				mcpStatus: {
					servers: [
						{ name: "flypi-memory", state: "connected", transport: "http", tools: [{ name: "memory_search", destructive: false, openWorld: false }] },
						// "not reachable" carries the server's own words, because that is what a user pastes.
						{ name: "search", state: "failed", transport: "stdio", error: "spawn npx ENOENT", tools: [] },
						{ name: "sentry", state: "needs-auth", transport: "http", error: "HTTP 401", tools: [] },
						// Left off in the file — a state, not a failure.
						{ name: "old-one", state: "disabled", transport: "stdio", tools: [] },
					],
					log: "2026-01-01T00:00:00.000Z [search] spawn npx ENOENT",
				},
			}).ok,
		).toBe(true);
		// A state outside the four the panel can render is refused rather than shown as a blank badge, and a
		// tool that does not say whether it is destructive cannot be offered as a thing to gate.
		expect(checkServerFrame({ type: "result", requestId: "r16", mcpStatus: { servers: [{ name: "a", state: "shaky", transport: "http", tools: [] }], log: "" } }).ok).toBe(false);
		expect(checkServerFrame({ type: "result", requestId: "r16", mcpStatus: { servers: [{ name: "a", state: "connected", transport: "http", tools: [{ name: "t" }] }], log: "" } }).ok).toBe(false);
		// An answer with no log is a missing field, not "nothing logged" — the probe always sets it.
		expect(checkServerFrame({ type: "result", requestId: "r16", mcpStatus: { servers: [] } }).ok).toBe(false);
	});

	it("rejects a malformed frame — a broken frame is our bug, not the client's", () => {
		expect(checkServerFrame({ type: "event", conversationId: "c1", seq: 0, event: {} }).ok).toBe(false);
		expect(checkServerFrame({ type: "event", conversationId: "c1", seq: 1 }).ok).toBe(false);
		expect(checkServerFrame({ type: "whatever" }).ok).toBe(false);
		expect(checkServerFrame(null).ok).toBe(false);
	});
});
