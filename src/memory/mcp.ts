/**
 * The memory store as an MCP server over HTTP (Streamable HTTP), so anything that speaks MCP —
 * pi's own `mcp.json` in Phase 5, another agent, a script — reaches one shared store instead of
 * keeping a private copy of the facts.
 *
 * Deliberately stateless per request: no session id, no server→client stream. flypi's own agent
 * wiring stays in-process and shares the SQLite handle (docs/memory.md Phase 4, risk 3); this is the
 * surface for everyone else, so it must not become a second writer.
 *
 * Provenance is not a tool argument. `origin_class`/`session_kind` are set by the mount (the
 * principal the caller authenticated as), because "the user said so" inside a body a model wrote
 * carries no authority (docs/memory.md Phase 4).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Type, type Static } from "typebox";
import { Check, Errors } from "typebox/value";
import { resolve } from "node:path";
import { readMedia } from "./media.ts";
import { containsSecret, redactSecrets } from "../secrets/redact.ts";
import type { OriginClass, MemoryStore, SessionKind } from "./store.ts";

const SERVER_INFO = { name: "flypi-memory", version: "0.1.0" } as const;

const Body = Type.String({ minLength: 1, maxLength: 8000 });
const Kind = Type.String({ minLength: 1, maxLength: 60 });
const Id = Type.Integer({ minimum: 1 });
const Tags = Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 60 }), { maxItems: 20 }));
const Reason = Type.Optional(Type.String({ maxLength: 500 }));
/** A file the *server* can read: this is a loopback daemon on the same machine, so a path beats
 *  megabytes of base64 in a tool argument. `memory_media` is how the bytes come back. */
const MediaPath = Type.Optional(Type.String({ minLength: 1, maxLength: 4096 }));
const Ids = Type.Array(Id, { minItems: 1, maxItems: 20 });
/** A turn may cite nothing; an empty list is the answer, not a missing argument. */
const IdList = Type.Optional(Type.Array(Id, { maxItems: 20 }));
/**
 * What the provider reported for the turn — input, cache reads and writes, summed across its model
 * calls by flypi. A model is never asked for these: it was never told them, so anything it produced
 * would be invented (docs/prompt-cache.md Phase 4.6 A1).
 */
const TurnUsage = Type.Optional(
	Type.Object({
		input: Type.Number({ minimum: 0 }),
		output: Type.Number({ minimum: 0 }),
		cacheRead: Type.Number({ minimum: 0 }),
		cacheWrite: Type.Number({ minimum: 0 }),
		totalTokens: Type.Number({ minimum: 0 }),
		cost: Type.Number({ minimum: 0 }),
	}),
);

const TOOL_MODELS = {
	memory_search: Type.Object({
		query: Type.String({ minLength: 1, maxLength: 500 }),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 5 })),
		/** Hard cap on the text returned; a memory is dropped whole, never cut mid-sentence. */
		max_tokens: Type.Optional(Type.Integer({ minimum: 64, maximum: 8000 })),
		/**
		 * Only what automatic injection may use (facts the user stated or this agent wrote). flypi's own
		 * per-turn recall sets it — a fact from an untrusted source must never reach a prompt nobody asked
		 * for. Left out, the search covers everything, including what flypi would not inject on its own.
		 */
		injectable_only: Type.Optional(Type.Boolean()),
	}),
	memory_write: Type.Object({ body: Body, kind: Kind, tags: Tags, reason: Reason, media_path: MediaPath }),
	/**
	 * flypi's own heuristic capture (docs/memory.md Phase 4). A separate tool rather than `memory_write`
	 * because the text came from the user, not from the model: this is the one place a caller's words carry
	 * `owner` authority, and it is the mount that says so, not an argument.
	 */
	memory_capture: Type.Object({ body: Body, kind: Kind, tags: Tags, reason: Reason }),
	/**
	 * The turn just run: what was injected and what the reply cited. flypi calls this after a turn — the
	 * memory server is the only writer, so this is how a turn of a conversation reaches SQLite (Phase 4).
	 */
	memory_turn: Type.Object({
		conversation_id: Type.String({ minLength: 1, maxLength: 64 }),
		cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
		user_text: Body,
		assistant_text: Type.Optional(Body),
		retrieved: IdList,
		cited: IdList,
		usage: TurnUsage,
	}),
	memory_read: Type.Object({ id: Id }),
	/**
	 * Which rows a turn actually used. flypi calls this after a turn, with the `#id`s its own reply
	 * contained — the model is not asked to grade itself, so a citation cannot be self-reported.
	 */
	memory_cite: Type.Object({ ids: Ids }),
	/** Insert the replacement and retire the old row in one call — a replacement is never silent. */
	memory_supersede: Type.Object({ id: Id, body: Body, kind: Kind, tags: Tags, reason: Reason, media_path: MediaPath }),
	memory_forget: Type.Object({ id: Id, reason: Reason }),
	/** The image or recording of a memory, as base64, for whoever has to show or play it. */
	memory_media: Type.Object({ id: Id }),
	memory_index_status: Type.Object({}),
} as const;

