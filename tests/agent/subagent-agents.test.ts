/**
 * `.flypi/agent/agents/*.md` — the agent types flypi's subagent extension can spawn — and the one import that
 * copies them out of the host `~/.pi/agent/agents`.
 *
 * Two rules hold every row here. **An operator's own file is never overwritten**: the import is a convenience,
 * and a copy that replaced a hand-edited `scout.md` would destroy the one thing the operator wrote, in the one
 * place flypi writes on their behalf — and the entry that is *there* includes a symlink or a fifo, which
 * `existsSync` would have looked straight through. **Only a regular `.md` is a candidate**: `copyFileSync` follows
 * symlinks, so a `link.md` pointing out of the source dir would otherwise be copied *through* into the agent dir.
 *
 * Every row works in a temp root (`docs/testing.md`); the two rows that need a host `~/.pi` plant one, and the
 * operator's own home is never read. The resolution rows need no filesystem and no runtime at all, except the few
 * that read a checkout's available models (`availableModels`, and `readAgentTypes` when the caller passes no set) —
 * where an endpoint that is never contacted is the point, not a risk.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { availableModels, hostAgentsDir, importAgentFiles, listAgentFiles, readAgentTypes, resolveAgentModel, type AgentFileRow, type AvailableModel } from "../../src/agent/subagent-agents.ts";
import { flypiPaths, type FlypiPaths } from "../../src/agent/paths.ts";
import { agentDirEnv, createTempFlypiRoot, homeEnv, withProviderConfig } from "../helpers/flypi-root.ts";

/** A checkout of the operator's own, plus the directory the import reads from. */
function fixture(): { root: string; paths: FlypiPaths; source: string } {
	const root = createTempFlypiRoot();
	const source = join(root, "host-agents");
	mkdirSync(source, { recursive: true });
	return { root, paths: flypiPaths(root), source };
}

/**
 * A host home that is not the operator's, holding a seeded `~/.pi/agent/agents`. `os.homedir()` takes `$HOME` at
 * call time (as `tests/agent/agent-dir-isolation.test.ts` relies on), so this is how a row reads the host path
 * without reading the real one.
 */
function plantedHome(prefix = "flypi-hostagents-"): { home: string; agentsDir: string; restore(): void } {
	const home = mkdtempSync(join(tmpdir(), prefix));
	const agentsDir = join(home, ".pi", "agent", "agents");
	mkdirSync(agentsDir, { recursive: true });
	const env = homeEnv(home);
	return {
		home,
		agentsDir,
		restore: () => {
			env.restore();
			rmSync(home, { recursive: true, force: true });
		},
	};
}

/** The mode, as `ls -l` would show it. */
const statMode = (file: string) => statSync(file).mode & 0o777;

/**
 * Quoted on purpose, with the body behind blank lines and leading spaces: pi's parser drops the quotes and trims
 * the body, so an implementation that parsed the frontmatter and wrote it back out could not produce these bytes.
 * The byte-identity rows below are the difference between "copied verbatim" and "re-written, looks the same".
 */
const agentFile = (description: string) => `---\ndescription: "${description} quoted on purpose"\nmodel: lmstudio/qwen3\nthinking: low\n---\n\n  ${description} body text that a re-serialiser would trim\n`;

