import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DAEMON_FILE, assertFlypiOwned, flypiPaths, forceFlypiAgentDir, healthUrl, memoryMcpUrl } from "../../src/agent/paths.ts";
import { agentDirEnv, hostPiRoot } from "../helpers/flypi-root.ts";

describe("flypiPaths", () => {
	it("puts every flypi path under .flypi/", () => {
		const paths = flypiPaths("/repo");
		expect(paths).toMatchObject({
			root: "/repo",
			agentDir: "/repo/.flypi/agent",
			sessionsDir: "/repo/.flypi/sessions",
			memoryDir: "/repo/.flypi/memory",
			modelsDir: "/repo/.flypi/models",
			uploadsDir: "/repo/.flypi/uploads",
			authPath: "/repo/.flypi/agent/auth.json",
			modelsPath: "/repo/.flypi/agent/models.json",
			settingsPath: "/repo/.flypi/agent/settings.json",
			mcpPath: "/repo/.flypi/agent/mcp.json",
		});
	});

	it("resolves a relative root against the working directory", () => {
		expect(flypiPaths(".").agentDir).toBe(join(resolve("."), ".flypi", "agent"));
	});

	it("owns the daemon pid file name and the two URLs", () => {
		const paths = flypiPaths("/repo");
		expect(paths.daemonFile).toBe(join("/repo", DAEMON_FILE));
		expect(memoryMcpUrl(8790)).toBe("http://127.0.0.1:8790/mcp");
		expect(healthUrl(8791)).toBe("http://127.0.0.1:8791/healthz");
	});

	// One owner, asserted on the source: a second literal in these four sites is the drift this task exists
	// to remove. `localhost` counts as drift too — it can resolve to ::1 and miss a server bound to
	// 127.0.0.1. src/memory/mcp.ts is absent on purpose (risk R9: it reports the host it actually bound)
	// and scripts/start.mjs is absent because it cannot import paths.ts —
	// tests/scripts/health-url.test.ts pins the /mcp copy its ensureConfig writes into mcp.json.
	it("leaves no loopback URL literal at the four sites that now call paths.ts", () => {
		for (const file of ["src/agent/config-files.ts", "src/daemon/index.ts", "scripts/serve-daemon.ts", "scripts/pi.ts"]) {
			expect(readFileSync(file, "utf8"), file).not.toMatch(/http:\/\/(127\.0\.0\.1|localhost):\$\{/);
		}
	});
});

describe("assertFlypiOwned (risk 1: never touch host ~/.pi)", () => {
	it("accepts the repo config dir", () => {
		expect(() => assertFlypiOwned(flypiPaths("/repo"))).not.toThrow();
	});

	it("rejects a config dir under the host pi directory", () => {
		const paths = flypiPaths(join(homedir(), ".pi", "agent", "flypi"));
		expect(() => assertFlypiOwned(paths)).toThrow(/host pi directory/);
	});

	it("rejects an agentDir that is not .flypi/agent", () => {
		const paths = { ...flypiPaths("/repo"), agentDir: join(homedir(), ".pi", "agent") };
		expect(() => assertFlypiOwned(paths)).toThrow(/agentDir must be \.flypi\/agent/);
	});

	// pi's own `getAgentDir()` takes `$PI_CODING_AGENT_DIR` at call time, so an exported value re-points code
	// flypi never passes a path to (docs/risks.md risk 1). `hostPiRoot` points `HOME` at a temp dir so the
	// value under test can name the host agent dir without the run ever touching the real one.
	it("refuses a PI_CODING_AGENT_DIR inside the host ~/.pi", () => {
		const host = hostPiRoot();
		const saved = process.env.PI_CODING_AGENT_DIR;
		try {
			process.env.PI_CODING_AGENT_DIR = join(homedir(), ".pi", "agent"); // `homedir()` is the temp one now
			expect(() => assertFlypiOwned(flypiPaths("/repo"))).toThrow(
				/PI_CODING_AGENT_DIR .* got .* — unset it or point it at \/repo\/\.flypi\/agent/,
			);
		} finally {
			if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = saved;
			host.restore();
		}
	});

	// A relative value resolves against whatever the cwd happens to be — the same unpredictable target.
	it("refuses a relative PI_CODING_AGENT_DIR", () => {
		const saved = process.env.PI_CODING_AGENT_DIR;
		try {
			process.env.PI_CODING_AGENT_DIR = join(".flypi", "agent");
			expect(() => assertFlypiOwned(flypiPaths("/repo"))).toThrow(/PI_CODING_AGENT_DIR/);
		} finally {
			if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = saved;
		}
	});

	// pi expands a leading `~` in `getAgentDir()`, so the spelling has to be refused too rather than expanded
	// against the operator's home and compared there.
	it("refuses a ~/... PI_CODING_AGENT_DIR", () => {
		const saved = process.env.PI_CODING_AGENT_DIR;
		try {
			process.env.PI_CODING_AGENT_DIR = join("~", ".pi", "agent");
			expect(() => assertFlypiOwned(flypiPaths("/repo"))).toThrow(/PI_CODING_AGENT_DIR/);
		} finally {
			if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = saved;
		}
	});

	// The case the error message asks for, and the one the daemon runs with once it pins its own agent dir.
	it("accepts a PI_CODING_AGENT_DIR that names a flypi agent dir", () => {
		const saved = process.env.PI_CODING_AGENT_DIR;
		try {
			process.env.PI_CODING_AGENT_DIR = flypiPaths("/repo").agentDir;
			expect(() => assertFlypiOwned(flypiPaths("/repo"))).not.toThrow();
		} finally {
			if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = saved;
		}
	});

	// Unset is "not flypi's yet", not a refusal: every call site runs with it unset today, so refusing it would
	// stop the daemon from starting. `:48` re-pinned on purpose — that hole closes at the assignment, not here.
	it("passes a PI_CODING_AGENT_DIR that is unset", () => {
		const saved = process.env.PI_CODING_AGENT_DIR;
		try {
			delete process.env.PI_CODING_AGENT_DIR;
			expect(() => assertFlypiOwned(flypiPaths("/repo"))).not.toThrow();
		} finally {
			if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = saved;
		}
	});

	// pi treats an empty value as unset (`if (envDir)` in dist/config.js) and falls back to `~/.pi/agent`, so the
	// guard deliberately does not refuse it — like unset, that is "not flypi's yet" and the assignment overwrites it.
	it("passes a PI_CODING_AGENT_DIR that is empty", () => {
		const saved = process.env.PI_CODING_AGENT_DIR;
		try {
			process.env.PI_CODING_AGENT_DIR = "";
			expect(() => assertFlypiOwned(flypiPaths("/repo"))).not.toThrow();
		} finally {
			if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = saved;
		}
	});
});

// The guard only refuses what every caller can survive; this is the strict half, and it is the one that closes
// the hole the guard leaves open on purpose (decision 2): unset is not refused, it is replaced.
describe("forceFlypiAgentDir (the pin: pi's implicit agent dir is flypi's)", () => {
	// An operator's own value is a decision, and the message has to carry both halves of it: what is set and
	// what flypi needs. Matched on the whole sentence (decision 13) — `is set to <x>` is what makes it fixable.
	it("refuses another root's agent dir, naming the value and the directory it needs", () => {
		const env = agentDirEnv(join("/other", ".flypi", "agent"));
		try {
			expect(() => forceFlypiAgentDir(flypiPaths("/repo"))).toThrow(
				/PI_CODING_AGENT_DIR is set to \/other\/\.flypi\/agent; flypi needs \/repo\/\.flypi\/agent — unset it or point it there/,
			);
			expect(process.env.PI_CODING_AGENT_DIR).toBe(join("/other", ".flypi", "agent")); // refused, not overwritten
		} finally {
			env.restore();
		}
	});

	// The guard accepts this value (absolute, nowhere near host `~/.pi`), so strict equality with this root's
	// agent dir lives here — which is what refuses a wrong directory *under* the root it was asked for.
	it("refuses a value under <root>/.flypi that is not the agent dir", () => {
		const env = agentDirEnv(join("/repo", ".flypi", "elsewhere"));
		try {
			expect(() => forceFlypiAgentDir(flypiPaths("/repo"))).toThrow(/PI_CODING_AGENT_DIR is set to \/repo\/\.flypi\/elsewhere/);
		} finally {
			env.restore();
		}
	});

	// The order inside the helper is load-bearing, not style: the root invariant outranks the environment
	// invariant, so a root that is itself wrong reports the root even when the variable is foreign too. Without
	// the value planted here nothing distinguishes the two statements — measured at this commit, swapping the two
	// statements leaves `npm test` green, because every other row's value is one flypi wrote itself.
	it("reports the root, not the variable, when both are wrong", () => {
		const host = hostPiRoot(); // a root inside host `~/.pi`: check 1's case
		const env = agentDirEnv("/tmp/foreign-agent"); // and a variable the helper's own check would refuse
		try {
			expect(() => forceFlypiAgentDir(flypiPaths(host.root))).toThrow(/host pi directory/);
		} finally {
			env.restore();
			host.restore();
		}
	});

	// What every process in the suite runs with today, and the case the assignment exists for: replaced, not refused.
	it("replaces a PI_CODING_AGENT_DIR that is unset", () => {
		const env = agentDirEnv(undefined);
		try {
			forceFlypiAgentDir(flypiPaths("/repo"));
			expect(process.env.PI_CODING_AGENT_DIR).toBe("/repo/.flypi/agent");
		} finally {
			env.restore();
		}
	});

	// Empty is unset to pi as well (`if (envDir)` in dist/config.js), so it is overwritten rather than refused.
	it("replaces a PI_CODING_AGENT_DIR that is empty", () => {
		const env = agentDirEnv("");
		try {
			forceFlypiAgentDir(flypiPaths("/repo"));
			expect(process.env.PI_CODING_AGENT_DIR).toBe("/repo/.flypi/agent");
		} finally {
			env.restore();
		}
	});

	// The daemon's own state after its first force, and what a restart of the same root re-reads. Only the no-throw
	// half is pinned: this row's value *is* `paths.agentDir`, so reading it back proved nothing — measured green
	// with the assignment deleted (mutation A). `not.toThrow()` is the row that dies under F, the equality rule
	// pointed at another directory, and only when nothing forced this root earlier in the module: run on its own it
	// fails, run after the two rows above the `flypiAgentDirEnv` escape saves it — which is why `npm test` as a
	// whole stays green under F.
	it("keeps a PI_CODING_AGENT_DIR that already names this root's agent dir", () => {
		const env = agentDirEnv("/repo/.flypi/agent");
		try {
			expect(() => forceFlypiAgentDir(flypiPaths("/repo"))).not.toThrow();
		} finally {
			env.restore();
		}
	});

	// Two roots in one process is what the module-level `flypiAgentDirEnv` exists for: `process.env` is global
	// while flypi's own pin is not this root's any more, so the second root must not meet the first as though an
	// operator had written it (decision 4 — vitest reuses a worker across files, and a tools process visits two).
	it("gives each root forced in one process its own value", () => {
		const env = agentDirEnv(undefined);
		try {
			forceFlypiAgentDir(flypiPaths("/repo-a"));
			expect(process.env.PI_CODING_AGENT_DIR).toBe("/repo-a/.flypi/agent");
			forceFlypiAgentDir(flypiPaths("/repo-b"));
			expect(process.env.PI_CODING_AGENT_DIR).toBe("/repo-b/.flypi/agent");
		} finally {
			env.restore();
		}
	});
});
