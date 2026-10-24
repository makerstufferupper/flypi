/**
 * The settings view (docs/protocol.md `getConfig` / `saveConfig`). What is asserted here is the page's
 * half: the view replaces the chat and can be left again, the address bar says which of the two is up, the
 * gear asks for the files, the files become two compact lists, and every action opens one modal for one
 * entry and sends one edit for it — never a list of everything the panel happens to show. What those edits
 * do to the files is covered in tests/agent/config-files.test.ts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import App from "./App.svelte";
import type { ClientCommand, ConfigSnapshot, McpStatusSnapshot, PackagesSnapshot, PiVersions, ServerFrame } from "../src/server/protocol.ts";
import type { Transport } from "./lib/client.ts";

class FakeTransport implements Transport {
	sent: ClientCommand[] = [];
	#handlers = new Set<(signal: ServerFrame | { type: "connected" } | { type: "disconnected" }) => void>();

	on(handler: (signal: ServerFrame | { type: "connected" } | { type: "disconnected" }) => void): () => void {
		this.#handlers.add(handler);
		return () => this.#handlers.delete(handler);
	}

	send(command: ClientCommand): void {
		this.sent.push(command);
	}

	emit(signal: Parameters<Parameters<Transport["on"]>[0]>[0]): void {
		for (const handler of this.#handlers) handler(signal);
	}
}

const SNAPSHOT: ConfigSnapshot = {
	endpoints: [
		{ name: "lmstudio", baseUrl: "http://127.0.0.1:8000/v1", api: "openai-completions", apiKey: "$LM_API_KEY", models: ["qwen3", "qwen3-next"] },
		{ name: "chatgml", baseUrl: "https://chatgml.dev/v1", api: "openai-completions", apiKey: "", models: [] },
		// A third, with a model of its own: one endpoint cannot be the default and another clickable at the
		// same time, and an endpoint with no model id has to be shown as unable to be one.
		{ name: "nv", baseUrl: "http://192.168.1.9:1234/v1", api: "openai-completions", apiKey: "", models: ["nv-large"] },
	],
	mcpServers: [
		{
			name: "flypi-memory",
			url: "http://127.0.0.1:8790/mcp",
			command: "",
			args: [],
			authorization: "Bearer ${FLYPI_MEMORY_TOKEN}",
			env: {},
			cwd: "",
			description: "memory store",
			exposure: "direct",
			// The server is `direct`, and one of its tools still stays out of the model's reach — the only way
			// to hide what flypi calls after a turn (docs/memory.md Phase 4).
			toolExposure: { memory_cite: "hidden" },
			oauth: { clientId: "", clientSecret: "", callbackUrl: "", scope: "" },
			enabled: false,
		},
		{
			name: "fs",
			url: "",
			command: "npx",
			args: ["-y", "server-fs", "."],
			authorization: "",
			env: { KEEP: "${KEEP_ME}" },
			cwd: "/srv/docs",
			description: "",
			exposure: "codemode",
			toolExposure: {},
			oauth: { clientId: "cid", clientSecret: "${OAUTH_SECRET}", callbackUrl: "http://localhost:8080/callback", scope: "read" },
			enabled: true,
		},
	],
	// Required by the protocol: the server always answers with the files it could not read, even when that
	// list is empty, and with the default pair even when settings.json does not name one (src/server/protocol.ts).
	defaults: { provider: "lmstudio", model: "qwen3" },
	// The two files as their exact bytes — what the raw editor's boxes are filled with.
	files: [
		{ name: "models", text: '{\n  "providers": {\n    "lmstudio": {\n      "baseUrl": "http://127.0.0.1:8000/v1",\n      "models": [{ "id": "qwen3", "input": ["text", "image"] }]\n    }\n  }\n}\n' },
		{ name: "settings", text: '{\n  "defaultProvider": "lmstudio",\n  "defaultModel": "qwen3"\n}\n' },
	],
	errors: [],
};

async function mount(): Promise<FakeTransport> {
	const transport = new FakeTransport();
	render(App, { props: { transport } });
	await tick();
	transport.emit({ type: "connected" });
	await tick();
	return transport;
}

/** The gear, then the files the server answers with. */
async function openSettings(transport: FakeTransport, config: ConfigSnapshot = SNAPSHOT): Promise<void> {
	fireEvent.click(screen.getByRole("button", { name: /endpoints and MCP servers/i }));
	await tick();
	transport.emit({ type: "result", requestId: "r-config", conversationId: "c1", config });
	await tick();
}

const sent = (transport: FakeTransport, type: string) => transport.sent.filter((c) => c.type === type);
/** The edits a request carries: lists for entries, one pair for the default. */
const saved = (transport: FakeTransport, kind: "endpoints" | "mcpServers" | "defaults") =>
	transport.sent.flatMap((c) => {
		if (c.type !== "saveConfig") return [];
		const value = (c as { [k: string]: unknown })[kind];
		return Array.isArray(value) ? value : value === undefined ? [] : [value];
	}) as unknown[];

// An address bar left over from one test would open the next one in the wrong view (or on the wrong
// conversation), because a URL naming a view or a session is honoured at mount.
afterEach(() => {
	cleanup();
	history.replaceState(null, "", "/");
});

/** One line of one list. */
const row = (role: "endpoint" | "mcp", nth = 0) => document.querySelectorAll(`[data-role="${role}"]`)[nth] as HTMLElement;
/** The modal's form, whichever entry it holds. */
const form = (role: "endpoint-form" | "mcp-form") => document.querySelector(`[data-role="${role}"]`) as HTMLFormElement;
const field = (role: "endpoint-form" | "mcp-form", name: string) => form(role).querySelector(`[name="${name}"]`) as HTMLInputElement;

/** Type into a modal field. Its values are state, so an input event is what moves them. */
async function type(role: "endpoint-form" | "mcp-form", name: string, value: string): Promise<void> {
	fireEvent.input(field(role, name), { target: { value } });
	await tick();
}

/** Click a row's edit icon, which is what opens the modal for it. */
async function editEntry(role: "endpoint" | "mcp", nth = 0): Promise<void> {
	fireEvent.click(row(role, nth).querySelector(`[data-role="${role}-edit"]`) as HTMLElement);
	await tick();
}