const TOOL_NAMES = Object.keys(TOOL_MODELS) as (keyof typeof TOOL_MODELS)[];

type SearchArgs = Static<(typeof TOOL_MODELS)["memory_search"]>;
type WriteArgs = Static<(typeof TOOL_MODELS)["memory_write"]>;
type IdArgs = Static<(typeof TOOL_MODELS)["memory_read"]>;
type CiteArgs = Static<(typeof TOOL_MODELS)["memory_cite"]>;
type CaptureArgs = Static<(typeof TOOL_MODELS)["memory_capture"]>;
type TurnArgs = Static<(typeof TOOL_MODELS)["memory_turn"]>;
type SupersedeArgs = Static<(typeof TOOL_MODELS)["memory_supersede"]>;
type ForgetArgs = Static<(typeof TOOL_MODELS)["memory_forget"]>;
type MediaArgs = Static<(typeof TOOL_MODELS)["memory_media"]>;

/** read-only/destructive hints are set for the Phase 5 permission gate to reuse, not for show. */
const TOOL_META: Record<(keyof typeof TOOL_MODELS), { description: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean } }> = {
	memory_search: {
		description:
			"Search stored memories by keyword and (when embeddings are configured) by meaning. Text, images and audio share one embedding space, so a typed query can find a recording or a picture. Returns #id, body, kind, tags, modality and the row's origin_class — where the fact came from, which is set by code and not by the text itself. Every row is searchable here; flypi's own automatic recall asks with injectable_only, so pass it when you want only what flypi trusts enough to put in front of a model by itself.",
		annotations: { readOnlyHint: true, destructiveHint: false },
	},
	memory_write: {
		description:
			"Store one durable fact. Write what outlives this conversation; quote it as #id when you use it. A fact that contradicts one already stored replaces it, and the answer names the row it retired. For an image or a recording, pass media_path (a file this server can read: png/jpeg/webp/gif, or wav) and write one line describing it — that line is what keyword search sees.",
		annotations: { readOnlyHint: false, destructiveHint: false },
	},
	memory_capture: {
		description:
			"Store a durable fact taken from the user's own words in this turn. flypi's automatic capture calls this itself after a turn — you never need to, and using it for something you inferred yourself would claim an authority the sentence does not have. For your own inference, use memory_write.",
		annotations: { readOnlyHint: false, destructiveHint: false },
	},
	memory_turn: {
		description:
			"Record one turn of a conversation: what was retrieved for it and what its reply cited by #id, and what the provider reported it cost. flypi calls this itself after every turn; a model that reports its own hits is grading its own homework.",
		annotations: { readOnlyHint: false, destructiveHint: false },
	},
	memory_read: {
		description: "Read one memory in full, with its audit history (who wrote it, what replaced it).",
		annotations: { readOnlyHint: true, destructiveHint: false },
	},
	memory_cite: {
		description:
			"Record which memories a turn cited by #id, so the store learns which facts earned their place. flypi calls this itself after a turn — you never need to, and calling it for a fact you did not use would make the count mean nothing.",
		annotations: { readOnlyHint: false, destructiveHint: false },
	},
	memory_supersede: {
		description: "Replace a memory that is no longer true: the old row stays as superseded, the new one takes its place.",
		annotations: { readOnlyHint: false, destructiveHint: true },
	},
	memory_forget: {
		description: "Delete a memory. Only when the user asked for it — a fact that is merely unused is not wrong.",
		annotations: { readOnlyHint: false, destructiveHint: true },
	},
	memory_media: {
		description: "Read the bytes of a memory's image or recording (base64, with its mime type).",
		annotations: { readOnlyHint: true, destructiveHint: false },
	},
	memory_index_status: {
		description: "Report whether the stored vectors all belong to the configured embedding model (a mismatch queues a re-embed).",
		annotations: { readOnlyHint: true, destructiveHint: false },
	},
};

