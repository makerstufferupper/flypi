/**
 * A `deferred` MCP server (docs/architecture.md Phase 5, docs/testing.md): its tools are **not declared**
 * to the model, and `tool_search` is the only route to them. flypi registered the exposure and never
 * loaded `tool_search`, so a server set to `deferred` was reachable by no route at all — silently fewer
 * tools, no error. This is the second half of the phase's "Done when".
 *
 * The server is the real `@modelcontextprotocol/server-filesystem` over stdio, because the parts a fake
 * would get wrong are pi's own: which tools a deferred server registers, what `tool_search` will match,
 * and that loading it through the active tool set makes the next call work.
 *
 * The third block is `toolExposure`, the per-tool exception the settings panel writes now: a server stays
 * `direct` while one of its tools is taken away (docs/architecture.md Phase 5).
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFlypiSession, type FlypiSession } from "../../src/agent/runtime.ts";
import { createTempFlypiRoot } from "../helpers/flypi-root.ts";
import { createStubModel, fauxAssistantMessage, fauxText, fauxToolCall } from "../helpers/stub-model.ts";

const FILESYSTEM_SERVER = createRequire(import.meta.url).resolve("@modelcontextprotocol/server-filesystem/dist/index.js");
const LIST_TOOL = "mcp__filesystem__list_directory";
const TOOL_SEARCH = "tool_search";

function rootWithServer(extra: Record<string, unknown> = {}): { root: string; readable: string } {
	const root = createTempFlypiRoot();
	const created = join(root, "readable");
	mkdirSync(created);
	writeFileSync(join(created, "on-disk.txt"), "the file the server is asked to find\n");
	// The server compares realpaths, and a temp dir on macOS is a symlink (`/var` is `/private/var`).
	const readable = realpathSync(created);
	const entry = { command: process.execPath, args: [FILESYSTEM_SERVER, readable], ...extra };
	writeFileSync(join(root, ".flypi", "agent", "mcp.json"), JSON.stringify({ mcpServers: { filesystem: entry } }));
	return { root, readable };
}

const rootWithDeferredServer = () => rootWithServer({ exposure: "deferred" });

/**
 * The server connects in the background, so proof its tool is *registered* (which is not the same as
 * declared) is a wait with a deadline — the same shape `activeToolNames` uses.
 */
async function registered(session: FlypiSession, name: string, deadline = 20_000): Promise<boolean> {
	const until = Date.now() + deadline;
	for (;;) {
		if (session.getCallableToolNames().includes(name)) return true;
		if (Date.now() > until) return false;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

describe("a deferred MCP server", () => {
	it("is loaded by tool_search, and then answers", async () => {
		const { root, readable } = rootWithDeferredServer();
		const stub = await createStubModel({
			responses: [
				fauxAssistantMessage([fauxToolCall(TOOL_SEARCH, { query: "list a directory" }, { id: "search-1" })], {
					stopReason: "toolUse",
					timestamp: 0,
				}),
				fauxAssistantMessage([fauxToolCall(LIST_TOOL, { path: readable }, { id: "list-1" })], {
					stopReason: "toolUse",
					timestamp: 0,
				}),
				fauxAssistantMessage([fauxText("one file: on-disk.txt")], { timestamp: 0 }),
			],
		});
		const { session } = await createFlypiSession({ root, modelRuntime: stub.modelRuntime, model: stub.model });
		try {
			expect(await registered(session, LIST_TOOL), "the deferred server never registered its tool").toBe(true);
			// Registered is not declared — that is what the exposure means, and it is why the model has to
			// search before it can reach the server.
			expect(session.getActiveToolNames()).not.toContain(LIST_TOOL);
			// And the route exists: flypi's sessions carry tool_search active.
			expect(session.getActiveToolNames()).toContain(TOOL_SEARCH);

			await session.prompt("what is in that directory?");

			// Loading went through the active tool set, so the tool is declared from here on — recorded in the
			// transcript like any other tool change, which is what makes it survive resume and fork.
			expect(session.getActiveToolNames()).toContain(LIST_TOOL);
			// The search named it, the call ran against the real server, and the answer is the server's:
			// that file name exists nowhere but in what it read off disk.
			const shown = JSON.stringify(stub.requests.at(-1)!.messages);
			expect(shown).toContain(LIST_TOOL);
			expect(shown).toContain("on-disk.txt");
		} finally {
			session.dispose();
		}
	});

	it("reaches a server left at pi's own default exposure the same way", async () => {
		// pi's default is `codemode`, and flypi loads no codemode extension — so an entry written without an
		// `exposure` key is the common case of the same dead end. This is the case that caught a deleted line:
		// a `deferred` server's tools activate `tool_search` when they register, a default-exposure server's
		// do not, so the sessions have to activate it themselves (src/agent/runtime.ts).
		const { root, readable } = rootWithServer();
		const stub = await createStubModel({
			responses: [
				fauxAssistantMessage([fauxToolCall(TOOL_SEARCH, { query: "list a directory" }, { id: "search-1" })], {
					stopReason: "toolUse",
					timestamp: 0,
				}),
				fauxAssistantMessage([fauxToolCall(LIST_TOOL, { path: readable }, { id: "list-1" })], {
					stopReason: "toolUse",
					timestamp: 0,
				}),
				fauxAssistantMessage([fauxText("one file: on-disk.txt")], { timestamp: 0 }),
			],
		});
		const { session } = await createFlypiSession({ root, modelRuntime: stub.modelRuntime, model: stub.model });
		try {
			expect(await registered(session, LIST_TOOL), "the default-exposure server never registered its tool").toBe(true);
			expect(session.getActiveToolNames()).not.toContain(LIST_TOOL);
			expect(session.getActiveToolNames()).toContain(TOOL_SEARCH);
			await session.prompt("what is in that directory?");
			expect(session.getActiveToolNames()).toContain(LIST_TOOL);
			expect(JSON.stringify(stub.requests.at(-1)!.messages)).toContain("on-disk.txt");
		} finally {
			session.dispose();
		}
	});
});

describe("a per-tool exception on a direct server", () => {
	it("takes one tool away and leaves the rest declared", async () => {
		// The reason the settings panel had to grow `toolExposure`: flypi's own memory server is `direct`, and
		// the counters it calls after a turn must stay out of the model's reach (docs/memory.md Phase 4). The
		// exception is read by pi, not by us, so this is the real server in a real session.
		const { root } = rootWithServer({ exposure: "direct", toolExposure: { list_directory: "hidden" } });
		const stub = await createStubModel({ responses: [] });
		const { session } = await createFlypiSession({ root, modelRuntime: stub.modelRuntime, model: stub.model });
		const READ_TOOL = "mcp__filesystem__read_file";
		try {
			expect(await registered(session, READ_TOOL), "the direct server never registered its tools").toBe(true);
			expect(session.getActiveToolNames()).toContain(READ_TOOL);
			// `hidden` removes the tool rather than hiding its name: not declared, and not callable either.
			expect(session.getActiveToolNames()).not.toContain(LIST_TOOL);
			expect(session.getCallableToolNames()).not.toContain(LIST_TOOL);
		} finally {
			session.dispose();
		}
	});
});
