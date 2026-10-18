/**
 * One `AgentSession` per conversationId (docs/architecture.md Phase 1).
 *
 * The registry owns lifecycle and the event fan-out; the WS layer never touches a session.
 * Sessions keep running with no client attached — the event log is per conversation, not per
 * socket, so a closed tab loses nothing. Phase 4.5 widens this (daemon, `runs` table); the
 * rule that matters already lives here: **a session whose turn is still running is never
 * evicted** — `session.isIdle` covers runs, compaction, retries and queued work.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SessionManager, type AgentSessionEvent, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { flypiPaths, type FlypiPaths } from "../agent/paths.ts";
import { applyConfigEdits, readConfig, type ConfigEdits } from "../agent/config-files.ts";
import { applyPackageEdits, readPackages, type PackageEdits } from "../agent/packages.ts";
import { createFlypiSession, type FlypiModel, type FlypiSession, type FlypiThinkingLevel } from "../agent/runtime.ts";
import { mcpStatus } from "../agent/mcp-status.ts";
import { signIn as startMcpSignIn, submitRedirect as submitMcpRedirect } from "../agent/mcp-signin.ts";
import { redactSecrets } from "../secrets/redact.ts";
import type { SecretStore } from "../secrets/vault.ts";
import { isImage, type FlypiAttachment } from "../shared/attachments.ts";
import { EventLog } from "./event-log.ts";
import { createExtensionUiBridge } from "./extension-ui.ts";
import type { CommandRow, DebugInfo, ExtensionUiFrame, SessionSummary, ConfigSnapshot, McpStatusSnapshot, PackagesSnapshot } from "./protocol.ts";
import type { FlypiMessage } from "../shared/transcript.ts";

export type EventListener = (seq: number, event: AgentSessionEvent) => void;
/** What an extension said to the user (`src/server/extension-ui.ts`) — a second channel, not a pi event. */
export type ExtensionUiListener = (frame: ExtensionUiFrame) => void;
/** Supplies the session for a conversation: production uses `createFlypiSession`, tests use the stub model. */
export type CreateSession = (options: {
	sessionManager: SessionManager;
	/** flypi's conversation id. It is the key the memory store records turns under, so the session factory
	 *  has to pass it down (docs/memory.md Phase 4). */
	conversationId: string;
	/** Report the memory block the turn injected, so `debugInfo` can show it. */
	onMemoryBlock: (block: string) => void;
	/**
	 * What `ctx.ui` does for this conversation. It has to reach `bindExtensions` — pi binds the UI once, at
	 * `session_start`, and binding twice would reconnect every MCP server.
	 */
	extensionUi: ExtensionUIContext;
}) => Promise<FlypiSession>;

export interface Conversation {
	readonly id: string;
	readonly log: EventLog<AgentSessionEvent>;
	readonly listeners: Set<EventListener>;
	session: FlypiSession;
	/**
	 * The seq each message arrived on, for the whole life of the conversation — the log ring drops old
	 * events, a message on screen never stops being forkable. The value is pi's own message object, not
	 * a copy, which is what lets `fork()` find the session entry behind it.
	 */
	messages: Map<number, FlypiMessage>;
	/**
	 * The `<relevant_memories>` block the last turn actually put in front of the model, or null when it put none
	 * there. Held in a mutable box because the callback that fills it is handed to the session factory before
	 * this object exists. The block itself is a session entry since Phase 4.7 C2; this is only how the debug
	 * panel learns what the turn it is showing was given, including a note that was never persisted.
	 */
	memory: { block: string | null };
	/**
	 * The conversation's extension UI bridge: `ctx.ui.notify/select/confirm/input` reach the page through it,
	 * and it holds the dialogs still waiting for an answer. It outlives the session — `switchSession` binds a
	 * new session to the same bridge, so a dialog survives the chat being reopened.
	 */
	extensionUi: ReturnType<typeof createExtensionUiBridge>;
	/** Sockets watching this conversation's extension output. Detached with the socket, like event listeners. */
	uiListeners: Set<ExtensionUiListener>;
	unsubscribe: () => void;
	lastSettledAt: number;
	disposed: boolean;
}

