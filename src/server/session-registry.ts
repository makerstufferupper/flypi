/**
 * One `AgentSession` per conversationId (docs/architecture.md Phase 1).
 *
 * The registry owns lifecycle and the event fan-out; the WS layer never touches a session. Driving a turn is
 * `src/agent/turn.ts` (docs/deepening.md Phase 11.3): this file keeps the conversation — its log, its
 * listeners, its memory block, its run row — and asks the driver to run a turn of it.
 * Sessions keep running with no client attached — the event log is per conversation, not per
 * socket, so a closed tab loses nothing. Phase 4.5 widens this (daemon, `runs` table); the
 * rule that matters already lives here: **a conversation whose turn is still running is never
 * evicted** — `isIdle` covers runs, compaction, retries and queued work.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SessionManager, type AgentSessionEvent, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { flypiPaths, type FlypiPaths } from "../agent/paths.ts";
import { createFlypiSession, type FlypiModel, type FlypiSession, type FlypiThinkingLevel } from "../agent/runtime.ts";
import { createTurnDriver, turnInput, type TurnDriver } from "../agent/turn.ts";
import type { SecretStore } from "../secrets/vault.ts";
import type { FlypiAttachment } from "../shared/attachments.ts";
import { EventLog } from "./event-log.ts";
import { createExtensionUiBridge } from "./extension-ui.ts";
import type { CommandRow, DebugInfo, ExtensionUiFrame, SessionSummary } from "./protocol.ts";
import type { FlypiMessage } from "../shared/transcript.ts";

/** `at` is when this process saw the event (src/server/event-log.ts); a listener that does not need the
 *  clock for its own accounting can ignore it. */
