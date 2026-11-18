/**
 * Isolation, measured on the filesystem rather than on the paths flypi passes.
 *
 * `forceFlypiAgentDir` declares `PI_CODING_AGENT_DIR=<root>/.flypi/agent` (T46.1.2), which is what makes every
 * default pi resolves for itself — `getAgentDir()` and everything hanging off it, including the default session
 * dir a subagent's child session uses — the same file flypi already passes explicitly (docs/risks.md risk 1).
 * Flypi's own calls pass paths by hand, so a mutation of the pin shows up only in a call that resolves a default,
 * which is why the rows below ask pi to resolve one.
 *
 * A live session cannot prove this yet: the child that leaked in D-M belonged to `@tintinweb/pi-subagents`,
 * which flypi does not declare until T46.2, so no T46.1 session has a subagent child to leak and live row L6 is
 * `N/A`. The rows below run the mechanism itself instead — `SessionManager.create(cwd)` with no session dir, the
 * one call whose answer is `<getAgentDir()>/sessions` — which is decision 10 / D6.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { flypiPaths, forceFlypiAgentDir } from "../../src/agent/paths.ts";
import { createFlypiSession } from "../../src/agent/runtime.ts";
import { agentDirEnv, createTempFlypiRoot, homeEnv } from "../helpers/flypi-root.ts";
import { createStubModel } from "../helpers/stub-model.ts";

/**
 * A host `~/.pi/agent` that is not the operator's. `os.homedir()` takes `$HOME` at call time and pi's
 * `getAgentDir()` falls back to `homedir()/.pi/agent`, so the only way to see what a process would write there
 * is to hand it a home and read it back (the same seam `hostPiRoot` uses for the guard).
 *
 * Seeded rather than empty, so "untouched" compares against a tree that exists — D-M counted the entries under
 * `.pi/agent`, 4 before the subagent ran and 7 after. What the rows assert is paths and bytes, which is what a
 * leak changes; nothing here claims to observe a read.
 */
function plantedHome(prefix = "flypi-host-"): { home: string; restore(): void } {
	const home = mkdtempSync(join(tmpdir(), prefix));
	mkdirSync(join(home, ".pi", "agent", "extensions"), { recursive: true });
	writeFileSync(join(home, ".pi", "agent", "settings.json"), '{"defaultProvider":"host","defaultModel":"host-only"}\n');
	writeFileSync(join(home, ".pi", "agent", "extensions", "evil.ts"), "throw new Error('the host agent dir was loaded');\n");
	const env = homeEnv(home);
	return {
		home,
		restore: () => {
			env.restore();
			rmSync(home, { recursive: true, force: true });
		},
	};
}

/** The tree as one sorted list of paths with their bytes in them: what "byte-identical" compares. */
function walk(dir: string): string[] {
	return readdirSync(dir, { recursive: true })
		.map((entry) => String(entry))
		.sort()
		.map((rel) => {
			const path = join(dir, rel);
			return statSync(path).isDirectory() ? `${rel}/` : `${rel} ${readFileSync(path, "utf8")}`;
		});
}

/** The transcripts under a session dir, however pi nested them. */
function transcripts(dir: string): string[] {
	try {
		return readdirSync(dir, { recursive: true }).map(String).filter((entry) => entry.endsWith(".jsonl")).sort();
	} catch {
		return []; // no directory at all is the answer the row is asserting against, not an error here
	}
}

