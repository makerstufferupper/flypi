/**
 * Automatic recall — what flypi's own agent does with the memory server in `.flypi/agent/mcp.json`
 * (docs/memory.md Phase 4, "retrieve once per turn"; docs/prompt-cache.md Phase 4.7 C2 for why the block
 * is in the session rather than only in the request).
 *
 * Each turn asks the memory server what matches the prompt, and the answer is put in front of the model as
 * one durable session message: searched once per turn, one block per conversation, and the *same bytes* in
 * every later request (risk 2 stays; the turn-boundary re-payment C1 measured is what goes away). Two rules
 * keep risk 4 true — the digest gate says nothing when the same set of memories is already in this
 * conversation, and a superseded block is dropped from model context by a `context_edit` while its entry
 * stays in the file.
 *
 * It speaks MCP rather than opening the SQLite file, so the memory server stays the only writer
 * (risk 3). Saving stays the model's job: `memory_write` is declared to the model by mcp.json
 * (`exposure: "direct"`), and `memoryInstruction` below is what tells the model when to call that tool —
 * in the session prompt, once, not in the block it would otherwise have to re-send every turn
 * (docs/prompt-cache.md Phase 4.6 B).
 *
 * What happens after a turn is also this file's business, because this is the one place that knows what a
 * turn was shown: the citations are reported (`memory_cite`), the turn is recorded with what it retrieved
 * and what it cited (`memory_turn`, the hit-rate metrics in docs/memory.md Phase 4), and a fact the user
 * stated in their own words is captured without asking a model to notice it (src/memory/capture.ts).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHash } from "node:crypto";
import type { ExtensionContext, ExtensionFactory, McpServerEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { addUsage, emptyUsage, usageOf, type RenderedUsage } from "../shared/transcript.ts";
import { captureFromTurn, type ToolOutcome } from "./capture.ts";
import type { ReviewFork } from "./review.ts";

/**
 * The mcp.json entry flypi ships a template for, and the one `src/memory/mcp.ts` names itself.
 * A memory server under another name is still usable by the model — only the automatic search
 * follows this name, which keeps a second, unrelated MCP server from being searched every turn.
 */
export const RECALL_SERVER = "flypi-memory";

/**
 * The `customType` of the session entry a recalled block is persisted as (Phase 4.7 C2). It marks the block
 * in the transcript — risk 4's "tag the block" — and it is what the digest gate and the supersede pass look
 * for, including on a session reopened from its file, where nothing of the last process survived.
 */
export const RECALL_ENTRY = "flypi-memory-block";

/**
 * A block's set of memories as something comparable: sorted unique ids, so the same rows fetched in a
 * different order are one set (C1 measured a turn that did exactly that), and nothing about ranking, token
 * budgets or trimming leaks in. A new row, a retired row or a changed scope filter is a different digest.
 */
export function setDigest(ids: Iterable<number>): string {
	return createHash("sha256")
		.update([...new Set(ids)].sort((a, b) => a - b).join(","))
		.digest("hex")
		.slice(0, 16);
}

/** The bounds `memory_search` itself declares (src/memory/mcp.ts). */
const QUERY_CHARS = 500;
const MEMORY_ROWS = 8;
/** Hard cap on injected text; a memory is dropped whole, never cut mid-sentence. */
const MEMORY_TOKENS = 1200;
/** Failed memory calls one turn may make before the answer stops being worth retrying (docs/memory.md). */
const RETRY_CAP = 3;
/** The turn's own text, as far as the store's body limit (src/memory/mcp.ts). */
const TURN_CHARS = 8000;

/** pi's own tool naming for a connected server: `mcp__<server>__<tool>` (docs/mcp.md). */
export const memoryTool = (server: string, tool: string): string =>
	`mcp__${server.replace(/[^A-Za-z0-9_]/g, "_")}__${tool}`;

/**
 * The first `${NAME}` in an entry that this process does not have. pi expands these when it connects
 * (docs/mcp.md), and a name that is missing means the entry cannot authenticate: its tools never reach the
 * session. flypi has to know that, because the alternative is a prompt that orders the model to call
 * `mcp__flypi_memory__memory_write` — and a recall note that says "call memory_search yourself" — over a
 * server that was never connected and a `tool_search` that finds nothing (docs/risks.md risk 8).
 */
