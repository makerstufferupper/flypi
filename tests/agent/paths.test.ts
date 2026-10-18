import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertFlypiOwned, flypiPaths } from "../../src/agent/paths.ts";

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
