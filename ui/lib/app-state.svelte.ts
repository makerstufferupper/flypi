/**
 * All of the UI's state, and every command it can send, in one class with no DOM in it.
 *
 * The page holds **one chat per session**, and each chat is bound to exactly one server-side conversation
 * for as long as the page lives: opening another session never rebinds this one, and a background turn keeps
 * streaming into its own chat. That 1:1 mapping is the whole design — a single global transcript was what let
 * one session's answer land in another's chat and what made a row click look like it killed a turn.
 *
 * `App.svelte` renders this; the UI tests drive it with a fake transport and assert the DOM that comes out.
 * The transcript is never held twice: it is the reducer's output per chat, and a reconnect replays each
 * chat's own log through the same `applyEvent` the live stream uses (docs/protocol.md).
 */
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { FlypiAttachment } from "../../src/shared/attachments.ts";
import { emptyTranscript, applyEvent, type Transcript } from "../../src/shared/transcript.ts";
import { applyPerfEvent, emptyPerf, hasMeasurement, type Perf } from "../../src/shared/metrics.ts";
import { loadLastAnswer, forgetLastAnswer, modelName, saveLastAnswer } from "./last-answer.ts";
import type { ClientCommand, ConfigFileEdit, ConfigSnapshot, DebugInfo, DefaultsEdit, EndpointEdit, ExtensionUiFrame, McpEdit, McpStatusSnapshot, MemoryEdit, MemorySnapshot, PackagesSnapshot, PiVersions as PiVersionsSnapshot, SchedulerSnapshot, SecretEdit, SecretsSnapshot, ServerFrame, SessionSummary } from "../../src/server/protocol.ts";
import type { View } from "./route.ts";
import type { FlypiThinkingLevel } from "../../src/agent/runtime.ts";
import type { Transport } from "./client.ts";

/** One session's chat, and the pi conversation answering it — one of each, for the chat's whole life. */
interface Chat {
	/** Local identity, stable across a rebind: a restart gives the session a new conversation id, not a new chat. */
	id: string;
	/** The server-side conversation this chat is bound to. Changes only when the old one is forgotten. */
	conversationId: string;
	/** The session file, when the server has one. A conversation pi has not written yet has none. */
	sessionPath?: string;
	transcript: Transcript;
	metrics: Perf;
	/** The model `metrics.last` was measured on — a rate describes a model, and this is part of the number. */
	measuredOn: string | null;
	/** The model this conversation answers on, as the app last heard it. */
	modelInUse: string | null;
	debug?: DebugInfo;
	/** Set when the daemon says a turn in this session was cut short by a restart. */
	interruptedAt?: string;
	extensionNotes: { message: string; level: string }[];
	extensionDialog?: ExtensionUiFrame;
	/** What is typed in the box but not sent. It belongs to the session, not to the page. */
	draft: string;
	attachments: FlypiAttachment[];
	/** The seq of the last event applied here — this chat's own resume cursor. */
	lastSeq: number;
	/** Whether this chat has asked for the session list since it was bound. */
	rowRequested: boolean;
	/** A recovery is in flight: this chat's conversation id is dead and is being reopened by path. */
	rebinding: boolean;
	/** The last thing the server said went wrong *about this chat*, so a background failure is not the active chat's. */
	error?: string;
	/**
	 * A turn finished in this chat while it was not the one on screen. Cleared when it is opened; shown as
	 * the row's unread marker. A turn in the chat you are looking at is not unread — you watched it happen.
	 */
	unread?: boolean;
}

/** What a finished turn looks like to the page's notifications (ui/lib/notify.ts). */
export interface SettledTurn {
	chatId: string;
	sessionPath?: string;
	/** Was this the chat on screen when it finished? */
	active: boolean;
	/** The session's own name or first message, else its file name. */
	title: string;
	/** The last thing it said, shortened for a notification body. */
	preview: string;
}

/** What a binding request is for. `replace` rebinds a chat that has no session file to reopen. */
type BindTarget = { kind: "new"; replace?: string } | { kind: "open" } | { kind: "fork" };

const EMPTY_TRANSCRIPT = emptyTranscript();
const EMPTY_PERF = emptyPerf();

