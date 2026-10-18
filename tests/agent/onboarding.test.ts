import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	credentialEnvName,
	importEnvCredential,
	readAuth,
	resolveCredential,
	writeAuthKey,
} from "../../src/agent/onboarding.ts";

const models = (apiKey?: string) => ({ providers: { lmstudio: apiKey === undefined ? {} : { apiKey } } });
const tempAuth = () => join(mkdtempSync(join(tmpdir(), "flypi-auth-")), "auth.json");

describe("credentialEnvName", () => {
	it("matches the variable name pi-style providers use", () => {
		expect(credentialEnvName("lmstudio")).toBe("LMSTUDIO_API_KEY");
		expect(credentialEnvName("openai")).toBe("OPENAI_API_KEY");
		expect(credentialEnvName("my-provider")).toBe("MY_PROVIDER_API_KEY");
	});
});

describe("resolveCredential", () => {
	it("uses a stored auth.json key first (pi's own precedence)", () => {
		const result = resolveCredential({
			provider: "lmstudio",
			models: models("from-models-json"),
			auth: { lmstudio: { type: "api_key", key: "stored" } },
			env: { LMSTUDIO_API_KEY: "from-env" },
		});
		expect(result).toEqual({ ok: true, provider: "lmstudio", source: "auth.json" });
	});

	it("accepts a key declared in models.json, which is how a local server stays available", () => {
		const result = resolveCredential({ provider: "lmstudio", models: models("lmstudio-local"), auth: {}, env: {} });
		expect(result).toMatchObject({ ok: true, source: "models.json" });
	});

	it("accepts an environment key when nothing is stored", () => {
		const result = resolveCredential({ provider: "lmstudio", models: {}, auth: {}, env: { LMSTUDIO_API_KEY: "k" } });
		expect(result).toMatchObject({ ok: true, source: "env" });
	});

	it("treats a blank stored key as missing", () => {
		const result = resolveCredential({ provider: "lmstudio", models: {}, auth: { lmstudio: { type: "api_key", key: "  " } }, env: {} });
		expect(result.ok).toBe(false);
	});

	it("reports a missing credential as a message, not an exception", () => {
		const result = resolveCredential({ provider: "lmstudio", models: {}, auth: {}, env: {} });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.message).toContain("LMSTUDIO_API_KEY");
		expect(result.message).toContain('"lmstudio"');
	});
});

describe("credential files (pi's auth.json format)", () => {
	it("writes a 0600 file in pi's shape and keeps unrelated providers", () => {
		const path = tempAuth();
		writeAuthKey(path, "llama_d", "other");
		writeAuthKey(path, "lmstudio", "lmstudio-local");
		const auth = JSON.parse(readFileSync(path, "utf8"));
		expect(auth).toEqual({
			llama_d: { type: "api_key", key: "other" },
			lmstudio: { type: "api_key", key: "lmstudio-local" },
		});
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("imports an env key once and never overwrites a stored key", () => {
		const path = tempAuth();
		expect(importEnvCredential(path, "lmstudio", {})).toBe(false);
		expect(importEnvCredential(path, "lmstudio", { LMSTUDIO_API_KEY: "first" })).toBe(true);
		expect(readAuth(path).lmstudio?.key).toBe("first");
		expect(importEnvCredential(path, "lmstudio", { LMSTUDIO_API_KEY: "second" })).toBe(false);
		expect(readAuth(path).lmstudio?.key).toBe("first");
	});
});
