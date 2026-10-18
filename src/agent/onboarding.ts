import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** pi's auth.json shape: { "<provider>": { "type": "api_key", "key": "..." } } */
export type AuthStorage = Record<string, { type: string; key?: string } | undefined>;

export type ResolvedCredential =
	| { ok: true; provider: string; source: "auth.json" | "models.json" | "env" }
	| { ok: false; provider: string; message: string };

/** `lmstudio` -> `LMSTUDIO_API_KEY`, `openai` -> `OPENAI_API_KEY`. */
export function credentialEnvName(provider: string): string {
	return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

function hasValue(value: unknown): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

/**
 * Decide whether a provider can be used, without throwing: a missing credential is a
 * message the user can act on, not a stack trace.
 *
 * pi's own precedence is auth.json > models.json apiKey > env, so this reports the
 * source pi would actually use. `env` is listed last because pi reads it last.
 */
export function resolveCredential(input: {
	provider: string;
	models: { providers?: Record<string, { apiKey?: unknown }> | undefined };
	auth: AuthStorage;
	env: Record<string, string | undefined>;
}): ResolvedCredential {
	const { provider, models, auth, env } = input;
	if (hasValue(auth[provider]?.key)) return { ok: true, provider, source: "auth.json" };
	if (hasValue(models.providers?.[provider]?.apiKey)) return { ok: true, provider, source: "models.json" };
	if (hasValue(env[credentialEnvName(provider)])) return { ok: true, provider, source: "env" };
	return {
		ok: false,
		provider,
		message:
			`no credential for provider "${provider}". Set ${credentialEnvName(provider)} in the environment, ` +
			`or add {"${provider}":{"type":"api_key","key":"…"}} to the model credential file.`,
	};
}

export function readAuth(authPath: string): AuthStorage {
	if (!existsSync(authPath)) return {};
	return JSON.parse(readFileSync(authPath, "utf8")) as AuthStorage;
}

/** Store a key in pi's own credential file (0600), merging unrelated providers. */
export function writeAuthKey(authPath: string, provider: string, key: string): void {
	const auth = readAuth(authPath);
	auth[provider] = { type: "api_key", key };
	mkdirSync(dirname(authPath), { recursive: true });
	writeFileSync(authPath, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
	chmodSync(authPath, 0o600);
}

/**
 * Move an environment-supplied key into the credential file so later runs (and the
 * daemon) do not depend on the caller's shell. Returns false when there is nothing to do.
 */
export function importEnvCredential(
	authPath: string,
	provider: string,
	env: Record<string, string | undefined>,
): boolean {
	const key = env[credentialEnvName(provider)];
	if (!hasValue(key)) return false;
	if (hasValue(readAuth(authPath)[provider]?.key)) return false;
	writeAuthKey(authPath, provider, key as string);
	return true;
}