export class FlypiAppState {
	/** Every chat this page holds, in the order it opened them. Only the active one is rendered. */
	chats = $state<Chat[]>([]);
	/** Which chat is on screen. The others keep their own transcripts, turns and drafts. */
	activeChatId = $state<string | undefined>(undefined);
	sessions = $state<SessionSummary[]>([]);
	/**
	 * The daemon's job queue, for the activity panel's scheduler section (Phase 4.5). Asked when that
	 * section is opened, never on a timer — and a plain `npm run serve` has no queue to show.
	 */
	scheduler = $state<SchedulerSnapshot | undefined>(undefined);
	/** The agent dir's config files, as the server last read them; the settings panel edits them. */
	config = $state<ConfigSnapshot | undefined>(undefined);
	/**
	 * Which of the page's views is up: the chat, settings, or the vault (App.svelte). Here rather than in one
	 * component because the sidebar opens all three, each view has a way back, and the address bar mirrors it
	 * (ui/lib/route.ts).
	 */
	view = $state<View>("chat");
	connected = $state(false);
	/** Last thing the server said went wrong and that was not about one conversation — shown in the chat. */
	pageError = $state<string | undefined>(undefined);
	/**
	 * A config edit the server refused. It belongs here rather than only in `pageError` because the settings
	 * view is not the chat: a rejected row has to be said where the row is.
	 */
	configError = $state<string | undefined>(undefined);
	/**
	 * What the MCP servers answered when they were last asked (Phase 5). Asked by a button in the settings
	 * view, never on a timer: answering means starting an stdio server. `mcpChecking` is why that button
	 * cannot be pressed twice into a ten-second wait.
	 */
	mcpStatus = $state<McpStatusSnapshot | undefined>(undefined);
	mcpChecking = $state(false);
	/**
	 * An MCP sign-in the browser has to finish (docs/architecture.md Phase 5, risk 5): the URL to open, and the
	 * box the address it lands on comes back in. The server pushes the URL as an `mcpAuth` frame; the sign-in's
	 * own ack — a refreshed `mcpStatus` — is what retires it, so a browser that reached the server directly and
	 * never needed a paste still clears the box.
	 */
	mcpSignIn = $state<{ name: string; url: string } | undefined>(undefined);
	mcpSigningIn = $state(false);
	/**
	 * The extension packages the agent loads (`packages` in `.flypi/agent/settings.json`), and whether an
	 * install, removal or update is in flight. npm or git does that work, which takes seconds, so the button
	 * says so rather than looking stuck.
	 */
	packages = $state<PackagesSnapshot | undefined>(undefined);
	packagesBusy = $state(false);
	/** What the scheduler section shows when the queue refused to answer (`npm run serve` has none). */
	schedulerError = $state<string | undefined>(undefined);
	/**
	 * The update the daemon reported (docs/architecture.md Phase 7): what its "install now" is doing, and what
	 * it refused. The line itself comes from `/healthz` (App.svelte), not from here.
	 */
	updateInstalling = $state(false);
	updateError = $state<string | undefined>(undefined);
	/**
	 * The vault as the server last described it (docs/secrets.md). Masks, counters and key state — the row
	 * type has no value field, so a snapshot cannot carry one. Asked for when the Secrets view opens.
	 */
	secrets = $state<SecretsSnapshot | undefined>(undefined);
	/** A vault this process could not open, or an edit it refused — said in the Secrets view, not on the chat. */
	secretsError = $state<string | undefined>(undefined);
	/**
	 * One value the panel asked for by name, kept only while that view is showing it. Nothing writes it down:
	 * it is a field in memory with no path to the socket, the transcript or storage, and leaving the view drops
	 * it. `hideSecret` is the button that drops it early.
	 */
	revealed = $state<{ name: string; value: string } | undefined>(undefined);
	/**
	 * The memory store as the browser sees it (docs/memory.md Phase 6): rows in every status, the turn log,
	 * the wiki and the hit-rate numbers. Asked for when the Memory view opens, never polled — the same shape
	 * as the vault and the scheduler.
	 */
	memories = $state<MemorySnapshot | undefined>(undefined);
	/** A store this process could not open, or an edit it refused — said in the Memory view, not on the chat. */
	memoryError = $state<string | undefined>(undefined);
	protocolMismatch = $state<string | undefined>(undefined);
	/**
	 * Which pi the server loaded (docs/pi-upgrades.md Phase 8.1) — the version it is really running, not the
	 * range flypi's package.json declares. From `hello`, refreshed by the `/healthz` poll in App.svelte.
	 */
	pi = $state<{ version: string; pinned: boolean; bundled?: string } | undefined>(undefined);
	/**
	 * What pi this flypi runs, what is on disk to move to, and the daemon's daily answer about what is
	 * published (docs/pi-upgrades.md Phase 8.4). Asked when the settings view opens, never polled.
	 */
	piVersions = $state<PiVersionsSnapshot | undefined>(undefined);
	/** A pi switch is in flight: the daemon is about to restart, and this page goes down with it. */
	piBusy = $state(false);

	#transport: Transport;
	/**
	 * The conversation ids this socket is currently following (`resume` sent, no `unsubscribe` yet). The
	 * active chat and every chat with a turn running stay here; an idle background chat is let go so the
	 * server can evict it, and a later resume re-attaches it.
	 */
	#watched = new Set<string>();
	/**
	 * The server's clock minus this page's, from `hello`. Events are stamped by the backend and a live
	 * window keeps growing on this page's clock, so the two are put on one timeline instead of assuming
	 * this page and the daemon are the same machine.
	 */
	#clockOffset = 0;
	/** Request ids whose `result` names the conversation that answers a session file. */
	#bindTargets = new Map<string, BindTarget>();
	/** Which chat a `debug` request was asked for, so a late reply refreshes that chat and not the one on screen. */
	#debugTargets = new Map<string, string>();
	#pendingRequest = new Map<string, (result: { conversationId?: string; sessionPath?: string; sessions?: SessionSummary[]; debug?: DebugInfo; config?: ConfigSnapshot; scheduler?: SchedulerSnapshot }) => void>();
	#updateRequests = new Set<string>();

	constructor(
		transport: Transport,
		private readonly options: { onTurnSettled?: (turn: SettledTurn) => void } = {},
	) {
		this.#transport = transport;
	}

	// ---- The active chat, as the components read it ------------------------------------------------------

