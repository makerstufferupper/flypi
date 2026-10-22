/**
 * Extension packages (docs/protocol.md `packages` / `savePackages`, pi's docs/packages.md). What is asserted
 * here is flypi's half of the contract: the declaration goes into `.flypi/agent/settings.json` and nothing
 * else in that file moves, the code lands inside `.flypi/` rather than the host `~/.pi` (docs/risks.md
 * risk 1), a `settings.json` pi cannot read is said instead of shown as "no packages", and the package
 * actually reaches a flypi session — including a session that was already open when it was installed, which
 * is the part that silently loses MCP tools if the reload is done wrong.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPackageEdits, autoExtensions, dueForPackageCheck, readPackages, readPackageCheck, writePackageCheck } from "../../src/agent/packages.ts";
import { FlypiConfigError, createFlypiSession, type FlypiSession } from "../../src/agent/runtime.ts";
import { flypiPaths, type FlypiPaths } from "../../src/agent/paths.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import { startMemoryServer, type MemoryServerHandle } from "../../src/memory/mcp.ts";
import { createTempFlypiRoot } from "../helpers/flypi-root.ts";
import { activeToolNames } from "../helpers/flypi-harness.ts";
import { createStubModel } from "../helpers/stub-model.ts";
import { openTestDb, wordEmbedder } from "../helpers/memory-db.ts";

const TOKEN = "packages-memory-token";
const MEMORY_TOOLS = ["mcp__flypi_memory__memory_search", "mcp__flypi_memory__memory_write"];

let handle: MemoryServerHandle;

beforeAll(async () => {
	handle = await startMemoryServer({ store: new MemoryStore(openTestDb(), wordEmbedder()), token: TOKEN });
});

afterAll(async () => {
	await handle.close();
});

/** A checkout with a package next to it, ready to install by path. */
function rootWithPackage(settings: Record<string, unknown> = { defaultProvider: "lmstudio", defaultModel: "qwen3" }) {
	const root = createTempFlypiRoot();
	const paths = flypiPaths(root);
	writeFileSync(paths.settingsPath, JSON.stringify(settings, null, 2));
	// A package with one extension that registers a tool: the tool name is what every test below looks for.
	const dir = join(root, "my-pkg");
	mkdirSync(join(dir, "extensions"), { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "my-pkg", version: "1.0.0", pi: { extensions: ["extensions/tool.ts"] } }, null, 2));
	writeFileSync(
		join(dir, "extensions", "tool.ts"),
		"export default function (pi) {\n\tpi.registerTool({ name: \"pkg_tool\", description: \"d\", parameters: {}, execute: async () => ({ content: [{ type: \"text\", text: \"ok\" }], details: undefined }) });\n}\n",
	);
	return { root, paths, dir };
}

const settingsOf = (paths: FlypiPaths) => JSON.parse(readFileSync(paths.settingsPath, "utf8")) as Record<string, unknown>;

describe("whether the daemon may update extensions by itself", () => {
	// The default is the behaviour that predates the key; only `false` turns it off. pi itself never updates
	// unattended, in either setting (docs/pi-upgrades.md).
	it("is on unless settings.json says otherwise", () => {
		// No settings.json at all: the defaults have to work.
		expect(autoExtensions(flypiPaths(join(tmpdir(), "flypi-no-such-root")))).toBe(true);
		const { paths } = rootWithPackage({ updates: { autoExtensions: false } });
		expect(autoExtensions(paths)).toBe(false);
		const { paths: other } = rootWithPackage({ updates: { autoExtensions: true } });
		expect(autoExtensions(other)).toBe(true);
	});
});