export interface MemoryMcpOptions {
	principal?: string;
	origin_class?: OriginClass;
	session_kind?: SessionKind;
}

/**
 * What an unattended writer may not do (docs/memory.md Phase 4.8, and the one `if` docs/testing.md names as a
 * 100%-coverage choke point). A review fork runs with nobody reading it, so it may *add* a fact and nothing
 * else: `memory_supersede` retires a row a human may be relying on, `memory_forget` deletes one, and
 * `memory_capture` mints `owner` — the authority only the user's own words carry, which is why it is not a
 * tool argument anywhere. Nothing auto-deletes is the project invariant; this is that invariant applied to the
 * one writer nobody is watching.
 */
const UNATTENDED_FORBIDDEN: readonly string[] = ["memory_capture", "memory_supersede", "memory_forget"];

/**
 * The mounts one memory server answers. Provenance is set by which mount a caller reached, never by what the
 * caller's body claims (the header comment): a fork's session is pointed at `/mcp/background` by flypi's own
 * code, so `session_kind='background'` cannot be claimed — or lost — by a model editing its arguments.
 */
const MOUNTS: Record<string, MemoryMcpOptions> = {
	"/mcp": {},
	"/mcp/background": { session_kind: "background", principal: "fork" },
};

/** The MCP half of the surface: tool definitions plus their calls, with no transport in sight. */
export function createMemoryMcpServer(store: MemoryStore, options: MemoryMcpOptions = {}): Server {
	const actor = options.principal ?? "mcp";
	const originClass = options.origin_class ?? "agent";
	const sessionKind = options.session_kind ?? "interactive";

	const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: TOOL_NAMES.map((name) => ({
			name,
			description: TOOL_META[name].description,
			inputSchema: TOOL_MODELS[name] as unknown as Record<string, unknown>,
			annotations: TOOL_META[name].annotations,
		})),
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const name = request.params.name as keyof typeof TOOL_MODELS;
		const model = TOOL_MODELS[name];
		if (!model) return text(`unknown tool: ${request.params.name}`, true);
		if (sessionKind === "background" && UNATTENDED_FORBIDDEN.includes(name)) {
			return text(
				{
					error:
						`${name} is not available to a background writer: an unattended run may add a memory with memory_write, and may not supersede, forget or claim the user's own words for one. ` +
						"Say what should change instead, and let the user or the agent in a live conversation do it.",
				},
				true,
			);
		}
		const params = (request.params.arguments ?? {}) as Record<string, unknown>;
		if (!Check(model, params)) {
			const why = [...Errors(model, params)].map((error) => `${error.instancePath || "/"}: ${error.message}`);
			return text({ error: `invalid arguments: ${why.join("; ")}` }, true);
		}
		try {
			switch (name) {
				case "memory_search": {
					const args = params as SearchArgs;
					const result = await store.search({
						query: args.query,
						limit: args.limit ?? 5,
						...(args.max_tokens === undefined ? {} : { maxTokens: args.max_tokens }),
						...(args.injectable_only ? { injectableOnly: true } : {}),
					});
					// `partial` is in the payload, not hidden: keyword-only results must say so (risk 8).
					return text({
						...(result.partial ? { partial: true, ...(result.note ? { note: result.note } : {}) } : {}),
						results: result.results.map((row) => ({
							id: row.id,
							kind: row.kind,
							body: row.body,
							tags: row.tags,
							modality: row.modality,
							...(row.media ? { media: { kind: row.media.kind, mime: row.media.mime, bytes: row.media.bytes_size } } : {}),
							score: Number(row.score.toFixed(6)),
							matched_by: row.matched_by,
							// Provenance travels with the row: authority is code's, so a caller has to be able to
							// see it rather than believe what the body claims about itself.
							origin_class: row.origin_class,
							use_count: row.use_count,
							created_at: row.created_at,
						})),
					});
				}
				case "memory_write": {
					const args = params as WriteArgs;
					const leaked = secretInBody(args.body);
					if (leaked) return leaked;
					const written = await store.addMemory(await provenance(args, actor, originClass, sessionKind));
					// A repeat write says so instead of quietly adding a second copy of the fact, and a row
					// the embedder refused says why instead of pretending it is searchable by meaning.
					return text({
						id: written.id,
						duplicate_of: written.duplicateOf,
						// Naming what it replaced is the only way the model can say "I changed the earlier fact".
						...(written.contradicted ? { contradicted: written.contradicted } : {}),
						...(written.notIndexed ? { indexed: false, note: written.notIndexed } : {}),
						// A write that nothing judged is stated the same way: the fact landed, and the reader
						// knows the contradiction question went unanswered.
						...(written.notJudged ? { judged: false, judgment_note: written.notJudged } : {}),
					});
				}
				case "memory_cite": {
					const args = params as CiteArgs;
					// An id that does not exist is not a citation, and the answer says which ones counted: the
					// caller is reporting what a model wrote, and models invent numbers.
					return text({ cited: args.ids.filter((id) => store.markCited(id)) });
				}
				case "memory_capture": {
					const args = params as CaptureArgs;
					const leaked = secretInBody(args.body);
					if (leaked) return leaked;
					// The name in the audit row says where the write came from, because "who wrote this fact" is
					// the question an audit row exists to answer.
					const written = await store.addMemory({
						body: args.body,
						kind: args.kind,
						tags: args.tags ?? [],
						reason: args.reason,
						actor: `${actor}:capture`,
						origin_class: "owner",
						session_kind: sessionKind,
					});
					return text({
						id: written.id,
						duplicate_of: written.duplicateOf,
						...(written.contradicted ? { contradicted: written.contradicted } : {}),
						...(written.notIndexed ? { indexed: false, note: written.notIndexed } : {}),
					});
				}
				case "memory_turn": {
					const args = params as TurnArgs;
					// A turn is the first thing the memory server ever hears about a conversation, so the row it
					// points at is created here — idempotently, because the next turn points at the same one.
					store.ensureConversation({ id: args.conversation_id, ...(args.cwd ? { cwd: args.cwd } : {}) });
					const turn = store.recordTurn(args.conversation_id, {
						userText: args.user_text,
						...(args.assistant_text === undefined ? {} : { assistantText: args.assistant_text }),
						...(args.retrieved ? { retrieved: args.retrieved } : {}),
						...(args.cited ? { cited: args.cited } : {}),
						...(args.usage ? { usage: args.usage } : {}),
					});
					// The counts come back, not the row: the caller reported them, and saying what landed is what
					// makes a silent no-op impossible.
					return text({ turn, retrieved: args.retrieved?.length ?? 0, cited: args.cited?.length ?? 0 });
				}
				case "memory_read": {
					const args = params as IdArgs;
					const memory = store.memory(args.id);
					if (!memory) return text(`no memory #${args.id}`, true);
					return text({ memory, history: store.history(args.id) });
				}
				case "memory_supersede": {
					const args = params as SupersedeArgs;
					const leaked = secretInBody(args.body);
					if (leaked) return leaked;
					const previous = store.memory(args.id);
					if (!previous) return text(`no memory #${args.id}`, true);
					if (previous.status !== "active") return text(`memory #${args.id} is ${previous.status}; only an active row can be superseded`, true);
					const replacement = (await store.addMemory({
						...(await provenance(args, actor, originClass, sessionKind)),
						supersedes: args.id,
						strength: previous.strength,
						reason: args.reason,
					})).id;
					store.markSuperseded(args.id, replacement, actor, args.reason);
					return text({ superseded: args.id, replacement });
				}
				case "memory_forget": {
					const args = params as ForgetArgs;
					const existing = store.memory(args.id);
					if (!existing) return text(`no memory #${args.id}`, true);
					store.forget(args.id, actor, args.reason);
					return text({ id: args.id, status: store.memory(args.id)!.status });
				}
				case "memory_media": {
					const args = params as MediaArgs;
					const media = store.mediaBytes(args.id);
					if (!media) return text(`memory #${args.id} has no image or recording`, true);
					return text({
						id: args.id,
						kind: media.kind,
						mime: media.mime,
						path: media.path,
						base64: Buffer.from(media.bytes).toString("base64"),
					});
				}
				case "memory_index_status":
					return text(store.indexIdentity());
				default:
					return text(`unknown tool: ${request.params.name}`, true);
			}
		} catch (error) {
			return text({ error: (error as Error).message }, true);
		}
	});

	return server;
}

