/**
 * A pair of fake servers for testing pi's MCP OAuth flow (src/agent/mcp-signin.ts): an authorization server
 * that answers discovery, dynamic client registration and the token exchange, and an MCP server that only
 * answers the protected-resource metadata and refuses everything else with a 401.
 *
 * Real HTTP on loopback, because the flow is pi's own: stubbing pi's OAuth code would prove this repo calls a
 * shape it invented. The tokens it hands out are constants a test can look for in `mcp-auth.json`.
 */
import { createServer, type Server } from "node:http";

export const FAKE_ACCESS_TOKEN = "signed-in-access-token";

export interface FakeOAuth {
	/** Put this in `mcp.json` as the server's `url`. */
	mcpUrl: string;
	/** Where the authorization endpoints live. */
	authOrigin: string;
	/** Every request either fake server answered, as `METHOD /path`. */
	asked: string[];
	close(): Promise<void>;
}

export async function startFakeOAuth(): Promise<FakeOAuth> {
	const asked: string[] = [];
	let authOrigin = "";
	let mcpOrigin = "";

	const auth = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		asked.push(`${request.method} ${url.pathname}`);
		const json = (status: number, body: unknown) => {
			response.writeHead(status, { "content-type": "application/json" });
			response.end(JSON.stringify(body));
		};
		if (url.pathname === "/.well-known/oauth-authorization-server") {
			return json(200, {
				issuer: authOrigin,
				authorization_endpoint: `${authOrigin}/authorize`,
				token_endpoint: `${authOrigin}/token`,
				registration_endpoint: `${authOrigin}/register`,
				response_types_supported: ["code"],
				grant_types_supported: ["authorization_code", "refresh_token"],
				code_challenge_methods_supported: ["S256"],
				token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
			});
		}
		// Dynamic client registration: pi sends its redirect URI, this hands back a client.
		if (url.pathname === "/register") return json(201, { client_id: "test-client", client_secret: "test-secret" });
		if (url.pathname === "/token") {
			return json(200, { access_token: FAKE_ACCESS_TOKEN, token_type: "Bearer", expires_in: 3600, refresh_token: "refresh-1" });
		}
		return json(404, { error: "not_found" });
	});

	// The MCP server half: a sign-in authorizes against the server without connecting to it, so only the
	// protected-resource metadata is answered — and everything else is refused the way an OAuth server does.
	const mcp = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		asked.push(`${request.method} ${url.pathname}`);
		if (url.pathname === "/.well-known/oauth-protected-resource") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ resource: `${mcpOrigin}/mcp`, authorization_servers: [authOrigin] }));
			return;
		}
		response.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${mcpOrigin}/.well-known/oauth-protected-resource"` });
		response.end();
	});

	await listen(auth, (origin) => (authOrigin = origin));
	await listen(mcp, (origin) => (mcpOrigin = origin));
	return {
		get mcpUrl() {
			return `${mcpOrigin}/mcp`;
		},
		get authOrigin() {
			return authOrigin;
		},
		asked,
		close: () => new Promise<void>((resolve) => {
			auth.close();
			mcp.close(() => resolve());
		}),
	};
}

function listen(server: Server, remember: (origin: string) => void): Promise<void> {
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address && typeof address === "object") remember(`http://127.0.0.1:${(address as { port: number }).port}`);
			resolve();
		});
	});
}