describe("importAgentFiles", () => {
	it("never overwrites a type that is already in flypi's dir, and says it skipped", () => {
		const { paths, source } = fixture();
		mkdirSync(paths.agentsDir, { recursive: true });
		const mine = join(paths.agentsDir, "scout.md");
		writeFileSync(mine, "OPERATOR'S OWN FILE\n");
		const before = readFileSync(mine);
		writeFileSync(join(source, "scout.md"), "---\ndescription: the flypi copy\n---\nbodies nobody asked for\n");

		const report = importAgentFiles(paths, source);

		expect(readFileSync(mine)).toEqual(before);
		expect(readFileSync(mine, "utf8")).toBe("OPERATOR'S OWN FILE\n");
		expect(report.copied).toEqual([]);
		expect(report.skipped).toEqual(["scout"]);
		expect(existsSync(mine)).toBe(true);
	});

	// The skipped name is the type, which is what the operator's own file declares — the filename is only the
	// loader's fallback, and `scout.md` that declares `name: pilot` blocks the type `pilot`.
	it("names the skipped entry by the type the existing file declares", () => {
		const { paths, source } = fixture();
		mkdirSync(paths.agentsDir, { recursive: true });
		writeFileSync(join(paths.agentsDir, "scout.md"), "---\nname: pilot\n---\nnot a copy of scout\n");
		writeFileSync(join(source, "scout.md"), agentFile("scout"));

		expect(importAgentFiles(paths, source).skipped).toEqual(["pilot"]);
	});

	it("copies every `*.md` verbatim at mode 600 and reports the destinations", () => {
		const { paths, source } = fixture();
		const scout = join(source, "scout.md");
		writeFileSync(scout, agentFile("scout"));
		chmodSync(scout, 0o644); // the host dir's files are world-readable; flypi's must not become so
		writeFileSync(join(source, "tester.md"), agentFile("tester"));

		const report = importAgentFiles(paths, source);

		expect(report.copied).toEqual([join(paths.agentsDir, "scout.md"), join(paths.agentsDir, "tester.md")]);
		expect(report.skipped).toEqual([]);
		expect(report.ignored).toEqual([]);
		expect(readFileSync(join(paths.agentsDir, "scout.md"))).toEqual(readFileSync(scout)); // byte for byte
		expect(readFileSync(join(paths.agentsDir, "tester.md"), "utf8")).toBe(agentFile("tester"));
		expect(readFileSync(join(paths.agentsDir, "scout.md"), "utf8")).toBe(agentFile("scout"));
		for (const dest of report.copied) expect(statMode(dest), dest).toBe(0o600);
	});

	// The `existsSync` guard looked through the link instead of at the entry: a dangling `scout.md` pointing at
	// `elsewhere/sensitive.md` — exactly what a stow-style dotfiles manager leaves behind — read as "not there", and
	// `copyFileSync` wrote *through* it, creating a file outside flypi's dir and reporting it as copied.
	it("will not write through a symlink planted at the destination, dangling or not", () => {
		const { root, paths, source } = fixture();
		mkdirSync(paths.agentsDir, { recursive: true });
		const outside = join(root, "elsewhere", "sensitive.md"); // deliberately never created: the link dangles
		mkdirSync(join(root, "elsewhere"), { recursive: true });
		const dest = join(paths.agentsDir, "scout.md");
		symlinkSync(outside, dest);
		writeFileSync(join(source, "scout.md"), agentFile("scout"));

		const report = importAgentFiles(paths, source);

		expect(existsSync(outside)).toBe(false); // nothing was created outside flypi's dir
		expect(readlinkSync(dest)).toBe(outside); // and the operator's link is the entry it was
		expect(report.skipped).toEqual(["scout"]); // named by the filename: reading a link's target is not on offer
		expect(report.copied).toEqual([]);
	});

	// A copy that died partway (ENOSPC, EIO) used to leave a truncated `scout.md` behind, which every later import
	// reported as `skipped` — the operator could never re-import. The write goes to `scout.md.tmp` and is moved in.
	it("leaves no `.tmp` beside the file it imported", () => {
		const { paths, source } = fixture();
		writeFileSync(join(source, "scout.md"), agentFile("scout"));

		importAgentFiles(paths, source);

		expect(readdirSync(paths.agentsDir)).toEqual(["scout.md"]);
	});

	// The symlink row is the one that keeps `copyFileSync` from following a link out of the source dir: the file it
	// points at is not in the source and would arrive in the agent dir under a name nothing there chose.
	it("ignores a `.txt`, a subdirectory and a symlink, and copies nothing through them", () => {
		const { root, paths, source } = fixture();
		writeFileSync(join(source, "scout.md"), agentFile("scout"));
		writeFileSync(join(source, "notes.txt"), "not a type\n");
		mkdirSync(join(source, "sub"), { recursive: true });
		writeFileSync(join(source, "sub", "inner.md"), agentFile("inner"));
		const outside = join(root, "elsewhere");
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, "target.md"), agentFile("target"));
		symlinkSync(join(outside, "target.md"), join(source, "link.md"));

		const report = importAgentFiles(paths, source);

		expect(report.copied).toEqual([join(paths.agentsDir, "scout.md")]);
		expect(report.ignored.sort()).toEqual(["link.md", "notes.txt", "sub"]);
		expect(existsSync(join(paths.agentsDir, "link.md"))).toBe(false);
		expect(existsSync(join(paths.agentsDir, "inner.md"))).toBe(false);
		expect(readFileSync(join(paths.agentsDir, "scout.md"), "utf8")).toBe(agentFile("scout"));
	});

	it("says so when the source dir is empty rather than calling it nothing", () => {
		const { paths, source } = fixture();

		const report = importAgentFiles(paths, source);

		expect(report.exists).toBe(true);
		expect(report).toMatchObject({ copied: [], skipped: [], ignored: [] });
		expect(report.error).toBeUndefined();
	});

	// The dev container is permanently this shape — `/home/flypi/.pi` does not exist — and the panel's disabled
	// button needs the difference between "no agents yet" and "there is nothing here to import".
	it("reports a source dir that is not there as `exists: false`, without throwing", () => {
		const { paths, source } = fixture();

		const report = importAgentFiles(paths, join(source, "absent"));

		expect(report.exists).toBe(false);
		expect(report).toMatchObject({ copied: [], skipped: [], ignored: [] });
	});

	// Importing a dir into itself would find every name already present and report a directory of skips as a
	// success; the refusal is what keeps that from being the answer.
	it("refuses a source that is flypi's own agents dir, and copies nothing", () => {
		const { paths } = fixture();
		mkdirSync(paths.agentsDir, { recursive: true });
		writeFileSync(join(paths.agentsDir, "scout.md"), "OPERATOR'S OWN FILE\n");

		const report = importAgentFiles(paths, paths.agentsDir);

		expect(report).toMatchObject({ source: paths.agentsDir, exists: false, copied: [], skipped: [], ignored: [] });
		expect(report.error).toContain("flypi's own agents directory");
		expect(readFileSync(join(paths.agentsDir, "scout.md"), "utf8")).toBe("OPERATOR'S OWN FILE\n");
	});

	// The same refusal one `ln -s` away: a source that is a *link* to flypi's dir resolves to somewhere else, so the
	// `resolve` comparison let it through and the run walked the directory reporting every name as a skip.
	it("refuses a source that is a symlink to flypi's own agents dir", () => {
		const { root, paths } = fixture();
		mkdirSync(paths.agentsDir, { recursive: true });
		writeFileSync(join(paths.agentsDir, "scout.md"), "OPERATOR'S OWN FILE\n");
		const link = join(root, "agents-link"); // the name the panel would hand in, now pointed at flypi's dir
		symlinkSync(paths.agentsDir, link);

		const report = importAgentFiles(paths, link);

		expect(report.error).toContain("flypi's own agents directory");
		expect(report).toMatchObject({ exists: false, copied: [], skipped: [], ignored: [] });
		expect(readFileSync(join(paths.agentsDir, "scout.md"), "utf8")).toBe("OPERATOR'S OWN FILE\n");
	});

	// The default source is the host dir, not the agent dir pi resolves for itself: flypi pins
	// `PI_CODING_AGENT_DIR` at process start, so `getAgentDir()` would answer with the write target here.
	it("imports from the host `~/.pi/agent/agents` when the caller names no source", () => {
		const { paths } = fixture();
		const host = plantedHome();
		writeFileSync(join(host.agentsDir, "scout.md"), agentFile("scout"));
		const env = agentDirEnv(paths.agentDir); // what `forceFlypiAgentDir` pins a real process to
		try {
			const report = importAgentFiles(paths);

			expect(report.source).toBe(hostAgentsDir());
			expect(report.copied).toEqual([join(paths.agentsDir, "scout.md")]);
		} finally {
			env.restore();
			host.restore();
		}
	});
});