describe("the settings view", () => {
	it("replaces the chat, and the way back puts the chat back — with the address bar saying which is up", async () => {
		history.replaceState(null, "", "/");
		const transport = await mount();
		expect(document.querySelector(".chat")).toBeTruthy();
		expect(document.querySelector(".activity-panel")).toBeTruthy();
		expect(location.pathname).toBe("/");

		await openSettings(transport);
		// "Its own panel that replaces the chat and the activity panel", not a drawer over either: the
		// conversation is not on screen at all while the config files are.
		expect(document.querySelector(".chat")).toBeNull();
		expect(document.querySelector(".activity-panel")).toBeNull();
		expect(document.querySelector('[data-role="settings-view"]')).toBeTruthy();
		// The sidebar stays — this is a view of the same page, and the sessions are still reachable.
		expect(document.querySelector(".sidebar")).toBeTruthy();
		expect(location.pathname).toBe("/settings");

		fireEvent.click(screen.getByRole("button", { name: /back to chat/i }));
		await tick();
		expect(document.querySelector(".chat")).toBeTruthy();
		expect(document.querySelector(".activity-panel")).toBeTruthy();
		expect(document.querySelector('[data-role="settings-view"]')).toBeNull();
		// Back to the chat means the plain address again.
		expect(location.pathname).toBe("/");
	});

	it("opens on the view the address bar asks for, and asks for the files then", async () => {
		// A reload or a shared link lands where the page was — the reason to name the view at all.
		history.replaceState(null, "", "/settings");
		const transport = await mount();
		expect(document.querySelector('[data-role="settings-view"]')).toBeTruthy();
		expect(document.querySelector(".chat")).toBeNull();
		expect(sent(transport, "getConfig")).toHaveLength(1);
	});

	it("leaves settings with the gear too, and takes the address back", async () => {
		const transport = await mount();
		await openSettings(transport);
		const gear = screen.getByRole("button", { name: /endpoints and MCP servers/i });
		expect(gear.getAttribute("aria-pressed")).toBe("true");

		fireEvent.click(gear);
		await tick();
		expect(document.querySelector('[data-role="endpoint"]')).toBeNull();
		expect(gear.getAttribute("aria-pressed")).toBe("false");
		expect(location.pathname).toBe("/");
		// Closing does not ask again: the files are read when the view opens, not on every toggle. The two asks
		// are the connect (the chat asks so it can say when nothing is configured) and this view opening.
		expect(sent(transport, "getConfig")).toHaveLength(2);
	});

	it("goes back to the chat when the sidebar picks a conversation", async () => {
		// The settings view has no conversation of its own, so the rows in the sidebar are the other way back.
		const transport = await mount();
		transport.emit({ type: "result", requestId: "r-new", conversationId: "c1", sessionPath: "/tmp/current.jsonl", sessions: [{ path: "/tmp/a.jsonl", modified: "2024-01-01T00:00:00.000Z", messageCount: 2, firstMessage: "fix the parser" }] });
		await tick();
		await openSettings(transport);
		fireEvent.click(screen.getByRole("button", { name: "fix the parser" }));
		await tick();
		expect(sent(transport, "switchSession")).toHaveLength(1);
		expect(document.querySelector(".chat")).toBeTruthy();
		expect(document.querySelector('[data-role="settings-view"]')).toBeNull();
		// The address bar stops naming a view and names the conversation instead (`/sessions/<id>`). Which session
		// it names next follows the server's ack, as always (ui/app.test.ts covers that half) — and no ack comes
		// from this transport, so it still holds the one the connect handed over.
		expect(location.pathname).toBe("/sessions/current.jsonl");
	});

	it("lists what is configured, one line per entry, with nothing open", async () => {
		const transport = await mount();
		// One ask before the view opens — the chat's own, at connect, so it can tell the user nothing is
		// configured (ui/Chat.svelte). Nothing else about config is on the socket until the view opens: like the
		// debug snapshot, config is asked for, not polled, and not for every conversation.
		expect(sent(transport, "getConfig")).toHaveLength(1);
		await openSettings(transport);

		expect(document.querySelectorAll('[data-role="endpoint"]')).toHaveLength(3);
		expect(row("endpoint").textContent).toContain("lmstudio");
		expect(row("endpoint").textContent).toContain("http://127.0.0.1:8000/v1");
		// The ids the file defines are shown, but a list row never re-types them: the modal only asks for ids
		// to add, so a row cannot drop a model by omission.
		expect(row("endpoint").textContent).toContain("qwen3, qwen3-next");
		// The second endpoint has no models at all, and the line says so rather than looking fine.
		expect(row("endpoint", 1).textContent).toContain("no models");

		expect(document.querySelectorAll('[data-role="mcp"]')).toHaveLength(2);
		expect(row("mcp").textContent).toContain("http://127.0.0.1:8790/mcp");
		expect(row("mcp").textContent).toContain("direct");
		expect(row("mcp").textContent).toContain("disabled");
		// A stdio server reads as its command, not as an empty URL.
		expect(row("mcp", 1).textContent).toContain("npx -y server-fs .");
		expect(row("mcp", 1).textContent).toContain("codemode");

		// Both actions on a row are icon buttons, and the accessible name says which entry they act on —
		// a glyph with no name would be a button a screen reader cannot describe.
		expect(screen.getByRole("button", { name: "Edit lmstudio" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Delete chatgml" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Delete flypi-memory" })).toBeTruthy();

		// Which endpoint a new conversation starts on is named once, below the rows, and the row that holds it
		// is the one offering a model choice. The other rows offer the star instead — a row cannot be the
		// default and pick a default model at the same time.
		expect(document.querySelector('[data-role="default-line"]')?.textContent).toContain("lmstudio/qwen3");
		const pick = row("endpoint", 0).querySelector("select[data-role=\"default-model\"]") as HTMLSelectElement;
		expect(pick.value).toBe("qwen3");
		expect([...pick.options].map((option) => option.value)).toEqual(["qwen3", "qwen3-next"]);
		expect(row("endpoint", 0).querySelector('[data-role="endpoint-default"]')).toBeNull();
		expect(screen.getByRole("button", { name: "Set nv as default" })).toBeTruthy();
		// chatgml defines no model id, so it cannot be a default: settings.json needs one, and the next
		// conversation would fail to resolve a model without it.
		expect((screen.getByRole("button", { name: "Set chatgml as default" }) as HTMLButtonElement).disabled).toBe(true);
		expect(document.querySelector('[data-role="config-modal"]')).toBeNull();
	});

	it("makes another endpoint the default, naming a model it actually defines", async () => {
		const transport = await mount();
		await openSettings(transport);

		fireEvent.click(row("endpoint", 2).querySelector('[data-role="endpoint-default"]') as HTMLElement);
		await tick();

		// One small edit, and it carries both halves: `defaultProvider` without a `defaultModel` is a
		// conversation that cannot start (src/agent/runtime.ts).
		expect(saved(transport, "defaults")).toEqual([{ provider: "nv", model: "nv-large" }]);
	});

	it("changes which model of the default endpoint a new conversation starts on", async () => {
		const transport = await mount();
		await openSettings(transport);

		const pick = row("endpoint", 0).querySelector("select[data-role=\"default-model\"]") as HTMLSelectElement;
		fireEvent.change(pick, { target: { value: "qwen3-next" } });
		await tick();

		expect(saved(transport, "defaults")).toEqual([{ provider: "lmstudio", model: "qwen3-next" }]);
	});

	it("says so when the server refuses a config edit, rather than leaving the list looking saved", async () => {
		const transport = await mount();
		await openSettings(transport);

		fireEvent.click(row("endpoint", 2).querySelector('[data-role="endpoint-default"]') as HTMLElement);
		await tick();
		const requestId = (transport.sent.find((command) => command.type === "saveConfig") as { requestId: string }).requestId;
		transport.emit({ type: "error", requestId, message: 'default model "nv/nv-tiny" is not defined by that endpoint' });
		await tick();

		// The chat's error strip is not on screen here, and a list still showing the old values reads as a
		// save that worked. The refusal belongs where the row is.
		expect(document.querySelector('[data-role="save-error"]')?.textContent).toContain("not defined by that endpoint");
		expect(document.querySelector('[data-role="default-line"]')?.textContent).toContain("lmstudio/qwen3");

		// Files as they are on disk, so the next clean snapshot retires the message.
		transport.emit({ type: "result", requestId, config: SNAPSHOT });
		await tick();
		expect(document.querySelector('[data-role="save-error"]')).toBeNull();
	});

	it("says plainly when nothing is set as the default", async () => {
		const transport = await mount();
		// An agent dir with no settings.json: `resolveConfiguredModel()` would refuse to start a conversation,
		// so the panel says that rather than showing an endpoint list that looks fine.
		await openSettings(transport, { ...SNAPSHOT, defaults: { provider: "", model: "" } });

		expect(document.querySelector('[data-role="default-line"]')?.textContent).toContain("nothing set");
		expect(document.querySelectorAll('[data-role="default-model"]')).toHaveLength(0);
		// Every row offers to become the default; the one without models is disabled.
		expect(document.querySelectorAll('[data-role="endpoint-default"]')).toHaveLength(3);
	});

	it("says when the default is not one of these endpoints", async () => {
		const transport = await mount();
		// settings.json may name a built-in provider, or one that was deleted from models.json. Showing the
		// pair is honest; claiming it is one of these rows would not be.
		await openSettings(transport, { ...SNAPSHOT, defaults: { provider: "anthropic", model: "claude-sonnet" } });

		const line = document.querySelector('[data-role="default-line"]')?.textContent ?? "";
		expect(line).toContain("anthropic/claude-sonnet");
		expect(line).toContain("not one of these endpoints");
		expect(document.querySelectorAll('[data-role="default-model"]')).toHaveLength(0);
	});

	it("opens the same modal from the entry's name, which is the row's other handle", async () => {
		const transport = await mount();
		await openSettings(transport);
		fireEvent.click(row("mcp").querySelector(".cfg-name") as HTMLElement);
		await tick();
		expect(field("mcp-form", "name").value).toBe("flypi-memory");
	});

	it("opens one entry in a modal prefilled from the file, and saving sends one edit for it", async () => {
		const transport = await mount();
		await openSettings(transport);
		await editEntry("endpoint");

		expect(field("endpoint-form", "baseUrl").value).toBe("http://127.0.0.1:8000/v1");
		expect(field("endpoint-form", "apiKey").value).toBe("$LM_API_KEY");
		// A reference, held as the file holds it: nothing here expands `$LM_API_KEY`.
		// The name is the key in the file, so editing an entry cannot move it.
		expect(field("endpoint-form", "name").disabled).toBe(true);
		// What is already defined is shown, and the field asks only for ids to add.
		expect(form("endpoint-form").textContent).toContain("Already defines: qwen3, qwen3-next");

		await type("endpoint-form", "baseUrl", "http://127.0.0.1:9000/v1");
		await type("endpoint-form", "models", "qwen3-vision, qwen3");
		fireEvent.submit(form("endpoint-form"));
		await tick();

		expect(saved(transport, "endpoints")).toEqual([
			{ name: "lmstudio", baseUrl: "http://127.0.0.1:9000/v1", api: "openai-completions", apiKey: "$LM_API_KEY", models: ["qwen3-vision", "qwen3"] },
		]);
		// One edit for one entry: the other endpoint and every MCP server are not in it.
		expect(saved(transport, "mcpServers")).toEqual([]);
		// Saving closes the modal, and the list it was opened from is still there.
		expect(document.querySelector('[data-role="config-modal"]')).toBeNull();
		expect(document.querySelectorAll('[data-role="endpoint"]')).toHaveLength(3);
	});

	it("edits a server: the exposure select holds its level, the checkbox its enabled flag", async () => {
		const transport = await mount();
		await openSettings(transport);
		await editEntry("mcp");

		expect(field("mcp-form", "url").value).toBe("http://127.0.0.1:8790/mcp");
		expect(field("mcp-form", "authorization").value).toBe("Bearer ${FLYPI_MEMORY_TOKEN}");
		expect(field("mcp-form", "exposure").value).toBe("direct");
		expect((field("mcp-form", "enabled") as HTMLInputElement).checked).toBe(false);

		field("mcp-form", "enabled").click();
		await tick();
		await type("mcp-form", "authorization", "Bearer literal-token");
		fireEvent.submit(form("mcp-form"));
		await tick();
		expect(saved(transport, "mcpServers")).toEqual([
			{
				name: "flypi-memory",
				url: "http://127.0.0.1:8790/mcp",
				command: "",
				args: [],
				authorization: "Bearer literal-token",
				env: {},
				cwd: "",
				description: "memory store",
				exposure: "direct",
				toolExposure: { memory_cite: "hidden" },
				oauth: { clientId: "", clientSecret: "", callbackUrl: "", scope: "" },
				enabled: true,
			},
		]);
	});

	// The tail of Phase 5: the fields a server needs only sometimes. They are in the same modal, prefilled
	// from the file, and they go back as the maps pi reads — which is what lets a per-tool exception, an env
	// reference or an OAuth client be set without opening the file.
	it("edits a server's environment, working directory, tool exceptions and OAuth client", async () => {
		const transport = await mount();
		await openSettings(transport);

		// The list row says an entry has exceptions at all: a per-tool override is invisible otherwise, and
		// "why is this tool not offered?" is a question about the row you are looking at.
		expect(row("mcp").textContent).toContain("1 tool exception");

		await editEntry("mcp", 1);
		// Prefilled as the file holds it, references and all — nothing here expands `${KEEP_ME}`.
		expect(field("mcp-form", "env").value).toBe("KEEP=${KEEP_ME}");
		expect(field("mcp-form", "cwd").value).toBe("/srv/docs");
		expect(field("mcp-form", "oauthClientId").value).toBe("cid");
		expect(field("mcp-form", "oauthClientSecret").value).toBe("${OAUTH_SECRET}");
		expect(field("mcp-form", "oauthCallbackUrl").value).toBe("http://localhost:8080/callback");
		expect(field("mcp-form", "oauthScope").value).toBe("read");

		await type("mcp-form", "env", "KEEP=\nAPI_KEY=!flypi secret print FS_KEY\n");
		await type("mcp-form", "toolExposure", "write_* = hidden");
		await type("mcp-form", "cwd", "");
		fireEvent.submit(form("mcp-form"));
		await tick();

		const edits = saved(transport, "mcpServers") as { env: Record<string, string>; cwd: string; toolExposure: Record<string, string> }[];
		expect(edits).toHaveLength(1);
		const edit = edits[0]!;
		// An emptied line is sent as an empty value — the page does not decide what the file should hold; the
		// server is the one that takes the key out (src/agent/config-files.ts, tests/agent/config-files.test.ts).
		expect(edit.env).toEqual({ KEEP: "", API_KEY: "!flypi secret print FS_KEY" });
		// One line per entry, and a pattern is a key like any other; the value is trimmed, the reference is not.
		expect(edit.toolExposure).toEqual({ "write_*": "hidden" });
		// An emptied field means "take that key out of the file" — the same rule as every other field here.
		expect(edit.cwd).toBe("");
	});

	it("refuses a line it cannot read, and sends nothing", async () => {
		const transport = await mount();
		await openSettings(transport);
		await editEntry("mcp", 1);

		await type("mcp-form", "toolExposure", "memory_cite=everywhere");
		fireEvent.submit(form("mcp-form"));
		await tick();

		// pi knows four levels, and a frame the wire schema refuses has no requestId to answer — so the page
		// says why in the modal instead of closing on nothing and leaving the list looking saved.
		expect(document.querySelector('[data-role="form-error"]')?.textContent).toContain("everywhere");
		expect(transport.sent.filter((command) => command.type === "saveConfig")).toEqual([]);
		expect(document.querySelector('[data-role="config-modal"]')).toBeTruthy();

		await type("mcp-form", "toolExposure", "memory_cite direct");
		fireEvent.submit(form("mcp-form"));
		await tick();
		expect(document.querySelector('[data-role="form-error"]')?.textContent).toContain("not a name=value line");
		expect(transport.sent.filter((command) => command.type === "saveConfig")).toEqual([]);
	});

	it("adds an endpoint through the same modal", async () => {
		const transport = await mount();
		await openSettings(transport);

		fireEvent.click(screen.getByRole("button", { name: "Add endpoint" }));
		await tick();
		// A new entry is a new key, so its name is the one field a modal lets you type.
		expect(field("endpoint-form", "name").disabled).toBe(false);
		expect(field("endpoint-form", "models").value).toBe("");

		for (const [name, value] of Object.entries({ name: "chatgml", baseUrl: "https://chatgml.dev/v1", apiKey: "${chatgml_API_KEY}", models: "chatgml-large" })) {
			await type("endpoint-form", name, value);
		}
		fireEvent.submit(form("endpoint-form"));
		await tick();
		expect(saved(transport, "endpoints")).toEqual([
			{ name: "chatgml", baseUrl: "https://chatgml.dev/v1", api: "openai-completions", apiKey: "${chatgml_API_KEY}", models: ["chatgml-large"] },
		]);
	});

	it("prefills flypi's own memory MCP, with the token left as a reference", async () => {
		const transport = await mount();
		await openSettings(transport);
		fireEvent.click(screen.getByRole("button", { name: "Add server" }));
		await tick();
		fireEvent.click(screen.getByRole("button", { name: /memory MCP/i }));
		await tick();

		expect(field("mcp-form", "url").value).toBe("http://127.0.0.1:8790/mcp");
		// A reference, never a secret: pi resolves `${…}`, so the token does not end up in a file the page wrote.
		expect(field("mcp-form", "authorization").value).toBe("Bearer ${FLYPI_MEMORY_TOKEN}");
		// The memory tools have to reach the model, not only a codemode script.
		expect(field("mcp-form", "exposure").value).toBe("direct");
		fireEvent.submit(form("mcp-form"));
		await tick();
		expect(saved(transport, "mcpServers")).toEqual([
			{
				name: "flypi-memory",
				url: "http://127.0.0.1:8790/mcp",
				command: "",
				args: [],
				authorization: "Bearer ${FLYPI_MEMORY_TOKEN}",
				env: {},
				cwd: "",
				description: "flypi memory store: memory_search, memory_write, memory_read, memory_supersede, memory_forget, memory_media, memory_index_status",
				exposure: "direct",
				// Not all ten of that server's tools: the counters flypi calls after a turn are hidden from the
				// model, which is what the prefill now sets, and the description lists only the callable seven.
				toolExposure: { memory_cite: "hidden", memory_capture: "hidden", memory_turn: "hidden" },
				oauth: { clientId: "", clientSecret: "", callbackUrl: "", scope: "" },
				enabled: true,
			},
		]);
	});

	it("cancels without sending anything", async () => {
		const transport = await mount();
		await openSettings(transport);
		await editEntry("mcp", 1);
		await type("mcp-form", "args", "-y server-fs /tmp");
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await tick();

		expect(document.querySelector('[data-role="config-modal"]')).toBeNull();
		expect(transport.sent.filter((c) => c.type === "saveConfig")).toEqual([]);
	});

	it("deletes one entry, and only that one", async () => {
		const transport = await mount();
		await openSettings(transport);

		(row("mcp").querySelector('[data-role="mcp-remove"]') as HTMLButtonElement).click();
		await tick();
		expect(saved(transport, "mcpServers")).toEqual([{ name: "flypi-memory", remove: true }]);
		expect(saved(transport, "endpoints")).toEqual([]);
	});

	it("says so when a config file will not parse, instead of showing an empty config", async () => {
		const transport = await mount();
		await openSettings(transport, { ...SNAPSHOT, endpoints: [], mcpServers: [], errors: ["/x/.flypi/agent/mcp.json: Expected property name"] });
		await tick();
		expect(document.querySelector('[data-role="config-error"]')?.textContent).toContain("Expected property name");
		// Empty lists say they are empty, and adding is still offered: a broken `mcp.json` is no reason the
		// page cannot write a new one.
		expect(document.querySelector('[data-role="mcp-servers"]')?.textContent).toContain("none configured");
		expect(screen.getByRole("button", { name: "Add server" })).toBeTruthy();
	});
});

