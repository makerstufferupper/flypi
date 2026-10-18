/**
 * A scripted turn calling a **real third-party MCP server** (docs/architecture.md Phase 5, docs/testing.md):
 * `@modelcontextprotocol/server-filesystem` is spawned by flypi's own session wiring from
 * `.flypi/agent/mcp.json`, its tool reaches the model as `mcp__filesystem__list_directory`, the model calls
 * it, and the answer the model is then shown came out of that server.
 *
 * Nothing here is a stub of an MCP server: the point of the test is the parts a fake could get wrong — pi's
 * naming of a connected server's tools, the stdio transport, the allowed-directory argument, and the result
 * coming back as a tool result the model can read. The model is the stub, because the turn has to be
 * deterministic; the server is not.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFlypiSession } from "../../src/agent/runtime.ts";
import { createTempFlypiRoot } from "../helpers/flypi-root.ts";
import { activeToolNames } from "../helpers/flypi-harness.ts";
import { createStubModel, fauxAssistantMessage, fauxText, fauxToolCall } from "../helpers/stub-model.ts";

const FILESYSTEM_SERVER = createRequire(import.meta.url).resolve("@modelcontextprotocol/server-filesystem/dist/index.js");
const LIST_TOOL = "mcp__filesystem__list_directory";

/**
 * A checkout with a real directory to read and an `mcp.json` entry that starts the real server over stdio.
 * `exposure: "direct"` is what declares its tools to the model (docs/mcp.md) — the default would leave them
 * reachable only from a codemode script.
 */
function rootWithFilesystemServer(): { root: string; readable: string } {
	const root = createTempFlypiRoot();
	const created = join(root, "readable");
	mkdirSync(created);
	writeFileSync(join(created, "on-disk.txt"), "the file the server is asked to find\n");
	// The server compares realpaths, and a temp dir on macOS is a symlink (`/var` is `/private/var`), so the
	// path it is given and the path the model asks for are both the resolved one.
	const readable = realpathSync(created);
	writeFileSync(
		join(root, ".flypi", "agent", "mcp.json"),
		JSON.stringify({
			mcpServers: { filesystem: { command: process.execPath, args: [FILESYSTEM_SERVER, readable], exposure: "direct" } },
		}),
	);
	return { root, readable };
}

describe("a turn that calls a real MCP server", () => {
	it("reaches the server and brings its answer back to the model", async () => {
		const { root, readable } = rootWithFilesystemServer();
		const stub = await createStubModel({
			responses: [
				fauxAssistantMessage([fauxToolCall(LIST_TOOL, { path: readable }, { id: "list-1" })], { stopReason: "toolUse", timestamp: 0 }),
				fauxAssistantMessage([fauxText("one file: on-disk.txt")], { timestamp: 0 }),
			],
		});
		const { session } = await createFlypiSession({ root, modelRuntime: stub.modelRuntime, model: stub.model });
		try {
			// Connected before the turn: `session_start` is what spawns it, and the tool name is pi's own
			// (`mcp__<server>__<tool>`), not something flypi invented.
			const active = await activeToolNames(session, [LIST_TOOL]);
			expect(active).toContain(LIST_TOOL);

			await session.prompt("what is in that directory?");

			// The second model call carries the tool result. That text is the server's, not the harness's: the
			// file name only exists in what the server read off disk.
			const shown = JSON.stringify(stub.requests.at(-1)!.messages);
			expect(shown).toContain("on-disk.txt");
			// And the model answered with it, which is the whole point of connecting a server.
			expect(stub.requests).toHaveLength(2);
		} finally {
			session.dispose();
		}
	});

	it("holds a tool of that server back when the user asked to be asked, without the server running", async () => {
		// The gate and the panel are one loop: the panel shows `mcp__filesystem__*` tool names, the settings
		// file names them, and a call that is not approved never reaches the server (src/agent/permission-gate.ts).
		const { root, readable } = rootWithFilesystemServer();
		writeFileSync(join(root, ".flypi", "agent", "settings.json"), JSON.stringify({ permissions: { askBeforeUse: ["mcp__filesystem__*"] } }));
		const stub = await createStubModel({
			responses: [
				fauxAssistantMessage([fauxToolCall(LIST_TOOL, { path: readable }, { id: "list-1" })], { stopReason: "toolUse", timestamp: 0 }),
				fauxAssistantMessage([fauxText("waiting on you")], { timestamp: 0 }),
			],
		});
		const { session } = await createFlypiSession({ root, modelRuntime: stub.modelRuntime, model: stub.model });
		try {
			await session.prompt("what is in that directory?");
			const shown = JSON.stringify(stub.requests.at(-1)!.messages);
			// Not the server's answer: the reason it did not run.
			expect(shown).toContain("needs your approval first");
			expect(shown).not.toContain("on-disk.txt");
		} finally {
			session.dispose();
		}
	});
});