describe("listAgentFiles", () => {
	it("is an empty list when flypi has no `agents/` dir yet", () => {
		const { paths } = fixture();

		expect(listAgentFiles(paths)).toEqual([]);
		// After the call, because the claim is "reads only": a `mkdirSync` in the read would leave this row green
		// and make the settings panel's refresh a mutation.
		expect(existsSync(paths.agentsDir)).toBe(false);
	});

	// The comment claims filename order and readdir makes no such promise: the container's ext4 returns hash order.
	// Created in one order, asserted in another, and `Mike`/`alpha` pin the locale collation rather than byte order.
	it("returns the rows in filename order, whatever order the directory hands back", () => {
		const { paths } = fixture();
		mkdirSync(paths.agentsDir, { recursive: true });
		for (const name of ["zulu.md", "Mike.md", "alpha.md"]) writeFileSync(join(paths.agentsDir, name), `---\ndescription: ${name}\n---\nbody\n`);

		expect(listAgentFiles(paths).map((row) => row.file)).toEqual([
			join(paths.agentsDir, "alpha.md"),
			join(paths.agentsDir, "Mike.md"),
			join(paths.agentsDir, "zulu.md"),
		]);
	});

	// Claude Code's rule, which the loader follows: `name:` IS the type. A panel that listed the filename instead
	// would name a type `Agent({subagent_type})` refuses.
	it("takes the type from `name:` when the file declares one, and keeps the fields as written", () => {
		const { paths } = fixture();
		mkdirSync(paths.agentsDir, { recursive: true });
		writeFileSync(join(paths.agentsDir, "reviewer.md"), "---\nname: code-reviewer\ndescription: read the diff\nmodel: playred-lms/spark\nthinking: xhigh\n---\nread it once\n");
		writeFileSync(join(paths.agentsDir, "tester.md"), "---\ndescription: run the tests\n---\nrun them\n");
		writeFileSync(join(paths.agentsDir, "notes.txt"), "not a type\n");

		expect(listAgentFiles(paths)).toEqual([
			{
				type: "code-reviewer",
				file: join(paths.agentsDir, "reviewer.md"),
				description: "read the diff",
				model: "playred-lms/spark",
				thinking: "xhigh",
			},
			{ type: "tester", file: join(paths.agentsDir, "tester.md"), description: "run the tests" },
		]);
	});

	// Both of these stay on disk, and the import still copies them: a row with a reason is the difference between
	// "the file is broken" and "there was never a fifth agent".
	it("calls a `name:` containing a colon invalid, and the import still copies that file verbatim", () => {
		const { paths, source } = fixture();
		const body = "name: plugin:scout\ndescription: a scoped name\n---\nstill the operator's prompt\n";
		writeFileSync(join(source, "scout.md"), `---\n${body}`);

		const report = importAgentFiles(paths, source);

		expect(report.copied).toEqual([join(paths.agentsDir, "scout.md")]);
		expect(readFileSync(join(paths.agentsDir, "scout.md"), "utf8")).toBe(`---\n${body}`);
		const [row] = listAgentFiles(paths);
		expect(row?.type).toBe("plugin:scout");
		expect(row?.invalid).toContain("contains a ':'");
	});

	it("calls frontmatter that will not parse invalid, rather than throwing on the read", () => {
		const { paths } = fixture();
		mkdirSync(paths.agentsDir, { recursive: true });
		writeFileSync(join(paths.agentsDir, "broken.md"), "---\nname: [unclosed\n---\nbody\n");

		const [row] = listAgentFiles(paths);

		expect(row?.type).toBe("broken");
		expect(row?.invalid).toContain("unreadable frontmatter");
	});
});