/** What a probe answers: one server left off in the file, one that is up and says what it offers. */
const MCP_STATUS: McpStatusSnapshot = {
	servers: [
		{ name: "flypi-memory", state: "disabled", transport: "http", tools: [] },
		{
			name: "fs",
			state: "connected",
			transport: "stdio",
			tools: [
				{ name: "list_directory", destructive: false, openWorld: false },
				{ name: "write_file", destructive: true, openWorld: true },
			],
		},
	],
	log: "2024-01-01T00:00:01.000Z [fs] server ready\n2024-01-01T00:00:02.000Z [flypi-memory] unauthorized",
};

describe("the MCP status panel", () => {
	/** The files, then what the servers said: the two things that section of the view shows. */
	async function answered(transport: FakeTransport, status: McpStatusSnapshot = MCP_STATUS): Promise<void> {
		const requestId = (transport.sent.find((command) => command.type === "mcpStatus") as { requestId: string }).requestId;
		transport.emit({ type: "result", requestId, mcpStatus: status });
		await tick();
	}

	it("marks each row with what its server answered", async () => {
		const transport = await mount();
		await openSettings(transport);
		// Asked when the view opens, like the files: an answer takes seconds (an stdio server has to start), so
		// it is asked once per visit rather than on a timer.
		expect(sent(transport, "mcpStatus")).toHaveLength(1);
		// Until it answers a row says so, rather than looking fine or looking broken.
		expect(row("mcp", 1).textContent).toContain("not checked");

		await answered(transport);

		// The state belongs next to the row it describes, not in a panel of its own.
		expect(row("mcp", 1).textContent).toContain("connected · 2 tools");
		// A server that is off in the file is shown as off: it was never asked, and it is not “down”.
		expect(row("mcp").textContent).toContain("disabled");
		expect(row("mcp").querySelector('[data-role="mcp-state"]')).toBeNull();

		// What each server offers is the row's count, not a list of names under the list.

		// pi's own log, for the connections a session actually made — not the same thing as this probe.
		expect(document.querySelector('[data-role="mcp-log"]')?.textContent).toContain("[flypi-memory] unauthorized");
	});

	it("quotes a server's own failure, and says when nothing was logged", async () => {
		const transport = await mount();
		await openSettings(transport);
		await answered(transport, { servers: [{ name: "fs", state: "failed", transport: "stdio", error: "spawn npx ENOENT", tools: [] }], log: "" });

		expect(row("mcp", 1).textContent).toContain("not reachable");
		// The server's words, not a tidied-up one-liner: this is the text a user pastes into a bug report.
		expect(row("mcp", 1).querySelector('[data-role="mcp-error"]')?.textContent).toContain("spawn npx ENOENT");
		// Nothing logged is a state, not a blank box (risk 8).
		expect(document.querySelector('[data-role="mcp-log"]')?.textContent).toContain("nothing logged");
	});

	it("retires the answer when the files change, rather than describing servers that may be gone", async () => {
		const transport = await mount();
		await openSettings(transport);
		await answered(transport);
		expect(row("mcp", 1).textContent).toContain("connected");

		(row("mcp").querySelector('[data-role="mcp-remove"]') as HTMLButtonElement).click();
		await tick();
		const requestId = (transport.sent.find((command) => command.type === "saveConfig") as { requestId: string }).requestId;
		transport.emit({ type: "result", requestId, config: { ...SNAPSHOT, mcpServers: SNAPSHOT.mcpServers.slice(1) } });
		await tick();

		// The entry that answer described has just been deleted, so the rows left go back to “not checked” and
		// the tool list goes with them. Asking again is the button's job — nothing re-asks by itself.
		expect(row("mcp", 0).textContent).toContain("not checked");
		expect(document.querySelector('[data-role="mcp-tools"]')).toBeNull();
		expect(document.querySelector('[data-role="mcp-log"]')).toBeNull();
		expect(sent(transport, "mcpStatus")).toHaveLength(1);
	});
});

