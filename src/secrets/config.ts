/**
 * `secrets` in `.flypi/agent/settings.json` (docs/secrets.md Phase 5.5), and the reference syntax the
 * config files use to point at a vault entry.
 *
 * Only the options this code acts on are here. `redact` is not one of them: redaction is the point of the
 * feature, so it is always on. `shellEnv` is not either, for the opposite reason — a vault value never
 * enters a process environment, because the environment is inherited by every child and lands in crash
 * reports (risk 13). What is left is on/off, which key provider to use, and whether `secret_get` asks
 * first.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FlypiPaths } from "../agent/paths.ts";
import { keyfileProvider, type KeyProvider } from "./crypto.ts";

export interface SecretsConfig {
	enabled: boolean;
	/** The seam, not a menu: `keyfile` is the only provider implemented, and a name it does not know is an error the user should see. */
	keyProvider: string;
	keyfile: string;
	/** `secret_get` is held until the user says yes — the permission gate's mechanism, the vault's decision. */
	askBeforeUse: boolean;
}

export function secretsConfig(paths: FlypiPaths): SecretsConfig {
	let settings: unknown;
	try {
		settings = JSON.parse(readFileSync(paths.settingsPath, "utf8"));
	} catch {
		settings = {}; // no settings file yet: the defaults have to work
	}
	return parseSecretsConfig(settings, paths);
}

export function parseSecretsConfig(settings: unknown, paths: FlypiPaths): SecretsConfig {
	const raw = (settings as { secrets?: Record<string, unknown> } | undefined)?.secrets;
	return {
		enabled: raw?.enabled !== false,
		keyProvider: typeof raw?.keyProvider === "string" && raw.keyProvider.length > 0 ? raw.keyProvider : "keyfile",
		keyfile: typeof raw?.keyfile === "string" && raw.keyfile.length > 0 ? raw.keyfile : paths.secretKeyPath,
		askBeforeUse: raw?.askBeforeUse !== false,
	};
}

/**
 * The provider the settings name. "keyfile" is the only one, and saying so beats inventing a plugin point
 * Phase 5.5 does not need: another provider (a macOS keychain, say) would appear here and in `keyProvider`
 * above together, and nothing else.
 */
export function keyProviderFor(config: SecretsConfig): KeyProvider {
	if (config.keyProvider !== "keyfile") {
		throw new Error(`secrets.keyProvider is "${config.keyProvider}" and no such provider exists — the only one is "keyfile"`);
	}
	return keyfileProvider(config.keyfile);
}

/**
 * pi's own reference syntax, used here rather than invented: a leading `!` in an `apiKey`, `headers` or `env`
 * value is a command whose stdout becomes the value (docs/models.md, docs/mcp.md). flypi's half of that is a
 * command that prints a vault value, so a config file can hold a reference and still be portable, shareable
 * and free of secrets. Anything that ends in `secret print NAME` counts, because that is how the command looks
 * both as `!flypi secret print NAME` and as `!node /path/to/flypi/scripts/flypi.mjs secret print NAME` —
 * there is no `flypi` on PATH until Phase 7 packages one.
 */
export const SECRET_REF = /!\S.*\ssecret\s+print\s+([A-Za-z0-9][A-Za-z0-9._-]*)\s*$/;

/** The vault name a config value points at, if it points at one. */
export function secretRefName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return value.match(SECRET_REF)?.[1];
}

/** One config entry that points at a vault entry. This is the "used by" half of the UI (docs/secrets.md). */
export interface SecretReference {
	file: string;
	/** Where in that file, so a user can fix the reference rather than guess: `mcpServers.github.headers.Authorization`. */
	path: string;
	name: string;
}

/**
 * The references in the three files pi reads for credentials. Read defensively: a file that does not parse is
 * reported by the settings panel already, and a references panel that throws would be worse than one that
 * shows less.
 */
export function secretReferences(paths: FlypiPaths): SecretReference[] {
	const found: SecretReference[] = [];
	for (const [file, label] of [
		[paths.authPath, "auth.json"],
		[paths.mcpPath, "mcp.json"],
		[paths.modelsPath, "models.json"],
	] as const) {
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(file, "utf8"));
		} catch {
			continue;
		}
		walk(raw, label, (path, value) => {
			const name = secretRefName(value);
			if (name === undefined) return;
			found.push({ file: label, path, name });
		});
	}
	return found;
}

function walk(value: unknown, path: string, visit: (path: string, value: unknown) => void): void {
	if (typeof value === "string") {
		visit(path, value);
		return;
	}
	if (Array.isArray(value)) {
		value.forEach((item, index) => walk(item, `${path}[${index}]`, visit));
		return;
	}
	if (typeof value === "object" && value !== null) {
		for (const [key, item] of Object.entries(value)) walk(item, `${path}.${key}`, visit);
	}
}

/**
 * A vault name, and the name `secret_file` will use as a file. One rule for both, because a name that is not
 * a safe file name cannot be written for ssh to read, and a name with a space in it cannot be written in a
 * config file's `!flypi secret print NAME`.
 */
export const SECRET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Where `secret_file` puts a plaintext a command needs a path to. `mode` is the caller's, 0400. */
export function secretFilePath(paths: FlypiPaths, name: string): string {
	if (!SECRET_NAME.test(name)) throw new Error(`"${name}" is not a usable secret name: letters, digits, dot, dash and underscore`);
	return join(paths.secretsDir, name);
}
