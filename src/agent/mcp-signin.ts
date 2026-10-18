/**
 * Signing an MCP server in from the settings view (docs/architecture.md Phase 5, risk 5): the half the
 * status panel left open — a server with an `oauth` entry used to be reported as unreachable, which is true
 * but not something a user can act on.
 *
 * This is pi's own authorization-code flow (PKCE, dynamic client registration or a pre-registered client),
 * run by pi's `signInMcpServer` — see src/agent/pi-mcp.ts for why flypi calls it directly rather than
 * through the MCP extension. The only flypi part is the prompt: the authorization URL goes to the browser
 * as an `mcpAuth` frame, and the address the browser lands on comes back as a paste. That paste is the whole
 * point — when flypi runs somewhere a browser cannot reach (a box reached over SSH), the loopback callback
 * pi also listens for never arrives, and the sign-in is otherwise impossible.
 *
 * Tokens land in `.flypi/agent/mcp-auth.json`, which is what a conversation's own connections read next time
 * (src/agent/runtime.ts) and what the status probe sends when it asks a server whether it answers
 * (src/agent/mcp-status.ts).
 */
import type { McpServerEntry } from "@earendil-works/pi-coding-agent";
import type { FlypiPaths } from "./paths.ts";
import { loadPiMcpRuntime, mcpCredentials, usesMcpOAuth, type PiMcpOAuthSettings, type PiMcpRuntime } from "./pi-mcp.ts";
import { readFlypiMcpConfig } from "./runtime.ts";

/**
 * How long a sign-in may wait for the paste. pi's CLI uses its MCP request timeout for the same wait; this
 * is longer on purpose — a person opening a URL on a different device, approving it, and copying an address
 * is slower than a network call, and cancelling a sign-in out from under them is the failure to avoid.
 */
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

/** One sign-in per server name at a time, process-wide: two flows for one server would race on its tokens. */
const waiting = new Map<string, (redirectUrl: string | undefined) => void>();

/** Whether a paste would reach a sign-in right now — what the settings view's button is disabled by. */
export function signInIsWaiting(name: string): boolean {
	return waiting.has(name);
}

/**
 * Hand the pasted address to the sign-in for `name`. Empty cancels. Returns false when nothing is waiting,
 * which is what the server turns into an error frame rather than a dropped frame.
 */
export function submitRedirect(name: string, redirectUrl: string): boolean {
	const paste = waiting.get(name);
	if (!paste) return false;
	paste(redirectUrl.trim() || undefined);
	return true;
}

/**
 * Run the sign-in for one entry of `.flypi/agent/mcp.json`. Resolves once the tokens are stored; throws with
 * the sentence a reader acts on — the settings view shows whatever comes back.
 */
export async function signIn(
	paths: FlypiPaths,
	name: string,
	onAuthorizationUrl: (url: string) => void,
	timeoutMs = SIGN_IN_TIMEOUT_MS,
): Promise<void> {
	const entry = readFlypiMcpConfig(paths).servers.find((server) => server.name === name);
	if (!entry) throw new Error(`no MCP server named "${name}" in ${paths.mcpPath}`);
	const target = signInTarget(entry, paths.mcpPath);
	if ("refusal" in target) throw new Error(target.refusal);
	if (waiting.has(name)) throw new Error(`a sign-in for "${name}" is already waiting for its redirect URL`);

	// The slot is taken before anything is loaded, so a second click while pi's OAuth machinery is still
	// arriving is refused too rather than starting a second flow for the same server.
	let paste: (redirectUrl: string | undefined) => void = () => {};
	const pasted = new Promise<string | undefined>((resolve) => (paste = resolve));
	const timer = setTimeout(() => paste(undefined), timeoutMs);
	timer.unref();
	waiting.set(name, paste);
	// Assigned inside the try, so the catch can still name pi's own cancellation error.
	let pi: PiMcpRuntime | undefined;
	try {
		pi = await loadPiMcpRuntime();
		const credentials = await mcpCredentials(paths);
		await pi.signInMcpServer({
			serverUrl: target.url,
			store: credentials.forServer(name, target.url),
			settings: oauthSettings(pi.resolveConfigValueOrThrow, entry),
			prompt: {
				showAuthorizationUrl: (authorizationUrl) => onAuthorizationUrl(authorizationUrl.href),
				// pi races this against its own loopback callback, so a browser on this machine finishes the
				// sign-in without the paste; the paste is what makes it finish when one cannot.
				promptForRedirectUrl: () => pasted,
			},
		});
	} catch (error) {
		if (pi && error instanceof pi.McpSignInCancelledError) {
			throw new Error(`sign-in to "${name}" was cancelled, or no redirect URL arrived within ${Math.round(timeoutMs / 1000)}s`);
		}
		throw error;
	} finally {
		clearTimeout(timer);
		waiting.delete(name);
	}
}

/**
 * The URL to authorize against, or the sentence explaining why this entry cannot be signed in to. The rule
 * is pi's own (src/agent/pi-mcp.ts): an HTTP server authenticates with OAuth when it sends no
 * `Authorization` header of its own and delegates to no provider — anything else is a credential to fix in
 * the file, not a sign-in to do.
 */
function signInTarget(entry: McpServerEntry, mcpPath: string): { url: string } | { refusal: string } {
	const config = entry.config;
	if (!("url" in config)) return { refusal: `"${entry.name}" is a command flypi starts locally: there is nothing to sign in to` };
	if (config.enabled === false) return { refusal: `"${entry.name}" is disabled in ${mcpPath}` };
	if (!usesMcpOAuth(config)) {
		return {
			refusal: config.auth?.provider
				? `"${entry.name}" sends the token of provider "${config.auth.provider}" — that is a /login credential, not an OAuth sign-in`
				: `"${entry.name}" sends its own Authorization header, so it is not an OAuth server — fix that header in ${mcpPath}`,
		};
	}
	return { url: config.url };
}

/**
 * The entry's `oauth` block as pi wants it, resolved the way pi resolves it: only `clientSecret` can name an
 * environment variable or a command, and a reference that does not resolve is an error naming the entry.
 */
function oauthSettings(resolve: (value: string, description: string) => string, entry: McpServerEntry): PiMcpOAuthSettings {
	const oauth = "oauth" in entry.config ? entry.config.oauth : undefined;
	if (!oauth) return {};
	return {
		clientId: oauth.clientId,
		...(oauth.clientSecret === undefined
			? {}
			: { clientSecret: resolve(oauth.clientSecret, `MCP server "${entry.name}" oauth.clientSecret`) }),
		callbackPort: oauth.callbackPort,
		callbackUrl: oauth.callbackUrl,
		scope: oauth.scope,
		clientName: oauth.clientName,
		clientRegistration: oauth.clientRegistration,
		...(oauth.authServerMetadataUrl ? { authServerMetadataUrl: new URL(oauth.authServerMetadataUrl) } : {}),
	};
}