	#activeChat(): Chat | undefined {
		return this.chats.find((chat) => chat.id === this.activeChatId);
	}

	get conversationId(): string | undefined {
		return this.#activeChat()?.conversationId;
	}

	get sessionPath(): string | undefined {
		return this.#activeChat()?.sessionPath;
	}

	get transcript(): Transcript {
		return this.#activeChat()?.transcript ?? EMPTY_TRANSCRIPT;
	}

	get metrics(): Perf {
		return this.#activeChat()?.metrics ?? EMPTY_PERF;
	}

	get measuredOn(): string | null {
		return this.#activeChat()?.measuredOn ?? null;
	}

	get debug(): DebugInfo | undefined {
		return this.#activeChat()?.debug;
	}

	get interruptedAt(): string | undefined {
		return this.#activeChat()?.interruptedAt;
	}

	get extensionNotes(): { message: string; level: string }[] {
		return this.#activeChat()?.extensionNotes ?? [];
	}

	get extensionDialog(): ExtensionUiFrame | undefined {
		return this.#activeChat()?.extensionDialog;
	}

	/** The last error said about the chat on screen, or the page's own last error. */
	get lastError(): string | undefined {
		return this.#activeChat()?.error ?? this.pageError;
	}

	get draft(): string {
		return this.#activeChat()?.draft ?? "";
	}

	set draft(value: string) {
		const chat = this.#activeChat();
		if (chat) chat.draft = value;
	}

	get attachments(): FlypiAttachment[] {
		return this.#activeChat()?.attachments ?? [];
	}

	set attachments(value: FlypiAttachment[]) {
		const chat = this.#activeChat();
		if (chat) chat.attachments = value;
	}

	/**
	 * Is a turn running in the session at `path` — the sidebar's own question, answered per session.
	 *
	 * For a session this page holds, its own transcript is the truth: the list's `running` flag is only as
	 * fresh as the last fetch, and a turn that settled since then otherwise kept the row blinking forever.
	 * The flag is still what answers for a session there is no chat for.
	 */
	isRunning(path: string): boolean {
		const chat = this.chats.find((candidate) => candidate.sessionPath === path);
		if (chat) return chat.transcript.running;
		return this.sessions.find((session) => session.path === path)?.running === true;
	}

	/** A finished turn in this session that has not been looked at yet. */
	isUnread(path: string): boolean {
		return this.chats.find((candidate) => candidate.sessionPath === path)?.unread === true;
	}

	// ---- Transport ---------------------------------------------------------------------------------------

	/** Subscribe to the transport. Call once; the first chat arrives with the connection. */
	watch(): () => void {
		return this.#transport.on((signal) => {
			if (signal.type === "connected") {
				this.connected = true;
				// The socket is new, so nothing is attached to it any more: resume every chat this page holds,
				// each from its own cursor. A reconnect replays each log; it is not a fresh start.
				this.#watched.clear();
				if (this.chats.length) this.#syncSubscriptions();
				else this.newSession();
				// The chat needs the config files too, not only the settings view: with no endpoint configured the
				// first thing the page should do is say so (ui/Chat.svelte) rather than let the first prompt fail.
				if (this.view === "chat") this.showConfig();
				return;
			}
			if (signal.type === "disconnected") {
				this.connected = false;
				return;
			}
			this.handleFrame(signal);
		});
	}

	send(command: ClientCommand): void {
		this.#transport.send(command);
	}

	/**
	 * "Now", on the backend's clock: event stamps are the backend's, so anything that keeps growing
	 * between events (a streaming response's decode window) has to be read on the same timeline.
	 */
	now(): number {
		return Date.now() + this.#clockOffset;
	}

	/** Commands that answer with a result frame: give them a request id and wait for it. */
	async request(command: ClientCommand & { requestId: string }): Promise<void> {
		return new Promise((resolve) => {
			this.#pendingRequest.set(command.requestId, resolve as never);
			this.send(command);
		});
	}

	// ---- Chat lifecycle ----------------------------------------------------------------------------------

	#makeChat(conversationId: string, sessionPath: string | undefined): Chat {
		return {
			id: `chat-${++chatCounter}`,
			conversationId,
			...(sessionPath ? { sessionPath } : {}),
			transcript: emptyTranscript(),
			metrics: { ...emptyPerf(), last: sessionPath ? loadLastAnswer(sessionPath) : null },
			measuredOn: sessionPath ? (loadLastAnswer(sessionPath)?.model ?? null) : null,
			modelInUse: null,
			extensionNotes: [],
			draft: "",
			attachments: [],
			lastSeq: 0,
			rowRequested: false,
			rebinding: false,
		};
	}

	/** Point an existing chat at a (new) conversation, rebuilding everything bound to the old one. */
	#resetChat(chat: Chat, conversationId: string, sessionPath: string | undefined): void {
		if (this.#watched.delete(chat.conversationId)) this.send({ type: "unsubscribe", conversationId: chat.conversationId });
		chat.conversationId = conversationId;
		if (sessionPath) chat.sessionPath = sessionPath;
		const answer = chat.sessionPath ? loadLastAnswer(chat.sessionPath) : null;
		chat.transcript = emptyTranscript();
		chat.metrics = { ...emptyPerf(), last: answer };
		chat.measuredOn = answer?.model ?? null;
		chat.modelInUse = null;
		chat.debug = undefined;
		chat.interruptedAt = undefined;
		chat.extensionNotes = [];
		chat.extensionDialog = undefined;
		chat.lastSeq = 0;
		chat.rowRequested = false;
		chat.rebinding = false;
		chat.error = undefined;
	}

	#setActive(chat: Chat): void {
		this.activeChatId = chat.id;
		chat.unread = false;
		this.#syncSubscriptions();
	}

	/**
	 * Handle the `result` that names the conversation answering a session file. `open` reuses the chat already
	 * on that file (rebuilding it only when the conversation really changed); `new` and `fork` make a new one.
	 */
	#adopt(conversationId: string, sessionPath: string | undefined, target: BindTarget): Chat {
		const existing =
			target.kind === "open"
				? (this.chats.find((chat) => (sessionPath ? chat.sessionPath === sessionPath : false)) ?? this.chats.find((chat) => chat.conversationId === conversationId))
				: target.kind === "new" && target.replace
					? this.chats.find((chat) => chat.id === target.replace)
					: undefined;
		if (existing) {
			const rebound = existing.conversationId !== conversationId;
			if (rebound) this.#resetChat(existing, conversationId, sessionPath);
			else if (sessionPath) existing.sessionPath = sessionPath;
			existing.rebinding = false;
			this.activeChatId = existing.id;
			existing.unread = false;
			this.#syncSubscriptions();
			return existing;
		}
		const chat = this.#makeChat(conversationId, sessionPath);
		this.chats.push(chat);
		this.activeChatId = chat.id;
		this.#syncSubscriptions();
		return chat;
	}

	/** Tell the page a turn finished, for a desktop notification. Silent when nothing is listening. */
	#announceSettled(chat: Chat): void {
		if (!this.options.onTurnSettled) return;
		try {
			this.options.onTurnSettled({
				chatId: chat.id,
				...(chat.sessionPath ? { sessionPath: chat.sessionPath } : {}),
				active: chat.id === this.activeChatId,
				title: this.#titleOf(chat),
				preview: lastSpoken(chat.transcript),
			});
		} catch {
			// A notification is the least important thing here; it must not break the turn that produced it.
		}
	}

	/** The name the sidebar gives this session, so a notification says the same thing the row does. */
	#titleOf(chat: Chat): string {
		const row = chat.sessionPath ? this.sessions.find((session) => session.path === chat.sessionPath) : undefined;
		return row?.name || row?.firstMessage || chat.sessionPath?.split("/").pop() || "flypi";
	}

	/**
	 * Keep exactly the chats that need a live subscription attached: the one on screen and any with a turn
	 * running. Everything else is let go, so an idle conversation can be evicted and a later `resume` (which
	 * reopens from the file if it really is gone) brings it back.
	 */
	#syncSubscriptions(): void {
		for (const chat of this.chats) {
			if (chat.rebinding) continue;
			const shouldWatch = chat.id === this.activeChatId || chat.transcript.running;
			const watching = this.#watched.has(chat.conversationId);
			if (shouldWatch && !watching) {
				this.#watched.add(chat.conversationId);
				this.send({ type: "resume", conversationId: chat.conversationId, afterSeq: chat.lastSeq });
			} else if (!shouldWatch && watching) {
				this.#watched.delete(chat.conversationId);
				this.send({ type: "unsubscribe", conversationId: chat.conversationId });
			}
		}
		for (const conversationId of [...this.#watched]) {
			if (this.chats.some((chat) => chat.conversationId === conversationId)) continue;
			this.#watched.delete(conversationId);
			this.send({ type: "unsubscribe", conversationId });
		}
	}

	newSession(): void {
		const requestId = nextId();
		this.#bindTargets.set(requestId, { kind: "new" });
		this.send({ type: "newSession", requestId });
	}

	/**
	 * Show an existing session. The chat already on that file is reused as it is — its conversation is the one
	 * answering it — and only a session this page has never opened asks the server for a conversation of its own.
	 */
	openSession(path: string): void {
		const existing = this.chats.find((chat) => chat.sessionPath === path);
		if (existing) {
			this.#setActive(existing);
			this.showDebug(existing);
			return;
		}
		// A session this page has never seen: the server answers with the conversation that answers the file.
		// Session files are unique per conversation, so the answer is recognised by its path — which is what
		// lets a chat be *reopened* rather than replaced, even when the conversation id behind it is new.
		const requestId = nextId();
		this.#bindTargets.set(requestId, { kind: "open" });
		this.send({ type: "switchSession", sessionPath: path, requestId });
	}

	/** A conversation the server has forgotten: reopen the session it was showing as a conversation of its own. */
	#recover(chat: Chat): void {
		chat.rebinding = true;
		this.#watched.delete(chat.conversationId);
		const requestId = nextId();
		if (chat.sessionPath) {
			this.#bindTargets.set(requestId, { kind: "open" });
			this.send({ type: "switchSession", sessionPath: chat.sessionPath, requestId });
			return;
		}
		this.#bindTargets.set(requestId, { kind: "new", replace: chat.id });
		this.send({ type: "newSession", requestId });
	}

	// ---- Commands, all against the chat on screen ----------------------------------------------------------

	prompt(text: string, mode: "steer" | "followUp" = "steer", attachments: FlypiAttachment[] = []): void {
		const chat = this.#activeChat();
		if (!chat) return;
		chat.error = undefined;
		this.send({ type: "prompt", conversationId: chat.conversationId, text, ...(attachments.length ? { attachments } : {}), mode });
	}

	abort(): void {
		const chat = this.#activeChat();
		if (chat) this.send({ type: "abort", conversationId: chat.conversationId });
	}

	fork(messageSeq: number): void {
		const chat = this.#activeChat();
		if (!chat) return;
		const requestId = nextId();
		this.#bindTargets.set(requestId, { kind: "fork" });
		this.send({ type: "fork", conversationId: chat.conversationId, messageSeq, requestId });
	}

	listSessions(): void {
		void this.request({ type: "listSessions", requestId: nextId() });
	}

	rename(name: string): void {
		const chat = this.#activeChat();
		if (chat) this.send({ type: "renameSession", conversationId: chat.conversationId, name });
	}

	/**
	 * Delete a session file for good — the server answers with the list without it. The chat that was showing
	 * it goes with it, and if it was the one on screen the page falls back to another open chat, or a fresh one.
	 */
	deleteSession(path: string): void {
		forgetLastAnswer(path);
		void this.request({ type: "deleteSession", sessionPath: path, requestId: nextId() }).then(() => {
			const chat = this.chats.find((candidate) => candidate.sessionPath === path);
			if (!chat) return;
			this.#watched.delete(chat.conversationId);
			const wasActive = this.activeChatId === chat.id;
			this.chats = this.chats.filter((candidate) => candidate.id !== chat.id);
			if (!wasActive) return;
			const next = this.chats.at(-1);
			if (next) this.#setActive(next);
			else this.newSession();
		});
	}

	setModel(provider: string, modelId: string): void {
		const chat = this.#activeChat();
		if (!chat) return;
		this.send({ type: "setModel", conversationId: chat.conversationId, provider, modelId });
		// No round trip needed to know the model changed: the numbers on screen stop being this chat's.
		this.#keepNumbersFor(chat, `${provider}/${modelId}`);
	}

	/**
	 * A rate describes the model it was measured on, so numbers measured on another model are not this
	 * chat's numbers. Called whenever the model in use may have changed (a debug snapshot, or a model you
	 * just picked): keep what is on screen only if it was measured on this model — and since they are kept
	 * per chat, switching back to a model this chat measured on brings its numbers back.
	 */
	#keepNumbersFor(chat: Chat, model: string | null): void {
		if (!model) return;
		chat.modelInUse = model;
		if (!chat.sessionPath || chat.measuredOn === model) return;
		// Numbers whose model the app never knew were measured in this chat, and this is the first thing that
		// ever named a model — so name them instead of retiring what was just measured. Only numbers known to
		// belong to another model are retired below.
		if (!chat.measuredOn && (hasMeasurement(chat.metrics.run) || hasMeasurement(chat.metrics.last))) {
			chat.measuredOn = model;
			if (hasMeasurement(chat.metrics.run)) saveLastAnswer(chat.sessionPath, { ...chat.metrics.run, model });
			return;
		}
		const answer = loadLastAnswer(chat.sessionPath);
		const keep = answer && answer.model === model ? answer : null;
		// A rate describes the model that produced it, so the question's average goes with it — that count
		// is live state, not something a round trip could hand back.
		chat.metrics = { ...emptyPerf(), last: keep };
		chat.measuredOn = keep ? model : null;
	}

	setThinkingLevel(level: FlypiThinkingLevel): void {
		const chat = this.#activeChat();
		if (chat) this.send({ type: "setThinkingLevel", conversationId: chat.conversationId, level });
	}

	/**
	 * Answer an extension's question: the option or text it asked for, or null for "cancelled" — what pi's own
	 * dialogs report when the user dismisses them. The dialog leaves the screen as soon as it is sent: the
	 * server either resolves the handler or says nothing was waiting, and both mean stop showing it.
	 */
	answerExtension(dialogId: string, value: string | null): void {
		const chat = this.#activeChat();
		if (!chat) return;
		this.send({ type: "extensionReply", conversationId: chat.conversationId, dialogId, value });
		chat.extensionDialog = undefined;
	}

	showDebug(chat: Chat | undefined = this.#activeChat()): void {
		if (!chat) return;
		const requestId = nextId();
		this.#debugTargets.set(requestId, chat.id);
		void this.request({ type: "debug", conversationId: chat.conversationId, requestId });
	}

	// ---- The page's views and the global settings surfaces -------------------------------------------------

	/** What the daemon's queue is, and what it last did. Asked when the section opens; see ActivityPanel. */
	loadScheduler(): void {
		const requestId = nextId();
		this.#schedulerRequests.add(requestId);
		void this.request({ type: "scheduler", requestId });
	}

	/**
	 * Install the downloaded update now instead of at the daemon's idle moment. The install replaces the files
	 * the daemon runs from, so it restarts and this socket drops with it: the page shows what is happening and
	 * watches `/healthz` for the new process (ui/App.svelte), and the socket re-reads its token and reconnects
	 * (ui/lib/client.ts). Nothing here waits — the answer to that is the reload.
	 */
	installUpdate(): void {
		const requestId = nextId();
		this.#updateRequests.add(requestId);
		this.updateError = undefined;
		this.updateInstalling = true;
		void this.request({ type: "installUpdate", requestId });
	}

	openChat(): void {
		this.revealed = undefined;
		this.view = "chat";
		// A page that opened on another view has never read the files, and the chat's setup note needs them.
		if (!this.config) this.showConfig();
	}

	openSettings(): void {
		this.revealed = undefined;
		this.view = "settings";
	}

	openSecrets(): void {
		this.view = "secrets";
	}

	openMemory(): void {
		this.revealed = undefined;
		this.view = "memory";
	}

	toggleSettings(): void {
		if (this.view === "settings") this.openChat();
		else this.openSettings();
	}

	toggleSecrets(): void {
		if (this.view === "secrets") this.openChat();
		else this.openSecrets();
	}

	toggleMemory(): void {
		if (this.view === "memory") this.openChat();
		else this.openMemory();
	}

	showConfig(): void {
		void this.request({ type: "getConfig", requestId: this.#configRequest() });
	}

	/** Apply an edit; the refreshed files come back with the ack and repopulate the panel. */
	saveConfig(edits: { endpoints?: EndpointEdit[]; mcpServers?: McpEdit[]; defaults?: DefaultsEdit; files?: ConfigFileEdit[] }): void {
		void this.request({ type: "saveConfig", ...edits, requestId: this.#configRequest() });
	}

	/**
	 * The extension packages, as the agent dir declares them. Its request id is a config one, like the probe's:
	 * a refusal there — a `settings.json` pi will not read — is a sentence about the settings view, and
	 * `configError` is the line that panel has for those.
	 */
	showPackages(): void {
		void this.request({ type: "packages", requestId: this.#configRequest() });
	}

	/**
	 * Install, remove or update packages. The refreshed list comes back with the ack, and the server reloads the
	 * conversations that are idle, so the tool that was just installed is in the chat on screen (src/server/
	 * session-registry.ts).
	 */
	savePackages(edits: { install?: string[]; remove?: string[]; update?: string[] }): void {
		this.packagesBusy = true;
		void this.request({ type: "savePackages", ...edits, requestId: this.#configRequest() });
	}

	/** Which pi the server runs, and what it could move to. Reaches no network: the daemon's stamp answers. */
	showPiVersions(): void {
		void this.request({ type: "piVersions", requestId: this.#configRequest() });
	}

	/** Ask the registry for a newer pi now. The answer arrives as the same `pi` frame, so the stamp line moves. */
	checkPi(): void {
		void this.request({ type: "piCheck", requestId: this.#configRequest() });
	}

	/**
	 * Move to a pi version. The daemon flips the pointer and restarts through the CLI, so this page loses its
	 * socket: what it learns afterwards is which version came back, from `/healthz` — not a promise that the
	 * switch worked. If the new process does not answer reporting that version, the pointer goes back on its
	 * own (docs/risks.md risk 13).
	 */
	usePi(version: string): void {
		this.piBusy = true;
		void this.request({ type: "usePi", version, requestId: this.#configRequest() });
	}

	/**
	 * Ask the servers. Its request id is a config one on purpose: a probe that fails is a settings-view
	 * problem, and `configError` is the line that panel already has for those (see the error case).
	 */
	checkMcp(): void {
		this.mcpChecking = true;
		void this.request({ type: "mcpStatus", requestId: this.#configRequest() });
	}

	/**
	 * Start an OAuth sign-in for one server. Its request id is a config one, like the probe's: a failed sign-in
	 * is a sentence about the row it was started from, and `configError` is the line the panel has for those.
	 * The request stays open until the sign-in ends (docs/protocol.md).
	 */
	signInMcp(name: string): void {
		this.mcpSigningIn = true;
		void this.request({ type: "mcpSignIn", name, requestId: this.#configRequest() });
	}

	/**
	 * The address the browser was redirected to, for the sign-in of `name`. Empty cancels — the server then
	 * answers the open `mcpSignIn` with an error frame, which is where the panel is told to stop waiting.
	 */
	submitMcpRedirect(name: string, url: string): void {
		this.send({ type: "mcpRedirect", name, url });
	}

	/** The vault, masks only. Asked for when the Secrets view opens and after nothing else. */
	showSecrets(): void {
		void this.request({ type: "secrets", requestId: this.#secretsRequest() });
	}

	/**
	 * Put, rotate, delete or restore. A value leaves this page in exactly one frame — this one — and never
	 * comes back: the ack carries the refreshed snapshot, whose rows hold masks.
	 */
	saveSecrets(edits: SecretEdit[]): void {
		void this.request({ type: "saveSecrets", secrets: edits, requestId: this.#secretsRequest() });
	}

	/** The one request the protocol answers with a plaintext. Ask for one name at a time, never all of them. */
	revealSecret(name: string): void {
		void this.request({ type: "revealSecret", name, requestId: this.#secretsRequest() });
	}

	/** The store, the turn log and the wiki. Asked for when the Memory view opens and after nothing else. */
	showMemories(): void {
		void this.request({ type: "memory", requestId: this.#memoryRequest() });
	}

	/**
	 * Edit, delete or undo one memory. The refreshed store comes back with the ack, so the page shows what the
	 * write produced — including the audit row it wrote, which is what makes the next undo possible.
	 */
	saveMemories(edits: MemoryEdit[]): void {
		void this.request({ type: "saveMemory", memories: edits, requestId: this.#memoryRequest() });
	}

	hideSecret(): void {
		this.revealed = undefined;
	}

	/**
	 * Config requests outstanding, by request id: a rejected one is answered with an `error` frame carrying
	 * that id, and this is how the settings view knows the failure it must show is one of its own rows.
	 */
	#configRequests = new Set<string>();
	// So a vault failure is said in the Secrets view rather than on the chat (see the error case).
	#secretsRequests = new Set<string>();
	// So a memory failure is said in the Memory view rather than on the chat (see the error case).
	#memoryRequests = new Set<string>();
	// So a scheduler failure lands in the scheduler section instead of the chat (see the error case).
	#schedulerRequests = new Set<string>();

	#configRequest(): string {
		const requestId = nextId();
		this.#configRequests.add(requestId);
		return requestId;
	}

	#secretsRequest(): string {
		const requestId = nextId();
		this.#secretsRequests.add(requestId);
		return requestId;
	}

	#memoryRequest(): string {
		const requestId = nextId();
		this.#memoryRequests.add(requestId);
		return requestId;
	}

	// ---- Frames -------------------------------------------------------------------------------------------

	handleFrame(frame: ServerFrame): void {
		switch (frame.type) {
			case "hello":
				if (frame.protocolVersion !== 1) this.protocolMismatch = `server speaks protocol v${frame.protocolVersion}, this UI speaks v1`;
				if (typeof frame.now === "number") this.#clockOffset = frame.now - Date.now();
				this.pi = frame.pi;
				return;
			case "event": {
				// Every event frame is addressed to a conversation, and every conversation has exactly one chat.
				// Frames for a chat the page is not showing still update *that* chat — that is how a background
				// turn's answer lands where it came from, and never in whatever happens to be on screen.
				const chat = this.chats.find((candidate) => candidate.conversationId === frame.conversationId);
				if (!chat) return;
				// The only place a transcript changes: the same reducer a replay goes through.
				chat.lastSeq = Math.max(chat.lastSeq, frame.seq);
				// The protocol checks only the discriminator (SessionEventFrameBody); the reducer is the
				// place that knows what each event means, and it ignores what it does not recognise.
				const event = frame.event as AgentSessionEvent;
				if (event.type === "agent_start") chat.error = undefined;
				// The clock is the one the **backend** stamped on the event (`at`), not when this page received
				// it: a replay delivers minutes of a response in one burst, and timing that would report a
				// thousands-of-tokens/second rate for a model that streamed at twenty. With no stamp (an older
				// server) arrival is the only clock there is.
				const at = typeof frame.at === "number" ? frame.at : Date.now();
				const clock = () => at;
				chat.transcript = applyEvent(chat.transcript, event, clock, frame.seq);
				chat.metrics = applyPerfEvent(chat.metrics, event, clock);
				// The rates belong to this chat on the model that answered it, so they are kept per session and
				// say which model they came from (ui/lib/last-answer.ts). What is kept is the question's average —
				// the same sum the strip shows — so reopening a chat brings back those numbers, not one answer's.
				if (event.type === "message_end" && hasMeasurement(chat.metrics.run) && chat.sessionPath) {
					const measuredOn = chat.modelInUse;
					if (measuredOn) chat.measuredOn = measuredOn;
					saveLastAnswer(chat.sessionPath, { ...chat.metrics.run, model: measuredOn });
				}
				// Context usage is a server-side estimate (pi's `getContextUsage`), and it only becomes
				// trustworthy when the turn's answer lands — so the gauge is refreshed with the turn.
				if (event.type === "agent_settled") {
					// A turn that finished somewhere you were not looking is unread; the one you watched is not.
					chat.unread = chat.id !== this.activeChatId;
					this.showDebug(chat);
					// The list's own `running` flag has to catch up too: a row the page holds reads its chat, but a
					// session it does not hold is only answered by this.
					this.listSessions();
					this.#announceSettled(chat);
				}
				if (event.type === "agent_start") chat.unread = false;
				// A chat earns its row with its first message: pi writes the session file on its first entry,
				// so before that there is nothing to list. Once, and only once, per conversation.
				if (!chat.rowRequested && chat.transcript.messages.some((message) => message.role === "user")) {
					chat.rowRequested = true;
					this.listSessions();
				}
				// A turn starting or settling changes which chats need a live subscription.
				if (event.type === "agent_start" || event.type === "agent_settled") this.#syncSubscriptions();
				return;
			}
			case "extensionUi": {
				// Addressed like an event frame: an extension speaks for one conversation, and its question is
				// answered against that conversation — the page shows the active chat's, and keeps the others'.
				const chat = this.chats.find((candidate) => candidate.conversationId === frame.conversationId);
				if (!chat) return;
				if (frame.kind === "notify") {
					chat.extensionNotes = [...chat.extensionNotes.slice(-49), { message: frame.message, level: frame.level ?? "info" }];
					return;
				}
				chat.extensionDialog = frame;
				return;
			}
			case "mcpAuth":
				// The URL a sign-in is waiting on its redirect for. Nothing else carries it: this page asked for
				// the sign-in, so it knows which row the frame belongs to.
				this.mcpSignIn = { name: frame.name, url: frame.url };
				return;
			case "result": {
				// A result carrying a conversation *and* a session path is the server naming the conversation
				// that answers a file — the answer to `newSession`, `switchSession` or `fork`. It is recognised
				// structurally so a page recovering from a restart, which may not know the request it made,
				// still lands on the right chat.
				const target = frame.requestId ? this.#bindTargets.get(frame.requestId) : undefined;
				const binding = target ?? (frame.conversationId && frame.sessionPath ? { kind: "open" as const } : undefined);
				if (binding && frame.conversationId) {
					if (frame.requestId) this.#bindTargets.delete(frame.requestId);
					const chat = this.#adopt(frame.conversationId, frame.sessionPath, binding);
					// The daemon answers this with the session it cut short, so the chat can say why the last
					// answer stops where it does. Opening a later turn replaces it.
					chat.interruptedAt = frame.interrupted?.at;
					// The sidebar's model and thinking selectors list what the live session offers, and the list
					// itself is the navigation: both are refetched for every new, opened or forked conversation.
					this.showDebug(chat);
					this.listSessions();
				}
				if (frame.sessions) this.sessions = frame.sessions;
				if (frame.config) {
					if (frame.requestId) this.#configRequests.delete(frame.requestId);
					this.config = frame.config;
					// Files as they are now, so a refusal that came before them stops being shown.
					this.configError = undefined;
					// And the last answer describes servers that may no longer be in the file: drop it rather than
					// showing a connection state for a server that was just renamed or deleted.
					this.mcpStatus = undefined;
				}
				if (frame.debug) {
					// The snapshot is routed to the chat that asked for it — by request id first, then by the
					// conversation the server named — so a late reply for a chat you left refreshes that chat's
					// selectors and context gauge, never the one on screen.
					const askedFor = frame.requestId ? this.#debugTargets.get(frame.requestId) : undefined;
					if (frame.requestId) this.#debugTargets.delete(frame.requestId);
					const chat = this.chats.find((candidate) => candidate.id === askedFor) ?? (frame.conversationId ? this.chats.find((candidate) => candidate.conversationId === frame.conversationId) : undefined) ?? this.#activeChat();
					if (chat) {
						chat.debug = frame.debug;
						// The snapshot names the model this conversation is on, so it is also what retires numbers
						// that were measured on a different one.
						this.#keepNumbersFor(chat, modelName(frame.debug));
					}
				}
				if (frame.scheduler) this.scheduler = frame.scheduler;
				if (frame.secrets) {
					if (frame.requestId) this.#secretsRequests.delete(frame.requestId);
					this.secrets = frame.secrets;
					// A snapshot is the truth about the vault, so a refusal that came before it stops being shown.
					this.secretsError = undefined;
				}
				if (frame.revealed) {
					if (frame.requestId) this.#secretsRequests.delete(frame.requestId);
					// The value arrives here and nowhere else. Its row's use count is deliberately not refreshed
					// for it: that would be a second round trip to show a number nobody is waiting for.
					this.revealed = frame.revealed;
				}
				if (frame.memory) {
					if (frame.requestId) this.#memoryRequests.delete(frame.requestId);
					this.memories = frame.memory;
					// A snapshot is the truth about the store, so a refusal that came before it stops being shown.
					this.memoryError = undefined;
				}
				if (frame.mcpStatus) {
					if (frame.requestId) this.#configRequests.delete(frame.requestId);
					this.mcpStatus = frame.mcpStatus;
					this.mcpChecking = false;
					// A status this fresh was taken after a sign-in ended, so the URL and the paste box have
					// nothing left to be for.
					this.mcpSignIn = undefined;
					this.mcpSigningIn = false;
				}
				if (frame.pi) {
					if (frame.requestId) this.#configRequests.delete(frame.requestId);
					this.piVersions = frame.pi;
					this.piBusy = false;
				}
				if (frame.packages) {
					if (frame.requestId) this.#configRequests.delete(frame.requestId);
					this.packages = frame.packages;
					this.packagesBusy = false;
					// The list is what the last install or removal produced, so a refusal that came before it
					// stops being shown.
					this.configError = undefined;
				}
				this.#pendingRequest.get(frame.requestId)?.(frame);
				this.#pendingRequest.delete(frame.requestId);
				return;
			}
			case "error": {
				// A panel's own failure belongs in that panel, not on the chat's error line.
				if (frame.requestId && this.#updateRequests.delete(frame.requestId)) {
					this.updateError = frame.message;
					this.updateInstalling = false;
					return;
				}
				if (frame.requestId && this.#schedulerRequests.delete(frame.requestId)) {
					this.schedulerError = frame.message;
					return;
				}
				// A conversation the server has forgotten — a new process, or a session it evicted — would make
				// every later command fail. It is recovered from rather than reported: the page reopens the
				// session it was showing as a conversation of its own, so the chat comes back by itself.
				if (frame.code === "unknownConversation" && frame.conversationId) {
					const chat = this.chats.find((candidate) => candidate.conversationId === frame.conversationId);
					if (chat && !chat.rebinding) {
						this.#recover(chat);
						return;
					}
					// A conversation this page no longer holds: nothing to recover, and nothing a user can act on.
					if (!chat) return;
				}
				// A failure that names a chat is that chat's, even when the chat is not the one on screen.
				const about = frame.conversationId ? this.chats.find((candidate) => candidate.conversationId === frame.conversationId) : undefined;
				if (about) about.error = frame.message;
				else this.pageError = frame.message;
				if (frame.requestId && this.#configRequests.delete(frame.requestId)) {
					this.configError = frame.message;
					// A failed probe leaves nothing to show, so the button goes back to being pressable.
					this.mcpChecking = false;
					// Same for a sign-in that failed or was cancelled: the URL is only worth showing while the
					// sign-in that produced it is alive.
					this.mcpSignIn = undefined;
					this.mcpSigningIn = false;
					// And an install the server refused (a source it could not fetch) leaves the list as it was:
					// the button goes back to being pressable. Same for a pi version the server would not move to.
					this.packagesBusy = false;
					this.piBusy = false;
					return;
				}
				if (frame.requestId && this.#secretsRequests.delete(frame.requestId)) {
					this.secretsError = frame.message;
					// A reveal the vault refused (a name that is not there) leaves nothing to hide, and a failed
					// write leaves the snapshot as it was — both are said once, in the panel that asked.
					this.revealed = undefined;
				}
				if (frame.requestId && this.#memoryRequests.delete(frame.requestId)) {
					// The store refused an edit (a row that is not there, an undo of a write) or this process has
					// no memory database at all. Nothing changed, so the refusal has to be said where the row is.
					this.memoryError = frame.message;
				}
				return;
			}
		}
	}
}

/** The last thing the assistant said, for a notification body. Empty turns fall back to a plain sentence. */
function lastSpoken(transcript: Transcript): string {
	for (let index = transcript.messages.length - 1; index >= 0; index -= 1) {
		const message = transcript.messages[index];
		if (!message || message.role !== "assistant") continue;
		const text = message.blocks
			.filter((block) => block.kind === "text")
			.map((block) => (block.kind === "text" ? block.text : ""))
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();
		if (text) return text.length > 160 ? `${text.slice(0, 157)}…` : text;
	}
	return "Finished its turn.";
}

let chatCounter = 0;
let counter = 0;
function nextId(): string {
	return `ui-${++counter}`;
}
