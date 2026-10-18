/**
 * The OAuth sign-in flypi runs from the settings view (docs/architecture.md Phase 5, risk 5): "open this URL,
 * paste the redirect back".
 *
 * The flow is pi's own, so it is driven against real HTTP — the fake authorization server and MCP server in
 * tests/helpers/fake-oauth.ts. Nothing inside pi is stubbed: the authorization URL is the one pi built (PKCE
 * and all), the URL pasted back is the one a browser would have been redirected to, and the tokens are what
 * pi writes to `.flypi/agent/mcp-auth.json`. A fake of pi's OAuth code would only prove this file calls a
 * shape it invented.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mcpStatus } from "../../src/agent/mcp-status.ts";
import { signIn, signInIsWaiting, submitRedirect } from "../../src/agent/mcp-signin.ts";
import { mcpCredentials } from "../../src/agent/pi-mcp.ts";
import { flypiPaths, type FlypiPaths } from "../../src/agent/paths.ts";
import { startMemoryServer, type MemoryServerHandle } from "../../src/memory/mcp.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import { createTempFlypiRoot } from "../helpers/flypi-root.ts";
import { FAKE_ACCESS_TOKEN, startFakeOAuth, type FakeOAuth } from "../helpers/fake-oauth.ts";
import { openTestDb, wordEmbedder } from "../helpers/memory-db.ts";

let fake: FakeOAuth;

beforeAll(async () => {
	fake = await startFakeOAuth();
});
afterAll(async () => {
	await fake.close();
});

/** A checkout whose mcp.json holds exactly these entries. */
function rootWith(mcpServers: Record<string, unknown>): string {
	const root = createTempFlypiRoot();
	writeFileSync(join(root, ".flypi", "agent", "mcp.json"), JSON.stringify({ mcpServers }));
	return root;
}

/** The entry a user would write for the fake server — a function, because its port is only known once it listens. */
const oauthEntry = (): Record<string, unknown> => ({ url: fake.mcpUrl });

/**
 * Run a sign-in, answering its URL the way a user would: open it, read the `state` and `redirect_uri` the
 * authorization request carries, and paste back the address the browser would have landed on. Read
 * `authorizationUrl()` after awaiting `done` — it is only filled once the flow reaches the redirect.
 */
function signInWithPaste(paths: FlypiPaths, name = "sentry"): { done: Promise<void>; authorizationUrl: () => string } {
	let authorizationUrl = "";
	const done = signIn(paths, name, (url) => {
		authorizationUrl = url;
		// The paste happens on its own tick: the sign-in is still inside `showAuthorizationUrl`.
		queueMicrotask(() => {
			const params = new URL(url).searchParams;
			submitRedirect(name, `${params.get("redirect_uri")}?code=the-code&state=${params.get("state")}`);
		});
	});
	return { done, authorizationUrl: () => authorizationUrl };
}

