/**
 * The MCP status panel (docs/architecture.md Phase 5): is each server in `.flypi/agent/mcp.json` actually
 * reachable, how many tools does it offer, what did it complain about.
 *
 * pi keeps its own connections inside the MCP extension and shows the host none of that state — not over
 * the SDK, not in the `.flypi/agent/mcp.log` file it is handed (docs/pi-api.md). So this asks the servers
 * directly, the way `pi mcp list` does: connect, list tools, close. It is a second set of connections for
 * as long as the request takes, and it does not touch the ones a running conversation holds — which is the
 * honest answer to "is it up", since the connections a session made are not the ones this panel describes
 * after a config edit (an existing conversation keeps its own, docs/architecture.md Phase 5).
 *
 * The tool list carries the two annotations that mean something to a reader: `destructiveHint` ("this can
 * destroy something") and `openWorldHint` ("this reaches outside the machine"). That is what a user puts on
 * `permissions.askBeforeUse` in src/agent/permission-gate.ts — the gate itself never sees an annotation.
 */
import { readFileSync, existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerEntry } from "@earendil-works/pi-coding-agent";
import type { FlypiPaths } from "./paths.ts";
import { mcpCredentials, usesMcpOAuth, type PiMcpCredentials } from "./pi-mcp.ts";
import { readFlypiMcpConfig } from "./runtime.ts";

/** "not answering" has to be distinguishable from "not up yet", so a probe that hangs is a failure. */
export type McpServerState = "connected" | "disabled" | "failed" | "needs-auth";

export interface McpToolRow {
	name: string;
	/** What the server announced about the tool, not what flypi guessed. Absent means not announced. */
	destructive: boolean;
	openWorld: boolean;
}

export interface McpStatusRow {
	name: string;
	state: McpServerState;
	transport: "http" | "stdio";
	/** Set for `failed` / `needs-auth`, in the server's own words. */
	error?: string;
	tools: McpToolRow[];
}

export interface McpStatusSnapshot {
	servers: McpStatusRow[];
	/** The tail of `.flypi/agent/mcp.log`: pi's own words about the connections a session actually made. */
	log: string;
}

/** pi's own startup wait for one server (docs/mcp.md); matching it means this never gives up before pi would. */
const PROBE_TIMEOUT_MS = 10_000;
/** The log rotates at 5 MB (pi's MCP extension); the panel shows the end of it, not all of it. */
const LOG_TAIL_BYTES = 8 * 1024;

/** Every configured server, probed in parallel: one slow one must not add up behind the others. */
export async function mcpStatus(paths: FlypiPaths, timeoutMs = PROBE_TIMEOUT_MS): Promise<McpStatusSnapshot> {
	const config = readFlypiMcpConfig(paths);
	// The OAuth servers need what a sign-in stored (see transportFor), so the probe reads the same file a
	// conversation's connections read.
	const credentials = await mcpCredentials(paths);
	const rows = await Promise.all(config.servers.map((entry) => probe(entry, credentials, timeoutMs)));
	return { servers: rows, log: mcpLogTail(paths) };
}

/** Connect and list, then close. Never throws: a server that will not answer is a row, not an error frame. */
async function probe(entry: McpServerEntry, credentials: PiMcpCredentials, timeoutMs: number): Promise<McpStatusRow> {
	const config = entry.config;
	const base = { name: entry.name, transport: "command" in config ? ("stdio" as const) : ("http" as const) };
	if (config.enabled === false) return { ...base, state: "disabled", tools: [] };

	const client = new Client({ name: "flypi-status", version: "0.0.0" });
	try {
		await withTimeout(client.connect(await transportFor(entry, credentials)), timeoutMs);
		const listed = await withTimeout(client.listTools(), timeoutMs);
		return {
			...base,
			state: "connected",
			tools: listed.tools.map((tool) => ({
				name: tool.name,
				destructive: tool.annotations?.destructiveHint === true,
				openWorld: tool.annotations?.openWorldHint === true,
			})),
		};
	} catch (error) {
		// A 401 is its own state: the server is there and the credential is missing or wrong, which is a
		// different thing to fix than a server that is not up. It is read off the SDK's own status
		// (`StreamableHTTPError.code`), because the message alone is not enough — a 401 with an empty body
		// says nothing but "Error POSTing to endpoint".
		const state: McpServerState = httpStatusOf(error) === 401 ? "needs-auth" : "failed";
		return { ...base, state, error: (error as Error).message ?? String(error), tools: [] };
	} finally {
		await client.close().catch(() => undefined);
	}
}

/** The HTTP status of a failed MCP request, or undefined when the failure was not an HTTP answer. */
function httpStatusOf(error: unknown): number | undefined {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "number" ? code : undefined;
}

/**
 * The transport pi would build for this entry: URL and headers for HTTP, spawned process for stdio.
 * `${NAME}` in a header or env value is expanded here because this is a second client and pi's own
 * expansion does not apply to it — same rule as src/memory/recall.ts.
 * `shortcut: no "!command" values here either; add them with recall.ts if an entry ever uses one.`
 */
async function transportFor(entry: McpServerEntry, credentials: PiMcpCredentials): Promise<Transport> {
	const config = entry.config;
	if ("command" in config) {
		return new StdioClientTransport({
			command: config.command,
			args: config.args ?? [],
			...(config.cwd ? { cwd: config.cwd } : {}),
			env: { ...getDefaultEnvironment(), ...expand(Object.entries(config.env ?? {})) },
		});
	}
	const headers = expand(Object.entries(config.headers ?? {}));
	// A server the user signed in to in a browser: send the token that sign-in stored, the way pi's own
	// connection does. Without it the panel would call a server "needs authorisation" one second after the
	// sign-in that just worked (docs/architecture.md Phase 5).
	// shortcut: no refresh here — a token that expired since shows as needs-auth, and signing in again is the fix.
	const token = usesMcpOAuth(config) ? credentials.tokens(entry.name, config.url)?.access_token : undefined;
	if (token) headers.Authorization = `Bearer ${token}`;
	return new StreamableHTTPClientTransport(new URL(config.url), Object.keys(headers).length ? { requestInit: { headers } } : {});
}

const expand = (entries: [string, string | undefined][]): Record<string, string> =>
	Object.fromEntries(
		entries.map(([name, value]) => [name, (value ?? "").replace(/\$\{([A-Za-z0-9_]+)\}/g, (_, env: string) => process.env[env] ?? "")]),
	);

/** A hung server is the one failure mode that would otherwise leave the panel waiting forever. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000}s`)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

/**
 * The last `LOG_TAIL_BYTES` of pi's MCP log, whole lines only. Empty when there is no log, which is the
 * normal state of a machine where nothing has gone wrong; the panel says "nothing logged" rather than
 * leaving a blank box (risk 8).
 */
export function mcpLogTail(paths: FlypiPaths, bytes = LOG_TAIL_BYTES): string {
	if (!existsSync(paths.mcpLogPath)) return "";
	let raw: Buffer;
	try {
		raw = readFileSync(paths.mcpLogPath);
	} catch (error) {
		return `could not read ${paths.mcpLogPath}: ${(error as Error).message}`;
	}
	const cut = Math.max(0, raw.length - bytes);
	const tail = raw.subarray(cut).toString("utf8");
	// Only when bytes were actually dropped: the first surviving line is then a partial one.
	return cut > 0 ? tail.replace(/^[^\n]*\n/, "") : tail;
}
