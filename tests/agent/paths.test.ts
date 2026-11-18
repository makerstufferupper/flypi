import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DAEMON_FILE, assertFlypiOwned, flypiPaths, healthUrl, memoryMcpUrl } from "../../src/agent/paths.ts";
import { hostPiRoot } from "../helpers/flypi-root.ts";

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
			expect(() => assertFlypiOwned(flypiPaths("/repo"))).toThrow(/PI_CODING_AGENT_DIR/);
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
});
