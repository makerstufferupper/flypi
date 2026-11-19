/**
 * A declared extension package that will not install must cost a tool and not the conversation
 * (pi's docs/packages.md, docs/risks.md risk 1 for where the code may land).
 *
 * The failure this file exists for: pi awaits the install inside `resourceLoader.reload()` unguarded
 * (`core/package-manager.js:1014`, awaits at `:1033`/`:1046`), so an npm or git failure throws through
 * `resolve()` (`core/resource-loader.js:369`) and — with nothing containing it — out of
 * `createFlypiSession`. Since T46.2.2 flypi *declares* a package by default, so that failure is on the
 * default path: on a machine whose npm refuses the install (`npm_config_allow_scripts`, `~/.npmrc`) no
 * conversation could start at all. What is asserted here, in order: the conversation starts, the package's
 * tool is the only thing missing, the settings panel says why, and every other tool the conversation would
 * have had is still there.
 *
 * pi's own offline switch (`PI_OFFLINE`) decides which half of that is reached — an install that fails, or an
 * install that is never attempted — so the rows that depend on which one they are in name the value they need
 * (`withOffline`) instead of reading whatever the shell exported: `PI_OFFLINE=1 npx vitest run
 * tests/agent/package-degrade.test.ts` has to be green as well.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PACKAGES, ensureAgentConfig, ensureSubagentDefaults } from "../../src/agent/config-files.ts";
import { flypiPaths, type FlypiPaths } from "../../src/agent/paths.ts";
import { readPackages } from "../../src/agent/packages.ts";
import { createFlypiSession } from "../../src/agent/runtime.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import { startMemoryServer, type MemoryServerHandle } from "../../src/memory/mcp.ts";
import { createTempFlypiRoot, withProviderConfig } from "../helpers/flypi-root.ts";
import { activeToolNames } from "../helpers/flypi-harness.ts";
import { createStubModel } from "../helpers/stub-model.ts";
import { openTestDb, wordEmbedder } from "../helpers/memory-db.ts";

const TOKEN = "package-degrade-token";
const MEMORY_TOOLS = ["mcp__flypi_memory__memory_search", "mcp__flypi_memory__memory_write"];

/**
 * A source that cannot install **anywhere**, in milliseconds, with no registry, no network and no npm
 * policy to lean on: git's own transport refusing a loopback connect on port 1 (measured 0.02-0.07 s for
 * the install attempt, and the row below holds the whole session under 2 s).
 *
 * Chosen by measuring the candidates, not by guessing: `git+file:///<missing>`, `<missing>` and
 * `file://<missing>` all parse as a *local* path (`package-manager.js:1183` treats anything that is not an
 * `npm:`/`git:`/`http:`-prefixed string as a path) and a missing local path is simply not loaded — no
 * failure at all, so none of them exercise the path. `ssh://git@127.0.0.1:1/…` fails as fast but needs an
 * ssh binary; an `npm:` form fails only because *this* machine's npm refuses scripts, which a test may not
 * depend on.
 */
const UNINSTALLABLE = "https://127.0.0.1:1/flypi/no-such-repo.git";
/** A second one, failing just as fast and verifiably its own way, for the row that cares about the order. */
const UNINSTALLABLE_OTHER = "https://127.0.0.1:2/flypi/other-no-such-repo.git";

let handle: MemoryServerHandle;

beforeAll(async () => {
	handle = await startMemoryServer({ store: new MemoryStore(openTestDb(), wordEmbedder()), token: TOKEN });
	process.env.FLYPI_MEMORY_TOKEN = TOKEN;
});

afterAll(async () => {
	await handle.close();
});

/**
 * Run one row with `PI_OFFLINE` exactly as that row needs it — `undefined` means "pi may reach the network",
 * which is not the same statement as "unset in this shell". The rows that assert a reason came from a real
 * install need it cleared; the row that asserts the skipped install needs it set.
 */
async function withOffline<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
	const saved = process.env.PI_OFFLINE;
	if (value === undefined) delete process.env.PI_OFFLINE;
	else process.env.PI_OFFLINE = value;
	try {
		return await run();
	} finally {
		if (saved === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = saved;
	}
}