/**
 * The MCP sign-in (docs/architecture.md Phase 5, risk 5): the settings view opens the browser and takes the
 * redirect back as a paste, because flypi runs where a browser may not be able to reach it.
 */
describe("the MCP sign-in", () => {
	// A third server: an HTTP entry with no Authorization header of its own, which is the one condition pi
	// signs in under (src/agent/pi-mcp.ts).
	const OAUTH_SNAPSHOT: ConfigSnapshot = {
		...SNAPSHOT,
		mcpServers: [
			...SNAPSHOT.mcpServers,
			{
				...SNAPSHOT.mcpServers[1]!,
				name: "sentry",
				url: "https://mcp.sentry.dev/mcp",
				command: "",
				args: [],
				authorization: "",
				oauth: { clientId: "", clientSecret: "", callbackUrl: "", scope: "" },
				enabled: true,
			},
		],
	};

	/** Open settings with that server in it and press its "Sign in". */
	async function startSignIn(transport: FakeTransport): Promise<string> {
		await openSettings(transport, OAUTH_SNAPSHOT);
		fireEvent.click(row("mcp", 2).querySelector('[data-role="mcp-signin"]') as HTMLElement);
		await tick();
		return (sent(transport, "mcpSignIn")[0] as { requestId: string }).requestId;
	}

	it("offers a sign-in for an HTTP server with no Authorization header of its own", async () => {
		const transport = await mount();
		await openSettings(transport, OAUTH_SNAPSHOT);
		expect(row("mcp", 2).querySelector('[data-role="mcp-signin"]')).toBeTruthy();
	});

	it("offers none for a server with its own header or one flypi starts itself", async () => {
		const transport = await mount();
		await openSettings(transport);
		// Row 0 has an Authorization header and is off; row 1 is a command. Neither is an OAuth server, so the
		// panel must not offer a sign-in the file would ignore.
		expect(document.querySelector('[data-role="mcp-signin"]')).toBeNull();
	});

	it("shows the URL the server pushed, in the row it belongs to", async () => {
		const transport = await mount();
		await startSignIn(transport);
		expect(sent(transport, "mcpSignIn")).toHaveLength(1);

		transport.emit({ type: "mcpAuth", name: "sentry", url: "https://auth.example/authorize?state=abc" });
		await tick();
		// The box is inside the row, not a panel that could be about any server.
		const box = row("mcp", 2).querySelector('[data-role="mcp-signin-box"]') as HTMLElement;
		expect(box.querySelector('[data-role="mcp-auth-url"]')?.getAttribute("href")).toBe("https://auth.example/authorize?state=abc");
		expect(row("mcp", 1).querySelector('[data-role="mcp-signin-box"]')).toBeNull();
	});

	it("sends the pasted redirect back, and closes when the refreshed status arrives", async () => {
		const transport = await mount();
		const requestId = await startSignIn(transport);
		transport.emit({ type: "mcpAuth", name: "sentry", url: "https://auth.example/authorize?state=abc" });
		await tick();
		const box = row("mcp", 2).querySelector('[data-role="mcp-signin-box"]') as HTMLElement;

		fireEvent.input(box.querySelector('input[name="redirect"]') as HTMLInputElement, { target: { value: "http://127.0.0.1:9/callback?code=x&state=abc" } });
		await tick();
		fireEvent.submit(box.querySelector("form") as HTMLFormElement);
		await tick();
		expect(transport.sent).toContainEqual({ type: "mcpRedirect", name: "sentry", url: "http://127.0.0.1:9/callback?code=x&state=abc" });

		// The sign-in's own ack is a fresh status: the row it was started from, answering now that it has a
		// token. That is what retires the URL and the box — nothing polls to find out.
		transport.emit({ type: "result", requestId, mcpStatus: { servers: [{ name: "sentry", state: "connected", transport: "http", tools: [] }], log: "" } });
		await tick();
		expect(row("mcp", 2).querySelector('[data-role="mcp-signin-box"]')).toBeNull();
		expect(row("mcp", 2).textContent).toContain("connected · 0 tools");
	});

	it("cancels on an empty paste, and says so when the sign-in failed", async () => {
		const transport = await mount();
		const requestId = await startSignIn(transport);
		transport.emit({ type: "mcpAuth", name: "sentry", url: "https://auth.example/authorize?state=abc" });
		await tick();
		fireEvent.click(row("mcp", 2).querySelector('[data-role="mcp-signin-cancel"]') as HTMLElement);
		await tick();
		expect(transport.sent).toContainEqual({ type: "mcpRedirect", name: "sentry", url: "" });

		// A sign-in the server refused is a sentence about the row, in the settings view — not on the chat.
		transport.emit({ type: "error", requestId, message: 'sign-in to "sentry" was cancelled' });
		await tick();
		expect(document.querySelector('[data-role="save-error"]')?.textContent).toContain("was cancelled");
		expect(row("mcp", 2).querySelector('[data-role="mcp-signin-box"]')).toBeNull();
		// And the button is pressable again: the wait is over either way.
		expect((row("mcp", 2).querySelector('[data-role="mcp-signin"]') as HTMLButtonElement).disabled).toBe(false);
	});
});