export interface SessionRegistryOptions {
	root: string;
	createSession?: CreateSession;
	/** Evict conversations idle for this long with no client attached. */
	idleTtlMs?: number;
	logCapacity?: number;
	now?: () => number;
	/**
	 * Turn lifecycle, for the daemon's `runs` record (docs/architecture.md Phase 4.5): "a turn was running
	 * when this process went away" is only knowable across processes if it is on disk. Absent means no
	 * record is kept — a bare `npm run serve` has no memory store to write one to.
	 */
	onRunStatus?: (conversationId: string, status: "running" | "idle" | "aborted", info: { seq: number; sessionFile?: string }) => void;
	/**
	 * The vault, when this process opened one (docs/secrets.md Phase 5.5). Every conversation then gets the
	 * secret tools and the redaction; without it the sessions have neither, which is the honest state of a
	 * process that does not hold the vault's key.
	 */
	vault?: SecretStore;
}

const DEFAULT_IDLE_TTL_MS = 15 * 60 * 1000;

export class SessionRegistry {
	private readonly conversations = new Map<string, Conversation>();
	private readonly paths: FlypiPaths;
	private readonly createSession: CreateSession;
	private readonly idleTtlMs: number;
	private readonly now: () => number;
	private readonly onRunStatus: SessionRegistryOptions["onRunStatus"];

	constructor(private readonly options: SessionRegistryOptions) {
		this.paths = flypiPaths(options.root);
		this.createSession =
			options.createSession ??
			(({ sessionManager, conversationId, onMemoryBlock }) =>
				createFlypiSession({ root: options.root, sessionManager, conversationId, onMemoryBlock, vault: options.vault, review: true }).then((r) => r.session));
		this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
		this.now = options.now ?? Date.now;
		this.onRunStatus = options.onRunStatus;
	}

	get size(): number {
		return this.conversations.size;
	}

	async create(): Promise<Conversation> {
		return this.bind(
			SessionManager.create(this.paths.root, this.paths.sessionsDir),
		);
	}

	/** Rebind a conversation to an existing session file. The conversationId — what the client holds — does not change. */
	async switchSession(conversationId: string, sessionPath: string): Promise<Conversation> {
		const conversation = this.get(conversationId);
		const target = this.sessionFileIn(sessionPath);
		this.teardown(conversation);
		conversation.session = await this.createSession({
			sessionManager: SessionManager.open(target, this.paths.sessionsDir),
			conversationId,
			onMemoryBlock: (block) => (conversation.memory.block = block),
			extensionUi: conversation.extensionUi.uiContext,
		});
		conversation.memory.block = null;
		this.watch(conversation);
		// The transcript a client is looking at becomes the opened session's, from the start — so the
		// log restarts and the seed above is the whole of it. The client re-reads it with `resume`.
		conversation.log.reset();
		this.seedHistory(conversation);
		return conversation;
	}

	/**
	 * Branch a conversation's session at one of its answers into a new conversation. The new session
	 * holds the path to that message and nothing after it; the source keeps running untouched.
	 *
	 * Two pi behaviours do the work, relied on rather than reinvented: the message objects in session
	 * entries are the same objects the events carried, so identity finds the entry; and
	 * `createBranchedSession()` moves the `SessionManager` it runs onto the new file, so it runs here on
	 * a throwaway opened from the file, never on the live session.
	 */
	async fork(conversationId: string, messageSeq: number): Promise<Conversation> {
		const source = this.get(conversationId);
		if (!source.session.sessionFile) throw new Error(`conversation ${conversationId} has no persisted session to fork`);
		const message = source.messages.get(messageSeq);
		if (!message) throw new Error(`conversation ${conversationId} has no message at seq ${messageSeq}`);
		const role = (message as { role?: string }).role;
		if (role !== "assistant") throw new Error(`a fork starts from an answer, not from a ${role ?? "non"} message`);
		const entry = source.session.sessionManager.getBranch().find((candidate) => candidate.type === "message" && candidate.message === message);
		if (!entry) throw new Error(`the message at seq ${messageSeq} is not in ${source.session.sessionFile}`);
		const branch = SessionManager.open(source.session.sessionFile, this.paths.sessionsDir);
		if (!branch.createBranchedSession(entry.id)) throw new Error(`forking ${source.session.sessionFile} at ${entry.id} wrote no session file`);
		return this.bind(branch);
	}

