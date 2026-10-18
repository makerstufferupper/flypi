/**
 * The Phase 7 startup script (`scripts/start.mjs`, docs/architecture.md). What is testable about it is
 * the config half: a fresh machine must end up with agent config that starts, and a machine that already
 * has config must keep it. The process-spawning half is what `npm run probe` and the dev instance are for.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureConfig, installReason, nodeProblem } from "../../scripts/start.mjs";

let root: string;

const read = (file: string) => JSON.parse(readFileSync(join(root, ".flypi", "agent", file), "utf8"));

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "flypi-start-"));
});
afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("the Node check", () => {
	it("wants 22.19 or newer", () => {
		expect(nodeProblem("22.18.1")).toMatch(/Node 22\.19/);
		expect(nodeProblem("21.7.3")).toMatch(/Node 22\.19/);
		expect(nodeProblem("22.19.0")).toBeUndefined();
		expect(nodeProblem("22.20.0")).toBeUndefined();
		expect(nodeProblem("24.15.0")).toBeUndefined();
	});
});

describe("the first run on a fresh machine", () => {
	it("writes config that can start a session, and a memory entry with a generated token", () => {
		const first = ensureConfig(root, {});
		expect(first.created).toEqual(["settings.json", "models.json", "mcp.json (flypi-memory entry, token generated)"]);

		const settings = read("settings.json");
		expect(settings.defaultProvider).toBeTruthy();
		expect(settings.defaultModel).toBeTruthy(); // resolveConfiguredModel refuses a pair with a half missing
		expect(read("models.json").providers[settings.defaultProvider].models.length).toBeGreaterThan(0);

		const entry = read("mcp.json").mcpServers["flypi-memory"];
		expect(entry.url).toBe("http://127.0.0.1:8790/mcp");
		expect(entry.headers.Authorization).toBe(`Bearer ${first.token}`);
		expect(first.token.length).toBeGreaterThanOrEqual(32);
		expect(first.port).toBe(8790);
	});

	it("keeps the token and the config on a second run", () => {
		const before = readFileSync(join(root, ".flypi", "agent", "models.json"));
		const second = ensureConfig(root, {});
		expect(second.created).toEqual([]);
		expect(second.token).not.toBe("");
		expect(read("mcp.json").mcpServers["flypi-memory"].headers.Authorization).toBe(`Bearer ${second.token}`);
		expect(readFileSync(join(root, ".flypi", "agent", "models.json"))).toEqual(before);
	});

	it("replaces the empty pair the daemon writes for a root that has no config of its own", () => {
		// `flypi start` writes `{}` into both files so a fresh install says "no model configured" rather than
		// "cannot read the config". A checkout that ran it once still has to get its templates from here.
		const fresh = mkdtempSync(join(tmpdir(), "flypi-start-blank-"));
		try {
			mkdirSync(join(fresh, ".flypi", "agent"), { recursive: true });
			writeFileSync(join(fresh, ".flypi", "agent", "settings.json"), "{}");
			writeFileSync(join(fresh, ".flypi", "agent", "models.json"), "{}");

			const first = ensureConfig(fresh, {});
			expect(first.created).toEqual(["settings.json", "models.json", "mcp.json (flypi-memory entry, token generated)"]);
			const settings = JSON.parse(readFileSync(join(fresh, ".flypi", "agent", "settings.json"), "utf8"));
			expect(settings.defaultProvider).toBeTruthy();
			expect(settings.defaultModel).toBeTruthy();
		} finally {
			rmSync(fresh, { recursive: true, force: true });
		}
	});

	it("leaves a config it did not write alone, including other MCP servers", () => {
		rmSync(join(root, ".flypi", "agent", "mcp.json"));
		writeFileSync(
			join(root, ".flypi", "agent", "mcp.json"),
			JSON.stringify({ mcpServers: { "flypi-memory": { url: "http://127.0.0.1:9999/mcp", headers: { Authorization: "Bearer kept-token" } }, files: { command: "server-filesystem" } } }, null, 2),
		);
		const settings = readFileSync(join(root, ".flypi", "agent", "settings.json"), "utf8");

		const again = ensureConfig(root, {});
		expect(again.created).toEqual([]);
		expect(again.token).toBe("kept-token");
		expect(again.port).toBe(9999); // the port the file names, so no half listens somewhere else
		const mcp = read("mcp.json").mcpServers;
		expect(mcp.files).toEqual({ command: "server-filesystem" });
		expect(mcp["flypi-memory"].headers.Authorization).toBe("Bearer kept-token");
		expect(readFileSync(join(root, ".flypi", "agent", "settings.json"), "utf8")).toBe(settings);
	});

	it("takes the token from the environment when the file names ${FLYPI_MEMORY_TOKEN}", () => {
		writeFileSync(join(root, ".flypi", "agent", "mcp.json"), JSON.stringify({ mcpServers: { "flypi-memory": { url: "http://127.0.0.1:8790/mcp", headers: { Authorization: "Bearer ${FLYPI_MEMORY_TOKEN}" } } } }));
		expect(ensureConfig(root, { FLYPI_MEMORY_TOKEN: "from-env" }).token).toBe("from-env");
		// Nothing exported: a token is still produced, so the two halves agree rather than silently refusing.
		expect(ensureConfig(root, {}).token).toMatch(/^[0-9a-f]{48}$/);
	});
});

describe("the install check", () => {
	it("installs when the tree is missing or the lockfile moved", () => {
		expect(installReason(root)).toBe("no node_modules");
		mkdirSync(join(root, "node_modules"), { recursive: true });
		writeFileSync(join(root, "package-lock.json"), "{}");
		expect(installReason(root)).toMatch(/changed/);

		writeFileSync(join(root, ".flypi", "install-stamp"), createHash("sha256").update(readFileSync(join(root, "package-lock.json"))).digest("hex"));
		expect(installReason(root)).toBeUndefined();

		writeFileSync(join(root, "package-lock.json"), '{"version": 2}');
		expect(installReason(root)).toMatch(/changed/);
	});
});
