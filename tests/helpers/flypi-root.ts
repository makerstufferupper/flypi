import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A throwaway flypi checkout. Tests never touch the repo's own `.flypi/`
 * (docs/testing.md): teardown is `rm -rf`, not "hope the user's sessions survived".
 */
export function createTempFlypiRoot(prefix = "flypi-test-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	mkdirSync(join(dir, ".flypi", "agent"), { recursive: true });
	writeFileSync(join(dir, ".flypi", "agent", "settings.json"), "{}\n");
	return dir;
}

/**
 * A root under the host `~/.pi` (docs/risks.md risk 1), with HOME pointed at a temp dir so the test cannot
 * touch the real one: `assertFlypiOwned` reads `os.homedir()`, which takes `$HOME` at call time. Restore both
 * in the `finally` of the one `it` that uses it — `USERPROFILE` is what Windows reads.
 */
export function hostPiRoot(prefix = "flypi-hostpi-"): { root: string; restore(): void } {
	const home = mkdtempSync(join(tmpdir(), prefix));
	const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	return {
		root: join(home, ".pi", "state"),
		restore: () => {
			for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
			rmSync(home, { recursive: true, force: true });
		},
	};
}

/**
 * Move the process's home for the duration of one row. `os.homedir()` takes `$HOME` at call time, and both
 * halves of risk 1 are read through it: `assertFlypiOwned` asks where the host `~/.pi` is, and pi's
 * `getAgentDir()` falls back to `homedir()/.pi/agent` in exactly the process where flypi's pin did not land.
 * So a row that wants to watch the host agent dir has to be handed one rather than point at the operator's.
 * `USERPROFILE` is what Windows reads (as in `hostPiRoot` above). `undefined` means unset.
 */
export function homeEnv(value: string | undefined): { value: string | undefined; restore(): void } {
	const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
	for (const key of ["HOME", "USERPROFILE"]) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	return {
		value: saved.HOME,
		restore: () => {
			for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
		},
	};
}

/**
 * Set `PI_CODING_AGENT_DIR` for the duration of one row and hand back the state the process had before
 * (`value`): the pin is process-global and vitest shares `process.env` between the files in a worker, so a row
 * that leaves it set makes the next row in that worker answer for a value it never set. `undefined` means unset.
 */
export function agentDirEnv(value: string | undefined): { value: string | undefined; restore(): void } {
	const saved = process.env.PI_CODING_AGENT_DIR;
	if (value === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = value;
	return {
		value: saved,
		restore: () => {
			if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = saved;
		},
	};
}

/**
 * The env for a child process that owns a different flypi root: flypi pins `PI_CODING_AGENT_DIR` for its own
 * root, so whatever the parent's last session left there is not this child's answer — and a child cannot tell
 * that value from an operator's, so it refuses it (docs/risks.md risk 1). The same narrowing the suite already
 * does for the sibling variable: `noRootEnv()` in tests/daemon/cli.test.ts, `LMSTUDIO_API_KEY: ""` in
 * tests/agent/probe.test.ts.
 */
export function childEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.PI_CODING_AGENT_DIR;
	return { ...env, ...extra };
}

export function sessionFiles(root: string): string[] {
	try {
		return readdirSync(join(root, ".flypi", "sessions"));
	} catch {
		return [];
	}
}

/**
 * Configure a checkout against an unreachable local provider: enough to resolve a model
 * and create a session without a network call or a real credential.
 */
export function withProviderConfig(
	root: string,
	settings: Record<string, unknown> = { defaultProvider: "lmstudio", defaultModel: "qwen3" },
	auth?: Record<string, unknown>,
): string {
	writeFileSync(join(root, ".flypi", "agent", "settings.json"), JSON.stringify(settings));
	writeFileSync(
		join(root, ".flypi", "agent", "models.json"),
		JSON.stringify({
			providers: { lmstudio: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", models: [{ id: "qwen3", name: "Qwen3" }] } },
		}),
	);
	if (auth) writeFileSync(join(root, ".flypi", "agent", "auth.json"), JSON.stringify(auth));
	return root;
}