export type EventListener = (seq: number, event: AgentSessionEvent, at: number) => void;
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
	 * and it holds the dialogs still waiting for an answer. It belongs to the conversation and to nothing
	 * else — one per conversation, for the whole life of the session it answers.
	 */
	extensionUi: ReturnType<typeof createExtensionUiBridge>;
	/** Sockets watching this conversation's extension output. Detached with the socket, like event listeners. */
	uiListeners: Set<ExtensionUiListener>;
	/** The turn this conversation is driving, and the one subscription behind it. Bound in `bind()`. */
	turn: TurnDriver;
	lastSettledAt: number;
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
	 * A conversation is gone: its session is disposed and nothing will answer for it again. Called once per
	 * conversation, inside `teardown()`'s latch, for whoever is counting disposals — the eviction tests, and any
	 * bookkeeping that must not run twice for one conversation. Absent means nobody is watching.
	 */
	onTeardown?: (conversationId: string) => void;
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
	private readonly layout: FlypiPaths;
	private readonly createSession: CreateSession;
	private readonly idleTtlMs: number;
	private readonly now: () => number;
	private readonly onRunStatus: SessionRegistryOptions["onRunStatus"];
	private readonly onTeardown: SessionRegistryOptions["onTeardown"];

	constructor(private readonly options: SessionRegistryOptions) {
		this.layout = flypiPaths(options.root);
		this.createSession =
			options.createSession ??
			(({ sessionManager, conversationId, onMemoryBlock }) =>
				createFlypiSession({ root: options.root, sessionManager, conversationId, onMemoryBlock, vault: options.vault, review: true, goalDriver: true }).then((r) => r.session));
		this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
		this.now = options.now ?? Date.now;
		this.onRunStatus = options.onRunStatus;
		this.onTeardown = options.onTeardown;
	}

	get size(): number {
		return this.conversations.size;
	}

	/** The `.flypi` layout of this process, for the resource dispatcher (src/server/resources-server.ts). */
	get paths(): FlypiPaths {
		return this.layout;
	}

	async create(): Promise<Conversation> {
		return this.bind(
			SessionManager.create(this.paths.root, this.paths.sessionsDir),
		);
	}

	/**
	 * The conversation answering a session file, opened if there is none. **One session file, one
	 * conversation** — this is the whole mapping, and it is what makes a client's chr(c) safe to leave: a
	 * conversation is never moved onto another file and never taken away because someone looked at something
	 * else.
	 *
	 * Two readers of the same file would be two writers on it, so a file another conversation is already
	 * answering hands *that* conversation back — including a mid-turn one, whose answer is on its way to a
	 * page that may or may not be looking at it. Nothing is disposed here: a background turn keeps running
	 * and its events keep landing in its own log, which is what a client that comes back resumes.
	 */
	async switchSession(sessionPath: string): Promise<Conversation> {
		const target = this.sessionFileIn(sessionPath);
		const live = this.findByFile(target);
		if (live) return live;
		return this.bind(SessionManager.open(target, this.paths.sessionsDir));
	}

	/** The conversation answering a session file, or undefined. There is at most one, by construction. */
	findByFile(sessionFile: string): Conversation | undefined {
		for (const conversation of this.conversations.values()) {
			if (conversation.session.sessionFile === sessionFile) return conversation;
		}
		return undefined;
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
		// The code is what a page acts on: it holds a conversation id across reconnects, and after a restart
		// every command it sends names a conversation this process never had (ui/lib/app-state.svelte.ts).
		if (!conversation) throw Object.assign(new Error(`unknown conversation ${conversationId}`), { code: "unknownConversation" });
		return conversation;
	}

	log(conversationId: string): EventLog<AgentSessionEvent> {
		return this.get(conversationId).log;
	}

	prompt(conversationId: string, text: string, mode?: "steer" | "followUp", attachments: FlypiAttachment[] = []): Promise<void> {
		// Only the file write is the registry's: `turnInput` composes the body and the images, `start` drives it.
		// A rejection (no mode while streaming, no model) propagates — that rejection is the socket's error frame.
		const input = turnInput(text, attachments, (attachment) => this.saveUpload(attachment));
		return this.get(conversationId).turn.start({ ...input, mode });
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
		return this.get(conversationId).turn.abort();
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
	 *
	 * `running` is the one thing pi's list cannot know: whether a conversation in *this* process is
	 * mid-turn on that file. A turn keeps running with nobody looking at it, and that flag is the only
	 * sign of it on screen. It says nothing about a turn a previous process was cut short on — that is
	 * the daemon's `runs` record, reported when the session is opened.
	 */
	async listSessions(): Promise<SessionSummary[]> {
		const sessions = await SessionManager.list(this.paths.root, this.paths.sessionsDir);
		return sessions.map((session) => ({
			path: session.path,
			...(session.name ? { name: session.name } : {}),
			modified: session.modified.toISOString(),
			messageCount: session.messageCount,
			firstMessage: session.firstMessage,
			running: this.findByFile(session.path)?.turn.idle === false,
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
	 */
	async deleteSession(sessionPath: string): Promise<void> {
		const target = this.sessionFileIn(sessionPath);
		const holder = this.findByFile(target);
		if (holder) {
			if (!holder.turn.idle) throw new Error(`session ${target} is mid-turn; abort it first`);
			this.teardown(holder);
			this.conversations.delete(holder.id);
		}
		rmSync(target); // no force: a file that is not there is an error frame, not a silent success
	}

	/**
	 * Re-run each idle conversation's extensions against the packages on disk now. `reload()` swaps the extension
	 * runtime but does not re-emit `session_start` for a headless session, and that event is what connects the
	 * MCP servers — so without the `bindExtensions` that follows, reloading for an extension would silently drop
	 * every MCP tool the conversation had (tests/agent/packages.test.ts).
	 */
	async reloadExtensions(): Promise<void> {
		for (const conversation of this.conversations.values()) {
			if (!conversation.turn.idle) continue;
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
			if (conversation.listeners.size > 0 || !conversation.turn.idle) continue;
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
		// The same clock eviction uses, so a scripted clock in a test stamps the events it drives.
		const log = new EventLog<AgentSessionEvent>(this.options.logCapacity, this.now);
		const listeners = new Set<EventListener>();
		const messages = new Map<number, FlypiMessage>();
		const conversation: Conversation = {
			id,
			log,
			listeners,
			messages,
			session: await this.createSession({
				sessionManager,
				conversationId: id,
				onMemoryBlock: (block) => (memory.block = block),
				extensionUi: extensionUi.uiContext,
			}),
			extensionUi,
			uiListeners,
			memory,
			// Bound on the next line, once the conversation is in the map: the driver subscribes as it is
			// created, and the run status it reports is recorded against a conversation `markRun` finds there.
			turn: undefined as unknown as TurnDriver,
			lastSettledAt: this.now(),
		};
		// Invariant, and it is the two lines below that hold it: **no `await` may be introduced between them**,
		// and the driver is created after this insert and before `seedHistory`. `turn` is a placeholder in the
		// gap, so an `await` there would let a socket message, a timer or an `evictIdle` pass reach a
		// conversation with no turn — silently, and nothing downstream would catch it.
		this.conversations.set(conversation.id, conversation);
		// One driver, and so one subscription, for the whole life of the conversation — never one per turn.
		// It is created before the history is seeded so an event of a live turn cannot land in the gap.
		conversation.turn = createTurnDriver({
			session: conversation.session,
			log,
			onEvent: (seq, event, at) => {
				if (event.type === "message_end") messages.set(seq, event.message);
				for (const listener of listeners) listener(seq, event, at);
			},
			onRun: (status) => this.markRun(id, status),
			// A new turn has not injected anything yet: the panel must not show last turn's block as this one's.
			onTurnStart: () => (memory.block = null),
			// An extension waiting on a dialog nobody will ever answer would hold its handler open forever. Inside
			// the driver's latch, so it runs once per conversation and cannot be reached outside the teardown.
			onDispose: () => extensionUi.close(),
		});
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

	/** Write the run row, when anything is listening for it. Never lets bookkeeping break a turn. */
	private markRun(conversationId: string, status: "running" | "idle" | "aborted"): void {
		const conversation = this.conversations.get(conversationId);
		if (!conversation) return;
		// Eviction's idle clock restarts here, whether or not anyone is keeping a run row.
		if (status === "idle") conversation.lastSettledAt = this.now();
		if (!this.onRunStatus) return;
		try {
			this.onRunStatus(conversationId, status, { seq: conversation.log.lastSeq, sessionFile: conversation.session.sessionFile });
		} catch (error) {
			console.error(`flypi: run status (${status}) not recorded: ${(error as Error).message}`);
		}
	}

	private teardown(conversation: Conversation): void {
		// The driver's latch is the whole teardown: it closes the extension UI, drops the subscription and
		// disposes the session, once. Nothing of it may sit outside the latch — on a second teardown the latch
		// returns early, and whatever stood next to it would run again against a conversation that is gone.
		conversation.turn.dispose();
		// After the latch, and reachable only from the three call sites that tear a conversation out of the map,
		// so "once per conversation" is held by the same thing that holds it for the session.
		this.onTeardown?.(conversation.id);
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