describe("hostAgentsDir", () => {
	// The one read of the host tree, and the reason it is not `getAgentDir()`: with flypi's pin in place, that
	// call answers with the import target and the import would read the directory it writes.
	it("is `~/.pi/agent/agents` for the current home, whatever `PI_CODING_AGENT_DIR` pins", () => {
		const { paths } = fixture();
		const host = plantedHome();
		const env = agentDirEnv(paths.agentDir);
		try {
			expect(hostAgentsDir()).toBe(join(host.home, ".pi", "agent", "agents"));
			expect(hostAgentsDir()).not.toBe(join(paths.agentDir, "agents"));
		} finally {
			env.restore();
			host.restore();
		}
	});

	// pi's own answer for the same directory, with flypi's pin removed: this pins `HOST_CONFIG_DIR` to pi's
	// `CONFIG_DIR_NAME` without listing a string in `PI_COMPAT.imports[].values` (which would fail its own row).
	it("is what pi's own `getAgentDir()` calls its agents dir, with the env unset", () => {
		const env = agentDirEnv(undefined); // `getAgentDir()` reads the env at call time (dist/config.js:491-497)
		try {
			expect(hostAgentsDir()).toBe(join(getAgentDir(), "agents"));
		} finally {
			env.restore();
		}
	});
});

