/**
 * Extension packages (docs/protocol.md `packages` / `savePackages`, pi's docs/packages.md). What is asserted
 * here is flypi's half of the contract: the declaration goes into `.flypi/agent/settings.json` and nothing
 * else in that file moves, the code lands inside `.flypi/` rather than the host `~/.pi` (docs/risks.md
 * risk 1), a `settings.json` pi cannot read is said instead of shown as "no packages", and the package
 * actually reaches a flypi session — including a session that was already open when it was installed, which
 * is the part that silently loses MCP tools if the reload is done wrong.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { DEFAULT_PACKAGES } from "../../src/agent/config-files.ts";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPackageEdits, autoExtensions, dueForPackageCheck, npmName, prunePackageFailures, publishedVersions, readDeclinedPackages, readPackages, readPackageCheck, recordPackageDecline, recordPackageFailure, writePackageCheck } from "../../src/agent/packages.ts";
import { FlypiConfigError, createFlypiSession, type FlypiSession } from "../../src/agent/runtime.ts";
import { flypiPaths, type FlypiPaths } from "../../src/agent/paths.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import { startMemoryServer, type MemoryServerHandle } from "../../src/memory/mcp.ts";
import { createTempFlypiRoot, hostPiRoot } from "../helpers/flypi-root.ts";
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
		// `name` is the package the source names, with any pin stripped — what a pin is written back onto.
		expect(readPackages(paths).packages).toEqual([{ source: "npm:pi-web-access", scope: "user", installed: false, path: "", name: "pi-web-access" }]);
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

	// The panel's install is a writer of the agent-dir files like the settings save is: pi's package manager
	// puts the code under `<agentDir>/npm` and records the source in `<agentDir>/settings.json`, so a root
	// inside the host `~/.pi` has to be refused before either lands (docs/risks.md risk 1).
	it("refuses to install under the host pi directory, before the code or the declaration lands", async () => {
		const host = hostPiRoot();
		try {
			// The package itself lives in an ordinary temp checkout, so a run without the guard shows what it
			// prevents rather than failing for want of a source.
			const { dir } = rootWithPackage();
			await expect(applyPackageEdits(flypiPaths(host.root), { install: [dir] })).rejects.toThrow(/host pi directory/);
			expect(existsSync(join(host.root, ".flypi"))).toBe(false);
		} finally {
			host.restore();
		}
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
 * The decline behind the panel's Remove (`settings.json`'s `flypi.packagesDeclined`), asserted here because it
 * is written by the code above — `applyPackageEdits` — and not by the seed that reads it
 * (`ensureSubagentDefaults`, src/agent/config-files.ts, whose own rows prove what it does with the answer).
 * The sources are the ones the rows above already use: a local path is what pi installs without a registry.
 */