	get(conversationId: string): Conversation {
		const conversation = this.conversations.get(conversationId);
		if (!conversation) throw new Error(`unknown conversation ${conversationId}`);
		return conversation;
	}

	log(conversationId: string): EventLog<AgentSessionEvent> {
		return this.get(conversationId).log;
	}

	prompt(conversationId: string, text: string, mode?: "steer" | "followUp", attachments: FlypiAttachment[] = []): Promise<void> {
		// Images are the model's input; any other file is written to disk and named by path, so the agent
		// opens it with its own tools. flypi never decides what a PDF or a spreadsheet contains.
		const images = attachments.filter(isImage).map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType }));
		const files = attachments.filter((attachment) => !isImage(attachment)).map((attachment) => this.saveUpload(attachment));
		const body = [text.trim(), ...files.map((path) => `[attached file: ${path}]`)].filter(Boolean).join("\n");
		if (!body && images.length === 0) throw new Error("a prompt needs text or an attachment");
		// A new turn has not injected anything yet: the panel must not show last turn's block as this one's.
		this.get(conversationId).memory.block = null;
		// The daemon needs to know a turn is in flight before the first event of it can fire: a process that
		// dies mid-turn leaves the row `running`, and that is what a restart reconciles (Phase 4.5). pi's
		// `preflightResult` is where that is knowable — it fires once the run's messages are prepared, before
		// its first request and before any event — and it answers "handled" for input that starts no run at
		// all, which is what an extension command is, and what a refused prompt is.
		// No mode + already streaming ⇒ pi rejects rather than guessing. That rejection is the error frame.
		return this.get(conversationId).session.prompt(body, {
			...(images.length ? { images } : {}),
			...(mode ? { streamingBehavior: mode } : {}),
			preflightResult: (disposition) => {
				if (disposition !== "handled") this.markRun(conversationId, "running");
			},
		});
	}

	/**
	 * A pasted non-image file, kept where the agent can reach it. The name the user pasted it under is
	 * kept (it is what they recognise) but never allowed to choose the directory.
	 * shortcut: nothing prunes .flypi/uploads; add an age sweep to the daemon if it ever grows (Phase 4.5).
	 */
	private saveUpload(attachment: FlypiAttachment): string {
		mkdirSync(this.paths.uploadsDir, { recursive: true });
		const name = attachment.name.replace(/[^\w.-]/g, "_").slice(0, 100) || "file";
		const path = join(this.paths.uploadsDir, `${randomUUID()}-${name}`);
		writeFileSync(path, Buffer.from(attachment.data, "base64"));
		return path;
	}

	abort(conversationId: string): Promise<void> {
		// Recorded before the abort lands: if the process dies on the way, the row says why the turn stopped.
		this.markRun(conversationId, "aborted");
		return this.get(conversationId).session.abort();
	}

	async setModel(conversationId: string, provider: string, modelId: string): Promise<void> {
		const session = this.get(conversationId).session;
		const model: FlypiModel | undefined = session.modelRuntime.getModel(provider, modelId);
		if (!model) throw new Error(`model ${provider}/${modelId} is not available`);
		await session.setModel(model);
	}

	setThinkingLevel(conversationId: string, level: FlypiThinkingLevel): void {
		this.get(conversationId).session.setThinkingLevel(level);
	}

	/**
	 * The session files flypi owns, for the sidebar's list. pi's own list, so flypi keeps no second index
	 * of conversations (docs/decisions.md: one source of truth) — which is also why a chat you have only
	 * started, with nothing written, has no row: pi creates the file on its first entry.
	 */
	async listSessions(): Promise<SessionSummary[]> {
		const sessions = await SessionManager.list(this.paths.root, this.paths.sessionsDir);
		return sessions.map((session) => ({
			path: session.path,
			...(session.name ? { name: session.name } : {}),
			modified: session.modified.toISOString(),
			messageCount: session.messageCount,
			firstMessage: session.firstMessage,
		}));
	}

	/** Rename = pi's own session name, so the TUI and the web UI show the same thing. */
	rename(conversationId: string, name: string): void {
		this.get(conversationId).session.setSessionName(name);
	}

	/**
	 * Delete a session file for good. Anything that was showing it goes first: pi appends lazily, so a
	 * live session bound to a deleted file would write it back and the row would come straight back.
	 * A turn still running is refused rather than cut short — that work would be lost silently.
	 * ponytail: one user, one browser. Another tab holding the same session loses its conversation id
	 * when this runs; if tabs ever share the server, tell them over the socket instead.
	 */
	async deleteSession(sessionPath: string): Promise<void> {
		const target = this.sessionFileIn(sessionPath);
		for (const conversation of this.conversations.values()) {
			if (conversation.session.sessionFile !== target) continue;
			if (!conversation.session.isIdle) throw new Error(`session ${target} is mid-turn; abort it first`);
			this.teardown(conversation);
			this.conversations.delete(conversation.id);
		}
		rmSync(target); // no force: a file that is not there is an error frame, not a silent success
	}

	/**
	 * The config files the settings panel edits — the agent dir's `models.json` and `mcp.json`, read through
	 * flypi's own paths so the panel can never reach the host `~/.pi` (risk 1). Not conversation-scoped:
	 * a conversation already holds the model runtime it started with, and a new one reads the new files.
	 */
	configSnapshot(): ConfigSnapshot {
		return readConfig(this.paths);
	}

	/** Apply the panel's edits and hand back the refreshed files, so the panel shows what is on disk. */
	saveConfig(edits: ConfigEdits): ConfigSnapshot {
		applyConfigEdits(this.paths, edits);
		return readConfig(this.paths);
	}

	/**
	 * The extension packages `.flypi/agent/settings.json` declares (src/agent/packages.ts). Not
	 * conversation-scoped: the list is the agent dir's, and what a conversation holds is the set of extensions
	 * it loaded when it started — which `applyPackages` replaces, below.
	 */
	packages(): PackagesSnapshot {
		return readPackages(this.paths);
	}

	/**
	 * Install, remove or update a package, then put the new set into the conversations that are open, so the
	 * tool someone just installed is in the chat in front of them and not only in the next one. A turn in
	 * flight is never reloaded — that conversation keeps the extensions it started the turn with.
	 */
	async applyPackages(edits: PackageEdits): Promise<PackagesSnapshot> {
		const snapshot = await applyPackageEdits(this.paths, edits);
		await this.reloadExtensions();
		return snapshot;
	}

	/**
	 * Re-run each idle conversation's extensions against the packages on disk now. `reload()` swaps the extension
	 * runtime but does not re-emit `session_start` for a headless session, and that event is what connects the
	 * MCP servers — so without the `bindExtensions` that follows, reloading for an extension would silently drop
	 * every MCP tool the conversation had (tests/agent/packages.test.ts).
	 */
	async reloadExtensions(): Promise<void> {
		for (const conversation of this.conversations.values()) {
			if (!conversation.session.isIdle) continue;
			try {
				await conversation.session.reload();
				await conversation.session.bindExtensions({});
			} catch (error) {
				// The package is installed either way; a conversation that could not reload keeps the set it has.
				console.error(`flypi: conversation ${conversation.id} kept its old extensions: ${(error as Error).message}`);
			}
		}
	}

	/**
	 * The MCP servers asked directly whether they are up, for the settings view (src/agent/mcp-status.ts).
	 * Deliberately not the registry's own sessions: a running conversation holds the connections it made when
	 * it started, and the question the panel answers is whether a server named in the file answers now.
	 */
	mcpStatus(): Promise<McpStatusSnapshot> {
		return mcpStatus(this.paths);
	}

	/**
	 * Start an OAuth sign-in for one configured server (docs/architecture.md Phase 5, risk 5): the URL goes out
	 * through `onAuthorizationUrl` as an `mcpAuth` frame, the redirect comes back on `submitRedirect`, and the
	 * returned promise settles when the tokens are stored. Not a conversation's business — the next conversation
	 * is the one that gets the connection.
	 */
	mcpSignIn(name: string, onAuthorizationUrl: (url: string) => void): Promise<void> {
		return startMcpSignIn(this.paths, name, onAuthorizationUrl);
	}

	/** The pasted redirect URL. False when no sign-in is waiting for that name, which the WS layer reports. */
	submitMcpRedirect(name: string, redirectUrl: string): boolean {
		return submitMcpRedirect(name, redirectUrl);
	}

	/**
	 * Every path a client names must be one of flypi's own session files, never something it guessed. A bare
	 * file name — the address bar's `/sessions/<id>` (ui/lib/route.ts) — is resolved inside the sessions dir;
	 * `resolve` and the check below are what keep `..` from getting out of it.
	 */
	private sessionFileIn(sessionPath: string): string {
		const target = resolve(sessionPath.includes("/") ? sessionPath : join(this.paths.sessionsDir, sessionPath));
		if (!target.startsWith(`${this.paths.sessionsDir}/`)) {
			throw new Error(`session file ${target} is not inside ${this.paths.sessionsDir}`);
		}
		return target;
	}

	/**
	 * What the debug panel shows, and what the sidebar's selectors list. `memoryBlock` is the block the
	 * last turn actually injected (not what a recall would return now), or null when no turn injected one.
	 *
	 * `models` is deliberately pi's *available* set, not its catalog: the built-in catalog is ~1.5k
	 * models across 43 providers, and every one you have not configured a credential for is noise.
	 * The session's current model is reported whether or not its provider is available, so the
	 * selector can still show what you are actually running.
	 */
	async debugInfo(conversationId: string): Promise<DebugInfo> {
		const session = this.get(conversationId).session;
		const runtime = session.modelRuntime;
		const model = session.model;
		const context = session.getContextUsage();
		const configured = await Promise.all(
			runtime.getProviders().map(async (provider) => (await runtime.getAvailable(provider.id)).map((m) => ({ provider: provider.id, modelId: m.id, input: m.input ?? [] }))),
		);
		return {
			systemPrompt: session.systemPrompt,
			activeTools: session.getActiveToolNames(),
			models: configured.flat(),
			...(model ? { model: { provider: model.provider, modelId: model.id, input: model.input ?? [] } } : {}),
			thinkingLevel: session.thinkingLevel,
			...(session.sessionName ? { sessionName: session.sessionName } : {}),
			// The chat's context gauge reads pi's estimate rather than a second accounting of the context.
			...(context ? { context } : {}),
			memoryBlock: this.get(conversationId).memory.block,
			commands: commandsOf(session),
		};
	}

	/** Live events for one socket. Detach it when the socket closes. */
	attach(conversationId: string, listener: EventListener): () => void {
		const conversation = this.get(conversationId);
		conversation.listeners.add(listener);
		return () => conversation.listeners.delete(listener);
	}

	/** The same for what extensions say to the user. Detached with the socket, like the event listener. */
	attachUi(conversationId: string, listener: ExtensionUiListener): () => void {
		const conversation = this.get(conversationId);
		conversation.uiListeners.add(listener);
		return () => conversation.uiListeners.delete(listener);
	}

	/**
	 * The page answered an extension's question. False when nothing is waiting on that id — it timed out, or
	 * another tab got there first — which is what tells the chat to stop showing the dialog.
	 */
	replyExtension(conversationId: string, dialogId: string, value: string | null): boolean {
		return this.get(conversationId).extensionUi.reply(dialogId, value);
	}

	/**
	 * Evict conversations that have been idle for `idleTtlMs` with no client. A running turn
	 * is never evicted, and `teardown()` makes dispose exactly-once.
	 */
	evictIdle(): string[] {
		const now = this.now();
		const evicted: string[] = [];
		for (const conversation of [...this.conversations.values()]) {
			if (conversation.listeners.size > 0 || !conversation.session.isIdle) continue;
			if (now - conversation.lastSettledAt < this.idleTtlMs) continue;
			this.teardown(conversation);
			this.conversations.delete(conversation.id);
			evicted.push(conversation.id);
		}
		return evicted;
	}

	dispose(): void {
		for (const conversation of this.conversations.values()) this.teardown(conversation);
		this.conversations.clear();
	}

	private async bind(sessionManager: SessionManager): Promise<Conversation> {
		const id = randomUUID();
		const memory = { block: null as string | null };
		const uiListeners = new Set<ExtensionUiListener>();
		const extensionUi = createExtensionUiBridge((frame) => {
			for (const listener of uiListeners) listener({ type: "extensionUi", conversationId: id, ...frame });
		});
		const conversation: Conversation = {
			id,
			log: new EventLog<AgentSessionEvent>(this.options.logCapacity),
			listeners: new Set(),
			messages: new Map(),
			session: await this.createSession({
				sessionManager,
				conversationId: id,
				onMemoryBlock: (block) => (memory.block = block),
				extensionUi: extensionUi.uiContext,
			}),
			extensionUi,
			uiListeners,
			memory,
			unsubscribe: () => {},
			lastSettledAt: this.now(),
			disposed: false,
		};
		this.conversations.set(conversation.id, conversation);
		this.watch(conversation);
		this.seedHistory(conversation);
		return conversation;
	}

	/**
	 * pi loads a session's history into the session but does not re-emit it as events, so flypi seeds
	 * it into the conversation's event log. That keeps one kind of transcript source: a new, reopened
	 * or forked conversation all reach the UI the same way, through `resume`.
	 * ponytail: turn boundaries are not replayed, so a reopened conversation's "current turn" usage
	 * covers its whole history. Emit synthetic turn frames if the sidebar ever needs it per turn.
	 */
	private seedHistory(conversation: Conversation): void {
		for (const message of conversation.session.messages) {
			const buffered = conversation.log.push({ type: "message_end", message } as AgentSessionEvent);
			conversation.messages.set(buffered.seq, message);
		}
	}

	/**
	 * The last-resort filter on the live stream (docs/secrets.md Phase 5.5). The `message_end` hook in
	 * `src/secrets/extension.ts` is what keeps the session file clean, but the UI renders the frames that
	 * arrive *before* that, and whatever is pushed here is what a reconnect replays — so a value the model
	 * repeats would be on screen for a second and in the replay log for the life of the conversation.
	 *
	 * Every text field of the frame is rewritten, not just the one the reducer reads: the frame also carries
	 * pi's in-progress `message`, the finished block at `text_end.content` and this chunk's `delta`, and a
	 * value left in any of those is a copy of it sitting in the browser. The partials are the accumulated text,
	 * which is why the filter reads them rather than the deltas: a value split across two chunks is caught as
	 * soon as its last piece lands. The gap that stays open is the part of the value that has not streamed yet,
	 * and the Secrets view says so.
	 *
	 * The rewrite also *copies*. pi grows one mutable message object across the whole turn and hands every frame
	 * the same reference, so a frame that was filtered while its text was still short would later be read back
	 * from the log holding the finished value — which is exactly what a reconnect replays.
	 *
	 * shortcut: re-snapshots the partial on every delta, so a long streamed answer costs one copy per chunk; if
	 * that ever shows up in the timings, copy only from the last text block onwards.
	 */
	private redactStream(event: AgentSessionEvent): AgentSessionEvent {
		if (event.type !== "message_update") return event;
		const streamed = event.assistantMessageEvent;
		// A streamed frame carries the in-progress `partial`; pi's own `done`/`error` frame carries the finished
		// `message` under that key instead. Both are copies of the same mutable object, so both are rewritten.
		const partial = "partial" in streamed ? { partial: redactText(streamed.partial) } : {};
		// `text_end`/`thinking_end` carry their block as one string, and `*_delta` carries a chunk: a chunk that
		// happens to hold a whole value would otherwise be the one place it survives the frame.
		const text = "content" in streamed ? { content: redactSecrets(streamed.content) } : {};
		const delta = "delta" in streamed ? { delta: redactSecrets(streamed.delta) } : {};
		return {
			...event,
			message: redactText(event.message),
			assistantMessageEvent: { ...streamed, ...partial, ...text, ...delta },
		} as AgentSessionEvent;
	}

	/** The one subscription per conversation: sequence, record, fan out. */
	private watch(conversation: Conversation): void {
		conversation.unsubscribe = conversation.session.subscribe((raw) => {
			const event = this.redactStream(raw);
			if (event.type === "agent_settled") {
				conversation.lastSettledAt = this.now();
				this.markRun(conversation.id, "idle");
			}
			const buffered = conversation.log.push(event);
			if (event.type === "message_end") conversation.messages.set(buffered.seq, event.message);
			for (const listener of conversation.listeners) listener(buffered.seq, event);
		});
	}

	/** Write the run row, when anything is listening for it. Never lets bookkeeping break a turn. */
	private markRun(conversationId: string, status: "running" | "idle" | "aborted"): void {
		if (!this.onRunStatus) return;
		const conversation = this.conversations.get(conversationId);
		if (!conversation) return;
		try {
			this.onRunStatus(conversationId, status, { seq: conversation.log.lastSeq, sessionFile: conversation.session.sessionFile });
		} catch (error) {
			console.error(`flypi: run status (${status}) not recorded: ${(error as Error).message}`);
		}
	}

	private teardown(conversation: Conversation): void {
		if (conversation.disposed) return;
		conversation.disposed = true;
		// An extension waiting on a dialog nobody will ever answer would hold its handler open forever.
		conversation.extensionUi.close();
		conversation.unsubscribe();
		conversation.session.dispose();
	}
}