/**
 * The extensions section: the packages the agent loads (docs/protocol.md `packages` / `savePackages`). What
 * is asserted here is the page's half — the list arrives when the view opens, one source goes out per action,
 * and a source the server could not install is said where it was typed. What an install does to the agent dir
 * is covered in tests/agent/packages.test.ts and tests/server/server.test.ts.
 */
describe("the extension packages", () => {
	const PACKAGES: PackagesSnapshot = {
		packages: [
			{ source: "npm:pi-web-access", scope: "user", installed: true, path: "/repo/.flypi/agent/npm/node_modules/pi-web-access", update: true },
			{ source: "npm:pi-subagents@0.4.0", scope: "user", installed: false, path: "" },
		],
		checkedAt: "2026-01-05T09:00:00.000Z",
		errors: [],
	};

	/** The list, as the server answered it. Asked when the view opens, like the files and the servers. */
	async function answered(transport: FakeTransport, packages: PackagesSnapshot = PACKAGES): Promise<void> {
		const requestId = (transport.sent.find((command) => command.type === "packages") as { requestId: string }).requestId;
		transport.emit({ type: "result", requestId, packages });
		await tick();
	}

	const packageRow = (nth: number) => document.querySelectorAll('[data-role="package"]')[nth] as HTMLElement;
	const sentPackages = (transport: FakeTransport, kind: "install" | "remove" | "update") =>
		transport.sent.flatMap((c) => (c.type === "savePackages" ? (((c as { [k: string]: unknown })[kind] ?? []) as string[]) : []));

	it("asks for the list when the view opens, and shows one row per package", async () => {
		const transport = await mount();
		await openSettings(transport);
		expect(sent(transport, "packages")).toHaveLength(1);

		await answered(transport);
		const rows = document.querySelectorAll('[data-role="package"]');
		expect(rows).toHaveLength(2);
		// "not installed" is a state of its own: an entry can be declared with its code never fetched, and a
		// row that looked installed would be a lie about what the next conversation gets.
		expect(packageRow(0).querySelector('[data-role="package-state"]')?.textContent).toContain("installed");
		expect(packageRow(0).querySelector('[data-role="package-update"]')?.textContent).toContain("update available");
		expect(packageRow(1).querySelector('[data-role="package-state"]')?.textContent).toContain("not installed");
		// The daemon's answer, not a fresh check: the page never reaches a registry by itself. One stamp covers
		// both checks — the daemon writes the pi and extension stamps in the same daily pass.
		expect(document.querySelector('[data-role="pi-checked"]')?.textContent).toContain("2026-01-05");
	});

	it("says so when nothing is installed and nothing has been checked", async () => {
		const transport = await mount();
		await openSettings(transport);
		await answered(transport, { packages: [], errors: [] });
		expect(document.querySelector('[data-role="packages"] .cfg-none')?.textContent).toContain("none installed");
		expect(document.querySelector('[data-role="pi-checked"]')?.textContent).toContain("not checked");
	});

	it("installs the source that was typed, one per submit", async () => {
		const transport = await mount();
		await openSettings(transport);
		await answered(transport);

		const input = document.querySelector('[data-role="package-source"]') as HTMLInputElement;
		fireEvent.input(input, { target: { value: " npm:pi-web-access " } });
		await tick();
		fireEvent.submit(input.closest("form") as HTMLFormElement);
		await tick();

		expect(sentPackages(transport, "install")).toEqual(["npm:pi-web-access"]);
		// The box is empty again and the button says it is working: npm takes seconds, and a page that looks
		// stuck gets clicked twice.
		expect(input.value).toBe("");
		expect((document.querySelector('[data-role="package-install"]') as HTMLButtonElement).textContent).toContain("Working");
	});

	it("updates and removes one row, and only that one", async () => {
		const transport = await mount();
		await openSettings(transport);
		await answered(transport);

		fireEvent.click(packageRow(0).querySelector('[data-role="package-update-now"]') as HTMLButtonElement);
		await tick();
		fireEvent.click(packageRow(1).querySelector('[data-role="package-remove"]') as HTMLButtonElement);
		await tick();

		expect(sentPackages(transport, "update")).toEqual(["npm:pi-web-access"]);
		expect(sentPackages(transport, "remove")).toEqual(["npm:pi-subagents@0.4.0"]);
		// No Update button on a row the daemon found nothing newer for.
		expect(packageRow(1).querySelector('[data-role="package-update-now"]')).toBeNull();
	});

	it("says so when the server refuses, and the buttons work again", async () => {
		const transport = await mount();
		await openSettings(transport);
		await answered(transport);

		fireEvent.click(packageRow(0).querySelector('[data-role="package-update-now"]') as HTMLButtonElement);
		await tick();
		const requestId = (transport.sent.find((command) => command.type === "savePackages") as { requestId: string }).requestId;
		transport.emit({ type: "error", requestId, message: "the registry answered 404 for npm:pi-web-access" });
		await tick();

		// Nothing changed on disk, so the refusal has to be said where the row is — the chat's error strip is
		// not on screen while this view is.
		expect(document.querySelector('[data-role="save-error"]')?.textContent).toContain("404");
		// The wait is over either way, so the row can be tried again.
		expect((packageRow(0).querySelector('[data-role="package-update-now"]') as HTMLButtonElement).disabled).toBe(false);
	});

	it("offers the published versions of an npm extension, and installs one as a pin", async () => {
		const transport = await mount();
		await openSettings(transport);
		const PINS: PackagesSnapshot = {
			...PACKAGES,
			packages: [
				{
					source: "npm:pi-web-access",
					scope: "user",
					installed: true,
					path: "/repo/.flypi/agent/npm/node_modules/pi-web-access",
					version: "1.1.0",
					update: true,
					name: "pi-web-access",
					versions: ["1.0.0", "1.1.0", "2.0.0"],
					available: "2.0.0",
				},
				{
					source: "npm:pi-subagents@0.4.0",
					scope: "user",
					installed: true,
					path: "/repo/.flypi/agent/npm/node_modules/pi-subagents",
					version: "0.4.0",
					name: "pi-subagents",
					versions: ["0.4.0", "0.5.0"],
				},
			],
		};
		await answered(transport, PINS);

		// Installed over published — and a source already on the newest release is told so, not offered a step.
		expect(packageRow(0).querySelector('[data-role="package-available"]')?.textContent).toContain("newest published 2.0.0");
		expect(packageRow(1).querySelector('[data-role="package-available"]')?.textContent).toContain("nothing newer published");
		// The picker is newest first, and marks the one that is installed, so the reader knows what they are leaving.
		const options = (packageRow(1).querySelector('[data-role="package-version-pick"]') as HTMLSelectElement).options;
		expect(Array.from(options).map((option) => option.value)).toEqual(["0.5.0", "0.4.0"]);
		expect(options[1]?.textContent).toContain("installed");
		// A source that names a version is pinned, and the daily check leaves it where it is: that is the way back.
		expect(packageRow(1).querySelector('[data-role="package-pinned"]')?.textContent).toContain("pinned");
		expect(packageRow(0).querySelector('[data-role="package-pinned"]')).toBeNull();

		// Untouched picker: the newest release it shows. Touched: what the reader picked. The page is busy until
		// the server answers an install, so each one has to finish before the next row's button is clickable.
		const finishSave = (transport: FakeTransport) => {
			const requestId = (transport.sent.filter((command) => command.type === "savePackages").at(-1) as { requestId: string }).requestId;
			transport.emit({ type: "result", requestId, packages: PINS });
		};
		fireEvent.click(packageRow(0).querySelector('[data-role="package-pin"]') as HTMLButtonElement);
		finishSave(transport);
		await tick();
		const select = packageRow(1).querySelector('[data-role="package-version-pick"]') as HTMLSelectElement;
		fireEvent.change(select, { target: { value: "0.4.0" } });
		await tick();
		// The button says which version it is about to write, before the reader commits to it.
		expect((packageRow(1).querySelector('[data-role="package-pin"]') as HTMLButtonElement).textContent).toContain("Install 0.4.0");
		fireEvent.click(packageRow(1).querySelector('[data-role="package-pin"]') as HTMLButtonElement);
		await tick();
		// pi's own pin form through the existing install — it replaces the row's entry rather than adding one.
		expect(sentPackages(transport, "install")).toEqual(["npm:pi-web-access@2.0.0", "npm:pi-subagents@0.4.0"]);
	});

	it("says which file pi could not read, instead of an empty list", async () => {
		const transport = await mount();
		await openSettings(transport);
		await answered(transport, { packages: [], errors: ["/repo/.flypi/agent/settings.json: Expected property name"] });
		expect(document.querySelector('[data-role="package-errors"]')?.textContent).toContain("settings.json");
	});
});