describe("agent-dir isolation (pi's defaults resolve inside the root, not in ~/.pi)", () => {
	// The row D-M was filed for, and the write is what makes it one: measured with `process.env.PI_CODING_AGENT_DIR
	// = paths.agentDir` deleted, a flypi session on its own still leaves the planted home byte-identical, because
	// every path flypi uses is passed by hand. The leak needs a call that resolves a default, so this row performs
	// one — the subagent's child session (decision 10).
	it("leaves a planted host ~/.pi byte-identical when a child session opens pi's own default way", async () => {
		const host = plantedHome();
		const env = agentDirEnv(undefined); // the state a flypi process starts in: nothing set, so pi would guess
		const root = createTempFlypiRoot(); // the model is injected, so no provider config is read
		const paths = flypiPaths(root);
		try {
			const before = walk(host.home);
			// The stub's auth file is named, because `ModelRuntime.create` writes it where `getAuthPath()` points
			// and this row is about whether *flypi* left the host alone, not about the fixture writing there first.
			const stub = await createStubModel({ authPath: paths.authPath });
			const created = await createFlypiSession({ root, modelRuntime: stub.modelRuntime, model: stub.model });
			try {
				// A subagent's child session: no session dir, so pi answers `<getAgentDir()>/sessions/<encoded cwd>`.
				const child = SessionManager.create(paths.root);
				child.appendMessage({ role: "user", content: "a subagent prompt", timestamp: 0 });
				// Host first: a wrong-dir pin fails the assertions below inside the root, so this row's namesake runs at all.
				expect(walk(host.home)).toEqual(before);
				// Not a null result: a transcript really was written, and it really is inside the declared agent dir.
				// The resolved path is the expect message, so a leak names the file it wrote where it must not write.
				const file = child.getSessionFile()!;
				expect(transcripts(join(paths.agentDir, "sessions")).length, file).toBeGreaterThan(0);
				expect(file.startsWith(join(paths.agentDir, "sessions", "/")), file).toBe(true);
			} finally {
				created.session.dispose();
			}
			expect(existsSync(join(host.home, ".pi", "agent", "extensions", "evil.ts"))).toBe(true);
		} finally {
			env.restore();
			host.restore();
		}
	});

	// The two halves of pi's own answer, because the obvious one alone is vacuous: `usesDefaultSessionDir()` is
	// true when `PI_CODING_AGENT_DIR` is *unset* as well (dist/core/session-manager.js:776 compares against
	// `getDefaultSessionDirPath(cwd)`, which follows `getAgentDir()`), so it stays green in the exact case that
	// writes into the host. The directory is the half that decides, and it is compared against flypi's declared
	// `paths.agentDir` — not against `getAgentDir()`, which would agree with any value the pin wrote.
	// R13: pinning `<agentDir>/sessions` buys isolation, not visibility — the UI lists `paths.sessionsDir`
	// (`session-registry.ts:254`) and refuses anything outside it (`:312-313`), so T46.2 owns a transcript landing here.
	it("answers pi's own default session dir with the root, and writes the transcript there", () => {
		const host = plantedHome();
		const env = agentDirEnv(undefined);
		const root = createTempFlypiRoot();
		const paths = flypiPaths(root);
		try {
			forceFlypiAgentDir(paths);
			const child = SessionManager.create(paths.root);
			expect(child.usesDefaultSessionDir()).toBe(true);
			expect(dirname(child.getSessionDir())).toBe(join(paths.agentDir, "sessions"));
			child.appendMessage({ role: "user", content: "a subagent prompt", timestamp: 0 });
			expect(transcripts(dirname(child.getSessionDir()))).toHaveLength(1);
			expect(child.getSessionFile()!.startsWith(join(paths.agentDir, "sessions", "/"))).toBe(true);
			expect(existsSync(join(host.home, ".pi", "agent", "sessions"))).toBe(false);
		} finally {
			env.restore();
			host.restore();
		}
	});

	// The leak, made visible: the same call with the pin absent resolves outside the root, into the home. Without
	// this row the one above could be green because pi's default answer happened to be flypi's for some other
	// reason — `usesDefaultSessionDir()` cannot tell the two apart, which is the thing decision 2 leaves open
	// until the assignment runs.
	it("answers pi's own default session dir with the host home when the pin is absent", () => {
		const host = plantedHome();
		const env = agentDirEnv(undefined);
		const root = createTempFlypiRoot();
		const paths = flypiPaths(root);
		try {
			const child = SessionManager.create(paths.root);
			expect(child.usesDefaultSessionDir()).toBe(true); // true here too — which is why it decides nothing
			expect(dirname(child.getSessionDir())).toBe(join(host.home, ".pi", "agent", "sessions"));
			expect(child.getSessionDir().startsWith(join(paths.root, "/"))).toBe(false);
			child.appendMessage({ role: "user", content: "a subagent prompt", timestamp: 0 });
			expect(transcripts(join(host.home, ".pi", "agent", "sessions"))).toHaveLength(1);
		} finally {
			env.restore();
			host.restore();
		}
	});

	// One equality for everything else pi resolves by default: `settings.json`, `extensions/`, `prompts/`, `bin/`
	// and the debug log are each `join(getAgentDir(), …)` (dist/config.js:500-528), so this is the row that puts
	// all of them in the root — and the row that fails the moment the pin names any other directory, including a
	// plausible one under the same root.
	it("makes pi's own getAgentDir() the root's agent dir", () => {
		const host = plantedHome();
		const env = agentDirEnv(undefined);
		const root = createTempFlypiRoot();
		const paths = flypiPaths(root);
		try {
			forceFlypiAgentDir(paths);
			expect(getAgentDir()).toBe(paths.agentDir);
		} finally {
			env.restore();
			host.restore();
		}
	});
});
