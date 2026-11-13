import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DAEMON_FILE, assertFlypiOwned, flypiPaths, healthUrl, memoryMcpUrl } from "../../src/agent/paths.ts";

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
});