/** A checkout with a memory server and a `packages` list, configured against a provider it never calls. */
function rootDeclaring(packages: string[]): { root: string; paths: FlypiPaths } {
	const root = withProviderConfig(createTempFlypiRoot());
	const paths = flypiPaths(root);
	writeFileSync(paths.mcpPath, JSON.stringify({ mcpServers: { "flypi-memory": { url: handle.url, headers: { Authorization: `Bearer ${"${FLYPI_MEMORY_TOKEN}"}` }, exposure: "direct" } } }));
	writeFileSync(paths.settingsPath, JSON.stringify({ packages }));
	return { root, paths };
}

describe("a declared package that will not install", () => {
	// The red proof, flipped to green: this call used to reject with the install's own error
	// (`/tmp/t4623-red.log`), which is a conversation that cannot start.
	it("starts the conversation, loses only that package, and tells the panel", async () => {
		await withOffline(undefined, async () => {
			const { root, paths } = rootDeclaring([UNINSTALLABLE]);
			const stub = await createStubModel();
			const t0 = Date.now();
			const { session } = await createFlypiSession({ root, modelRuntime: stub.modelRuntime, model: stub.model });
			const elapsed = Date.now() - t0;
			try {
				// Under vitest's own 5 s testTimeout, so a slow run fails on the bound rather than as an opaque
				// timeout, and far under pi's 10 s network timeout, which is the thing being ruled out.
				// Measured 0.2 s for the whole session.
				expect(elapsed).toBeLessThan(2_000);
				// The tool the package would have registered is gone, and the flypi tools stayed.
				expect(session.getActiveToolNames()).not.toContain("Agent");
				expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "bash", "edit", "write", "task_write", "goal", "tool_search"]));
				// Said, rather than shown as an empty list: the source and the reason, one line each.
				const errors = readPackages(paths).errors;
				expect(errors).toHaveLength(1);
				expect(errors[0]).toContain(UNINSTALLABLE);
				expect(errors[0]).toContain("did not install");
				expect(errors[0]!.split("\n")).toHaveLength(1);
			} finally {
				session.dispose();
			}
		});
	});

	// The other way a declared source ends up absent: pi never throws in offline mode
	// (`isOfflineModeEnabled`, `core/package-manager.js:38`; the resolve path returns before the install at
	// `:1015`), so the catch that would have named the failure never runs. Without a stamp the operator gets a
	// tool that quietly vanished and a panel that says nothing — the pair the row for the shipped default forbids.
	it("says the install was skipped when pi was told to be offline", async () => {
		await withOffline("1", async () => {
			const { root, paths } = rootDeclaring([UNINSTALLABLE]);
			const stub = await createStubModel();
			const { session } = await createFlypiSession({ root, modelRuntime: stub.modelRuntime, model: stub.model });
			try {
				expect(session.getActiveToolNames()).not.toContain("Agent");
				const errors = readPackages(paths).errors;
				expect(errors).toHaveLength(1);
				expect(errors[0]).toBe(`${UNINSTALLABLE} did not install: install not attempted (pi offline mode)`);
			} finally {
				session.dispose();
			}
		});
	});

	// The offline sentence belongs to offline mode and nothing else: a local-path source the operator moved away
	// is missing in a process that can reach the network, and pi reports that one itself ("Extension path does not
	// exist"). Naming offline mode for it would send the reader to an environment variable that is not the cause.
	it("does not blame offline mode for a local path that is simply gone", async () => {
		await withOffline(undefined, async () => {
			const { root, paths } = rootDeclaring([]);
			writeFileSync(paths.settingsPath, JSON.stringify({ packages: [join(root, "gone-package-dir")] }));
			const stub = await createStubModel();
			const { session } = await createFlypiSession({ root, modelRuntime: stub.modelRuntime, model: stub.model });
			try {
				expect(session.getActiveToolNames()).not.toContain("Agent");
				expect(readPackages(paths).errors.join("\n")).not.toContain("offline");
			} finally {
				session.dispose();
			}
		});
	});

	// pi's `resolvePackageSources` (`core/package-manager.js:1001`) is a sequential loop that throws at the
	// first source it cannot install, so the ones behind it were never attempted and cannot be blamed for that
	// error. Both orders, because "first" has to mean what the operator wrote in settings.json.
	it("blames the source whose own install failed, and says the one behind it was not attempted", async () => {
		/** The host:port each source's own git error names. */
		const host = (source: string) => source.slice("https://".length).split("/")[0]!;
		const orders: Array<[string, string]> = [
			[UNINSTALLABLE, UNINSTALLABLE_OTHER],
			[UNINSTALLABLE_OTHER, UNINSTALLABLE],
		];
		for (const [first, second] of orders) {
			await withOffline(undefined, async () => {
				const { root, paths } = rootDeclaring([first, second]);
				const stub = await createStubModel();
				const { session } = await createFlypiSession({ root, modelRuntime: stub.modelRuntime, model: stub.model });
				try {
					expect(session.getActiveToolNames()).not.toContain("Agent");
					const errors = readPackages(paths).errors;
					expect(errors).toHaveLength(2);
					// The first carries the error its own install produced, and that error names its own host:port
					// — not the one the operator would otherwise be sent off to fix.
					expect(errors[0]!.startsWith(`${first} did not install:`)).toBe(true);
					expect(errors[0]).toContain(host(first));
					expect(errors[0]).not.toContain(host(second));
					expect(errors[1]).toBe(`${second} did not install: not attempted (an earlier declared source failed to install)`);
				} finally {
					session.dispose();
				}
			});
		}
	});

	// The stamp is advice for the panel, not a precondition for a conversation: an unwritable `.flypi` has to
	// cost the sentence, never the session and never the install error the catch is about to act on.
	it("still starts the conversation when the stamp itself cannot be written", async () => {
		await withOffline(undefined, async () => {
			const { root, paths } = rootDeclaring([UNINSTALLABLE]);
			const stamp = join(root, ".flypi", "package-failures.json");
			mkdirSync(stamp, { recursive: true });
			const stub = await createStubModel();
			const { session } = await createFlypiSession({ root, modelRuntime: stub.modelRuntime, model: stub.model });
			try {
				expect(session.getActiveToolNames()).not.toContain("Agent");
				expect(session.getActiveToolNames()).toContain("read");
				// And nothing was half-written over what the operator has standing there.
				expect(statSync(stamp).isDirectory()).toBe(true);
			} finally {
				session.dispose();
			}
		});
	});

	// The retry path must not be a different way to build a session. Every flypi tool and every MCP tool,
	// compared against the same root with nothing declared.
	it("leaves the rest of the tool set exactly as a healthy root has it", async () => {
		const healthy = rootDeclaring([]);
		const degraded = rootDeclaring([UNINSTALLABLE]);
		const stub = await createStubModel();
		const first = await createFlypiSession({ ...healthy, modelRuntime: stub.modelRuntime, model: stub.model });
		const second = await createFlypiSession({ ...degraded, modelRuntime: stub.modelRuntime, model: stub.model });
		try {
			const before = (await activeToolNames(first.session, MEMORY_TOOLS)).slice().sort();
			const after = (await activeToolNames(second.session, MEMORY_TOOLS)).slice().sort();
			expect(after).toEqual(before);
			expect(before).toEqual(expect.arrayContaining(MEMORY_TOOLS));
		} finally {
			first.session.dispose();
			second.session.dispose();
		}
	});

	// The retry borrows a process-wide variable, so it owes the process what it found there. `""` is the case
	// worth a row: pi reads it as "not offline" (`core/package-manager.js:38`), so the first reload still fails
	// and the retry still runs — and an unset restored as the string `"undefined"`, or a value restored over
	// somebody else's, would be left set for the daemon's own update check to believe.
	it("gives PI_OFFLINE back exactly as it found it", async () => {
		const { root, paths } = rootDeclaring([UNINSTALLABLE]);
		const saved = process.env.PI_OFFLINE;
		// `""` is pi's "not offline" (`core/package-manager.js:38`), so this row is an online row by choice.
		process.env.PI_OFFLINE = "";
		try {
			const stub = await createStubModel();
			const { session } = await createFlypiSession({ root, modelRuntime: stub.modelRuntime, model: stub.model });
			session.dispose();
			expect(process.env.PI_OFFLINE).toBe("");
			// The retry is why there is a conversation to talk about at all.
			expect(readPackages(paths).errors.join(" ")).toContain("did not install");
		} finally {
			if (saved === undefined) delete process.env.PI_OFFLINE;
			else process.env.PI_OFFLINE = saved;
		}
	});

	// A source that installs is the normal path: loaded, and nothing stamped or reported about it.
	it("still loads a package that installs, and says nothing about it", async () => {
		const { root, paths } = rootDeclaring([]);
		// A package with one extension that registers a tool — the same shape tests/agent/packages.test.ts builds.
		const dir = join(root, "my-pkg");
		mkdirSync(join(dir, "extensions"), { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "my-pkg", version: "1.0.0", pi: { extensions: ["extensions/tool.ts"] } }, null, 2));
		writeFileSync(
			join(dir, "extensions", "tool.ts"),
			"export default function (pi) {\n\tpi.registerTool({ name: \"pkg_tool\", description: \"d\", parameters: {}, execute: async () => ({ content: [{ type: \"text\", text: \"ok\" }], details: undefined }) });\n}\n",
		);
		writeFileSync(paths.settingsPath, JSON.stringify({ packages: [dir] }));
		const stub = await createStubModel();
		const { session } = await createFlypiSession({ root, modelRuntime: stub.modelRuntime, model: stub.model });
		try {
			expect(await activeToolNames(session, [...MEMORY_TOOLS, "pkg_tool"])).toEqual(expect.arrayContaining([...MEMORY_TOOLS, "pkg_tool"]));
			expect(readPackages(paths).errors).toEqual([]);
			// No stamp for a package that loaded: the retry never ran, so nothing was written beside it.
			expect(existsSync(join(root, ".flypi", "package-failures.json"))).toBe(false);
		} finally {
			session.dispose();
		}
	});
});

