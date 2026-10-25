/**
 * All of the UI's state, and every command it can send, in one class with no DOM in it.
 *
 * `App.svelte` renders this; the UI tests drive it with a fake transport and assert the DOM that
 * comes out. The transcript itself is never held twice: it is the reducer's output, and a reconnect
 * replays it through the same `applyEvent` the live stream uses (docs/protocol.md).
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

export class FlypiAppState {
	/** The rendered conversation. Rebuilt by the reducer, never by the components. */
	transcript = $state<Transcript>(emptyTranscript());
	/** Speed and context metrics for the same event stream — a second reducer over the same frames. */
	metrics = $state<Perf>(emptyPerf());
	/** The model `metrics.last` was measured on. A rate describes a model, so this is part of the number. */
	measuredOn = $state<string | null>(null);
	conversationId = $state<string | undefined>(undefined);
	sessionPath = $state<string | undefined>(undefined);
	sessions = $state<SessionSummary[]>([]);
	debug = $state<DebugInfo | undefined>(undefined);
	/**
	 * The daemon's job queue, for the activity panel's scheduler section (Phase 4.5). Asked when that
	 * section is opened, never on a timer — and a plain `npm run serve` has no queue to show.
	 */
	scheduler = $state<SchedulerSnapshot | undefined>(undefined);
	/**
	 * When the daemon says a turn in this session was cut short by a restart. The chat has to say so: a
	 * half-finished answer with no explanation reads as a model that stopped talking.
	 */
	interruptedAt = $state<string | undefined>(undefined);
	/** The agent dir's config files, as the server last read them; the settings panel edits them. */
	config = $state<ConfigSnapshot | undefined>(undefined);
	/**
	 * Which of the page's views is up: the chat, settings, or the vault (App.svelte). Here rather than in one
	 * component because the sidebar opens all three, each view has a way back, and the address bar mirrors it
	 * (ui/lib/route.ts).
	 */
	view = $state<View>("chat");
	connected = $state(false);
	/** Last thing the server told us went wrong — shown in the chat, not swallowed. */
	lastError = $state<string | undefined>(undefined);
	/**
	 * A config edit the server refused. It belongs here rather than only in `lastError` because the settings
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
	/**
	 * What the session's extensions said to the user this conversation (`extensionUi` frames): a notification
	 * from a slash command, or the answer it gave back. Not part of the transcript — pi puts it nowhere the
	 * session file holds (src/server/extension-ui.ts), so it lives here and is lost on a reload.
	 */
	extensionNotes = $state<{ message: string; level: string }[]>([]);
	/**
	 * A question an extension is waiting on (`ctx.ui.select` / `confirm` / `input`). Its handler is parked
	 * until the page answers with `extensionReply`, so this is the one piece of state that must not be
	 * dismissed silently — the server also releases it after five minutes of nobody answering.
	 */
	extensionDialog = $state<ExtensionUiFrame | undefined>(undefined);
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
	#lastSeq = 0;
	// Whether this conversation has asked for the session list since it was bound — see the event case.
	#rowRequested = false;
	/**
	 * The model this conversation answers on, as the app last heard it: from a debug snapshot, or from a model
	 * you just picked. It is the model the next answer's numbers belong to. Asking whichever snapshot happens
	 * to be on hand instead is what made a model you had just chosen retire the numbers measured on it, and
	 * what blanked the numbers of a question asked before the first snapshot landed.
	 */
	#modelInUse: string | null = null;
	/**
	 * The session to open on the next conversation the server hands us. Set when the server says the
	 * conversation this page held no longer exists (see the error case), so a fresh registry costs the
	 * chat on screen nothing but a round trip.
	 */
	#rebindTo: string | undefined;
	#pendingRequest = new Map<string, (result: { conversationId?: string; sessionPath?: string; sessions?: SessionSummary[]; debug?: DebugInfo; config?: ConfigSnapshot; scheduler?: SchedulerSnapshot }) => void>();
	#updateRequests = new Set<string>();

	constructor(transport: Transport) {
		this.#transport = transport;
	}

	/** Subscribe to the transport. Call once; the first conversation arrives with the connection. */
	watch(): () => void {
		return this.#transport.on((signal) => {
			if (signal.type === "connected") {
				this.connected = true;
				// Re-attach, don't reload: a reconnect replays the event log, it is not a fresh start.
				if (this.conversationId) this.send({ type: "resume", conversationId: this.conversationId, afterSeq: this.#lastSeq });
				else this.newSession();
				// The chat needs the config files too, not only the settings view: with no endpoint configured the
				// first thing the page should do is say so (ui/Chat.svelte) rather than let the first prompt fail.
				// Three file reads per connect, not a poll — and not when the page opens on a view that asks for the
				// files itself.
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

	/** Commands that answer with a result frame: give them a request id and wait for it. */
	async request(command: ClientCommand & { requestId: string }): Promise<void> {
		return new Promise((resolve) => {
			this.#pendingRequest.set(command.requestId, resolve as never);
			this.send(command);
		});
	}

	newSession(): void {
		void this.request({ type: "newSession", requestId: nextId() });
	}

	prompt(text: string, mode: "steer" | "followUp" = "steer", attachments: FlypiAttachment[] = []): void {
		if (!this.conversationId) return;
		this.send({ type: "prompt", conversationId: this.conversationId, text, ...(attachments.length ? { attachments } : {}), mode });
	}

	abort(): void {
		if (this.conversationId) this.send({ type: "abort", conversationId: this.conversationId });
	}

	fork(messageSeq: number): void {
		if (!this.conversationId) return;
		void this.request({ type: "fork", conversationId: this.conversationId, messageSeq, requestId: nextId() });
	}

	listSessions(): void {
		void this.request({ type: "listSessions", requestId: nextId() });
	}

	openSession(path: string): void {
		if (!this.conversationId) return;
		// The server decides what opening a session means — reusing the conversation already answering it, or
		// starting one so a turn in flight on this page is not cut short. It answers with the conversation to
		// resume, which is not always the one this page is holding.
		void this.request({ type: "switchSession", conversationId: this.conversationId, sessionPath: path, requestId: nextId() });
	}

	rename(name: string): void {
		if (!this.conversationId) return;
		this.send({ type: "renameSession", conversationId: this.conversationId, name });
	}

	/**
	 * Delete a session file for good — the server answers with the list without it. If it was the session
	 * on screen, the conversation went with it, so the app starts a fresh one rather than sending
	 * commands to a conversation id the server has already forgotten.
	 */
	deleteSession(path: string): void {
		const wasCurrent = path === this.sessionPath;
		forgetLastAnswer(path);
		void this.request({ type: "deleteSession", sessionPath: path, requestId: nextId() }).then(() => {
			if (wasCurrent) this.newSession();
		});
	}

	setModel(provider: string, modelId: string): void {
		if (!this.conversationId) return;
		this.send({ type: "setModel", conversationId: this.conversationId, provider, modelId });
		// No round trip needed to know the model changed: the numbers on screen stop being this chat's.
		this.#keepNumbersFor(`${provider}/${modelId}`);
	}

	/**
	 * A rate describes the model it was measured on, so numbers measured on another model are not this
	 * chat's numbers. Called whenever the model in use may have changed (a debug snapshot, or a model you
	 * just picked): keep what is on screen only if it was measured on this model — and since they are kept
	 * per chat, switching back to a model this chat measured on brings its numbers back.
	 */
	#keepNumbersFor(model: string | null): void {
		if (!model) return;
		this.#modelInUse = model;
		if (!this.sessionPath || this.measuredOn === model) return;
		// Numbers whose model the app never knew were measured in this chat, and this is the first thing that
		// ever named a model — so name them instead of retiring what was just measured. Only numbers known to
		// belong to another model are retired below.
		if (!this.measuredOn && (hasMeasurement(this.metrics.run) || hasMeasurement(this.metrics.last))) {
			this.measuredOn = model;
			if (hasMeasurement(this.metrics.run)) saveLastAnswer(this.sessionPath, { ...this.metrics.run, model });
			return;
		}
		const answer = loadLastAnswer(this.sessionPath);
		const keep = answer && answer.model === model ? answer : null;
		// A rate describes the model that produced it, so the question's average goes with it — that count
		// is live state, not something a round trip could hand back.
		this.metrics = { ...emptyPerf(), last: keep };
		this.measuredOn = keep ? model : null;
	}

	setThinkingLevel(level: FlypiThinkingLevel): void {
		if (!this.conversationId) return;
		this.send({ type: "setThinkingLevel", conversationId: this.conversationId, level });
	}

	/**
	 * Answer an extension's question: the option or text it asked for, or null for "cancelled" — what pi's own
	 * dialogs report when the user dismisses them. The dialog leaves the screen as soon as it is sent: the
	 * server either resolves the handler or says nothing was waiting, and both mean stop showing it.
	 */
	answerExtension(dialogId: string, value: string | null): void {
		if (!this.conversationId) return;
		this.send({ type: "extensionReply", conversationId: this.conversationId, dialogId, value });
		this.extensionDialog = undefined;
	}

	showDebug(): void {
		if (!this.conversationId) return;
		void this.request({ type: "debug", conversationId: this.conversationId, requestId: nextId() });
	}

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

	/**
	 * Move between the page's views. Nothing is fetched here beyond the config the chat needs and never had: a
	 * view asks for its own snapshot when it mounts, which is the same "ask when it is opened, not on a timer"
	 * the debug snapshot uses — and it works for a URL that opens the page there, where these methods are never
	 * called. Leaving the vault is where a revealed value goes: the plaintext has no reason to sit in memory for
	 * a view that is not showing it.
	 */
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

	handleFrame(frame: ServerFrame): void {
		switch (frame.type) {
			case "hello":
				if (frame.protocolVersion !== 1) this.protocolMismatch = `server speaks protocol v${frame.protocolVersion}, this UI speaks v1`;
				this.pi = frame.pi;
				return;
			case "event": {
				// Every event frame is addressed. Once the page holds a conversation, a frame naming another
				// one must not reach the transcript, the activity panel or the seq cursor: a turn started in the
				// chat you left has frames already on the wire when the page moves on, and `#lastSeq` is the
				// resume cursor of the conversation on screen. (Unbound is the startup window only — the server
				// subscribes before it answers `newSession`, and a conversation that never had a prompt has no
				// event to send in it.)
				if (this.conversationId && frame.conversationId !== this.conversationId) return;
				// The only place a transcript changes: the same reducer a replay goes through.
				this.#lastSeq = Math.max(this.#lastSeq, frame.seq);
				// The protocol checks only the discriminator (SessionEventFrameBody); the reducer is the
				// place that knows what each event means, and it ignores what it does not recognise.
				const event = frame.event as AgentSessionEvent;
				this.transcript = applyEvent(this.transcript, event, () => Date.now(), frame.seq);
				this.metrics = applyPerfEvent(this.metrics, event, () => Date.now());
				// The rates belong to this chat on the model that answered it, so they are kept per session and
				// say which model they came from (ui/lib/last-answer.ts). What is kept is the question's average —
				// the same sum the strip shows — so reopening a chat brings back those numbers, not one answer's. A
				// turn with nothing measured (no response, or a provider that reports no usage) keeps nothing. The
				// model named here is the one the app asked this chat to answer on, not whichever snapshot last
				// arrived: a snapshot can be stale (a model you just picked is not in it yet), and a question asked
				// before any snapshot has landed names nothing — that record says so, and the first snapshot that
				// names a model adopts it rather than contradicting it (#keepNumbersFor).
				if (event.type === "message_end" && hasMeasurement(this.metrics.run) && this.sessionPath) {
					const measuredOn = this.#modelInUse;
					if (measuredOn) this.measuredOn = measuredOn;
					saveLastAnswer(this.sessionPath, { ...this.metrics.run, model: measuredOn });
				}
				// Context usage is a server-side estimate (pi's `getContextUsage`), and it only becomes
				// trustworthy when the turn's answer lands — so the gauge is refreshed with the turn, on the
				// one round trip the app can already make.
				if (event.type === "agent_settled") this.showDebug();
				// A chat earns its row with its first message: pi writes the session file on its first entry,
				// so before that there is nothing to list — and the event for the message you just sent is what
				// proves it is written. Once, and only once, per conversation.
				if (!this.#rowRequested && this.transcript.messages.some((message) => message.role === "user")) {
					this.#rowRequested = true;
					this.listSessions();
				}
				return;
			}
			case "extensionUi":
				// Addressed like an event frame: an extension in another conversation has no business on this
				// page, and a dialog left on screen would be answered against the wrong conversation.
				if (this.conversationId && frame.conversationId !== this.conversationId) return;
				// An extension spoke. A notification is this conversation's output and nothing waits on it; a
				// question parks the extension's handler until the page answers (src/server/extension-ui.ts).
				if (frame.kind === "notify") {
					this.extensionNotes = [...this.extensionNotes.slice(-49), { message: frame.message, level: frame.level ?? "info" }];
					return;
				}
				this.extensionDialog = frame;
				return;
			case "mcpAuth":
				// The URL a sign-in is waiting on its redirect for. Nothing else carries it: this page asked for
				// the sign-in, so it knows which row the frame belongs to.
				this.mcpSignIn = { name: frame.name, url: frame.url };
				return;
			case "result": {
				if (frame.sessionPath) {
					// The server just handed us a conversation (new, opened or forked). Its history arrives
					// as the seeded events the registry published, so we ask for the log instead of the file.
					this.transcript = emptyTranscript();
					// The numbers a chat has are its own — measured here, on the model it was using — so opening
					// it is where they come back, and a half-measured response stays with the chat it came from.
					const answer = loadLastAnswer(frame.sessionPath);
					this.metrics = { ...emptyPerf(), last: answer };
					this.measuredOn = answer?.model ?? null;
					// A conversation the server just handed over answers on whatever model its file says, which this
					// page does not know until the snapshot below arrives.
					this.#modelInUse = null;
					this.#lastSeq = 0;
					this.conversationId = frame.conversationId;
					this.sessionPath = frame.sessionPath;
					// Extension output belongs to the conversation that produced it, and an unanswered question
					// belongs to a conversation the server may no longer have.
					this.extensionNotes = [];
					this.extensionDialog = undefined;
					// The daemon answers this with the session it cut short, so the chat can say why the last
					// answer stops where it does. Opening a later turn replaces it.
					this.interruptedAt = frame.interrupted?.at;
					// A session already in the list needs no second look; one that is not in it yet will ask
					// for the list at its first message (below).
					this.#rowRequested = this.sessions.some((session) => session.path === frame.sessionPath);
					if (frame.conversationId) this.send({ type: "resume", conversationId: frame.conversationId, afterSeq: 0 });
					// The sidebar's model and thinking selectors list what the live session offers, so they
					// need this snapshot as soon as a conversation is bound.
					this.showDebug();
					// Every session flypi owns is listed from the start — the list is the navigation, so it is
					// fetched rather than asked for. New, fork and switch all answer with a session path, so
					// this one call keeps the list current for all of them.
					this.listSessions();
					// The replacement conversation opens the session the dead one was showing, so the chat comes
					// back instead of the page landing on an empty new one.
					if (this.#rebindTo && frame.conversationId && this.#rebindTo !== frame.sessionPath) {
						const path = this.#rebindTo;
						this.#rebindTo = undefined;
						void this.request({ type: "switchSession", conversationId: frame.conversationId, sessionPath: path, requestId: nextId() });
					}
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
					this.debug = frame.debug;
					// The snapshot names the model this conversation is on, so it is also what retires numbers
					// that were measured on a different one.
					this.#keepNumbersFor(modelName(frame.debug));
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
				// A conversation the server has forgotten — a new process, or another tab deleted it — would make
				// every later command fail, so the page stops using it and asks for one in its place. That is what a
				// restart looks like, so it is recovered from rather than reported: the chat comes back by itself,
				// and a turn the restart cut short is said in the chat, from the session's own `interruptedAt`.
				// Reporting it left `unknown conversation <uuid>` on screen for the rest of the page's life.
				if (this.conversationId && frame.conversationId === this.conversationId && frame.code === "unknownConversation") {
					this.#rebindTo = this.sessionPath;
					this.newSession();
					return;
				}
				this.lastError = frame.message;
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

let counter = 0;
function nextId(): string {
	return `ui-${++counter}`;
}