async function provenance(
	args: Static<typeof TOOL_MODELS.memory_write> | Static<typeof TOOL_MODELS.memory_supersede>,
	actor: string,
	origin_class: OriginClass,
	session_kind: SessionKind,
) {
	return {
		body: args.body,
		kind: args.kind,
		tags: args.tags ?? [],
		reason: args.reason,
		actor,
		origin_class,
		session_kind,
		// Relative paths are read from the server's working directory — it runs on this machine.
		...(args.media_path ? { media: await readMedia(resolve(args.media_path)) } : {}),
	};
}

/**
 * The write gate (docs/secrets.md): a memory keeps the *pointer*, never the value. A body that quotes a
 * stored credential is refused rather than rewritten — the model can still say "authenticates with secret
 * `mats_ssh`", and a fact with a password welded into it would be pasted into every prompt it ever reaches.
 * The store's own `redactSecrets` stays as the backstop for writers that are not a model.
 */
function secretInBody(body: string): ReturnType<typeof text> | undefined {
	if (!containsSecret(body)) return undefined;
	const names = [...new Set([...redactSecrets(body).matchAll(/\[secret:([^\]]+)\]/g)].map((match) => match[1]!))];
	return text(
		{
			error: `the body quotes ${names.map((name) => `[secret:${name}]`).join(", ")} — a memory keeps the pointer, not the value. Write it as "…authenticates with secret ${names[0]}…" and use the secret tools to use the value.`,
			secrets: names,
		},
		true,
	);
}

