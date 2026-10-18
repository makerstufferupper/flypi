import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createFlypiSession, FlypiConfigError, resolveConfiguredModel } from "../../src/agent/runtime.ts";
import { flypiPaths } from "../../src/agent/paths.ts";
import { createTempFlypiRoot, withProviderConfig } from "../helpers/flypi-root.ts";

/** A checkout configured against a provider that is never contacted: resolution must not make network calls. */
function configuredRoot(settings: Record<string, unknown> = { defaultProvider: "lmstudio", defaultModel: "qwen3" }): string {
	return withProviderConfig(createTempFlypiRoot(), settings);
}

async function runtimeFor(root: string) {
	const paths = flypiPaths(root);
	return { paths, modelRuntime: await ModelRuntime.create({ authPath: paths.authPath, modelsPath: paths.modelsPath }) };
}

describe("model configuration (.flypi/agent is the only source)", () => {
	it("resolves the configured model from .flypi/agent/models.json", async () => {
		const root = configuredRoot();
		const { paths, modelRuntime } = await runtimeFor(root);
		const model = resolveConfiguredModel(paths, modelRuntime, { LMSTUDIO_API_KEY: "local" });
		expect(model).toMatchObject({ provider: "lmstudio", id: "qwen3" });
	});

	it("writes an imported env credential into .flypi/agent/auth.json, not ~/.pi", async () => {
		const root = configuredRoot();
		const { paths, modelRuntime } = await runtimeFor(root);
		resolveConfiguredModel(paths, modelRuntime, { LMSTUDIO_API_KEY: "local" });
		expect(read(paths.authPath)).toHaveProperty("lmstudio");
	});

	it("says which file to fix when the defaults are missing", async () => {
		const root = configuredRoot({ defaultProvider: "lmstudio" });
		const { paths, modelRuntime } = await runtimeFor(root);
		expect(() => resolveConfiguredModel(paths, modelRuntime, {})).toThrow(/must set defaultProvider and defaultModel/);
	});

	it("reports an unreadable config as a flypi config error", async () => {
		const root = createTempFlypiRoot(); // settings.json exists, models.json does not
		const { paths, modelRuntime } = await runtimeFor(root);
		let message = "";
		try {
			resolveConfiguredModel(paths, modelRuntime, {});
		} catch (error) {
			expect(error).toBeInstanceOf(FlypiConfigError);
			message = (error as Error).message;
		}
		expect(message).toContain("could not read");
		expect(message).toContain(join(".flypi", "agent", "models.json"));
	});

	it("with no root, uses the working directory's .flypi/ — never the host ~/.pi", async () => {
		const root = configuredRoot();
		const previous = process.cwd();
		process.chdir(root);
		try {
			const created = await createFlypiSession({ env: { LMSTUDIO_API_KEY: "local" } });
			try {
				expect(created.paths.agentDir).toBe(join(realpathSync(root), ".flypi", "agent")); // macOS /var is a symlink
			} finally {
				created.session.dispose();
			}
		} finally {
			process.chdir(previous);
		}
	});

	it("refuses a model that is not in models.json and lists what is", async () => {
		const root = configuredRoot({ defaultProvider: "lmstudio", defaultModel: "nope" });
		const { paths, modelRuntime } = await runtimeFor(root);
		expect(() => resolveConfiguredModel(paths, modelRuntime, { LMSTUDIO_API_KEY: "local" })).toThrow(
			/not defined in[\s\S]*lmstudio\/qwen3/,
		);
	});

	it("refuses a provider with no credential instead of failing at request time", async () => {
		const root = configuredRoot();
		const { paths, modelRuntime } = await runtimeFor(root);
		expect(() => resolveConfiguredModel(paths, modelRuntime, {})).toThrow(/no credential for provider "lmstudio"/);
	});
});

describe("createFlypiSession: the shared wiring the server and probe use", () => {
	it("creates a session on the configured model, with sessions under .flypi/sessions", async () => {
		const root = configuredRoot();
		const created = await createFlypiSession({ root, env: { LMSTUDIO_API_KEY: "local" } });
		try {
			expect(created.session.model).toMatchObject({ provider: "lmstudio", id: "qwen3" });
			expect(created.session.sessionFile!.startsWith(join(root, ".flypi", "sessions", "/"))).toBe(true);
			expect(created.paths.agentDir).toBe(join(root, ".flypi", "agent"));
		} finally {
			created.session.dispose();
		}
	});

	// The chat renders markdown, and pi's own prompt never asks for it — so the shape the renderer
	// expects is stated in the prompt. Asserted on the prompt itself, and asserted once: an instruction
	// the wiring repeats each turn would move the prefix and cost the cache.
	it("asks the model for markdown answers, exactly once", async () => {
		const root = configuredRoot();
		const created = await createFlypiSession({ root, env: { LMSTUDIO_API_KEY: "local" } });
		try {
			const prompt = created.session.systemPrompt;
			expect(prompt).toContain("Answer in markdown");
			expect(prompt.match(/Answer in markdown/g)).toHaveLength(1);
		} finally {
			created.session.dispose();
		}
	});

	// The sidebar keeps a model/thinking choice with the chat it was made in, so reopening that chat has
	// to come back on it — the session file is the record, and flypi must not answer over it.
	it("a reopened session comes back on the model and thinking level it was left on", async () => {
		// The credential is on disk before the runtime is built: pi only restores a model whose provider has
		// auth it can see, and that is read when the runtime is created.
		const root = withProviderConfig(createTempFlypiRoot(), undefined, { lmstudio: { type: "api_key", key: "local" } });
		// The second model declares `reasoning: true`: pi clamps a thinking level to off for a model that does
		// not say it can think, which is a models.json problem rather than a memory one (same trap as an
		// under-declared `input`).
		writeFileSync(
			join(root, ".flypi", "agent", "models.json"),
			JSON.stringify({
				providers: {
					lmstudio: {
						baseUrl: "http://127.0.0.1:1/v1",
						api: "openai-completions",
						models: [{ id: "qwen3" }, { id: "qwen3-next", reasoning: true }],
					},
				},
			}),
		);
		const sessionsDir = join(root, ".flypi", "sessions");
		const left = SessionManager.create(root, sessionsDir);
		left.appendMessage({ role: "user", content: "a question", timestamp: 0 });
		left.appendModelChange("lmstudio", "qwen3-next");
		left.appendThinkingLevelChange("high");

		const reopened = await createFlypiSession({
			root,
			sessionManager: SessionManager.open(left.getSessionFile()!, sessionsDir),
		});
		try {
			expect(reopened.session.model).toMatchObject({ provider: "lmstudio", id: "qwen3-next" });
			expect(reopened.session.thinkingLevel).toBe("high");
		} finally {
			reopened.session.dispose();
		}
	});

	// A new chat has nothing recorded, so it still starts on the settings default.
	it("a chat with no recorded model starts on the settings default", async () => {
		const root = withProviderConfig(createTempFlypiRoot(), undefined, { lmstudio: { type: "api_key", key: "local" } });
		const sessionsDir = join(root, ".flypi", "sessions");
		const fresh = SessionManager.create(root, sessionsDir);
		fresh.appendMessage({ role: "user", content: "a first question", timestamp: 0 });
		const created = await createFlypiSession({ root, sessionManager: fresh });
		try {
			expect(created.session.model).toMatchObject({ provider: "lmstudio", id: "qwen3" });
		} finally {
			created.session.dispose();
		}
	});
});

function read(file: string): unknown {
	return JSON.parse(readFileSync(file, "utf8"));
}