function unresolvedEnvName(entry: McpServerEntry): string | undefined {
	const config = entry.config as { url?: string; headers?: Record<string, string>; env?: Record<string, string> };
	for (const value of [config.url, ...Object.values(config.headers ?? {}), ...Object.values(config.env ?? {})]) {
		if (typeof value !== "string") continue;
		const name = [...value.matchAll(/\$\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]!).find((env) => !process.env[env]);
		if (name) return name;
	}
	return undefined;
}

/**
 * The server to search before the model runs: an enabled HTTP entry named `flypi-memory` that this process
 * can actually authenticate to. An entry pointing at an env var nobody exported is treated as no memory
 * server at all — the same thing a missing entry does (`src/agent/runtime.ts` builds the standing
 * instruction, the recall extension and the review fork from this one answer).
 */
export function recallServer(config: { servers: McpServerEntry[] }): McpServerEntry | undefined {
	return config.servers.find((server) => server.name === RECALL_SERVER && server.config.enabled !== false && !unresolvedEnvName(server));
}

/**
 * The standing memory instruction: when to write, when to supersede, and to cite as `#id`.
 *
 * It says the same thing on every turn, so it belongs in the prompt rather than in the block: the prompt is
 * byte-stable and sits at the front of every request, while the block exists only when a turn retrieved
 * something and changes whenever the retrieved set does (docs/prompt-cache.md Phase 4.6 B1/B2, and C2 made
 * the block a session entry, which does not make it a place to put a standing instruction — a constant inside
 * a per-turn message is re-sent or dropped by whatever the retrieval did). It stands on its own: "a memory
 * listed here" became "a memory you were given", since it is no longer inside the block it described.
 * Deliberately the same length as the sentence it replaces —
 * a move that made the prompt bigger than the block it trims would cost bytes on a route that re-pays the
 * whole prompt — and it never spells out the block's tag, which has to stay unique to the injected block so
 * the A3 prefix test can tell a leaked block from a sentence that merely mentions one. Built from the
 * server that is really configured, so a session with no memory server is never asked to call tools it does
 * not have (B1); `src/agent/runtime.ts` puts it in `appendSystemPrompt` under the same condition.
 */
export function memoryInstruction(serverName: string): string {
	const write = memoryTool(serverName, "memory_write");
	const supersede = memoryTool(serverName, "memory_supersede");
	return `When the user tells you to remember something, call ${write} with the one durable fact; call ${supersede} instead when a memory you were given is no longer true. Cite any memory you use as #id.`;
}

/**
 * `onInjected` hands the rendered block to the host as the turn starts. The debug panel asks what a turn was
 * really shown, and a turn that said nothing because of the digest gate has no block of its own — this is the
 * one place that knows the difference.
 *
 * `conversationId` is flypi's id for the conversation, which only the registry holds. Without it there is
 * no row to record a turn against, so the turn log and auto-capture stay off — a bare session (probe)
 * still gets its recall block.
 */