/**
 * The slash commands this conversation answers to, in the order pi resolves them: extension commands first
 * (under pi's own *invocation* name, so one that collides with a built-in is still reachable as `name:2`),
 * then prompt templates. Skills are left out — flypi loads none.
 */
function commandsOf(session: FlypiSession): CommandRow[] {
	return [
		...session.extensionRunner.getRegisteredCommands().map((command) => ({
			name: command.invocationName,
			description: command.description ?? "",
			source: "extension" as const,
		})),
		...session.promptTemplates.map((template) => ({
			name: template.name,
			description: template.description,
			source: "prompt" as const,
		})),
	];
}

/**
 * A copy of an in-progress assistant message with its text and thinking blocks redacted. The copy is made even
 * when nothing matched, because the object pi gave us is mutable and shared by every frame of the turn — see
 * `redactStream`. Anything that is not such a message (no `content` array) comes back as it was.
 */
function redactText(message: unknown): unknown {
	const content = (message as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) return message;
	return { ...(message as object), content: content.map((block) => {
		const part = block as { type?: string; text?: string; thinking?: string };
		const field = part?.type === "text" ? "text" : part?.type === "thinking" ? "thinking" : undefined;
		if (field === undefined || typeof part[field] !== "string") return block;
		return { ...part, [field]: redactSecrets(part[field]!) };
	}) };
}
