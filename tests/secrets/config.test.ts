/**
 * What the vault is configured with, and where the rest of the app already points at it (docs/secrets.md).
 * The second half matters more than the first: `!flypi secret print NAME` is the only way a credential gets
 * into auth.json / mcp.json / models.json without being typed in plaintext, so the references have to be
 * found where they are written — including the forms that work before Phase 7 puts `flypi` on PATH.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { flypiPaths } from "../../src/agent/paths.ts";
import { keyProviderFor, parseSecretsConfig, secretFilePath, secretRefName, secretReferences, secretsConfig } from "../../src/secrets/config.ts";

const temp = () => {
	const dir = mkdtempSync(join(tmpdir(), "flypi-secrets-config-"));
	return { paths: flypiPaths(dir), dispose: () => rmSync(dir, { recursive: true, force: true }) };
};

describe("settings", () => {
	it("are the defaults when there is no settings file, and nothing else is needed to start", () => {
		const { paths, dispose } = temp();
		try {
			expect(secretsConfig(paths)).toEqual({ enabled: true, keyProvider: "keyfile", keyfile: paths.secretKeyPath, askBeforeUse: true });
		} finally {
			dispose();
		}
	});

	it("keeps the gate on unless the user turns it off — that is the setting that holds a credential out of context", () => {
		const { paths, dispose } = temp();
		try {
			expect(parseSecretsConfig({}, paths).askBeforeUse).toBe(true);
			expect(parseSecretsConfig({ secrets: { askBeforeUse: false } }, paths).askBeforeUse).toBe(false);
			// A vault turned off in settings turns the feature off, but never quietly re-enables a provider
			// that does not exist.
			expect(parseSecretsConfig({ secrets: { enabled: false, keyfile: "/tmp/other.key" } }, paths)).toMatchObject({ enabled: false, keyfile: "/tmp/other.key" });
		} finally {
			dispose();
		}
	});

	it("names a key provider flypi does not have, rather than quietly using the key file", () => {
		const { paths, dispose } = temp();
		try {
			const config = parseSecretsConfig({ secrets: { keyProvider: "macos-keychain" } }, paths);
			expect(() => keyProviderFor(config)).toThrow(/no such provider exists/);
			expect(keyProviderFor({ ...parseSecretsConfig(undefined, paths), keyfile: join(paths.root, "k.json") }).currentVersion()).toBe(1);
		} finally {
			dispose();
		}
	});

	it("reads them from .flypi/agent/settings.json", () => {
		const { paths, dispose } = temp();
		try {
			mkdirSync(paths.agentDir, { recursive: true });
			writeFileSync(paths.settingsPath, JSON.stringify({ secrets: { askBeforeUse: false } }));
			expect(secretsConfig(paths).askBeforeUse).toBe(false);
		} finally {
			dispose();
		}
	});
});

describe("a config value that points at the vault", () => {
	it("is the `!flypi secret print NAME` pi runs for its value", () => {
		expect(secretRefName('!flypi secret print openai_key')).toBe("openai_key");
		expect(secretRefName('!flypi secret print id_ed25519.pub')).toBe("id_ed25519.pub");
	});

	it("and the form that works before `flypi` is on PATH", () => {
		expect(secretRefName("!node /Users/me/ws/flypi/scripts/flypi.mjs secret print gh_token")).toBe("gh_token");
	});

	it("is not every value that starts with a command", () => {
		for (const value of ["sk-plaintext", "!echo hello", "!flypi secret list", "!flypi secrets print x", 42, null]) {
			expect(secretRefName(value)).toBeUndefined();
		}
	});
});

describe("the references panel", () => {
	it("lists where each vault name is used, so deleting one can say what would break", () => {
		const { paths, dispose } = temp();
		try {
			mkdirSync(paths.agentDir, { recursive: true });
			writeFileSync(paths.authPath, JSON.stringify({ anthropic: { apiKey: "!flypi secret print anthropic_key" } }));
			// A null in a config file is a hole in the walk, not a crash: the reference beside it still counts.
			writeFileSync(paths.mcpPath, JSON.stringify({ mcpServers: { github: { url: null, headers: { Authorization: "Bearer !flypi secret print gh_token" } } } }));
			writeFileSync(paths.modelsPath, JSON.stringify({ providers: [{ id: "x", models: [{ apiKey: "!flypi secret print x_key" }] }] }));
			expect(secretReferences(paths)).toEqual([
				{ file: "auth.json", path: "auth.json.anthropic.apiKey", name: "anthropic_key" },
				{ file: "mcp.json", path: "mcp.json.mcpServers.github.headers.Authorization", name: "gh_token" },
				{ file: "models.json", path: "models.json.providers[0].models[0].apiKey", name: "x_key" },
			]);
		} finally {
			dispose();
		}
	});

	it("is empty, not broken, when the files are missing or malformed", () => {
		const { paths, dispose } = temp();
		try {
			mkdirSync(paths.agentDir, { recursive: true });
			writeFileSync(paths.mcpPath, "{ not json");
			expect(secretReferences(paths)).toEqual([]);
		} finally {
			dispose();
		}
	});
});

describe("the path form", () => {
	it("is one file per name, under .flypi/secrets", () => {
		const { paths, dispose } = temp();
		try {
			expect(secretFilePath(paths, "id_ed25519")).toBe(join(paths.secretsDir, "id_ed25519"));
			// The same rule as a name in a config file: it has to survive being a file name.
			expect(() => secretFilePath(paths, "../escape")).toThrow(/not a usable secret name/);
		} finally {
			dispose();
		}
	});
});