describe("the packages the operator took out stay out", () => {
	it("records a remove, writes nothing for an ordinary install, and forgets it on a re-install", async () => {
		const { paths, dir } = rootWithPackage({ defaultProvider: "lmstudio", defaultModel: "qwen3", packages: [...DEFAULT_PACKAGES] });
		expect(readDeclinedPackages(paths)).toEqual([]);

		// An install of its own is not a decision about anything: no flypi key goes into the operator's file.
		await applyPackageEdits(paths, { install: [dir] });
		expect("flypi" in settingsOf(paths)).toBe(false);

		// The panel's Remove, which is the only thing that means "not on this machine".
		await applyPackageEdits(paths, { remove: [dir] });
		expect(readDeclinedPackages(paths)).toEqual([dir]);
		await applyPackageEdits(paths, { remove: [DEFAULT_PACKAGES[0]!] });
		expect(readDeclinedPackages(paths)).toEqual([dir, ...DEFAULT_PACKAGES]);
		// The rest of the file is pi's and stays pi's; the decline is written by the uninstall that already
		// landed, so the declaration it removed is gone and the two agree. `settingsOf` runs after the `await`,
		// and `applyPackageEdits` flushes pi's queued write before it returns, so this is the file as it stands
		// once pi wrote it — not an intermediate state. (That the *order* is what it is gets pinned next door,
		// where a content assertion could not see it.)
		expect(settingsOf(paths)).toMatchObject({ defaultProvider: "lmstudio", defaultModel: "qwen3", packages: [] });
		// Owner-only, like every other file in the agent dir (`writeJson`, src/agent/config-files.ts).
		expect(statSync(paths.settingsPath).mode & 0o777).toBe(0o600);

		// Re-installing one source is the operator changing their mind about that source, and only that one.
		await applyPackageEdits(paths, { install: [dir] });
		expect(readDeclinedPackages(paths)).toEqual(DEFAULT_PACKAGES);
		expect(settingsOf(paths).packages).toHaveLength(1);
	});

	it("writes the decline only after pi's own write to settings.json has landed", async () => {
		// The fact to pin here is the *order*, and the bytes at the end cannot pin it: pi's
		// `persistScopedSettings` re-reads the file and rewrites only the field it was asked to set
		// (`settings-manager.js:449-472`), so the decline survives whether flypi writes before or after pi's
		// queued write — a content assertion stays green either way. Sampling inside pi's own `flush()` does see
		// the difference: the flypi key must still be absent when that write has landed, and present by the time
		// `applyPackageEdits` returns.
		const { paths, dir } = rootWithPackage();
		await applyPackageEdits(paths, { install: [dir] });
		const declinedAtFlush: boolean[] = [];
		const realFlush = SettingsManager.prototype.flush;
		const spy = vi.spyOn(SettingsManager.prototype, "flush").mockImplementation(async function (this: SettingsManager) {
			await realFlush.call(this);
			declinedAtFlush.push(readFileSync(paths.settingsPath, "utf8").includes("packagesDeclined"));
		});
		try {
			await applyPackageEdits(paths, { remove: [dir] });
		} finally {
			spy.mockRestore();
		}
		// A flush of somebody else's root could only ever add another `false`, hence "at least one, none true"
		// rather than a bare `[false]`.
		expect(declinedAtFlush.length).toBeGreaterThan(0);
		expect(declinedAtFlush).not.toContain(true);
		// And the one file holds both halves when the call returns: pi's `packages` and flypi's decline.
		expect(settingsOf(paths)).toMatchObject({ packages: [], flypi: { packagesDeclined: [dir] } });
	});

	it("reads as nothing over a file with no flypi key, a key that is not a list, and one that will not parse", () => {
		// The packages panel still has to open over a broken `settings.json`, so the decline is a read that
		// cannot fail — the same shape as `readPackages`' `errors` channel.
		const { paths } = rootWithPackage({ packages: [] });
		expect(readDeclinedPackages(paths)).toEqual([]);
		writeFileSync(paths.settingsPath, JSON.stringify({ packages: [], flypi: { packagesDeclined: "npm:x" } }, null, 2));
		expect(readDeclinedPackages(paths)).toEqual([]);
		writeFileSync(paths.settingsPath, "{ packages: ]");
		expect(readDeclinedPackages(paths)).toEqual([]);
		// No settings.json at all: a fresh root, with nothing declined and nothing thrown.
		expect(readDeclinedPackages(flypiPaths(join(tmpdir(), "flypi-no-such-decline-root")))).toEqual([]);
		// And the panel's own channel says only the one true thing about the broken file, not two things.
		const errors = readPackages(paths).errors;
		expect(errors.join(" ")).toMatch(/settings\.json/);
		expect(errors.filter((line) => line.includes("packagesDeclined"))).toEqual([]);
	});

	it("leaves a settings.json it cannot parse exactly as it is, rather than failing over it", () => {
		// The writer swallows like the failure stamp's writer does: a decline that cannot be recorded is advice
		// the next start loses, not an install to undo — and the file belongs to the operator to fix.
		const { paths } = rootWithPackage();
		writeFileSync(paths.settingsPath, "{ packages: ]");

		recordPackageDecline(paths, DEFAULT_PACKAGES[0]!, true);

		expect(readFileSync(paths.settingsPath, "utf8")).toBe("{ packages: ]");
		expect(readDeclinedPackages(paths)).toEqual([]);
		recordPackageDecline(paths, DEFAULT_PACKAGES[0]!, false);
		expect(readFileSync(paths.settingsPath, "utf8")).toBe("{ packages: ]");
	});
});

