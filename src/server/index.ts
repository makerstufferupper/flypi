/**
 * The flypi server: `node:http` + `ws` on 127.0.0.1 behind a token
 * (docs/architecture.md Phase 1–2, docs/protocol.md). No framework; one WS endpoint and the
 * built UI's static files.
 *
 * The daemon options (`health`, `scheduler`, `interruptedRun`) are all optional: `npm run serve` stays a
 * foreground server with no job queue and no memory store, and answers 404 for `/healthz`.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { extname, resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from "../shared/attachments.ts";
import { parsePath, VIEW_PATHS } from "../shared/views.ts";
import { PROTOCOL_VERSION, encodeFrame, parseClientCommand, type InterruptedRun, type PiVersions, type ResultFrame, type SchedulerSnapshot, type ServerFrame } from "./protocol.ts";
import type { PiInfo } from "../daemon/pi.ts";
import type { MemoryApi } from "./memory-api.ts";
import type { SessionRegistry } from "./session-registry.ts";
import type { SecretsApi } from "./secrets-api.ts";

export interface FlypiServerOptions {
	registry: SessionRegistry;
	/** Omit to generate one per run; `start.mjs` prints it in the URL (Phase 7). */
	token?: string;
	port?: number;
	host?: string;
	serverVersion?: string;
	/**
	 * Which pi this process loaded (docs/pi-upgrades.md Phase 8.1). Sent in `hello` so a client knows what it
	 * is talking to before it asks for anything; `/healthz` carries the same object for `flypi status`.
	 */
	pi?: () => PiInfo;
	/** How often to sweep idle, unattached conversations. */
	evictIntervalMs?: number;
	/** Built UI to serve (`npm run build`). Omit and the server is headless, as in Phase 1. */
	uiDir?: string;
	/**
	 * Answers `GET /healthz` — the daemon's liveness page for `flypi status` and the service manager
	 * (Phase 4.5). Absent means this process is not a daemon, and `/healthz` is a 404.
	 */
	health?: () => Record<string, unknown>;
	/**
	 * The page's "install now" for a downloaded update (docs/architecture.md Phase 7). Starts the install and
	 * the restart that follows it, so it answers before the work is done: null when it started, a reason when
	 * it did not. Absent in a process that does not manage its own updates — a checkout, or `npm run serve`.
	 */
	installUpdate?: () => Promise<string | null>;
	/** Which pi this process runs and what it could move to (docs/pi-upgrades.md Phase 8.4). */
	piVersions?: () => PiVersions;
	/** The registry asked now, with the answer written to the stamp. Absent where `piVersions` is. */
	piCheck?: () => Promise<PiVersions>;
	/** Move to a pi version and restart. Null when it started; a sentence when it refused. */
	usePi?: (version: string) => Promise<string | null>;
	/** The scheduler tab: what is queued, when it next runs, what the last runs changed. */
	scheduler?: () => SchedulerSnapshot;
	/**
	 * The Secrets tab (docs/secrets.md Phase 5.5). Absent in a process that opened no vault — a client then
	 * gets an error frame saying so, the same way the scheduler tab answers in a process without a daemon.
	 */
	secrets?: SecretsApi;
	/**
	 * The Memory tab (docs/memory.md Phase 6). Present where the process can reach the memory database: the
	 * daemon (which owns it) and a dev/serve process that opened it read-only. Anywhere else the tab answers
	 * with an error frame rather than an empty store, which would read as "nothing remembered".
	 */
	memory?: MemoryApi;
	/**
	 * Was a turn in this session file cut short when the daemon went away? Asked when a client opens that
	 * session, so the chat can say so instead of showing a half-finished answer with no explanation.
	 */
	interruptedRun?: (sessionFile: string) => InterruptedRun | undefined;
}

export interface FlypiServerHandle {
	port: number;
	host: string;
	token: string;
	url: string;
	/** How many pages are attached to this process right now. */
	clients(): number;
	close(): Promise<void>;
}

/** Per-socket state for one conversation. `lastSent` is the dedupe guard between replay and live frames. */
interface Subscription {
	lastSent: number;
	detach: () => void;
	detachUi: () => void;
}

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".svg": "image/svg+xml",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".map": "application/json",
};

