/**
 * pi's MCP OAuth machinery, reached at the file pi's own MCP extension loads it from.
 *
 * pi does not export any of this from its package entry: `createMcpExtension()` is the only public door to
 * the code, and it runs sign-in solely through pi's TUI (`/mcp`, which draws a terminal dialog). flypi signs
 * a user in from the settings view of a headless server, so it calls the same function the extension calls —
 * `signInMcpServer` — with a prompt of its own: the URL goes to the browser, the redirect comes back as a
 * paste (docs/architecture.md Phase 5, risk 5).
 *
 * The shapes below are copied from pi's `.d.ts` files, which the package's `exports` map keeps unreachable
 * as well. They describe four pi functions and nothing more; re-check them against
 * `dist/extensions/mcp/oauth.d.ts` after a pi upgrade (docs/pi-api.md).
 */
import { getPackageDir, type McpExtensionOptions, type McpServerConfig } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FlypiPaths } from "./paths.ts";

/** pi's `McpOAuthCredentialStore`, which `createMcpExtension({ credentials })` takes. */
export type PiMcpCredentials = NonNullable<McpExtensionOptions["credentials"]>;

/** What an authorization needs: pi's `McpOAuthSettings`, i.e. the `oauth` block of an `mcp.json` entry. */
export interface PiMcpOAuthSettings {
	clientId?: string;
	/** Already resolved — `${NAME}` and `!command` expanded. */
	clientSecret?: string;
	callbackPort?: number;
	callbackUrl?: string;
	scope?: string;
	clientName?: string;
	clientRegistration?: "dcr" | "cimd";
	authServerMetadataUrl?: URL;
}

/** The two ways a sign-in finishes: the browser reaches the loopback callback, or the user pastes what it landed on. */
export interface PiMcpSignInPrompt {
	showAuthorizationUrl(url: URL): void;
	/** `undefined` or "" cancels. Abandoned once the loopback callback arrives. */
	promptForRedirectUrl(signal: AbortSignal): Promise<string | undefined>;
}

/** pi's `McpOAuthCredentialStore.forServer()` — the per-server state handle `signInMcpServer` takes. */
export interface PiMcpServerStore {
	load(): unknown;
	save(state: { serverUrl: string; tokens?: { access_token?: string; token_type?: string } }): void | Promise<void>;
}

export interface PiMcpRuntime {
	signInMcpServer(options: { serverUrl: string; store: PiMcpServerStore; settings: PiMcpOAuthSettings; prompt: PiMcpSignInPrompt }): Promise<void>;
	McpOAuthCredentialStore: new (backend: unknown, lockDir: string) => PiMcpCredentials & {
		/** What a sign-in stored for this server, or nothing. Synchronous, like pi's own. */
		tokens(name: string, serverUrl: string): { access_token?: string } | undefined;
		forServer(name: string, serverUrl: string): PiMcpServerStore;
	};
	FileAuthStorageBackend: new (filePath: string) => unknown;
	McpSignInCancelledError: new (...args: never[]) => Error;
	/** `${NAME}` / `!command` → the value, or a thrown error naming what is missing. */
	resolveConfigValueOrThrow: (value: string, description: string) => string;
}

let cached: Promise<PiMcpRuntime> | undefined;

/** Loaded once per process, and only when something actually needs it: this pulls in pi's MCP client. */
export function loadPiMcpRuntime(): Promise<PiMcpRuntime> {
	const dir = getPackageDir();
	return (cached ??= Promise.all([
		import(pathToFileURL(join(dir, "dist/extensions/mcp/runtime.js")).href),
		import(pathToFileURL(join(dir, "dist/core/auth-storage.js")).href),
		import(pathToFileURL(join(dir, "dist/core/resolve-config-value.js")).href),
	]).then(([runtime, authStorage, configValue]) => ({
		signInMcpServer: runtime.signInMcpServer,
		McpOAuthCredentialStore: runtime.McpOAuthCredentialStore,
		FileAuthStorageBackend: authStorage.FileAuthStorageBackend,
		McpSignInCancelledError: runtime.McpSignInCancelledError,
		resolveConfigValueOrThrow: configValue.resolveConfigValueOrThrow,
	})));
}

/**
 * The credential store, pointed at flypi's own agent dir. pi's default is `mcp-auth.json` in *its* agent dir
 * (`$PI_CODING_AGENT_DIR`, else `~/.pi/agent`), which is the config bleed this repo refuses everywhere else
 * (risk 1) — so every consumer passes this: a session's connections, the status probe, and a sign-in.
 */
export async function mcpCredentials(paths: FlypiPaths): Promise<PiMcpCredentials & { tokens(name: string, serverUrl: string): { access_token?: string } | undefined }> {
	const pi = await loadPiMcpRuntime();
	return new pi.McpOAuthCredentialStore(new pi.FileAuthStorageBackend(paths.mcpAuthPath), paths.agentDir);
}

/**
 * Whether pi authenticates this entry with OAuth: an HTTP server that sends no `Authorization` header of its
 * own and delegates to no provider. That is pi's own rule, copied because the probe and the sign-in have to
 * agree with what a session will do — otherwise the panel offers a sign-in the file will ignore.
 */
export function usesMcpOAuth(config: McpServerConfig): boolean {
	if (!("url" in config) || config.auth?.provider) return false;
	return !Object.keys(config.headers ?? {}).some((header) => header.toLowerCase() === "authorization");
}