/**
 * The stamp a failed install leaves behind (`.flypi/package-failures.json`; src/agent/runtime.ts writes it
 * when a declared source costs the conversation nothing, docs/protocol.md `packages`). Asserted here because
 * the session rows in tests/agent/package-degrade.test.ts can only catch it in one state: what it says, that
 * it says it once, and the two ways it stops saying it.
 */
describe("the stamp a failed install leaves", () => {
	/** The failure pi hands up, in the shape it arrives: npm's own message, multi-line, with its advice. */
	const npmFailure = new Error(
		"npm install @tintinweb/pi-subagents --prefix /r/.flypi/agent/npm --legacy-peer-deps failed with code 1\nnpm error code EALLOWSCRIPTS\nnpm error --allow-scripts is not allowed in project-scoped installs.\n" + "n".repeat(500),
	);
	const SOURCE = "npm:@tintinweb/pi-subagents";

	/** A checkout that declares one source and has no code for it on disk. */
	function rootWithFailure() {
		const fixture = rootWithPackage();
		writeFileSync(fixture.paths.settingsPath, JSON.stringify({ packages: [SOURCE] }, null, 2));
		return fixture;
	}

	it("names the source that did not install, once, on one line — and survives a reload that did not fix it", () => {
		const { paths } = rootWithFailure();
		expect(recordPackageFailure(paths, npmFailure)).toEqual([SOURCE]);
		const errors = readPackages(paths).errors;
		// Once, and readable in a panel row: the settings errors and this one share `errors`, so an
		// accidentally-appended-twice list would be the bug here.
		expect(errors).toHaveLength(1);
		expect(errors[0]!.startsWith(`${SOURCE} did not install: npm install @tintinweb/pi-subagents`)).toBe(true);
		expect(errors[0]).toContain("EALLOWSCRIPTS");
		// Whitespace-collapsed and cut short: no npm usage block, no stack.
		expect(errors[0]!.split("\n")).toHaveLength(1);
		expect(errors[0]!.length).toBeLessThanOrEqual(`${SOURCE} did not install: `.length + 300);
		// The stamp itself is flypi's own file, beside the update stamp and never inside `<agentDir>`.
		const stamp = JSON.parse(readFileSync(join(paths.root, ".flypi", "package-failures.json"), "utf8")) as Record<string, { failedAt: string; reason: string }>;
		expect(Object.keys(stamp)).toEqual([SOURCE]);
		expect(Date.parse(stamp[SOURCE]!.failedAt)).not.toBeNaN();
		// A reload that worked without installing it (pi offline, or a retry) keeps the sentence: the
		// conversation still does not have the extension.
		prunePackageFailures(paths);
		expect(readPackages(paths).errors).toEqual(errors);
	});

	it("takes its reason from anything the reload threw, not only an Error", () => {
		const { paths } = rootWithFailure();
		expect(recordPackageFailure(paths, "git exited 128")).toEqual([SOURCE]);
		expect(readPackages(paths).errors[0]).toBe(`${SOURCE} did not install: git exited 128`);
	});

	it("stops reporting the source once its code is on disk, and drops the stamp when a reload says so", () => {
		const { paths } = rootWithFailure();
		recordPackageFailure(paths, npmFailure);
		// The installed package, built the way the rows above fake one: pi's own npm layout.
		const dir = join(paths.agentDir, "npm", "node_modules", "@tintinweb", "pi-subagents");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@tintinweb/pi-subagents", version: "0.26.0" }));
		// Reported no more — that half happens on the read alone.
		expect(readPackages(paths).errors).toEqual([]);
		expect(readPackages(paths).packages[0]).toMatchObject({ source: SOURCE, installed: true, version: "0.26.0" });
		// And the file goes away with the next reload that worked, which is where the factory clears it.
		prunePackageFailures(paths);
		expect(existsSync(join(paths.root, ".flypi", "package-failures.json"))).toBe(false);
	});

	it("says nothing about a source the operator took out of settings.json, and forgets it on the next reload", () => {
		const { paths } = rootWithFailure();
		recordPackageFailure(paths, npmFailure);
		writeFileSync(paths.settingsPath, JSON.stringify({ packages: [] }, null, 2));
		// A failure nobody can buy back has nobody to tell: the row is gone, so the sentence is gone.
		expect(readPackages(paths).errors).toEqual([]);
		prunePackageFailures(paths);
		expect(existsSync(join(paths.root, ".flypi", "package-failures.json"))).toBe(false);
	});

	it("stamps nothing when the root declares nothing", () => {
		const { paths } = rootWithPackage({ packages: [] });
		// The failure that is not a package's fault: the caller has to surface it, and it has to stay unnamed.
		expect(recordPackageFailure(paths, npmFailure)).toEqual([]);
		expect(existsSync(join(paths.root, ".flypi", "package-failures.json"))).toBe(false);
	});

	it("is a read: readPackages never writes the stamp file", () => {
		const { paths } = rootWithFailure();
		recordPackageFailure(paths, npmFailure);
		const file = join(paths.root, ".flypi", "package-failures.json");
		const before = readFileSync(file);
		readPackages(paths);
		readPackages(paths);
		expect(readFileSync(file)).toEqual(before);
	});

	// The stamp is flypi's own state, so a file that is not the map this writes is a bug report about nothing —
	// and `readPackages` is a hot read (src/server/resources-server.ts calls it on every panel open), where one
	// bad byte would take the panel down with it.
	it("says nothing at all for a stamp file that is not the shape this writes", () => {
		const { paths } = rootWithFailure();
		const file = join(paths.root, ".flypi", "package-failures.json");
		// `null` parses and is not a map: reading an entry out of it is a TypeError on the panel's read path.
		writeFileSync(file, "null\n");
		expect(readPackages(paths).errors).toEqual([]);
		// An entry that is not an object would render "did not install: undefined", advice about nothing.
		writeFileSync(file, JSON.stringify({ [SOURCE]: null }));
		expect(readPackages(paths).errors).toEqual([]);
		writeFileSync(file, JSON.stringify({ [SOURCE]: npmFailure.message }));
		expect(readPackages(paths).errors).toEqual([]);
	});

	// A corrupt stamp is repaired, not kept: the reload that worked rewrites the file from what is declared,
	// so one bad byte does not survive the start that noticed it.
	it("repairs a stamp file it cannot read at all on the next reload that worked", () => {
		const { paths } = rootWithFailure();
		const file = join(paths.root, ".flypi", "package-failures.json");
		writeFileSync(file, "{ packages ]\n");
		expect(readPackages(paths).errors).toEqual([]);
		// The source is on disk now, so there is nothing left to say — and the unreadable file goes with it.
		const dir = join(paths.agentDir, "npm", "node_modules", "@tintinweb", "pi-subagents");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@tintinweb/pi-subagents", version: "0.26.0" }));
		prunePackageFailures(paths);
		expect(existsSync(file)).toBe(false);
	});
});