export async function startFlypiServer(options: FlypiServerOptions): Promise<FlypiServerHandle> {
	const host = options.host ?? "127.0.0.1";
	const token = options.token ?? randomUUID();
	const registry = options.registry;

	const httpServer = createServer((request, response) => {
		const path = new URL(request.url ?? "/", `http://${host}`).pathname;
		// The UI reads its token here instead of parsing it out of a printed URL. Same origin as the
		// page, so dev (via the Vite proxy) and prod use one client.
		if (path === "/__flypi.json") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, token, wsPath: "/ws" }));
			return;
		}
		// Unauthenticated, like `/__flypi.json`: it says only that a daemon is up, and `launchd`/systemd
		// have to be able to poll it without being handed the token.
		if (path === "/healthz") {
			if (!options.health) {
				response.writeHead(404, { "content-type": "application/json" });
				response.end('{"ok":false,"reason":"this process is not a daemon"}\n');
				return;
			}
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ ok: true, ...options.health() }));
			return;
		}
		if (serveStatic(path, response)) return;
		response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		response.end("not found\n");
	});
	// ws' default maxPayload is 1 MiB, which a pasted screenshot comfortably exceeds. A prompt may carry
	// the whole attachment allowance, and base64 is 4/3 of those bytes: deriving the frame limit from the
	// same constants means "too big for the socket" (a close the chat cannot explain) never happens
	// before "too big" (a refusal the chat can show).
	const maxFrameBytes = Math.ceil((MAX_ATTACHMENTS * MAX_ATTACHMENT_BYTES * 4) / 3) + 64 * 1024;
	const webSockets = new WebSocketServer({ server: httpServer, maxPayload: maxFrameBytes });
	// `ws` mirrors the HTTP server's own `error` onto the WebSocketServer. With no listener here that is an
	// unhandled 'error' and the process dies on the spot — which is how a bind failure would skip the caller's
	// chance to report it and retry on another port (src/daemon/index.ts). The bind failure itself is reported
	// through the `listen` promise at the bottom of this function.
	webSockets.on("error", () => {});

	/** Serve the built UI. Nothing here is dynamic: the app's data all comes over the socket. */
	function serveStatic(path: string, response: ServerResponse): boolean {
		if (!options.uiDir || !existsSync(options.uiDir)) {
			if (path !== "/") return false;
			response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
			response.end("flypi agent server — connect over WebSocket; see docs/protocol.md\n");
			return true;
		}
		// The app's views and its conversations are addresses, not files (ui/lib/route.ts): `/settings` and
		// `/sessions/<id>` are the same page as `/`, so a reload or a bookmark lands on what it names instead of a 404.
		const page =
			path === "/" || parsePath(path).session || (VIEW_PATHS as readonly string[]).includes(path.slice(1)) ? "/index.html" : path;
		const file = resolve(options.uiDir, `.${page}`);
		if (!file.startsWith(resolve(options.uiDir)) || !existsSync(file)) return false;
		response.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
		response.end(readFileSync(file));
		return true;
	}

	webSockets.on("connection", (socket: WebSocket, request: IncomingMessage) => {
		const url = new URL(request.url ?? "/", `http://${host}`);
		if (url.searchParams.get("token") !== token) {
			socket.close(4401, "unauthorized");
			return;
		}

		const subscriptions = new Map<string, Subscription>();
		const send = (frame: ServerFrame) => {
			if (socket.readyState === socket.OPEN) socket.send(encodeFrame(frame));
		};
		const fail = (message: string, extra: { code?: string; requestId?: string; conversationId?: string } = {}) =>
			send({ type: "error", message, ...extra });
		/** Reply to a command that asked for one. `prompt` is deliberately not in that set: its events are the answer. */
		const reply = (requestId: string | undefined, extra: Omit<ResultFrame, "type" | "requestId"> = {}) => {
			if (requestId) send({ type: "result", requestId, ...extra });
		};

		/**
		 * Start (or keep) this socket's subscription to a conversation; `afterSeq` replays what it missed.
		 *
		 * Subscriptions are additive: one socket may follow several conversations, because a page holds every
		 * session it has opened — the one on screen and any background turn still running. Nothing is detached
		 * here; a client that is finished with an idle conversation says so with `unsubscribe`, which is what
		 * lets `evictIdle` release it.
		 */
		const subscribe = (conversationId: string, afterSeq?: number) => {
			let subscription = subscriptions.get(conversationId);
			if (!subscription) {
				const state: Subscription = { lastSent: 0, detach: () => {}, detachUi: () => {} };
				state.detach = registry.attach(conversationId, (seq, event, at) => {
					if (seq <= state.lastSent) return;
					state.lastSent = seq;
					// `at` is the backend's own clock: it is what lets a client attaching late measure the
					// response's real window rather than the burst its replay arrived in.
					send({ type: "event", conversationId, seq, at, event });
				});
				// Extension output is not a pi event, so it has no seq to dedupe: the page sees each frame once,
				// live, and a dialog it was not connected for is simply missed (src/server/extension-ui.ts).
				state.detachUi = registry.attachUi(conversationId, send);
				subscription = state;
				subscriptions.set(conversationId, state);
			}
			if (afterSeq === undefined) return;
			subscription.lastSent = afterSeq;
			const replay = registry.log(conversationId).replayAfter(afterSeq);
			if (replay.gap) {
				// Tell the client its transcript has a hole rather than pretending it does not.
				fail(`events 1–${registry.log(conversationId).evictedThroughSeq} were dropped; reload the transcript`, {
					code: "replay_gap",
					conversationId,
				});
			}
			for (const entry of replay.events) {
				if (entry.seq <= subscription.lastSent) continue;
				subscription.lastSent = entry.seq;
				// Replay is history the page never saw: it resumes from its cursor, so this frame is not a turn
				// that just happened, and the page must not treat it as one.
				send({ type: "event", conversationId, seq: entry.seq, at: entry.at, event: entry.event, replay: true });
			}
		};

		/** Stop following one conversation. The pi session behind it is untouched: only this socket lets go. */
		const unsubscribe = (conversationId: string) => {
			const subscription = subscriptions.get(conversationId);
			if (!subscription) return;
			subscription.detach();
			subscription.detachUi();
			subscriptions.delete(conversationId);
		};

		// `now` is this process's clock, so a client on another machine can put its own ticking windows on
		// the same timeline the events are stamped with instead of a skew's worth of milliseconds off.
		send({ type: "hello", protocolVersion: PROTOCOL_VERSION, serverVersion: options.serverVersion ?? "dev", now: Date.now(), ...(options.pi ? { pi: options.pi() } : {}) });

		const handle = async (raw: string): Promise<void> => {
			const parsed = parseClientCommand(raw);
			if (!parsed.ok) return fail(parsed.message);
			const command = parsed.command;
			const requestId = command.requestId;
			const conversationId = "conversationId" in command ? command.conversationId : undefined;
			const onError = (error: Error & { code?: string }) => {
				// What the page was told, in the dev log: an error frame alone leaves a stuck UI inexplicable.
				console.error(`flypi: ${command.type} failed: ${error.message}${conversationId ? ` (conversation ${conversationId})` : ""}`);
				fail(error.message, { ...(error.code ? { code: error.code } : {}), requestId, conversationId });
			};

			try {
				switch (command.type) {
					case "newSession": {
						const conversation = await registry.create();
						subscribe(conversation.id); // attach before the first event can fire: a new conversation loses nothing
						reply(requestId, { conversationId: conversation.id, sessionPath: conversation.session.sessionFile });
						return;
					}
					case "resume":
						subscribe(command.conversationId, command.afterSeq);
						return;
					case "unsubscribe":
						unsubscribe(command.conversationId);
						return reply(requestId, { conversationId });
					case "extensionReply":
						// The answer to an extension's question. Nothing waiting on that id means it timed out or
						// another tab answered it, and the page has to stop showing the dialog either way.
						if (!registry.replyExtension(command.conversationId, command.dialogId, command.value)) {
							return fail(`no extension dialog ${command.dialogId} is waiting for an answer`, { requestId });
						}
						return reply(requestId, { conversationId });
					case "prompt":
						subscribe(command.conversationId);
						// Awaits the whole run; that is fine because each message is handled independently and
						// the events are already streaming. A rejection (bad mode, no model) is the error frame.
						await registry.prompt(command.conversationId, command.text, command.mode, command.attachments);
						return;
					case "abort":
						subscribe(command.conversationId);
						await registry.abort(command.conversationId);
						return reply(requestId, { conversationId });
					case "switchSession": {
						const switched = await registry.switchSession(command.sessionPath);
						// A turn the last process left half-done is reported with the session it belongs to — the
						// client is about to render that chat, and nothing else tells it why the last answer stops short.
						const interrupted = options.interruptedRun?.(switched.session.sessionFile ?? "");
						// Opened but not followed: the client is handed the conversation id and decides what to
						// watch. Following it here would make every session ever clicked a live subscription, and
						// an unattached idle conversation is what `evictIdle` exists to release.
						return reply(requestId, {
							conversationId: switched.id,
							sessionPath: switched.session.sessionFile,
							...(interrupted ? { interrupted } : {}),
						});
					}
					case "fork": {
						const forked = await registry.fork(command.conversationId, command.messageSeq);
						subscribe(forked.id);
						return reply(requestId, { conversationId: forked.id, sessionPath: forked.session.sessionFile });
					}
					case "setModel":
						subscribe(command.conversationId);
						await registry.setModel(command.conversationId, command.provider, command.modelId);
						return reply(requestId, { conversationId });
					case "setThinkingLevel":
						subscribe(command.conversationId);
						registry.setThinkingLevel(command.conversationId, command.level);
						return reply(requestId, { conversationId });
					case "listSessions":
						// Not conversation-scoped: it lists the session files flypi owns, for the sidebar.
						return reply(requestId, { sessions: await registry.listSessions() });
					case "renameSession":
						registry.rename(command.conversationId, command.name);
						return reply(requestId, { conversationId });
					case "deleteSession":
						// The refreshed list comes back with the ack: the sidebar is the only caller, and what it
						// needs after a delete is the list without the deleted row in it.
						await registry.deleteSession(command.sessionPath);
						return reply(requestId, { sessions: await registry.listSessions() });
					case "debug":
						return reply(requestId, { conversationId, debug: await registry.debugInfo(command.conversationId) });
					case "installUpdate":
						// The daemon's own update path, asked for when the user will not wait for the idle moment.
						// The ack goes out before the restart, because the restart closes this socket.
						if (!options.installUpdate) return fail("this flypi process does not manage its own updates — it is a checkout or a headless server", { requestId });
						return options.installUpdate().then((why) => (why ? fail(why, { requestId }) : reply(requestId)));
					case "scheduler":
						// The queue belongs to the daemon, not to a conversation, so a process without one says so
						// in an error frame the panel can show rather than rendering an empty table.
						if (!options.scheduler) return fail("this flypi process has no scheduler — `flypi start` runs one", { requestId });
						return reply(requestId, { scheduler: options.scheduler() });
					case "getConfig":
						// Config files, not conversations: the settings panel reads what is on disk.
						return reply(requestId, { config: registry.configSnapshot() });
					case "saveConfig":
						// The refreshed files come back with the ack, as with deleteSession: the panel's next
						// thing to show is what the write produced.
						return reply(requestId, { config: registry.saveConfig(command) });
					case "packages":
						// The packages the agent loads, read from the agent dir. No network: what has an update
						// waiting comes from the daemon's daily stamp (src/agent/packages.ts).
						return reply(requestId, { packages: registry.packages() });
					case "savePackages":
						// npm or git does the work, so this is the slow one of the settings commands; the page shows a
						// busy state while it is open. The refreshed list comes back with the ack, as with saveConfig.
						return reply(requestId, { packages: await registry.applyPackages(command) });
					case "piVersions":
						// Which pi answers, and what could be moved to. The daemon's daily stamp, never a live
						// check — the same rule `packages` follows.
						if (!options.piVersions) return fail("this flypi process does not manage pi versions — it is a checkout or a headless server", { requestId });
						return reply(requestId, { pi: options.piVersions() });
					case "piCheck":
						// The daily stamp, refreshed on request. Slow by nature (one registry call), and the fresh
						// answer comes back as the same `pi` frame the `piVersions` command sends.
						if (!options.piCheck) return fail("this flypi process does not manage pi versions — it is a checkout or a headless server", { requestId });
						return options.piCheck().then((pi) => reply(requestId, { pi }));
					case "usePi":
					case "rollbackPi": {
						// The pointer moves and the daemon restarts through the CLI, so the ack has to go out
						// first: this socket is the one being replaced. What the page shows afterwards is the
						// version the new process reports, not a promise about this one.
						if (!options.usePi) return fail("this flypi process does not manage pi versions — in a checkout, `npm install @earendil-works/pi-coding-agent@X && npm test && npm run smoke`", { requestId });
						return options.usePi(command.version).then((why) => (why ? fail(why, { requestId }) : reply(requestId)));
					}
					case "mcpStatus":
						// Not config and not a conversation: the servers themselves are asked. Slow by nature (a
						// stdio server has to start), which is why the panel asks once and shows a busy state
						// rather than polling (src/agent/mcp-status.ts).
						return reply(requestId, { mcpStatus: await registry.mcpStatus() });
					case "mcpSignIn":
						// The browser round-trip (risk 5). This request stays open for the whole sign-in: the URL is
						// pushed as an `mcpAuth` frame, the redirect arrives as `mcpRedirect`, and the ack is the
						// refreshed status — the row the user was looking at, answering now that it has a token.
						await registry.mcpSignIn(command.name, (url) => send({ type: "mcpAuth", name: command.name, url }));
						return reply(requestId, { mcpStatus: await registry.mcpStatus() });
					case "mcpRedirect":
						// No ack of its own: the `mcpSignIn` still open is what answers this, and a sign-in that
						// failed is an `error` frame for that request. Here there is only one thing to say: that
						// nothing was waiting for this paste.
						if (!registry.submitMcpRedirect(command.name, command.url)) {
							return fail(`no sign-in is waiting for "${command.name}" — start one with "Sign in"`, { requestId });
						}
						return;
					case "secrets":
						if (!options.secrets) return fail("this flypi process has no vault open", { requestId });
						return reply(requestId, { secrets: options.secrets.snapshot() });
					case "saveSecrets":
						if (!options.secrets) return fail("this flypi process has no vault open", { requestId });
						// The refreshed list comes back with the ack, as with saveConfig: the page should show what
						// the vault holds now, including the mask it chose for a value it never sends back.
						return reply(requestId, { secrets: options.secrets.apply(command.secrets) });
					case "revealSecret": {
						if (!options.secrets) return fail("this flypi process has no vault open", { requestId });
						const revealed = options.secrets.reveal(command.name);
						if (revealed === undefined) return fail(`no secret named "${command.name}"`, { requestId });
						return reply(requestId, { revealed });
					}
					case "memory":
						if (!options.memory) return fail("this flypi process has no memory store open — `flypi start` runs the one that owns it", { requestId });
						return reply(requestId, { memory: options.memory.snapshot() });
					case "saveMemory":
						if (!options.memory) return fail("this flypi process has no memory store open — `flypi start` runs the one that owns it", { requestId });
						// The refreshed store comes back with the ack, as with saveSecrets: the panel's next thing to
						// show is what the write produced, including the audit row it just wrote.
						return reply(requestId, { memory: options.memory.apply(command.memories) });
				}
			} catch (error) {
				onError(error as Error);
			}
		};

		// Never await here: a prompt must not block the next command on the same socket.
		socket.on("message", (data) => void handle(String(data)));

		const drop = () => {
			for (const subscription of subscriptions.values()) {
				subscription.detach();
				subscription.detachUi();
			}
			subscriptions.clear();
		};
		socket.on("close", drop);
		socket.on("error", drop);
	});

	const sweep = setInterval(() => registry.evictIdle(), options.evictIntervalMs ?? 60_000);
	sweep.unref();

	const port = await new Promise<number>((resolvePort, reject) => {
		httpServer.once("error", reject);
		httpServer.listen(options.port ?? 0, host, () => {
			const address = httpServer.address();
			if (address && typeof address === "object") resolvePort(address.port);
			else reject(new Error("could not bind the flypi server socket"));
		});
	});

	return {
		port,
		host,
		token,
		url: `ws://${host}:${port}`,
		/** How many pages are attached. The daemon's sweep trigger reads this: a sweep waits for the quiet a
		 *  live conversation does not give it (docs/memory.md Phase 6). */
		clients: () => webSockets.clients.size,
		close: () =>
			new Promise<void>((resolveClose) => {
				clearInterval(sweep);
				for (const client of webSockets.clients) client.terminate();
				webSockets.close();
				httpServer.close(() => resolveClose());
			}),
	};
}