/**
 * The raw editor: `models.json` and `settings.json` as text, for the fields the forms do not hold. What is
 * asserted here is the page's half — the boxes hold the file's own bytes, a save sends one file with the text
 * it was loaded with as the guard against overwriting someone else's write, and an edit that has not been
 * saved survives a refresh. The write itself is covered in tests/agent/config-files.test.ts.
 */
describe("the pi this flypi runs", () => {
	const PI: PiVersions = { running: "1.3.0", pinned: true, bundled: "1.0.4", trees: ["1.3.0", "1.2.0"], next: "1.4.0", latest: "1.4.0", checkedAt: "2026-01-05T09:00:00.000Z" };

	async function answeredPi(transport: FakeTransport, pi: PiVersions | undefined = PI): Promise<void> {
		const requestId = (transport.sent.find((command) => command.type === "piVersions") as { requestId: string }).requestId;
		transport.emit({ type: "result", requestId, ...(pi ? { pi } : {}) });
		await tick();
	}

	it("asks when the view opens, and names the running version, the pin and the installed tree", async () => {
		const transport = await mount();
		await openSettings(transport);
		expect(sent(transport, "piVersions")).toHaveLength(1);
		await answeredPi(transport);
		const line = document.querySelector('[data-role="pi-running"]')?.textContent ?? "";
		expect(line).toContain("running pi 1.3.0");
		expect(line).toContain("(pinned)");
		expect(document.querySelector('[data-role="pi-checked"]')?.textContent).toContain("2026-01-05");
	});

	it("asks before it restarts the daemon, and only moves on the confirm", async () => {
		const transport = await mount();
		await openSettings(transport);
		await answeredPi(transport);
		fireEvent.click(document.querySelector('[data-role="pi-use"]') as HTMLButtonElement);
		await tick();
		expect(sent(transport, "usePi")).toHaveLength(0);
		// The cost of the operation, said before it happens: this page goes down with the process.
		expect(document.querySelector('[data-role="pi-confirm"]')?.textContent).toContain("this restarts the daemon");
		fireEvent.click(document.querySelector('[data-role="pi-use-confirm"]') as HTMLButtonElement);
		await tick();
		const asked = transport.sent.filter((c) => c.type === "usePi") as { version: string }[];
		expect(asked.map((c) => c.version)).toEqual(["1.4.0"]);
	});

	it("offers to go back only to a version whose tree is on disk, and never to the running one", async () => {
		const transport = await mount();
		await openSettings(transport);
		await answeredPi(transport);
		const rows = [...document.querySelectorAll('[data-role="pi-tree"]')].map((row) => row.textContent ?? "");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain("pi 1.2.0");
		expect(rows[0]).toContain("Switch back to 1.2.0");
		expect(rows.join("")).not.toContain("pi 1.3.0");
	});

	it("shows no list at all when there is nothing to move to", async () => {
		const transport = await mount();
		await openSettings(transport);
		await answeredPi(transport, { ...PI, next: PI.running, latest: PI.running, trees: [PI.running] });
		// An empty list is a box with two horizontal lines and nothing between them.
		expect(document.querySelector('[data-role="pi-versions"]')).toBeNull();
		expect(document.querySelector('[data-role="pi-running"]')?.textContent).toContain("running pi 1.3.0");
	});

	it("says what a process that does not manage pi versions shows instead", async () => {
		const transport = await mount();
		await openSettings(transport);
		// A checkout or a headless server: the answer is the sentence, not an empty list that reads as
		// "nothing newer".
		transport.emit({ type: "error", requestId: (transport.sent.find((c) => c.type === "piVersions") as { requestId: string }).requestId, message: "this flypi process does not manage pi versions" });
		await tick();
		expect(document.querySelector('[data-role="pi-none"]')?.textContent).toContain("a CLI thing in a checkout");
		// A process that cannot check has nothing to ask, so the button is not offered.
		expect(document.querySelector('[data-role="pi-check"]')).toBeNull();
	});

	it("asks the registry again when the check button is clicked, and moves the stamp", async () => {
		const transport = await mount();
		await openSettings(transport);
		await answeredPi(transport);
		fireEvent.click(document.querySelector('[data-role="pi-check"]') as HTMLButtonElement);
		await tick();
		const requestId = (transport.sent.find((c) => c.type === "piCheck") as { requestId: string }).requestId;
		transport.emit({ type: "result", requestId, pi: { ...PI, next: undefined, checkedAt: "2026-01-06T10:00:00.000Z" } });
		await tick();
		expect(document.querySelector('[data-role="pi-checked"]')?.textContent).toContain("2026-01-06");
		expect(document.querySelector('[data-role="pi-next"]')).toBeNull();
	});
});