const text = (payload: unknown, isError = false) => ({
	content: [{ type: "text" as const, text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 1) }],
	...(isError ? { isError: true } : {}),
});

export interface MemoryServerOptions extends MemoryMcpOptions {
	store: MemoryStore;
	/** Omit to generate one per run; the token is what keeps this off the LAN as an open door. */
	token?: string;
	port?: number;
	host?: string;
}

export interface MemoryServerHandle {
	port: number;
	host: string;
	token: string;
	url: string;
	close(): Promise<void>;
}

/**
 * Loopback HTTP, one endpoint: `POST /mcp`. `?token=` or `Authorization: Bearer` both work, since
 * `mcp.json` carries headers while a browser-style client more easily carries a query parameter.
 */
export async function startMemoryServer(options: MemoryServerOptions): Promise<MemoryServerHandle> {
	const host = options.host ?? "127.0.0.1";
	const token = options.token ?? randomUUID();

	const httpServer = createServer((request, response) => {
		void handle(request, response);
	});

	const handle = async (request: IncomingMessage, response: ServerResponse) => {
		const url = new URL(request.url ?? "/", `http://${host}`);
		const supplied = url.searchParams.get("token") ?? request.headers.authorization?.replace(/^Bearer\s+/i, "");
		const mount = MOUNTS[url.pathname];
		if (!mount) return send(response, 404, "not found\n");
		if (supplied !== token) return send(response, 401, "unauthorized\n");

		// A fresh server+transport per request is the stateless Streamable HTTP pattern. One store behind both
		// mounts, so the background mount is not a second writer (risk 3) — only a different principal.
		const server = createMemoryMcpServer(options.store, { ...options, ...mount });
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true,
		});
		request.on("aborted", () => void transport.close());
		try {
			await server.connect(transport);
			await transport.handleRequest(request, response);
			// `enableJsonResponse` means the response is complete when handleRequest resolves; closing
			// here is what keeps one request from holding a transport open. (Not req.on("close"): for a
			// POST whose body is already read, that fires while the request is still being handled.)
			await transport.close();
			await server.close();
		} catch (error) {
			console.error(`flypi memory: ${(error as Error).message}`);
			if (!response.headersSent) send(response, 500, "internal error\n");
		}
	};

	const port = await new Promise<number>((resolvePort, reject) => {
		httpServer.once("error", reject);
		httpServer.listen(options.port ?? 0, host, () => {
			const address = httpServer.address();
			if (address && typeof address === "object") resolvePort(address.port);
			else reject(new Error("could not bind the memory server socket"));
		});
	});

	return {
		port,
		host,
		token,
		url: `http://${host}:${port}/mcp`,
		close: () =>
			new Promise<void>((resolveClose, rejectClose) => {
				httpServer.close((error) => (error ? rejectClose(error) : resolveClose()));
				// A client that never closed its connection must not keep shutdown waiting.
				httpServer.closeAllConnections();
			}),
	};
}

function send(response: ServerResponse, status: number, body: string): void {
	response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
	response.end(body);
}