/**
 * The published versions an extension can be pinned to (docs/pi-upgrades.md 8.4). Going back is not a second
 * mechanism: pi's own package manager refuses to move a source that names a version, so the way back is
 * `npm:<name>@<version>` written through the same install path — which needs the list, and the list is what
 * the daemon's daily stamp holds.
 */
describe("the published versions an extension can be pinned to", () => {
	/** The registry document, in the shape the npm registry answers it — prereleases included. */
	const packument = (versions: string[]) =>
		new Response(JSON.stringify({ versions: Object.fromEntries(versions.map((v) => [v, {}])) }), { headers: { "content-type": "application/json" } });

	it("names the package an npm source pins, and none for a git URL or a path", () => {
		expect(npmName("npm:pi-web-access")).toBe("pi-web-access");
		expect(npmName("npm:pi-subagents@0.4.0")).toBe("pi-subagents");
		expect(npmName("npm:foo@^1.2")).toBe("foo");
		expect(npmName("npm:@scope/pi-x@1.0.0")).toBe("@scope/pi-x");
		expect(npmName("https://github.com/owner/repo")).toBeUndefined();
		expect(npmName("/local/extension-dir")).toBeUndefined();
	});

	it("asks the registry once per npm source, released versions only, oldest first", async () => {
		const { paths } = rootWithPackage();
		writeFileSync(paths.settingsPath, JSON.stringify({ packages: ["npm:pi-web-access", "npm:@scope/pi-x", "/local/dir"] }, null, 2));
		const asked: string[] = [];
		const fetchImpl = (async (url: string) => {
			asked.push(String(url));
			return url.endsWith("%2Fpi-x") ? packument(["0.9.0", "1.0.0", "1.1.0-beta.1"]) : packument(["2.0.0", "2.1.0"]);
		}) as unknown as typeof fetch;
		// A scoped name is asked as `@scope%2Fname`; a path source has no registry to ask, and a prerelease is
		// not a release anyone should be asked to install.
		expect(await publishedVersions(paths, fetchImpl)).toEqual({ "npm:pi-web-access": ["2.0.0", "2.1.0"], "npm:@scope/pi-x": ["0.9.0", "1.0.0"] });
		expect(asked).toEqual(["https://registry.npmjs.org/pi-web-access", "https://registry.npmjs.org/@scope%2Fpi-x"]);
	});

	it("leaves a row with no list when the registry has never heard of it, rather than failing the check", async () => {
		const { paths } = rootWithPackage();
		writeFileSync(paths.settingsPath, JSON.stringify({ packages: ["npm:not-a-package"] }, null, 2));
		const fetchImpl = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
		expect(await publishedVersions(paths, fetchImpl)).toEqual({});
	});

	it("shows installed over published, and offers nothing newer for a source pinned to the newest release", async () => {
		const { root, paths } = rootWithPackage();
		writeFileSync(paths.settingsPath, JSON.stringify({ packages: ["npm:pi-web-access", "npm:pi-subagents@1.1.0"] }, null, 2));
		// The code pi sees, at the version its own package.json claims.
		for (const [name, version] of [["pi-web-access", "2.0.0"], ["pi-subagents", "1.1.0"]] as [string, string][]) {
			const dir = join(paths.agentDir, "npm", "node_modules", name);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version }));
		}
		writePackageCheck(root, {
			checkedAt: new Date().toISOString(),
			updates: ["npm:pi-web-access"],
			versions: { "npm:pi-web-access": ["2.0.0", "2.1.0", "2.2.0"], "npm:pi-subagents": ["1.0.0", "1.1.0"] },
		});
		const rows = readPackages(paths).packages;
		expect(rows[0]).toMatchObject({ version: "2.0.0", name: "pi-web-access", available: "2.2.0", versions: ["2.0.0", "2.1.0", "2.2.0"] });
		// Already on the newest published release: no `available`, so the page cannot offer a step up that is not one.
		expect(rows[1]).toMatchObject({ version: "1.1.0", name: "pi-subagents" });
		expect(rows[1]?.available).toBeUndefined();
		// The pin reads off the source itself — it is no longer `npm:<name>`.
		expect(rows[1]?.source).not.toBe(`npm:${rows[1]?.name}`);
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