describe("signing an MCP server in from the settings view", () => {
	beforeEach(() => {
		// What the two fake servers were asked, per test: one test's "it never did X" cannot be answered out
		// of a list another test filled.
		fake.asked.length = 0;
	});

	it("finishes on the pasted redirect URL and stores the token in flypi's own agent dir", async () => {
		const paths = flypiPaths(rootWith({ sentry: oauthEntry() }));
		await signInWithPaste(paths).done;

		// The file holding this server's token is the one under .flypi, never the host `~/.pi` (risk 1).
		const stored = JSON.parse(readFileSync(paths.mcpAuthPath, "utf8"));
		const state = Object.values(stored)[0] as { tokens?: { access_token?: string } };
		expect(state.tokens?.access_token).toBe(FAKE_ACCESS_TOKEN);
	});

	it("asks the server's own authorization server, and registers a client when the entry names none", async () => {
		const paths = flypiPaths(rootWith({ sentry: oauthEntry() }));
		const run = signInWithPaste(paths);
		await run.done;
		expect(fake.asked).toContain("GET /.well-known/oauth-protected-resource");
		expect(fake.asked).toContain("GET /.well-known/oauth-authorization-server");
		expect(fake.asked).toContain("POST /register");
		expect(fake.asked).toContain("POST /token");
		// The URL handed to the browser is the authorization server's, with PKCE on it — pi's flow, not ours.
		const authorize = new URL(run.authorizationUrl());
		expect(authorize.origin).toBe(fake.authOrigin);
		expect(authorize.pathname).toBe("/authorize");
		expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
	});

	it("uses a client the entry names instead of registering one, and resolves its secret from the environment", async () => {
		// The four OAuth fields the settings panel writes, in the file: a pre-registered client, its secret as a
		// reference pi resolves (not flypi's own expansion), and a metadata document to trust over discovery.
		process.env.FLYPI_TEST_MCP_SECRET = "pre-registered-secret";
		try {
			const paths = flypiPaths(
				rootWith({
					sentry: {
						...oauthEntry(),
						oauth: {
							clientId: "cid-1",
							clientSecret: "${FLYPI_TEST_MCP_SECRET}",
							scope: "read",
							authServerMetadataUrl: `${fake.authOrigin}/.well-known/oauth-authorization-server`,
						},
					},
				}),
			);
			await signInWithPaste(paths).done;
			expect(fake.asked).not.toContain("POST /register");
			expect(fake.asked).toContain("GET /.well-known/oauth-authorization-server");
			expect(fake.asked).toContain("POST /token");
		} finally {
			delete process.env.FLYPI_TEST_MCP_SECRET;
		}
	});

	it("refuses an entry whose clientSecret does not resolve, naming the entry and the variable", async () => {
		// The reference is pi's, so the failure is pi's sentence: a secret that is not there is a broken entry,
		// not a sign-in to retry.
		const paths = flypiPaths(rootWith({ sentry: { ...oauthEntry(), oauth: { clientSecret: "${FLYPI_TEST_MISSING_SECRET}" } } }));
		await expect(signIn(paths, "sentry", () => {})).rejects.toThrow(/oauth\.clientSecret from environment variable: FLYPI_TEST_MISSING_SECRET/);
	});

	it("refuses a redirect URL from a different sign-in rather than trading it for a token", async () => {
		const paths = flypiPaths(rootWith({ sentry: oauthEntry() }));
		let failure: Error | undefined;
		const done = signIn(paths, "sentry", (url) => {
			const params = new URL(url).searchParams;
			queueMicrotask(() => submitRedirect("sentry", `${params.get("redirect_uri")}?code=the-code&state=not-my-state`));
		}).catch((error: Error) => (failure = error));
		await done;
		expect(failure?.message).toContain("different sign-in");
		expect(fake.asked).not.toContain("POST /token");
	});

	it("cancels when the paste box is emptied", async () => {
		const paths = flypiPaths(rootWith({ sentry: oauthEntry() }));
		await expect(signIn(paths, "sentry", () => submitRedirect("sentry", ""))).rejects.toThrow(/cancelled/);
	});

	it("gives up on a sign-in nobody finished, and says how long it waited", async () => {
		const paths = flypiPaths(rootWith({ sentry: oauthEntry() }));
		// Nothing is ever pasted: the wait itself has to end, or the settings view waits forever.
		await expect(signIn(paths, "sentry", () => {}, 1_000)).rejects.toThrow(/within 1s/);
	});

	it("will not run two sign-ins for one server at a time", async () => {
		const paths = flypiPaths(rootWith({ sentry: oauthEntry() }));
		const first = signInWithPaste(paths);
		expect(signInIsWaiting("sentry")).toBe(true);
		await expect(signIn(paths, "sentry", () => {})).rejects.toThrow(/already waiting/);
		await first.done;
		// And the wait is over once it is done, so the button works again.
		expect(signInIsWaiting("sentry")).toBe(false);
	});

	it("says so when nothing is waiting for a pasted URL", () => {
		expect(submitRedirect("nobody", "http://127.0.0.1:1/callback?code=x")).toBe(false);
	});
});

describe("the entries a sign-in cannot be run for", () => {
	const refused: [string, () => Record<string, unknown>, RegExp][] = [
		["no such server", () => ({ other: oauthEntry() }), /no MCP server named "sentry"/],
		["a local command", () => ({ sentry: { command: "npx", args: ["server-fs", "."] } }), /command flypi starts locally/],
		["a server with its own header", () => ({ sentry: { ...oauthEntry(), headers: { Authorization: "Bearer ${TOKEN}" } } }), /sends its own Authorization header/],
		["a disabled entry", () => ({ sentry: { ...oauthEntry(), enabled: false } }), /is disabled in/],
		["a provider's token", () => ({ sentry: { ...oauthEntry(), auth: { provider: "anthropic" } } }), /\/login credential/],
	];

	for (const [what, servers, message] of refused) {
		it(`refuses ${what} with a sentence about the file`, async () => {
			await expect(signIn(flypiPaths(rootWith(servers())), "sentry", () => {})).rejects.toThrow(message);
		});
	}
});

describe("the status probe sends what a sign-in stored", () => {
	let handle: MemoryServerHandle;
	const TOKEN = "stored-probe-token";

	beforeAll(async () => {
		handle = await startMemoryServer({ store: new MemoryStore(openTestDb(), wordEmbedder()), token: TOKEN });
	});
	afterAll(async () => handle.close());

	it("connects to a server whose only credential is the token in .flypi/agent/mcp-auth.json", async () => {
		// The entry has no Authorization header — that is what makes it an OAuth server — and the token it
		// needs got there by a sign-in. A probe that ignored the store would call this server "needs
		// authorisation" one second after the sign-in that just worked.
		const paths = flypiPaths(rootWith({ "flypi-memory": { url: handle.url } }));
		const credentials = await mcpCredentials(paths);
		await credentials.forServer("flypi-memory", handle.url).save({
			serverUrl: handle.url,
			tokens: { access_token: TOKEN, token_type: "Bearer" },
		});

		const status = await mcpStatus(paths);
		expect(status.servers[0]).toMatchObject({ name: "flypi-memory", state: "connected", transport: "http" });
	});
});
