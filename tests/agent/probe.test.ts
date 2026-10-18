import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { flypiPaths } from "../../src/agent/paths.ts";

const root = resolve(import.meta.dirname, "../..");
const probe = join(root, "scripts", "probe.ts");
const tsx = join(root, "node_modules", "tsx", "dist", "cli.mjs");

/** Runs the probe as a subprocess, like CI would. Returns stdout+stderr and the exit code. */
function runProbe(args: string[], env: Record<string, string> = {}) {
	try {
		const stdout = execFileSync(process.execPath, [tsx, probe, ...args], {
			cwd: root,
			encoding: "utf8",
			env: { ...process.env, LMSTUDIO_API_KEY: "", ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { stdout, stderr: "", code: 0 };
	} catch (error) {
		const failure = error as { stdout?: string; stderr?: string; code?: number };
		return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code ?? 1 };
	}
}

/** A checkout whose provider has no credential anywhere. */
function rootWithoutCredential(): string {
	const dir = mkdtempSync(join(tmpdir(), "flypi-probe-"));
	const agentDir = join(dir, ".flypi", "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "lmstudio", defaultModel: "m" }));
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { lmstudio: { baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "m" }] } } }));
	writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {} }));
	return dir;
}

/** A checkout that defines the routes `--model` is asked to name. The real `.flypi/` is gitignored and
 * machine-owned, so a test that reads it passes only on the machine it was written on. */
function rootWithRoutes(): string {
	const dir = mkdtempSync(join(tmpdir(), "flypi-probe-model-"));
	const agentDir = join(dir, ".flypi", "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "lmstudio", defaultModel: "local-m" }));
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { lmstudio: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "local", models: [{ id: "local-m" }, { id: "llama_c" }] } } }));
	writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {} }));
	return dir;
}

describe("probe: config isolation (risk 1)", () => {
	it("reports .flypi/agent as the config dir and never the host ~/.pi", () => {
		// Its own root, not the checkout's: the real `.flypi/` is gitignored and machine-owned, so reading it
		// here would pass only on the machine the test was written on.
		const dir = rootWithRoutes();
		const run = runProbe(["--no-turn", "--root", dir]);
		expect(run.code, run.stderr).toBe(0);
		expect(run.stdout).toContain(join(dir, ".flypi", "agent"));
		expect(run.stdout).not.toMatch(/\/\.pi\/agent/);
		expect(run.stdout).toMatch(/tools\s+read, bash/);
	});

	it("keeps session files inside .flypi/sessions", () => {
		const paths = flypiPaths(root);
		expect(paths.sessionsDir).toBe(join(root, ".flypi", "sessions"));
	});
});

describe("probe: credential onboarding failures are messages, not stack traces", () => {
	it("exits 1 with an actionable line when no credential exists", () => {
		const run = runProbe(["--no-turn", "--root", rootWithoutCredential()]);
		expect(run.code).toBe(1);
		expect(run.stderr).toContain('no credential for provider "lmstudio"');
		expect(run.stderr).toContain("LMSTUDIO_API_KEY");
		expect(run.stderr).not.toMatch(/\n\s+at\s+\S/);
	});
});

describe("probe: --model runs a named route (Phase 4.6 A0 measures every route)", () => {
	it("names the model it will use instead of the settings default, with no turn and no network", () => {
		const run = runProbe(["--no-turn", "--root", rootWithRoutes(), "--model", "lmstudio/llama_c"]);
		expect(run.code, run.stderr).toBe(0);
		expect(run.stdout).toContain("model        lmstudio/llama_c");
	});

	it("rejects a route that is not in flypi's own models.json as a message", () => {
		const run = runProbe(["--no-turn", "--root", rootWithRoutes(), "--model", "lmstudio/not-defined-here"]);
		expect(run.code).toBe(1);
		expect(run.stderr).toContain('model "lmstudio/not-defined-here" is not defined in');
		expect(run.stderr).not.toMatch(/\n\s+at\s+\S/);
	});

	it("rejects a --model value with no provider in it", () => {
		const run = runProbe(["--no-turn", "--model", "llama_b"]);
		expect(run.code).toBe(1);
		expect(run.stderr).toContain('--model wants "provider/id"');
	});
});