describe("resolveAgentModel", () => {
	/** The conversation default, as `settings.json` holds it: a pair, not a display string. */
	const fallback = { provider: "lmstudio", modelId: "qwen3" };
	/** Never opened: the answer is a pure function of the row, the available set and the fallback. */
	const scoutFile = "/root/.flypi/agent/agents/scout.md";
	/** A listed file; only the two keys these rows are about ever change. */
	const row = (fields: { model?: string; thinking?: string }): AgentFileRow => ({ type: "scout", file: scoutFile, ...fields });
	/** A local endpoint that cannot think, and one that can. */
	const plain: AvailableModel = { provider: "lmstudio", modelId: "qwen3", reasoning: false };

	// The real case this feature exists for: the host's own `scout.md` names `playred-lms/spark-x2.6-4b`, whose
	// endpoint is down. The extension falls back to the parent's model and says nothing
	// (`pi-subagents/src/index.ts:1965-1972`), so a panel that stayed silent would lie about what actually runs.
	it("says so when the file names a model flypi cannot serve, and names the model it will run on instead", () => {
		const answer = resolveAgentModel(row({ model: "playred-lms/spark-x2.6-4b" }), [plain], fallback);

		expect(answer).toEqual({ model: "playred-lms/spark-x2.6-4b", runsOn: "lmstudio/qwen3", resolvable: false });
	});

	it("leaves a file alone when flypi can serve what it asked for, on the model the file named", () => {
		expect(resolveAgentModel(row({ model: "lmstudio/qwen3" }), [plain], fallback)).toEqual({
			model: "lmstudio/qwen3",
			runsOn: "lmstudio/qwen3",
			resolvable: true,
		});
	});

	// The extension compares `provider/modelId` lower-cased (`model-resolver.ts:46,53`), so an ask that differs only
	// in case resolves — and a flypi that called it unresolvable would raise the warning for nothing. `runsOn` is the
	// address the available set spells, which is also the one the panel already shows for that model.
	it("matches the ask the way the extension does, case aside", () => {
		const answer = resolveAgentModel(row({ model: "LMStudio/Qwen3" }), [plain], fallback);

		expect(answer).toEqual({ model: "LMStudio/Qwen3", runsOn: "lmstudio/qwen3", resolvable: true });
	});

	// The extension normalises `.` to `-` before it scores anything (`model-resolver.ts:53,64`), so the dot in a
	// version is cosmetic and `anthropic/claude-haiku-4.5` matches the id `claude-haiku-4-5`. Measured against the
	// extension's own `resolveModel`, this is one of five asks where flypi said `resolvable: false` while the run
	// would have got exactly the model the file named — the warning is the thing that was wrong, not the match.
	it("resolves the ask whose dots are the extension's dashes", () => {
		const haiku: AvailableModel = { provider: "anthropic", modelId: "claude-haiku-4-5", reasoning: true };

		expect(resolveAgentModel(row({ model: "anthropic/claude-haiku-4.5" }), [haiku], fallback)).toEqual({
			model: "anthropic/claude-haiku-4.5",
			runsOn: "anthropic/claude-haiku-4-5",
			resolvable: true,
		});
	});

	// The full address wins, whatever order the available set is in. The extension short-circuits on an exact
	// `provider/modelId` before it scores anything (`model-resolver.ts:52-57`), and pi's own openrouter catalog ships
	// ids that keep their slash — `anthropic/claude-haiku-4.5` is in `pi-ai/dist/providers/data/openrouter.json` — so
	// one `find` testing both arms can answer `openrouter/anthropic/claude-haiku-4.5` for the ask
	// `anthropic/claude-haiku-4.5` whenever openrouter sorts first, while the run itself goes to
	// `anthropic/claude-haiku-4-5`. Naming a model the run will not use is the one direction the contract above forbids,
	// and those two providers are credentialed together on an ordinary machine.
	it("names the provider the full address selects, not the first entry that matches one part of the ask", () => {
		const openrouter: AvailableModel = { provider: "openrouter", modelId: "anthropic/claude-haiku-4.5", reasoning: true };
		const anthropic: AvailableModel = { provider: "anthropic", modelId: "claude-haiku-4-5", reasoning: true };

		expect(resolveAgentModel(row({ model: "anthropic/claude-haiku-4.5" }), [openrouter, anthropic], fallback)).toEqual({
			model: "anthropic/claude-haiku-4.5",
			runsOn: "anthropic/claude-haiku-4-5",
			resolvable: true,
		});
		// The ordering that already worked, so what is pinned is "the full address", not "whichever entry sorts first".
		expect(resolveAgentModel(row({ model: "anthropic/claude-haiku-4.5" }), [anthropic, openrouter], fallback).runsOn).toBe("anthropic/claude-haiku-4-5");
	});

	// A bare `model: qwen3` is a legitimate ask, not a malformed one: the extension matches an exact id against every
	// provider it can see (`model-resolver.ts:64,88`). The row here used to call it unresolvable against a set that
	// held no such id at all, where the extension fails too — so it never touched the divergence it claimed to pin.
	it("resolves a bare `model:` against the provider that serves that id", () => {
		expect(resolveAgentModel(row({ model: "qwen3" }), [plain], fallback)).toEqual({
			model: "qwen3",
			runsOn: "lmstudio/qwen3",
			resolvable: true,
		});
	});

	it("calls a bare `model:` nothing serves unresolvable", () => {
		expect(resolveAgentModel(row({ model: "spark-x2.6-4b" }), [plain], fallback)).toEqual({
			model: "spark-x2.6-4b",
			runsOn: "lmstudio/qwen3",
			resolvable: false,
		});
	});

	// What flypi deliberately does **not** promise. The extension would fuzzy-match the substring `haiku` to
	// `anthropic/claude-haiku-4-5` (score 60 + length, `model-resolver.ts:76`); flypi stops at the two normalisations
	// and warns. That is the allowed direction — a warning may be conservative, because the cost is one needless
	// "will run on the conversation's model instead" line — while naming a model the run will not use never is.
	it("warns rather than claim a model the extension would only fuzzy-match", () => {
		const haiku: AvailableModel = { provider: "anthropic", modelId: "claude-haiku-4-5", reasoning: true };

		expect(resolveAgentModel(row({ model: "haiku" }), [haiku], fallback)).toEqual({
			model: "haiku",
			runsOn: "lmstudio/qwen3",
			resolvable: false,
		});
	});

	// Four of the five files the host ships are this shape; `scout.md` is the fifth. Warning here would be a lie in
	// the common case: the file asked for nothing, so inheriting is the answer rather than a failure — and the panel
	// needs the flag to say "inherits the conversation" instead of implying the file picked that model.
	it("says a file with no `model:` inherits the conversation, instead of implying it chose one", () => {
		expect(resolveAgentModel(row({}), [plain], fallback)).toEqual({ runsOn: "lmstudio/qwen3", resolvable: true, inherited: true });
	});

	// pi's own two truths about levels: `Model.reasoning` (`pi-ai/dist/types.d.ts:650`), read by pi's
	// `supportsThinking` (`agent-session.js:2160-2161`), and a `null` in `Model.thinkingLevelMap`
	// (`pi-ai/dist/models.js:697-699`). Both are about the model the run lands on, which is where pi clamps too.
	it("says so when a file asks for a level on a model that cannot think at all", () => {
		expect(resolveAgentModel(row({ model: "lmstudio/qwen3", thinking: "xhigh" }), [plain], fallback)).toEqual({
			model: "lmstudio/qwen3",
			runsOn: "lmstudio/qwen3",
			resolvable: true,
			thinkingUnsupported: true,
		});
	});

	it("says so when the model it resolved to maps the asked level to null", () => {
		const no_xhigh: AvailableModel = { provider: "nv", modelId: "nemotron", reasoning: true, thinkingLevelMap: { xhigh: null, high: "high" } };

		expect(resolveAgentModel(row({ model: "nv/nemotron", thinking: "xhigh" }), [no_xhigh], fallback)).toEqual({
			model: "nv/nemotron",
			runsOn: "nv/nemotron",
			resolvable: true,
			thinkingUnsupported: true,
		});
	});

	// `null` is not the only "no". pi's rule (`getSupportedThinkingLevels`, pi-ai/dist/models.js:696-703) is
	// `if (level === "xhigh" || level === "max") return mapped !== undefined`: for **those two** a missing key is a
	// "no" as well, while for `low`/`high`/… a missing key means provider defaults. The two files on this machine
	// that ask `xhigh` (`~/.pi/agent/agents/researcher.md`, `reviewer.md`) land on a model whose map is `{low, high}`
	// — pi clamps the level and flypi would have said nothing at all.
	it("says so when the model's map does not name `xhigh` at all", () => {
		const short_map: AvailableModel = { provider: "nv", modelId: "nemotron", reasoning: true, thinkingLevelMap: { low: "low", high: "high" } };

		expect(resolveAgentModel(row({ model: "nv/nemotron", thinking: "xhigh" }), [short_map], fallback)).toEqual({
			model: "nv/nemotron",
			runsOn: "nv/nemotron",
			resolvable: true,
			thinkingUnsupported: true,
		});
	});

	// …and the other half of the same rule: a `null` refuses an ordinary level too, so the missing-key case is not the
	// only one the `xhigh`/`max` exception sits next to.
	it("says so when a level that is not `xhigh` is mapped to null", () => {
		const no_low: AvailableModel = { provider: "nv", modelId: "nemotron", reasoning: true, thinkingLevelMap: { low: null, high: "high" } };

		expect(resolveAgentModel(row({ model: "nv/nemotron", thinking: "low" }), [no_low], fallback).thinkingUnsupported).toBe(true);
	});

	// `off` is a level the extension lists (`pi-subagents/src/types.ts:24`) and the only one pi offers a model that
	// cannot think (`models.js:694-695`), so asking it of a non-reasoning model is the ask succeeding — the panel
	// would warn on every local-endpoint file that spells its default out.
	it("is quiet when a model that cannot think was asked for no thinking", () => {
		expect(resolveAgentModel(row({ model: "lmstudio/qwen3", thinking: "off" }), [plain], fallback)).toEqual({
			model: "lmstudio/qwen3",
			runsOn: "lmstudio/qwen3",
			resolvable: true,
		});
	});

	// …and a model that *can* think can refuse `off` the same way, because pi's rule is one test for every level: a
	// `null` mapping is a "no" at any level (`models.js:697-699`). Real entries ship `"off": null` — `claude-fable-5`,
	// `claude-sonnet-5-5` and `claude-opus-5-5` in `pi-ai/dist/providers/data/anthropic.json` — so `thinking: off`
	// there is clamped up to the lowest level the model has, and a row that stayed quiet about it was quiet about the
	// one direction this feature exists to surface.
	it("says so when a reasoning model maps `off` itself to null", () => {
		const fable: AvailableModel = { provider: "anthropic", modelId: "claude-fable-5", reasoning: true, thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" } };

		expect(resolveAgentModel(row({ model: "anthropic/claude-fable-5", thinking: "off" }), [fable], fallback)).toEqual({
			model: "anthropic/claude-fable-5",
			runsOn: "anthropic/claude-fable-5",
			resolvable: true,
			thinkingUnsupported: true,
		});
	});

	// The quiet side, both ways pi can mean it: a map that carries the level, and a reasoning model that declares no
	// map at all. Flypi claims nothing about either — the level a run was *given* is pi's clamp and belongs to the
	// fleet (`subagents:usage.requestedThinking`), not to this row.
	it("is quiet when the model can do the level it was asked for", () => {
		const maps: AvailableModel = { provider: "nv", modelId: "nemotron", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } };

		expect(resolveAgentModel(row({ model: "nv/nemotron", thinking: "xhigh" }), [maps], fallback).thinkingUnsupported).toBeUndefined();
		expect(resolveAgentModel(row({ model: "nv/nemotron", thinking: "low" }), [{ provider: "nv", modelId: "nemotron", reasoning: true }], fallback).thinkingUnsupported).toBeUndefined();
	});

	// A file that named no model inherits the *conversation's* model, and that is the model the level gets clamped
	// against: `researcher.md`'s `xhigh` on a default that cannot think is a real warning, not the file's fault.
	it("warns about the inherited model too, when it cannot do the asked level", () => {
		expect(resolveAgentModel(row({ thinking: "xhigh" }), [plain], fallback)).toEqual({
			runsOn: "lmstudio/qwen3",
			resolvable: true,
			inherited: true,
			thinkingUnsupported: true,
		});
	});

	// Both halves at once, which is the real `scout.md` on a machine whose `playred-lms` endpoint is down: the ask
	// fails *and* the model it falls back to cannot think.
	it("names both halves when the ask fails and the fallback cannot think either", () => {
		expect(resolveAgentModel(row({ model: "playred-lms/spark-x2.6-4b", thinking: "low" }), [plain], fallback)).toEqual({
			model: "playred-lms/spark-x2.6-4b",
			runsOn: "lmstudio/qwen3",
			resolvable: false,
			thinkingUnsupported: true,
		});
	});

	// A settings default whose provider lost its credential is a model flypi cannot look at, so the row says nothing
	// about levels: promising one it has not checked is the same kind of lie as staying silent about the model.
	it("says nothing about levels when it cannot see the model the run lands on", () => {
		expect(resolveAgentModel(row({ thinking: "xhigh" }), [], fallback)).toEqual({ runsOn: "lmstudio/qwen3", resolvable: true, inherited: true });
	});
});