export function createMemoryRecallExtension(
	server: McpServerEntry | undefined,
	onInjected?: (block: string) => void,
	options: { conversationId?: string; review?: { interval: number; fork: ReviewFork } } = {},
): ExtensionFactory {
	return (pi) => {
		if (!server || server.config.enabled === false) return;
		/** The digest of the set this turn retrieved, "" when it retrieved none. `turn_end` uses it to tell
		 *  which block in the session is the current one. */
		let digest = "";
		/** What this turn's search could not do, in a sentence. Transient on purpose, and the only thing in the
		 *  prompt that still is: it is about this turn's call to the store, not a fact to keep (C2). */
		let note: string | null = null;
		/** Ids this turn was really shown — the block, or a memory tool result. A citation only counts for
		 *  one of these, so a number the model invented cannot inflate a count that means something. */
		const seen = new Set<number>();
		/** Failed memory-tool calls this turn. Reset per turn: last turn's failures are not this turn's. */
		let failures = 0;
		/** Ids already cited this turn, so a run that repeats itself cannot count a sentence twice. */
		const reported = new Set<number>();
		/** What the user asked, and what the turn's tools ran — the two inputs auto-capture reads. */
		let prompt = "";
		const tools: ToolOutcome[] = [];
		/** The model stored something itself this turn, so capturing the same instruction again is a copy. */
		let modelWroteMemory = false;
		/** One turn log per turn: a retried run re-ends the loop, and a second row would lie about the count. */
		let logged = false;
		/**
		 * Delivered answers this conversation has produced — what the review fork counts (Phase 4.8). Hydrated
		 * from the session file on reopen, so closing the tab or restarting the daemon does not restart the
		 * clock: the file already knows how many turns this conversation had.
		 */
		let delivered = 0;
		/** One fork at a time per conversation: a fast run of turns must not stack forks. */
		let reviewing = false;

		if (options.review) {
			pi.on("session_start", (_event, ctx) => {
				delivered = countUserTurns(ctx.sessionManager.getEntries());
			});
		}

		pi.on("before_agent_start", async (event, ctx) => {
			failures = 0;
			seen.clear();
			reported.clear();
			tools.length = 0;
			modelWroteMemory = false;
			logged = false;
			// pi 1.0.4 gave every run a `prompt`; 1.4.0 split the event in two — a submitted prompt carries
			// `prompt`, an idle `pi.sendMessage(…, { triggerTurn: true })` carries the custom message instead.
			// Retrieval asks with the user's own words, so a custom trigger clears the turn and searches nothing;
			// a *user* turn with empty text still searches, because the refusal is what tells the model recall
			// ran (risk 8). flypi sends no custom trigger-turn messages today.
			if (event.messageType === "custom") {
				prompt = "";
				return;
			}
			prompt = event.prompt;
			const outcome = await search(server, prompt);
			for (const row of outcome.rows) seen.add(row.id);
			onInjected?.(renderBlock(outcome));
			// A search that could not do all it was asked says so. When it brought rows with it the reason goes in
			// the block, because it qualifies those rows and is worth keeping with them; when it brought nothing the
			// reason is about this one call, so it rides on the newest user message for that turn only — which is
			// new content at the boundary anyway, so it costs the prefix nothing (risk 8, docs/prompt-cache.md C1).
			note = outcome.rows.length === 0 && outcome.note ? renderBlock({ rows: [], note: outcome.note }) : null;
			// A search that brought nothing back has nothing to keep, and takes nothing away: an outage is not a
			// reason to stop showing the model what an earlier turn found.
			digest = outcome.rows.length === 0 ? "" : setDigest(outcome.rows.map((row) => row.id));
			if (!digest) return;
			// The digest gate: this conversation already holds these memories, so say nothing. Saying the same set
			// twice is the duplication risk 4 is about, and it is what makes the bytes before a later turn stop
			// being the bytes a route has already read (docs/prompt-cache.md C1). The digest is the set of rows, not
			// the wording about how they were found: a turn that searched the same rows a weaker way does not get a
			// second copy of them to read.
			if (liveBlocks(ctx).some((entry) => entry.digest === digest)) return;
			// A message of its own, right after the user's, rather than part of the user's text: that is what makes
			// it carry through the next boundary. `display: false` says it is context, not something to show.
			return { message: { customType: RECALL_ENTRY, content: renderBlock(outcome), display: false, details: { digest } } };
		});

		/**
		 * The one thing that is still added at the last moment: what this turn's search could not do. It is not a
		 * memory, and it is not kept, so it never reaches the file — and a turn that had nothing to say about its
		 * own search pays nothing here.
		 */
		pi.on("context", (event) => {
			if (!note) return;
			const messages = [...event.messages];
			for (let i = messages.length - 1; i >= 0; i--) {
				const message = messages[i];
				if (!message || message.role !== "user") continue;
				const existing = typeof message.content === "string" ? [] : message.content;
				// Never twice in one turn: this handler re-runs on every model call of the turn, and risk 2 is
				// about a prompt that says the same thing once.
				if (existing[0]?.type === "text" && existing[0].text === note) return;
				const appended = { type: "text" as const, text: note };
				const content = typeof message.content === "string" ? [appended, { type: "text" as const, text: message.content }] : [appended, ...existing];
				messages[i] = { ...message, content };
				break;
			}
			return { messages };
		});

		/**
		 * A block belongs to the turn that retrieved it. Once this turn's block is in the conversation, any other
		 * one is superseded: `replacement: null` omits it from what the model is shown, while the entry and the
		 * edit both stay in the file, so what a turn was told remains readable history and the pair is auditable
		 * (docs/prompt-cache.md C2, risk 4). A turn that changed nothing appends nothing, and a turn that found
		 * nothing takes anything away: an outage is not a reason to stop showing the model what was already found.
		 */
		pi.on("turn_end", (_event, ctx) => {
			if (!digest) return;
			const stale = liveBlocks(ctx).filter((entry) => entry.digest !== digest);
			if (stale.length === 0) return;
			return { entries: stale.map((entry) => ({ type: "context_edit", targetId: entry.id, replacement: null })) };
		});

		/**
		 * A memory call that fails is the model's business for three tries, then it stops being one. The
		 * store is not going to come back mid-turn, and a fourth error costs a model call to learn it again,
		 * so the answer it gets names what is missing and tells it to carry on (docs/memory.md, retry cap).
		 * The rows this turn found stay in the text: the facts it already has are not lost with the call.
		 */
		pi.on("tool_result", (event) => {
			if (event.toolName.startsWith(memoryTool(server.name, ""))) {
				if (!event.isError) {
					// A row the model fetched for itself is exactly as citable as one it was handed.
					for (const id of idsIn(event.content)) seen.add(id);
					// A write it made itself is a fact it already kept. Capturing the same instruction again would
					// be a second copy, and the near-duplicate gate is not reliable enough to be trusted with it.
					const stored = memoryTool(server.name, "memory_write");
					const replaced = memoryTool(server.name, "memory_supersede");
					if (event.toolName === stored || event.toolName === replaced) modelWroteMemory = true;
					return;
				}
				failures += 1;
				if (failures <= RETRY_CAP) return;
				return {
					content: [
						{
							type: "text" as const,
							text: `${event.toolName} has failed ${failures} times this turn; the store is unchanged. ${
								seen.size ? `The memories you were given are ${[...seen].map((id) => `#${id}`).join(", ")} — use or cite those.` : "No memories were found for this turn."
							} Leave memory unchanged and continue your reply.`,
						},
					],
				};
			}
			// A command that failed, followed by one that worked, is the one fact worth keeping about a tool
			// call — and it is only knowable while the turn is still running (src/memory/capture.ts).
			const command = typeof event.input?.command === "string" ? event.input.command : undefined;
			if (command) tools.push({ name: event.toolName, command, isError: event.isError });
		});

		/**
		 * A citation is the model writing `#id` about a row it was shown. Its own words are what is read —
		 * not its tool calls, which would be the model grading itself — and the count only moves for rows it
		 * actually had, so `cited_count` keeps meaning "this fact earned its place" (docs/memory.md).
		 */
		pi.on("agent_end", async (event, ctx) => {
			const quoted = new Set<number>();
			const answer: string[] = [];
			for (const message of event.messages) {
				if (message.role !== "assistant") continue;
				for (const part of Array.isArray(message.content) ? message.content : []) {
					if (typeof part !== "object" || part === null) continue;
					const textPart = part as { type?: unknown; text?: unknown };
					if (textPart.type !== "text" || typeof textPart.text !== "string") continue;
					answer.push(textPart.text);
					for (const match of textPart.text.matchAll(/#(\d+)\b/g)) quoted.add(Number(match[1]));
				}
			}
			// Only ids this turn was really shown, and only once each: a retried run re-emits the answer it
			// already gave, and one sentence citing a row twice is one citation.
			const ids = [...quoted].filter((id) => seen.has(id) && !reported.has(id));
			if (ids.length > 0) {
				for (const id of ids) reported.add(id);
				await call(server, "memory_cite", { ids });
			}

			// Auto-capture, and only after the model had its chance: this is for the fact the user handed over
			// that no tool call was made about, not a second copy of what the model just stored.
			if (!modelWroteMemory) {
				for (const fact of captureFromTurn(prompt, tools)) {
					// The user's own words go to `memory_capture`, the mount's only path to `owner`; something the
					// agent watched happen is the agent's, and goes through the ordinary write tool.
					const args = { body: fact.body, kind: fact.kind, reason: "captured from this turn by flypi" };
					await call(server, fact.origin === "owner" ? "memory_capture" : "memory_write", args);
				}
			}

			// The turn log: what this turn was shown against what it actually cited. That pair is the only way
			// the hit-rate metrics exist (docs/memory.md Phase 4), and one row per turn is what makes a rate
			// mean anything.
			if (options.conversationId && !logged) {
				logged = true;
				// The turn's own numbers, read off what the provider answered with (docs/prompt-cache.md A1).
				// Nothing else can report them: a model was never told its cache hit rate. A turn the provider
				// gave no numbers for records no usage at all — the absence has to stay visible.
				const usage = turnUsage(event.messages);
				await call(server, "memory_turn", {
					conversation_id: options.conversationId,
					user_text: prompt.slice(0, TURN_CHARS),
					assistant_text: answer.join("\n").slice(0, TURN_CHARS),
					retrieved: [...seen],
					cited: ids,
					...(usage ? { usage } : {}),
				});
			}

			/**
			 * The review fork (docs/memory.md Phase 4.8), last: the answer is delivered and reported, and the
			 * fork runs detached, so nothing here waits for it. It counts only answers really delivered — an
			 * aborted or errored turn is not one to learn from. A probe, a daemon job, a subagent and a fork
			 * itself never reach here: they are created with no review runner at all.
			 */
			const review = options.review;
			if (!review || reviewing || !answerDelivered(event.messages)) return;
			delivered += 1;
			if (review.interval <= 0 || delivered % review.interval !== 0) return;
			reviewing = true;
			// Fire and forget: a fork that could not run is a fact not saved, not an error in the conversation
			// somebody is reading — and an unhandled rejection there would take the process down over it.
			void review
				.fork({ entries: ctx.sessionManager.getEntries() })
				.catch(() => undefined)
				.finally(() => {
					reviewing = false;
				});
		});
	};
}

/**
 * How many turns this conversation has asked for an answer. The recall block is a `custom_message`, not a
 * user message, so it is not counted; a reopened session counts exactly what it was told before, which is the
 * point — the fork's clock belongs to the conversation, not to the process that ran it.
 */
function countUserTurns(entries: SessionEntry[]): number {
	return entries.filter((entry) => entry.type === "message" && entry.message.role === "user").length;
}

/**
 * Whether this turn ended with an answer. pi derives the run's outcome from the last assistant message's
 * `stopReason`, and `agent_end` fires before the final `turn_end` boundary, so the messages are the only
 * place that knows it in time: an aborted run's last assistant message says `aborted`, and a run that never
 * reached one produced no answer to learn from either.
 */
function answerDelivered(messages: unknown[]): boolean {
	const last = [...messages].reverse().find((message) => (message as { role?: string }).role === "assistant");
	if (!last) return false;
	const stopReason = (last as { stopReason?: string }).stopReason;
	return stopReason !== "aborted" && stopReason !== "error";
}

/**
 * The provider's own numbers for one turn, summed across its model calls. `usageOf`/`addUsage` are the
 * same functions the chat UI uses to print "N cached", so a `turns` row and the number on screen are one
 * accounting and not two (docs/prompt-cache.md Phase 4.6 A1). Messages with no usage (the user's, tool
 * results) carry no numbers and add nothing.
 *
 * Null when the provider reported nothing at all — a route with `supportsUsageInStreaming: false`, or a
 * turn that never reached a model. Storing zeros there would read back as a turn that cost nothing, which
 * is the lie the column exists to avoid; the absence of a number has to stay visible.
 */
export function turnUsage(messages: unknown[]): RenderedUsage | null {
	let total = emptyUsage();
	let reported = false;
	for (const message of messages) {
		const usage = usageOf((message as { usage?: unknown })?.usage);
		if (!usage) continue;
		reported = true;
		total = addUsage(total, usage);
	}
	return reported ? total : null;
}

interface MemoryRow {
	id: number;
	kind: string;
	body: string;
}

interface SearchOutcome {
	rows: MemoryRow[];
	/** Why there is nothing to show: keyword-only, unreachable server. Never left silent (risk 8). */
	note?: string;
}

/**
 * The recall blocks this conversation is being shown right now. The session projection has already dropped
 * anything a `context_edit` omitted, so an entry here is in front of the model — which is what the digest gate
 * and the supersede pass need. Reading the session rather than remembering anything is what makes a session
 * reopened from its file behave like the same conversation: it still has the memories it was already given.
 */
function liveBlocks(ctx: ExtensionContext): { id: string; digest: string }[] {
	return ctx.sessionManager.buildSessionProjection().entries.flatMap((entry) => {
		const source = entry.sourceEntry;
		if (source.type !== "custom_message" || source.customType !== RECALL_ENTRY || entry.messages.length === 0) return [];
		return [{ id: source.id, digest: String((source.details as { digest?: string } | undefined)?.digest ?? "") }];
	});
}

/**
 * Connect, search, close. The memory server is stateless per request (src/memory/mcp.ts), so there is
 * no connection worth keeping across a turn and nothing to release on session shutdown.
 */
async function search(server: McpServerEntry, prompt: string): Promise<SearchOutcome> {
	if (!("url" in server.config)) {
		return { rows: [], note: `${server.name} is not an HTTP server, so flypi cannot search it before the model runs` };
	}
	const client = new Client({ name: "flypi-recall", version: "0.0.0" });
	try {
		await client.connect(
			new StreamableHTTPClientTransport(new URL(server.config.url), { requestInit: { headers: headersOf(server) } }),
		);
		const result = await client.callTool({
			name: "memory_search",
			arguments: {
				query: prompt.slice(0, QUERY_CHARS),
				limit: MEMORY_ROWS,
				max_tokens: MEMORY_TOKENS,
				// Only what the store trusts enough to be said without being asked for: facts the user stated
				// or this agent wrote. Everything else the model can still find by searching for itself.
				injectable_only: true,
			},
		});
		if (result.isError) return { rows: [], note: text(result.content) };
		const payload = JSON.parse(text(result.content) || "{}") as { results?: MemoryRow[]; partial?: boolean; note?: string };
		// `partial` means the vector half did not run; keyword hits are still shown, but never as if they
		// were the whole answer (risk 8).
		const note = payload.note ?? (payload.partial ? "keyword-only: the query could not be embedded" : undefined);
		return { rows: payload.results ?? [], ...(note ? { note } : {}) };
	} catch (error) {
		return { rows: [], note: `${(error as Error).message} — call ${memoryTool(server.name, "memory_search")} yourself` };
	} finally {
		await client.close().catch(() => undefined);
	}
}

const text = (content: unknown): string =>
	(Array.isArray(content) ? content : [])
		.filter((block): block is { type: string; text: string } => typeof block === "object" && block !== null && block.type === "text")
		.map((block) => block.text)
		.join("");

/**
 * The ids a successful memory tool result put in front of the model. The two shapes it knows are read
 * explicitly rather than any JSON with an `id` in it, so a write's row id never enters the citable set.
 */
function idsIn(content: unknown): number[] {
	try {
		const payload = JSON.parse(text(content) || "{}") as { results?: { id: number }[]; memory?: { id: number } };
		return [...(payload.results ?? []).map((row) => row.id), ...(payload.memory ? [payload.memory.id] : [])].filter(
			(id) => Number.isInteger(id),
		);
	} catch {
		return [];
	}
}

/**
 * A memory call whose answer nobody reads. A citation, a capture or a turn log that failed to record is a
 * metric missing a data point, not something to tell the model, and the next turn that reports will try
 * again. One client per call, because the memory server is stateless per request (src/memory/mcp.ts).
 */
async function call(server: McpServerEntry, tool: string, args: unknown): Promise<void> {
	if (!("url" in server.config)) return;
	const client = new Client({ name: "flypi-recall", version: "0.0.0" });
	try {
		await client.connect(new StreamableHTTPClientTransport(new URL(server.config.url), { requestInit: { headers: headersOf(server) } }));
		await client.callTool({ name: tool, arguments: args as Record<string, unknown> });
	} catch {
		// ignored: see above
	} finally {
		await client.close().catch(() => undefined);
	}
}

/**
 * pi expands `${NAME}` in headers itself when it connects (docs/mcp.md); this is a second client, so it
 * does the same. shortcut: no `!command` header values here, add them if an entry ever uses one.
 */
function headersOf(server: McpServerEntry): Record<string, string> {
	const raw = "headers" in server.config ? server.config.headers : undefined;
	return Object.fromEntries(
		Object.entries(raw ?? {}).map(([name, value]) => [
			name,
			value.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_, env: string) => process.env[env] ?? ""),
		]),
	);
}

/**
 * What one turn was shown: tags, the rows, and why if the search was degraded (risk 8). No instruction —
 * that is `memoryInstruction` in the prompt now, and its bytes were otherwise re-paid every turn
 * (docs/prompt-cache.md Phase 4.6 B3).
 */
function renderBlock({ rows, note }: SearchOutcome): string {
	return [
		"<relevant_memories>",
		...(note ? [`Memory search: ${note}`] : []),
		...rows.map((row) => `#${row.id} (${row.kind}): ${row.body}`),
		"</relevant_memories>",
	].join("\n");
}
