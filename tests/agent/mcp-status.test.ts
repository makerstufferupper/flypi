/**
 * The MCP status panel's half (docs/architecture.md Phase 5): asking the servers in `.flypi/agent/mcp.json`
 * whether they answer, and what they said. Every server here is a real one — flypi's own memory MCP over
 * HTTP, the third-party filesystem server over stdio, a port nobody listens on, the same memory MCP with the
 * wrong token — because a status panel built on fakes would only ever prove its own fixtures.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { mcpLogTail, mcpStatus } from "../../src/agent/mcp-status.ts";
import { flypiPaths } from "../../src/agent/paths.ts";
import { startMemoryServer, type MemoryServerHandle } from "../../src/memory/mcp.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import { createTempFlypiRoot } from "../helpers/flypi-root.ts";
import { openTestDb, wordEmbedder } from "../helpers/memory-db.ts";

const TOKEN = "status-probe-token";
// The package has no main entry, so the bin is what resolves — the same script `pi mcp add` would spawn.
const FILESYSTEM_SERVER = createRequire(import.meta.url).resolve("@modelcontextprotocol/server-filesystem/dist/index.js");

let handle: MemoryServerHandle;

beforeAll(async () => {
	handle = await startMemoryServer({ store: new MemoryStore(openTestDb(), wordEmbedder()), token: TOKEN });
});
afterAll(async () => {
	await handle.close();
});

/** A checkout whose mcp.json holds exactly these entries. */
function rootWith(mcpServers: Record<string, unknown>): string {
	const root = createTempFlypiRoot();
	writeFileSync(join(root, ".flypi", "agent", "mcp.json"), JSON.stringify({ mcpServers }));
	return root;
}

describe("asking the MCP servers", () => {
	it("connects to an HTTP server and lists the tools it announced", async () => {
		const root = rootWith({ "flypi-memory": { url: handle.url, headers: { Authorization: `Bearer ${"${FLYPI_MEMORY_TOKEN}"}` } } });
		process.env.FLYPI_MEMORY_TOKEN = TOKEN;
		try {
			const status = await mcpStatus(flypiPaths(root));
			expect(status.servers).toEqual([
				{
					name: "flypi-memory",
					state: "connected",
					transport: "http",
					// Everything the store's own server declares, with its own annotations — including the two
					// that retire a row, which is what a reader puts on `permissions.askBeforeUse` after seeing
					// them marked here (src/agent/permission-gate.ts).
					tools: expect.arrayContaining([
						{ name: "memory_search", destructive: false, openWorld: false },
						{ name: "memory_forget", destructive: true, openWorld: false },
					]),
				},
			]);
		} finally {
			delete process.env.FLYPI_MEMORY_TOKEN;
		}
	});

	it("starts a third-party stdio server and reads the tools it announced", async () => {
		// The entry a user would write by hand: this node, that package's bin, one allowed directory.
		const root = createTempFlypiRoot();
		writeFileSync(
			join(root, ".flypi", "agent", "mcp.json"),
			JSON.stringify({ mcpServers: { filesystem: { command: process.execPath, args: [FILESYSTEM_SERVER, join(root, ".flypi")] } } }),
		);
		const status = await mcpStatus(flypiPaths(root));
		expect(status.servers[0]).toMatchObject({
			name: "filesystem",
			state: "connected",
			transport: "stdio",
			tools: expect.arrayContaining([
				{ name: "list_directory", destructive: false, openWorld: false },
				{ name: "directory_tree", destructive: false, openWorld: false },
			]),
		});
		// Every one of its tools says it stays on this machine, and that is what shows: nothing here upgrades a
		// server's own claim into a scarier one.
		expect(status.servers[0]!.tools.every((tool) => tool.openWorld === false)).toBe(true);
	});

	it("does not claim a disabled entry is broken, and does not start it", async () => {
		const status = await mcpStatus(flypiPaths(rootWith({ filesystem: { command: process.execPath, args: [FILESYSTEM_SERVER, "."], enabled: false } })));
		expect(status.servers).toEqual([{ name: "filesystem", state: "disabled", transport: "stdio", tools: [] }]);
	});

	it("calls an unreachable port a failure, in the server's own words", async () => {
		const status = await mcpStatus(flypiPaths(rootWith({ gone: { url: "http://127.0.0.1:1/mcp" } })));
		expect(status.servers[0]).toMatchObject({ name: "gone", state: "failed", transport: "http", tools: [] });
		expect(status.servers[0]!.error).toBeTruthy();
	});

	it("calls a rejected credential a missing authorisation, not a dead server", async () => {
		// The distinction a user acts on: one needs a token in the entry, the other needs a server started.
		const status = await mcpStatus(flypiPaths(rootWith({ "flypi-memory": { url: handle.url, headers: { Authorization: "Bearer wrong" } } })));
		expect(status.servers[0]).toMatchObject({ name: "flypi-memory", state: "needs-auth" });
	});

	it("gives up on a server that never answers, and says that is what it did", async () => {
		// A process that starts and stays silent is the one case that would otherwise hang the panel forever.
		const root = rootWith({ silent: { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] } });
		const status = await mcpStatus(flypiPaths(root), 300);
		expect(status.servers[0]).toMatchObject({ name: "silent", state: "failed" });
		expect(status.servers[0]!.error).toContain("no answer within");
	});

	it("reports nothing, without an error, when no server is configured", async () => {
		expect(await mcpStatus(flypiPaths(createTempFlypiRoot()))).toEqual({ servers: [], log: "" });
	});
});

describe("the MCP log tail", () => {
	it("is empty when nothing was logged", () => {
		expect(mcpLogTail(flypiPaths(createTempFlypiRoot()))).toBe("");
	});

	it("returns what pi's own extension wrote", () => {
		const paths = flypiPaths(createTempFlypiRoot());
		writeFileSync(paths.mcpLogPath, "2024-01-01T00:00:00.000Z [flypi-memory] server ready\n2024-01-01T00:00:01.000Z [filesystem] ENOENT npx\n");
		expect(mcpLogTail(paths)).toContain("[flypi-memory] server ready");
		expect(mcpLogTail(paths)).toContain("ENOENT npx");
	});

	it("keeps whole lines when it cuts a long log", () => {
		const paths = flypiPaths(createTempFlypiRoot());
		const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
		writeFileSync(paths.mcpLogPath, lines.join("\n"));
		const tail = mcpLogTail(paths, 120);
		expect(tail).toBe(lines.slice(-Math.floor(120 / 8)).join("\n"));
		expect(tail.split("\n").every((line) => /^line \d+$/.test(line))).toBe(true);
	});
});
