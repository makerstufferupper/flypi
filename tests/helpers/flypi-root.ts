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