describe("availableModels", () => {
	// `withProviderConfig` gives the checkout a credential for one local endpoint (`tests/helpers/flypi-root.ts`);
	// the file it writes is then replaced, because this row is about *which* providers come back: `nocreds` is in
	// `models.json` exactly like the other and has no credential, so it is not a model a subagent can run on —
	// availability, not the file, is what the extension's resolver accepts (`model-resolver.ts:46-47`).
	function twoProviderRoot(): FlypiPaths {
		const root = withProviderConfig(createTempFlypiRoot(), { defaultProvider: "lmstudio", defaultModel: "qwen3" }, { lmstudio: { type: "api_key", key: "local" } });
		const paths = flypiPaths(root);
		writeFileSync(
			paths.modelsPath,
			JSON.stringify({
				providers: {
					lmstudio: {
						baseUrl: "http://127.0.0.1:1/v1",
						api: "openai-completions",
						models: [{ id: "qwen3", name: "Qwen3" }, { id: "nemotron", name: "Nemotron", reasoning: true, thinkingLevelMap: { xhigh: null } }],
					},
					nocreds: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", models: [{ id: "ghost", name: "Ghost" }] },
				},
			}),
		);
		return paths;
	}

	// Only this checkout's own providers are compared: an operator with a real credential in the environment would
	// otherwise make an exact-equality row answer for their machine.
	it("is pi's available set for this checkout, and not what `models.json` names", async () => {
		const models = await availableModels(twoProviderRoot());

		expect(models.filter((model) => model.provider === "lmstudio" || model.provider === "nocreds")).toEqual([
			{ provider: "lmstudio", modelId: "qwen3", reasoning: false },
			{ provider: "lmstudio", modelId: "nemotron", reasoning: true, thinkingLevelMap: { xhigh: null } },
		]);
	});

	// The proof rather than the inference, and read it as what is actually pinned: **no call originates inside
	// `availableModels`** on the pi this repo pins. The spy has teeth for exactly that — a literal `await fetch(...)`
	// in the function reddens this row — and no provider in this pi ships the optional `apiKey.check` hook
	// (`pi-ai/dist/auth/types.d.ts:180`), so resolving a credential sends nothing either.
	//
	// What it does **not** pin is the absence of `allowModelNetwork` (`model-runtime.js:100`, the option
	// `src/agent/runtime.ts:119-121` also leaves unset): measured on this pin, adding `allowModelNetwork: true` to the
	// `ModelRuntime.create` call keeps every row here green — with an `openrouter` credential in the fixture as well —
	// because pi makes no catalog request from this path at all. So "flypi never asks pi to refresh over the network
	// from here" is a comment-level contract on `availableModels`, not one this suite can turn red; there is nothing
	// cheap to pin, and the honest sentence about the spy beats a fake assertion that would make the old one true.
	it("asks no provider anything", async () => {
		const paths = twoProviderRoot();
		vi.stubGlobal("fetch", () => {
			throw new Error("availableModels reached the network");
		});
		try {
			const models = await availableModels(paths);

			expect(models.some((model) => model.provider === "lmstudio" && model.modelId === "qwen3")).toBe(true);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe("readAgentTypes", () => {
	/**
	 * A checkout whose `settings.json` names the default pair and whose only credential is one local endpoint, with
	 * the three shapes the panel lists written into flypi's own agents dir: a file that asks for a model flypi
	 * serves, one that asks nothing, and one that asks a model nobody here serves.
	 *
	 * `settings` is a parameter because one row needs the root nobody configured: `createTempFlypiRoot` writes a
	 * `{}` `settings.json`, which is that root.
	 */
	function typedRoot(settings: Record<string, unknown> = { defaultProvider: "lmstudio", defaultModel: "qwen3" }): FlypiPaths {
		const root = withProviderConfig(createTempFlypiRoot(), settings, { lmstudio: { type: "api_key", key: "local" } });
		const paths = flypiPaths(root);
		mkdirSync(paths.agentsDir, { recursive: true });
		writeFileSync(join(paths.agentsDir, "scout.md"), "---\ndescription: read the repo\nmodel: lmstudio/qwen3\n---\nbody\n");
		writeFileSync(join(paths.agentsDir, "coder.md"), "---\ndescription: write the code\n---\nbody\n");
		writeFileSync(join(paths.agentsDir, "pilot.md"), "---\ndescription: fly it\nmodel: playred-lms/spark-x2.6-4b\n---\nbody\n");
		return paths;
	}

	/** A set handed in by a caller that already paid for it — so these rows need no runtime. */
	const served: AvailableModel[] = [{ provider: "lmstudio", modelId: "qwen3", reasoning: false }];

	/**
	 * No provider credential in the environment for the duration of one row. pi's builtin providers take a key from
	 * `process.env` when the root's `auth.json` has none (`pi-ai/dist/auth/context.js:18-21`, where empty means
	 * absent), so "flypi was left with no model to serve" is otherwise a statement about the machine running the
	 * suite: measured with `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` and `OPENROUTER_API_KEY`
	 * exported, the empty set these two rows are about became 484 entries.
	 */
	function withoutProviderEnv(): { restore(): void } {
		for (const name of Object.keys(process.env)) if (/(KEY|TOKEN|SECRET)$/i.test(name)) vi.stubEnv(name, "");
		return { restore: () => vi.unstubAllEnvs() };
	}

	// The join the request path would otherwise get wrong: `runsOn` for an inherited row is the *root's* default
	// rather than a choice the file made, the unresolvable ask still names what the run lands on, and the available
	// set is not part of any row — two credentialed providers measured **402 entries**, and a row carries only its
	// own answer. The deep equality below is the assertion that says so.
	it("joins the files with the answer about each one's model, and writes nothing when the set was handed in", async () => {
		const paths = typedRoot();
		const before = readdirSync(paths.agentDir);

		const { rows, errors } = await readAgentTypes(paths, served);

		expect(errors).toEqual([]);
		expect(rows).toEqual([
			{ type: "coder", file: join(paths.agentsDir, "coder.md"), description: "write the code", runsOn: "lmstudio/qwen3", resolvable: true, inherited: true },
			{ type: "pilot", file: join(paths.agentsDir, "pilot.md"), description: "fly it", model: "playred-lms/spark-x2.6-4b", runsOn: "lmstudio/qwen3", resolvable: false },
			{ type: "scout", file: join(paths.agentsDir, "scout.md"), description: "read the repo", model: "lmstudio/qwen3", runsOn: "lmstudio/qwen3", resolvable: true },
		]);
		expect(readdirSync(paths.agentDir)).toEqual(before); // reads only, like `listAgentFiles` — on **this** path, where the
		// set was injected; the read path lets pi persist its catalog cache beside `models.json` (`availableModels`).
	});

	// The other half of the signature: a caller that did not pay for the set gets it read. Pass `[]` where the set
	// is meant to be read and `scout` turns red here — that is the row's teeth.
	it("reads the available set itself when the caller did not already pay for it", async () => {
		const paths = typedRoot();
		writeFileSync(join(paths.agentsDir, "researcher.md"), "---\ndescription: read it once\nthinking: xhigh\n---\nbody\n");

		const { rows, errors } = await readAgentTypes(paths);

		expect(errors).toEqual([]);
		expect(rows.map((row) => [row.type, row.resolvable, row.runsOn, row.thinkingUnsupported])).toEqual([
			["coder", true, "lmstudio/qwen3", undefined],
			["pilot", false, "lmstudio/qwen3", undefined],
			// The real `researcher.md` on a root whose default cannot think: inherits, and the level it asks is the
			// one that model has never offered.
			["researcher", true, "lmstudio/qwen3", true],
			["scout", true, "lmstudio/qwen3", undefined],
		]);
	});

	// A fresh root where nobody configured a model has no conversation default to name, and `runsOn:
	// "undefined/undefined"`, or a guessed model, would be a claim rather than an answer. The file's own facts stay;
	// `scout`'s `runsOn` stays too, because that model the set really does hold.
	it("names no model for a row whose answer would be the default that is not there", async () => {
		const paths = typedRoot({});

		const { rows, errors } = await readAgentTypes(paths, served);

		expect(errors).toEqual([]);
		expect(rows).toEqual([
			{ type: "coder", file: join(paths.agentsDir, "coder.md"), description: "write the code", resolvable: true, inherited: true },
			{ type: "pilot", file: join(paths.agentsDir, "pilot.md"), description: "fly it", model: "playred-lms/spark-x2.6-4b", resolvable: false },
			{ type: "scout", file: join(paths.agentsDir, "scout.md"), description: "read the repo", model: "lmstudio/qwen3", runsOn: "lmstudio/qwen3", resolvable: true },
		]);
		expect(rows.filter((row) => Object.hasOwn(row, "runsOn")).map((row) => row.type)).toEqual(["scout"]);
	});

	// One broken file, one sentence — five `resolvable: false` warnings would be five lies about five models the run
	// could not serve. Mechanism note: `ModelRuntime.create` swallows every malformed `models.json` on the pi this
	// repo pins (measured at `fabced1`: broken JSON, wrong shapes, an unreadable file and `modelsPath` a directory
	// all create fine and answer an empty set), so no file on disk provokes the throw and the spy is how the row
	// reaches it. The claim pinned is about `readAgentTypes`, not about pi — and it is a **different failure** from the
	// unreadable file the next two rows pin: that one pi swallows into an empty available set and never throws, so
	// this spy is how the row reaches the arm where a runtime fails outright.
	it("says one sentence, and claims no model at all, when the set cannot be read", async () => {
		const paths = typedRoot();
		const spy = vi.spyOn(ModelRuntime, "create").mockRejectedValue(new Error(`${paths.modelsPath}: expected a JSON object, got a string`));
		try {
			const { rows, errors } = await readAgentTypes(paths);

			expect(errors).toEqual([expect.stringContaining("expected a JSON object")]);
			for (const row of rows) {
				expect(Object.hasOwn(row, "resolvable"), row.type).toBe(false);
				expect(Object.hasOwn(row, "runsOn"), row.type).toBe(false);
				expect(Object.hasOwn(row, "thinkingUnsupported"), row.type).toBe(false);
			}
			// The files are still the files: what each one *asked for* is the row's own words, not a model claim.
			expect(rows.map((row) => [row.type, row.model])).toEqual([
				["coder", undefined],
				["pilot", "playred-lms/spark-x2.6-4b"],
				["scout", "lmstudio/qwen3"],
			]);
		} finally {
			spy.mockRestore();
		}
	});

	// The failure pi swallows, and the one that used to be silent: `ModelRuntime.create` does **not** throw on a
	// `models.json` it cannot parse (re-measured on this pin for broken JSON, `providers: "nope"`, a top-level array,
	// a malformed model and a junk `modelsPath` — every one answers an empty set). On a root whose providers are
	// declared in that file — the lmstudio/local shape — an empty set means every row warns "will run on the
	// conversation's model" while `errors` stays empty, so the panel blames the operator's agent files for one
	// unreadable `models.json`. Naming the file is the whole sentence.
	it("names the file when an unreadable `models.json` leaves flypi with no model to serve", async () => {
		const paths = typedRoot();
		writeFileSync(paths.modelsPath, "{ this is not json\n");
		const env = withoutProviderEnv();
		try {
			const { rows, errors } = await readAgentTypes(paths);

			expect(errors).toEqual([expect.stringContaining(paths.modelsPath)]);
			// The rows keep the claims the existing rules give them for an empty set: nothing in it can be named, so
			// every ask falls back to the settings default — including `scout`, whose model the file really did declare.
			expect(rows.map((row) => [row.type, row.resolvable, row.runsOn, row.inherited])).toEqual([
				["coder", true, "lmstudio/qwen3", true],
				["pilot", false, "lmstudio/qwen3", undefined],
				["scout", false, "lmstudio/qwen3", undefined],
			]);
		} finally {
			env.restore();
		}
	});

	// The other side of the same check: a root that never had a `models.json` has no file to blame. The empty set is
	// its real state (onboarding has not run) and the rows' own warnings are the answer, so the sentence stays out.
	it("blames no file when the root has no `models.json` at all", async () => {
		const paths = typedRoot();
		rmSync(paths.modelsPath);
		const env = withoutProviderEnv();
		try {
			const { rows, errors } = await readAgentTypes(paths);

			expect(errors).toEqual([]);
			expect(rows.map((row) => [row.type, row.resolvable, row.runsOn])).toEqual([
				["coder", true, "lmstudio/qwen3"],
				["pilot", false, "lmstudio/qwen3"],
				["scout", false, "lmstudio/qwen3"],
			]);
		} finally {
			env.restore();
		}
	});
});