describe("the raw file editor", () => {
	const box = (name: "models" | "settings") => document.querySelector(`[data-role="raw-${name}"]`) as HTMLTextAreaElement;
	const save = (name: "models" | "settings") => document.querySelector(`[data-role="raw-save-${name}"]`) as HTMLButtonElement;
	const filesSent = (transport: FakeTransport) =>
		transport.sent.flatMap((c) => (c.type === "saveConfig" ? ((c as { files?: unknown[] }).files ?? []) : []));

	it("shows both files as the exact text the server read", async () => {
		const transport = await mount();
		await openSettings(transport);
		expect(box("models").value).toBe(SNAPSHOT.files[0]!.text);
		expect(box("settings").value).toBe(SNAPSHOT.files[1]!.text);
	});

	it("sends one file per save, with the loaded text as the guard", async () => {
		const transport = await mount();
		await openSettings(transport);

		fireEvent.input(box("models"), { target: { value: '{"providers":{}}' } });
		await tick();
		fireEvent.click(save("models"));
		await tick();

		expect(filesSent(transport)).toEqual([{ name: "models", text: '{"providers":{}}', base: SNAPSHOT.files[0]!.text }]);
	});

	it("keeps an edit that has not been saved when another save refreshes the files", async () => {
		const transport = await mount();
		await openSettings(transport);

		// Typed into the models box, not saved; then a default is set, whose ack carries every file again.
		fireEvent.input(box("models"), { target: { value: '{"providers":{"new":{}}}' } });
		await tick();
		fireEvent.click(save("settings"));
		await tick();
		const requestId = (transport.sent.find((c) => c.type === "saveConfig") as { requestId: string }).requestId;
		transport.emit({ type: "result", requestId, config: SNAPSHOT });
		await tick();

		expect(box("models").value).toBe('{"providers":{"new":{}}}');
		// Its guard is still the text it was loaded with, so the server — not the page — decides.
		fireEvent.click(save("models"));
		await tick();
		expect(filesSent(transport)[1]).toEqual({ name: "models", text: '{"providers":{"new":{}}}', base: SNAPSHOT.files[0]!.text });
	});

	it("says so when the server refuses the write, and the box keeps what was typed", async () => {
		const transport = await mount();
		await openSettings(transport);
		fireEvent.input(box("settings"), { target: { value: "{ not json" } });
		await tick();
		fireEvent.click(save("settings"));
		await tick();

		const requestId = (transport.sent.find((c) => c.type === "saveConfig") as { requestId: string }).requestId;
		transport.emit({ type: "error", requestId, message: "Expected property name or '}' in JSON at position 2" });
		await tick();
		expect(document.querySelector('[data-role="save-error"]')?.textContent).toContain("in JSON at position 2");
		expect(box("settings").value).toBe("{ not json");
	});
});