describe("the packages a flypi checkout declares", () => {
	it("installs by source, records the declaration, and leaves the rest of settings.json alone", async () => {
		const { paths, dir } = rootWithPackage({ defaultProvider: "lmstudio", defaultModel: "qwen3", permissions: { askBeforeUse: ["bash"] } });
		const snapshot = await applyPackageEdits(paths, { install: [dir] });
		// The version is the installed code's own, which is what a rollback has to name.
		expect(snapshot.packages).toEqual([{ source: expect.any(String), scope: "user", installed: true, path: dir, version: "1.0.0" }]);
		expect(snapshot.errors).toEqual([]);
		// The entry is pi's own form — a path relative to the settings file that holds it — and the keys the
		// settings panel owns are untouched (src/agent/config-files.ts writes the default pair into this file).
		const settings = settingsOf(paths);
		const declared = settings.packages as unknown[];
		expect(declared).toHaveLength(1);
		expect(String(declared[0]).endsWith("my-pkg")).toBe(true);
		expect(settings).toMatchObject({ defaultProvider: "lmstudio", defaultModel: "qwen3", permissions: { askBeforeUse: ["bash"] } });
		// The list the panel gets back names where the code is, so a local package is visibly a local package.
		expect(readPackages(paths).packages[0]).toMatchObject({ installed: true, path: dir });
	});

	it("removes the declaration with remove, so the next conversation does not load it", async () => {
		const { paths, dir } = rootWithPackage();
		await applyPackageEdits(paths, { install: [dir] });
		const snapshot = await applyPackageEdits(paths, { remove: [dir] });
		expect(snapshot.packages).toEqual([]);
		expect(settingsOf(paths).packages).toEqual([]);
	});

	it("says which declared package has no code on disk yet, instead of pretending it is loaded", async () => {
		const { paths } = rootWithPackage();
		writeFileSync(paths.settingsPath, JSON.stringify({ packages: ["npm:pi-web-access"] }, null, 2));
		// A session would install it on start; the panel's job is to say it is not there (docs/protocol.md).
		expect(readPackages(paths).packages).toEqual([{ source: "npm:pi-web-access", scope: "user", installed: false, path: "" }]);
	});

	it("refuses to edit through a settings.json pi cannot read, rather than installing code that is never recorded", async () => {
		const { paths, dir } = rootWithPackage();
		writeFileSync(paths.settingsPath, "{ packages: ]");
		expect(readPackages(paths).errors.join(" ")).toMatch(/settings\.json/);
		await expect(applyPackageEdits(paths, { install: [dir] })).rejects.toThrow(FlypiConfigError);
		// Nothing was installed, and the broken file is still the operator's to fix.
		expect(existsSync(join(paths.agentDir, "npm"))).toBe(false);
		expect(readFileSync(paths.settingsPath, "utf8")).toBe("{ packages: ]");
	});

	it("keeps the update stamp as the answer the panel shows, and says when it is stale", () => {
		const { root, paths } = rootWithPackage();
		expect(readPackageCheck(root)).toBeNull();
		expect(dueForPackageCheck(readPackageCheck(root))).toBe(true);
		writePackageCheck(root, { checkedAt: new Date().toISOString(), updates: ["npm:pi-web-access"] });
		expect(dueForPackageCheck(readPackageCheck(root))).toBe(false);
		writeFileSync(paths.settingsPath, JSON.stringify({ packages: ["npm:pi-web-access"] }, null, 2));
		// The badge comes from the stamp: reading the list reaches no registry.
		expect(readPackages(paths).packages[0]).toMatchObject({ source: "npm:pi-web-access", installed: false, update: true });
	});
});

/**
 * The part that is easy to get wrong: a conversation that is already open. `reload()` swaps the extension
 * runtime but does not re-emit `session_start` for a headless session, and that event is what connects the
 * MCP servers — so a reload that forgets `bindExtensions` installs the extension and quietly drops every
 * memory tool the chat had (src/server/session-registry.ts).
 */
describe("an installed package reaches the conversations", () => {
	let root: string;
	let paths: FlypiPaths;
	let dir: string;
	let session: FlypiSession;

	beforeAll(async () => {
		process.env.FLYPI_MEMORY_TOKEN = TOKEN;
		({ root, paths, dir } = rootWithPackage());
		writeFileSync(paths.mcpPath, JSON.stringify({ mcpServers: { "flypi-memory": { url: handle.url, headers: { Authorization: `Bearer ${"${FLYPI_MEMORY_TOKEN}"}` }, exposure: "direct" } } }));
	});

	it("loads it in a new session, and in one that was open before it was installed", async () => {
		const stub = await createStubModel();
		const created = await createFlypiSession({ root, modelRuntime: stub.modelRuntime, model: stub.model });
		session = created.session;
		const before = await activeToolNames(session, MEMORY_TOOLS);
		expect(before).toEqual(expect.arrayContaining(MEMORY_TOOLS));
		expect(before).not.toContain("pkg_tool");

		await applyPackageEdits(paths, { install: [dir] });
		await session.reload();
		await session.bindExtensions({});

		const after = await activeToolNames(session, [...MEMORY_TOOLS, "pkg_tool"]);
		expect(after).toEqual(expect.arrayContaining([...MEMORY_TOOLS, "pkg_tool"]));
	});

	afterAll(() => session?.dispose());
});
