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
 * operator's own home is never read.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { hostAgentsDir, importAgentFiles, listAgentFiles } from "../../src/agent/subagent-agents.ts";
import { flypiPaths, type FlypiPaths } from "../../src/agent/paths.ts";
import { agentDirEnv, createTempFlypiRoot, homeEnv } from "../helpers/flypi-root.ts";

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