/**
 * The shipped default, end to end — the gap the T46.2.2 review found: the seeded root had only ever been read
 * back off the file, never started. Which half of the invariant holds is the *environment*'s business (an npm
 * that installs gives the conversation the tool; one that refuses must give the sentence), so the row asserts
 * the pair and never neither.
 */
describe("the default flypi ships", () => {
	it("starts a conversation over a root seeded exactly the way the daemon seeds one", async () => {
		const root = createTempFlypiRoot();
		const paths = flypiPaths(root);
		ensureAgentConfig(paths);
		expect(await ensureSubagentDefaults(paths)).toEqual([paths.settingsPath, join(paths.agentDir, "subagents.json")]);
		const stub = await createStubModel();
		const { session } = await createFlypiSession({ root, modelRuntime: stub.modelRuntime, model: stub.model });
		try {
			const tools = session.getActiveToolNames();
			const errors = readPackages(paths).errors;
			// Never both false: either the declared extension is loaded, or the panel says it is not.
			expect(tools.includes("Agent") || errors.some((error) => error.includes(DEFAULT_PACKAGES[0]!))).toBe(true);
		} finally {
			session.dispose();
		}
	});

	// The state T51 put every root in: the daemon's seed declared the default, and this row says what happens
	// when the code is *already there* — pi resolves an `npm:` source by looking for
	// `<agentDir>/npm/node_modules/<name>` and only installs when it is missing (`package-manager.js:1030`), so
	// the fabricated directory is also what keeps this row off the network. Green with
	// `npm_config_registry=http://127.0.0.1:9/` is the proof: had pi asked npm, the install would have failed
	// and this row would be in the degrade half above instead of holding a loaded tool.
	it("hands the conversation the default's own tool when the code is already installed under the root", async () => {
		const root = createTempFlypiRoot();
		const paths = flypiPaths(root);
		ensureAgentConfig(paths);
		expect(await ensureSubagentDefaults(paths)).toEqual([paths.settingsPath, join(paths.agentDir, "subagents.json")]);
		// Built, never installed: pi's npm layout and the shape the rows of tests/agent/packages.test.ts fake,
		// with one extension that registers the tool the real package registers.
		const dir = join(paths.agentDir, "npm", "node_modules", "@tintinweb", "pi-subagents");
		mkdirSync(join(dir, "extensions"), { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@tintinweb/pi-subagents", version: "0.26.1", pi: { extensions: ["extensions/agent.ts"] } }, null, 2));
		writeFileSync(
			join(dir, "extensions", "agent.ts"),
			"export default function (pi) {\n\tpi.registerTool({ name: \"Agent\", description: \"d\", parameters: {}, execute: async () => ({ content: [{ type: \"text\", text: \"ok\" }], details: undefined }) });\n}\n",
		);
		const stub = await createStubModel();
		const { session } = await createFlypiSession({ root, modelRuntime: stub.modelRuntime, model: stub.model });
		try {
			// The tool the default package provides is in the conversation — the seeded `askBeforeUse` gate
			// refuses a call, it does not hide the tool — and the package reads declared-and-installed with
			// nothing said against it, so the degrade path never ran.
			expect(await activeToolNames(session, ["Agent"])).toContain("Agent");
			expect(readPackages(paths).packages[0]).toMatchObject({ source: DEFAULT_PACKAGES[0], installed: true, version: "0.26.1" });
			expect(readPackages(paths).errors).toEqual([]);
		} finally {
			session.dispose();
		}
	});
});
