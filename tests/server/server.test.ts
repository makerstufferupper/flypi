/**
 * The Phase 1 gate: a scripted WS client drives a multi-tool turn, disconnects mid-turn,
 * reconnects, and renders the full transcript from replay.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { startFlypiServer, type FlypiServerHandle } from "../../src/server/index.ts";
import { checkServerFrame, PROTOCOL_VERSION, type ClientCommand, type EventFrame, type ServerFrame } from "../../src/server/protocol.ts";
import { MAX_ATTACHMENT_BYTES } from "../../src/shared/attachments.ts";
import { harness, normalize, toolTurn } from "../helpers/flypi-harness.ts";
import { FAKE_ACCESS_TOKEN, startFakeOAuth } from "../helpers/fake-oauth.ts";
import { fauxAssistantMessage, fauxText } from "../helpers/stub-model.ts";

interface Client {
	frames: ServerFrame[];
	send(command: ClientCommand | string): void;
	/** Next frame at or after the internal cursor — frames are never consumed out from under a test. */
	next(match: (frame: ServerFrame) => boolean, timeoutMs?: number): Promise<ServerFrame>;
	close(): Promise<void>;
}

function connect(url: string, token: string): Promise<Client> {
	const socket = new WebSocket(`${url}/?token=${encodeURIComponent(token)}`);
	const frames: ServerFrame[] = [];
	let cursor = 0;
	socket.on("message", (raw) => {
		const frame = JSON.parse(String(raw)) as ServerFrame;
		expect(checkServerFrame(frame).ok, `server sent a frame that violates its own schema: ${String(raw)}`).toBe(true);
		frames.push(frame);
	});
	const opened = new Promise<void>((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});

	return opened.then(() => ({
		frames,
		send: (command: ClientCommand | string) => socket.send(typeof command === "string" ? command : JSON.stringify(command)),
		next: (match, timeoutMs = 10_000) =>
			new Promise((resolve, reject) => {
				const deadline = Date.now() + timeoutMs;
				const poll = () => {
					for (let i = cursor; i < frames.length; i++) {
						if (match(frames[i]!)) {
							cursor = i + 1;
							return resolve(frames[i]!);
						}
					}
					if (Date.now() > deadline) return reject(new Error(`timed out waiting for a frame; frame types=${JSON.stringify(frames.map((frame) => frame.type))}, errors=${JSON.stringify(frames.filter((frame) => frame.type === "error"))}`));
					setTimeout(poll, 5);
				};
				poll();
			}),
		close: () =>
			new Promise<void>((resolve) => {
				socket.once("close", () => resolve());
				socket.close();
			}),
	}));
}

const isDelta = (frame: ServerFrame): boolean =>
	frame.type === "event" &&
	frame.event.type === "message_update" &&
	(frame.event as { assistantMessageEvent?: { type?: string } }).assistantMessageEvent?.type === "text_delta";

const isEvent = (type: string) => (frame: ServerFrame): frame is EventFrame => frame.type === "event" && frame.event.type === type;

/** What a client would render from an event stream: the messages, in order. */
function render(frames: EventFrame[]): string[] {
	return frames
		.filter((frame) => frame.event.type === "message_end")
		.map((frame) => {
			const message = (frame.event as unknown as { message: { role: string; content: unknown } }).message;
			const blocks = Array.isArray(message.content) ? message.content : message.content ? [{ type: "text", text: String(message.content) }] : [];
			const content = blocks.map((block) => {
				const value = block as { type: string; text?: string; name?: string; arguments?: unknown; toolCallId?: string };
				if (value.type === "text") return `text:${value.text}`;
				if (value.type === "toolCall") return `tool:${value.name}:${JSON.stringify(value.arguments)}`;
				return value.type;
			});
			return `${message.role}: ${content.join(" | ")}`;
		});
}

const streamedText = (frames: EventFrame[]) =>
	frames
		.filter((frame) => frame.event.type === "message_update")
		.map((frame) => (frame.event as { assistantMessageEvent?: { delta?: string } }).assistantMessageEvent?.delta ?? "")
		.join("");

/** The seq of the newest `message_end` frame for a role: the handle a client has on a message it showed. */
function lastMessageSeq(frames: ServerFrame[], role: string): number {
	const seq = frames
		.filter((frame): frame is EventFrame => frame.type === "event" && frame.event.type === "message_end" && (frame.event as { message?: { role?: string } }).message?.role === role)
		.at(-1)?.seq;
	if (seq === undefined) throw new Error(`no ${role} message frame to fork from`);
	return seq;
}

describe("flypi server", () => {
	async function start(registry: Parameters<typeof startFlypiServer>[0]["registry"]): Promise<FlypiServerHandle> {
		return startFlypiServer({ registry, evictIntervalMs: 10_000 });
	}

	it("answers the health check on plain HTTP", async () => {
		const h = await harness(toolTurn());
		try {
			const handle = await start(h.registry);
			const response = await fetch(`http://${handle.host}:${handle.port}/`);
			expect(response.status).toBe(200);
			expect(await response.text()).toContain("WebSocket");
			await handle.close();
		} finally {
			h.cleanup();
		}
	});

	it("drops a socket whose token is wrong", async () => {
		const h = await harness(toolTurn());
		try {
			const handle = await start(h.registry);
			const code = await new Promise<number>((resolve) => {
				const socket = new WebSocket(`${handle.url}/?token=nope`);
				socket.on("close", (code) => resolve(code));
			});
			expect(code).toBe(4401);
			await handle.close();
		} finally {
			h.cleanup();
		}
	});

	// ws' default maxPayload is 1 MiB, and a pasted screenshot is routinely bigger than that once it is
	// base64. Both halves of the size story: a big frame must arrive, and an over-limit one must come
	// back as a sentence rather than a socket close.
	it("carries a prompt frame bigger than ws' default limit, and refuses an attachment over ours", async () => {
		const h = await harness(() => [fauxAssistantMessage([fauxText("read it")], { timestamp: 0 })]);
		try {
			const handle = await start(h.registry);
			const client = await connect(handle.url, handle.token);
			try {
				await client.next((frame) => frame.type === "hello");
				client.send({ type: "newSession", requestId: "r1" });
				const created = await client.next((frame) => frame.type === "result" && frame.requestId === "r1");
				if (created.type !== "result" || !created.conversationId) throw new Error("no conversation id");
				const conversationId = created.conversationId;

				client.send({
					type: "prompt",
					conversationId,
					text: "read this",
					attachments: [{ name: "notes.txt", mimeType: "text/plain", data: "a".repeat(1_500_000) }],
					requestId: "r2",
				});
				// The prompt ran: the frame was not dropped for its size.
				await client.next(isEvent("message_end"));

				client.send({
					type: "prompt",
					conversationId,
					text: "too big",
					attachments: [{ name: "huge.png", mimeType: "image/png", data: "a".repeat(MAX_ATTACHMENT_BYTES * 2) }],
					requestId: "r3",
				});
				const refused = await client.next((frame) => frame.type === "error");
				expect(refused.type === "error" && refused.message).toContain("attachments");
			} finally {
				await client.close();
				await handle.close();
			}
		} finally {
			h.cleanup();
		}
	});

	it("drives a multi-tool turn and streams every event to the client", async () => {
		const h = await harness(toolTurn());
		try {
			const handle = await start(h.registry);
			const client = await connect(handle.url, handle.token);
			try {
				await client.next((frame) => frame.type === "hello");
				client.send({ type: "newSession", requestId: "r1" });
				const created = await client.next((frame) => frame.type === "result" && frame.requestId === "r1");
				expect(created.type).toBe("result");
				if (created.type !== "result" || !created.conversationId) throw new Error("no conversation id");
				const conversationId = created.conversationId;

				client.send({ type: "prompt", conversationId, text: "list the files", requestId: "r2" });
				await client.next(isEvent("tool_execution_start"));
				await client.next(isEvent("tool_execution_end"));
				await client.next(isEvent("agent_settled"));

				const events = client.frames.filter((frame): frame is EventFrame => frame.type === "event");
				expect(events.every((frame) => frame.conversationId === conversationId)).toBe(true);
				const answer = events
					.filter((frame) => frame.event.type === "message_update")
					.map((frame) => ((frame.event as { assistantMessageEvent?: { delta?: string } }).assistantMessageEvent?.delta ?? ""))
					.join("");
				expect(answer).toContain("listed the files");
			} finally {
				await client.close();
				await handle.close();
			}
		} finally {
			h.cleanup();
		}
	});

	it("a client that drops mid-turn reconnects to the same transcript", async () => {
		// Slow enough that closing the socket mid-turn is not a race.
		const h = await harness(toolTurn("listed the files, and here is a much longer answer that takes a while to stream out"), {
			tokensPerSecond: 40,
		});
		try {
			const handle = await start(h.registry);
			const newConversation = async (client: Client, requestId: string) => {
				client.send({ type: "newSession", requestId });
				const created = await client.next((frame) => frame.type === "result" && frame.requestId === requestId);
				if (created.type !== "result" || !created.conversationId) throw new Error("no conversation id");
				return created.conversationId;
			};

			// Run A: the socket never drops.
			const steady = await connect(handle.url, handle.token);
			await steady.next((frame) => frame.type === "hello");
			const conversationA = await newConversation(steady, "a1");
			steady.send({ type: "prompt", conversationId: conversationA, text: "list the files" });
			await steady.next(isEvent("agent_settled"));
			const eventsA = steady.frames.filter((frame): frame is EventFrame => frame.type === "event");
			await steady.close();

			// Run B: same script, same server; the socket closes mid-turn and a new one resumes.
			const flaky = await connect(handle.url, handle.token);
			const conversationB = await newConversation(flaky, "b1");
			flaky.send({ type: "prompt", conversationId: conversationB, text: "list the files" });
			await flaky.next(isEvent("tool_execution_end"));
			const beforeDrop = flaky.frames.filter((frame): frame is EventFrame => frame.type === "event");
			const lastSeq = beforeDrop[beforeDrop.length - 1]!.seq;
			await flaky.close();

			// The turn kept running with no client attached; resume replays the rest of it.
			const back = await connect(handle.url, handle.token);
			back.send({ type: "resume", conversationId: conversationB, afterSeq: lastSeq, requestId: "b2" });
			await back.next(isEvent("agent_settled"));
			const afterReplay = back.frames.filter((frame): frame is EventFrame => frame.type === "event");
			await back.close();

			// What the user would render: identical messages, tool calls, tool results and text.
			expect(render(afterReplay.length ? [...beforeDrop, ...afterReplay] : beforeDrop)).toEqual(render(eventsA));
			// Including what streamed: the deltas add up to the same answer.
			expect(streamedText([...beforeDrop, ...afterReplay])).toBe(streamedText(eventsA));
			// And the replay is exactly the missing tail: contiguous seqs, no holes, no duplicates.
			const seqs = [...beforeDrop, ...afterReplay].map((frame) => frame.seq);
			expect(seqs).toEqual(Array.from({ length: seqs.length }, (_unused, index) => index + 1));
			expect(afterReplay.length).toBeGreaterThan(0);
			await handle.close();
		} finally {
			h.cleanup();
		}
	});

	it("applies setThinkingLevel and setModel, and aborts a running turn", async () => {
		const answer = `a long answer that keeps streaming so abort has something to stop `.repeat(12);
		// Text-only script: abort has to land mid-stream, not between a tool call and its answer.
		const h = await harness(() => [fauxAssistantMessage([fauxText(answer)], { timestamp: 0 })], { tokensPerSecond: 40 });
		try {
			const handle = await start(h.registry);
			const client = await connect(handle.url, handle.token);
			try {
				client.send({ type: "newSession", requestId: "r1" });
				const created = await client.next((frame) => frame.type === "result" && frame.requestId === "r1");
				if (created.type !== "result" || !created.conversationId) throw new Error("no conversation id");
				const conversationId = created.conversationId;

				client.send({ type: "setThinkingLevel", conversationId, level: "low", requestId: "r2" });
				await client.next((frame) => frame.type === "result" && frame.requestId === "r2", 2000);
				expect(h.sessions[0]!.session.thinkingLevel).toBe("low");

				client.send({ type: "setModel", conversationId, provider: "flypi-stub", modelId: "stub", requestId: "r3" });
				await client.next((frame) => frame.type === "result" && frame.requestId === "r3", 2000);
				expect(h.sessions[0]!.session.model?.id).toBe("stub");

				client.send({ type: "prompt", conversationId, text: "go" });
				// Wait for real streamed text: the first message_update is `text_start`, which carries nothing.
				await client.next(isDelta, 2000);
				client.send({ type: "abort", conversationId, requestId: "r4" });
				await client.next((frame) => frame.type === "result" && frame.requestId === "r4", 2000);

				// Abort is observable: the run is over and the answer stopped early.
				expect(h.sessions[0]!.session.isStreaming).toBe(false);
				const partial = streamedText(client.frames.filter((frame): frame is EventFrame => frame.type === "event"));
				expect(partial.length).toBeGreaterThan(0);
				expect(partial.length).toBeLessThan(answer.length);
			} finally {
				await client.close();
				await handle.close();
			}
		} finally {
			h.cleanup();
		}
	});

	it("forks a conversation at one of its answers over the socket, and never past one", async () => {
		const h = await harness(toolTurn());
		try {
			const handle = await start(h.registry);
			const client = await connect(handle.url, handle.token);
			try {
				client.send({ type: "newSession", requestId: "r1" });
				const created = await client.next((frame) => frame.type === "result" && frame.requestId === "r1");
				if (created.type !== "result" || !created.conversationId || !created.sessionPath) throw new Error("no conversation");
				const sourceId = created.conversationId;
				const sourcePath = created.sessionPath;

				client.send({ type: "prompt", conversationId: sourceId, text: "list the files" });
				await client.next(isEvent("agent_settled"));

				// The first answer of the turn is the tool call: forking there must leave the text answer out.
				const toolCall = client.frames.find(
					(frame): frame is EventFrame =>
						frame.type === "event" && frame.event.type === "message_end" && (frame.event as { message?: { role?: string } }).message?.role === "assistant",
				);
				if (!toolCall) throw new Error("no answer to fork from");
				client.send({ type: "fork", conversationId: sourceId, messageSeq: toolCall.seq, requestId: "r2" });
				const forked = await client.next((frame) => frame.type === "result" && frame.requestId === "r2");
				if (forked.type !== "result" || !forked.conversationId || !forked.sessionPath) throw new Error("fork returned nothing");
				expect(forked.conversationId).not.toBe(sourceId);
				expect(forked.sessionPath).not.toBe(sourcePath);

				// What the new conversation replays is the conversation up to that answer — the rest of the
				// turn is not in it.
				client.send({ type: "resume", conversationId: forked.conversationId, afterSeq: 0, requestId: "r3" });
				await client.next((frame) => frame.type === "event" && frame.conversationId === forked.conversationId);
				const replayed = client.frames.filter(
					(frame): frame is EventFrame => frame.type === "event" && frame.conversationId === forked.conversationId && frame.event.type === "message_end",
				);
				const replayedText = render(replayed).join("\n");
				expect(replayedText).toContain("list the files");
				expect(replayedText).toContain("tool:bash:");
				expect(replayedText).not.toContain("listed the files");

				// A seq this conversation never carried is an error frame, not a silent whole-session fork.
				client.send({ type: "fork", conversationId: sourceId, messageSeq: 9999, requestId: "r4" });
				const refused = await client.next((frame) => frame.type === "error" && frame.requestId === "r4");
				expect(refused.type === "error" && refused.message).toContain("no message at seq 9999");

				// Switching back to the source hands back the conversation that holds that session — the fork
				// rebinding onto a file another conversation is answering would be a second writer on it.
				client.send({ type: "switchSession", conversationId: forked.conversationId, sessionPath: sourcePath, requestId: "r5" });
				const switched = await client.next((frame) => frame.type === "result" && frame.requestId === "r5");
				if (switched.type !== "result") throw new Error("switch failed");
				expect(switched.sessionPath).toBe(sourcePath);
				expect(switched.conversationId).toBe(sourceId);
			} finally {
				await client.close();
				await handle.close();
			}
		} finally {
			h.cleanup();
		}
	});

	it("streams a conversation only while the socket is on it — a turn started before the page moved on stays off screen", async () => {
		// Slow enough that the first turn is still streaming when the second conversation is handed over.
		const h = await harness(() => [fauxAssistantMessage([fauxText(`still talking. ${"word ".repeat(60)}`)], { timestamp: 0 })], { tokensPerSecond: 20 });
		try {
			const handle = await start(h.registry);
			const client = await connect(handle.url, handle.token);
			try {
				client.send({ type: "newSession", requestId: "r1" });
				const first = await client.next((frame) => frame.type === "result" && frame.requestId === "r1");
				if (first.type !== "result" || !first.conversationId) throw new Error("no conversation");
				const left = first.conversationId;

				client.send({ type: "prompt", conversationId: left, text: "talk for a while" });
				await client.next((frame) => frame.type === "event" && frame.conversationId === left);

				// The sidebar's “+”: another conversation, while the first one is mid-answer.
				client.send({ type: "newSession", requestId: "r2" });
				const second = await client.next((frame) => frame.type === "result" && frame.requestId === "r2");
				if (second.type !== "result" || !second.conversationId) throw new Error("no second conversation");
				expect(second.conversationId).not.toBe(left);

				// The abandoned turn keeps running — coming back to it must lose nothing — but its frames no
				// longer reach the socket, because the page has one transcript to put them in.
				const since = client.frames.length;
				await new Promise((resolve) => setTimeout(resolve, 300));
				expect(client.frames.slice(since).filter((frame) => frame.type === "event" && frame.conversationId === left)).toHaveLength(0);
				expect(h.registry.get(left).listeners.size).toBe(0);
				expect(h.registry.get(left).session.isIdle).toBe(false);

				// The conversation the socket is on still answers, and only its events arrive.
				client.send({ type: "prompt", conversationId: second.conversationId, text: "short answer" });
				const settled = await client.next((frame) => frame.type === "event" && frame.event.type === "agent_settled");
				expect(settled.type === "event" && settled.conversationId).toBe(second.conversationId);
			} finally {
				await client.close();
				await handle.close();
			}
		} finally {
			h.cleanup();
		}
	});

	it("the periodic sweep lets go of a conversation nobody is watching", async () => {
		const h = await harness(toolTurn(), { idleTtlMs: 0 });
		try {
			const handle = await startFlypiServer({ registry: h.registry, evictIntervalMs: 10 });
			// idleTtlMs 0 above is not the production default; it keeps this test to one event loop tick.
			const conversation = await (async () => {
				const client = await connect(handle.url, handle.token);
				client.send({ type: "newSession", requestId: "r1" });
				const created = await client.next((frame) => frame.type === "result" && frame.requestId === "r1");
				if (created.type !== "result" || !created.conversationId) throw new Error("no conversation id");
				await client.close();
				return h.registry.get(created.conversationId);
			})();
			expect(conversation.session.isIdle).toBe(true);

			// The sweep runs on a timer, so give it a moment rather than calling evictIdle() ourselves.
			for (let attempt = 0; attempt < 100 && h.registry.size > 0; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(h.registry.size).toBe(0);
			expect(h.disposeCount()).toBe(1);
			await handle.close();
		} finally {
			h.cleanup();
		}
	});

	it("reports a replay gap instead of pretending the transcript is complete", async () => {
		const h = await harness(toolTurn(), { logCapacity: 2 });
		try {
			const handle = await start(h.registry);
			const client = await connect(handle.url, handle.token);
			try {
				client.send({ type: "newSession", requestId: "r1" });
				const created = await client.next((frame) => frame.type === "result" && frame.requestId === "r1");
				if (created.type !== "result" || !created.conversationId) throw new Error("no conversation id");
				client.send({ type: "prompt", conversationId: created.conversationId, text: "go" });
				await client.next(isEvent("agent_settled"));

				// Only the last two events were retained, so seq 0 cannot be honoured.
				client.send({ type: "resume", conversationId: created.conversationId, afterSeq: 0, requestId: "r2" });
				const error = await client.next((frame) => frame.type === "error");
				expect(error.type === "error" && error.code).toBe("replay_gap");
				// The tail is still replayed, so the client can render what it has.
				await client.next((frame) => frame.type === "event" && frame.conversationId === created.conversationId);
			} finally {
				await client.close();
				await handle.close();
			}
		} finally {
			h.cleanup();
		}
	});

	it("rejects unknown commands and unknown conversations with error frames, never a crash", async () => {
		const h = await harness(toolTurn());
		try {
			const handle = await start(h.registry);
			const client = await connect(handle.url, handle.token);
			try {
				await client.next((frame) => frame.type === "hello");
				client.send("{not json");
				expect((await client.next((frame) => frame.type === "error")).type).toBe("error");
				client.send({ type: "prompt", conversationId: "nope", text: "hi", requestId: "r9" });
				const error = await client.next((frame) => frame.type === "error" && frame.requestId === "r9");
				expect(error.type === "error" && error.message).toMatch(/unknown conversation/);
				// The code is what the page recovers on — it holds the id across reconnects (ui/lib/app-state.svelte.ts).
				expect(error.type === "error" && error.code).toBe("unknownConversation");
			} finally {
				await client.close();
				await handle.close();
			}
		} finally {
			h.cleanup();
		}
	});

	// The same server, serving the built UI: this is `npm run build && npm run serve`.
	it("serves the built UI and tells the page where the socket is", async () => {
		const h = await harness(toolTurn());
		const uiDir = mkdtempSync(join(tmpdir(), "flypi-ui-"));
		writeFileSync(join(uiDir, "index.html"), "<html><body>flypi ui</body></html>");
		writeFileSync(join(uiDir, "app.js"), "console.log(1)");
		try {
			const handle = await startFlypiServer({ registry: h.registry, uiDir });
			const base = `http://${handle.host}:${handle.port}`;
			// The client reads its token here rather than parsing a printed URL.
			expect(await (await fetch(`${base}/__flypi.json`)).json()).toEqual({ protocolVersion: PROTOCOL_VERSION, token: handle.token, wsPath: "/ws" });
			const page = await fetch(`${base}/`);
			expect(page.headers.get("content-type")).toContain("text/html");
			expect(await page.text()).toContain("flypi ui");
			expect((await fetch(`${base}/app.js`)).headers.get("content-type")).toBe("text/javascript; charset=utf-8");
			// The app's views and its conversations are addresses, not files (ui/lib/route.ts): the one page answers
			// there too, so a reload or a bookmark of `/settings` or `/sessions/<id>` lands on what it names, not a 404.
			const view = await fetch(`${base}/settings`);
			expect(view.headers.get("content-type")).toContain("text/html");
			expect(await view.text()).toContain("flypi ui");
			expect((await fetch(`${base}/sessions/2026-01-01T00-00-00-000Z_01a1.jsonl`)).status).toBe(200);
			// A file that is not in the build directory is a 404, not the filesystem.
			expect((await fetch(`${base}/../package.json`)).status).toBe(404);
			expect((await fetch(`${base}/missing.html`)).status).toBe(404);
			await handle.close();
		} finally {
			rmSync(uiDir, { recursive: true, force: true });
			h.cleanup();
		}
	});

	// What the browser UI asks for beyond a turn: its sessions, a name, and what the session actually is.
	// The page's "install now" (docs/architecture.md Phase 7): the daemon's own install path, and the honest
	// answer from a process that has none.
	it("asks the daemon to install its update, and says so when it has no update path", async () => {
		const h = await harness(toolTurn());
		let asked = 0;
		const withUpdater = await startFlypiServer({ registry: h.registry, installUpdate: async () => (asked++ ? "the install could not start" : null) });
		const without = await startFlypiServer({ registry: h.registry });
		const client = await connect(withUpdater.url, withUpdater.token);
		try {
			client.send({ type: "installUpdate", requestId: "r1" });
			const started = await client.next((frame) => frame.type === "result" && frame.requestId === "r1");
			// The ack comes before the work: the install restarts the daemon, which closes this socket.
			expect(started.type).toBe("result");
			client.send({ type: "installUpdate", requestId: "r2" });
			const refused = await client.next((frame) => frame.type === "error" && frame.requestId === "r2");
			expect(refused.type === "error" && refused.message).toMatch(/could not start/);
		} finally {
			await client.close();
		}
		const client2 = await connect(without.url, without.token);
		try {
			client2.send({ type: "installUpdate", requestId: "r3" });
			const nope = await client2.next((frame) => frame.type === "error" && frame.requestId === "r3");
			expect(nope.type === "error" && nope.message).toMatch(/does not manage its own updates/);
		} finally {
			await client2.close();
			await withUpdater.close();
			await without.close();
			h.cleanup();
		}
	});

	it("serves the session list, a rename, a debug snapshot, and an opened session's history", async () => {
		const h = await harness(toolTurn());
		try {
			const handle = await start(h.registry);
			const client = await connect(handle.url, handle.token);
			try {
				client.send({ type: "newSession", requestId: "r1" });
				const created = await client.next((frame) => frame.type === "result" && frame.requestId === "r1");
				if (created.type !== "result" || !created.conversationId || !created.sessionPath) throw new Error("no conversation");
				const conversationId = created.conversationId;

				client.send({ type: "prompt", conversationId, text: "list the files" });
				await client.next(isEvent("agent_settled"));

				client.send({ type: "listSessions", requestId: "r2" });
				const listed = await client.next((frame) => frame.type === "result" && frame.requestId === "r2");
				if (listed.type !== "result" || !listed.sessions) throw new Error("no session list");
				const row = listed.sessions.find((session) => session.path === created.sessionPath);
				expect(row?.messageCount).toBeGreaterThan(0);
				expect(row?.firstMessage).toContain("list the files");
				expect(row?.name).toBeUndefined();

				client.send({ type: "renameSession", conversationId, name: "afternoon session", requestId: "r3" });
				await client.next((frame) => frame.type === "result" && frame.requestId === "r3");
				client.send({ type: "listSessions", requestId: "r4" });
				const renamed = await client.next((frame) => frame.type === "result" && frame.requestId === "r4");
				expect(renamed.type === "result" && renamed.sessions?.[0]?.name).toBe("afternoon session");

				client.send({ type: "debug", conversationId, requestId: "r5" });
				const debug = await client.next((frame) => frame.type === "result" && frame.requestId === "r5");
				if (debug.type !== "result" || !debug.debug) throw new Error("no debug info");
				expect(debug.debug.systemPrompt.length).toBeGreaterThan(0);
				expect(debug.debug.activeTools).toEqual(expect.arrayContaining(["read", "bash"]));
				expect(debug.debug.model).toEqual({ provider: "flypi-stub", modelId: "stub", input: ["text"] });
				// The selector's list is what pi considers usable, not its catalog: the stub runtime holds
				// ~1.5k built-in models and only the provider this session is configured with is listed.
				// (The harness isolates auth.json too, so this does not depend on whose ~/.pi has keys.)
				expect(debug.debug.models).toEqual([{ provider: "flypi-stub", modelId: "stub", input: ["text"] }]);
				expect(debug.debug.thinkingLevel).toBe(h.sessions[0]!.session.thinkingLevel);
				expect(debug.debug.sessionName).toBe("afternoon session");
				// Phase 4 fills this; Phase 2 says there is none rather than inventing one.
				expect(debug.debug.memoryBlock).toBeNull();
				// The chat's context gauge: pi's own estimate of what the next request would carry, against
				// the model's window. The stub model's window is 200k, and a turn has been answered, so the
				// token count is known here.
				expect(debug.debug.context?.contextWindow).toBe(200_000);
				expect((debug.debug.context?.tokens ?? 0)).toBeGreaterThan(0);

				// Opening the session again has to bring its transcript with it: the registry seeds the
				// loaded history into the event log, and `resume` is how the client reads it.
				const forked = await h.registry.fork(conversationId, lastMessageSeq(client.frames, "assistant"));
				await h.registry.switchSession(forked.id, created.sessionPath);
				client.send({ type: "resume", conversationId: forked.id, afterSeq: 0, requestId: "r6" });
				const opened = (await client.next((frame) => frame.type === "event" && frame.conversationId === forked.id && frame.event.type === "message_end")) as EventFrame;
				void opened;
				const seeded = client.frames.filter(
					(frame): frame is EventFrame => frame.type === "event" && frame.conversationId === forked.id && frame.event.type === "message_end",
				);
				expect(render(seeded)).toEqual(
					client.frames
						.filter((frame): frame is EventFrame => frame.type === "event" && frame.conversationId === conversationId && frame.event.type === "message_end")
						.map((frame) => render([frame])[0]!),
				);
				expect(seeded.length).toBeGreaterThan(1);
			} finally {
				await client.close();
				await handle.close();
			}
		} finally {
			h.cleanup();
		}
	});

	it("deletes a session over the socket and answers with the list without it", async () => {
		const h = await harness(toolTurn());
		try {
			const handle = await start(h.registry);
			const client = await connect(handle.url, handle.token);
			try {
				client.send({ type: "newSession", requestId: "r1" });
				const created = await client.next((frame) => frame.type === "result" && frame.requestId === "r1");
				if (created.type !== "result" || !created.conversationId || !created.sessionPath) throw new Error("no conversation");
				client.send({ type: "prompt", conversationId: created.conversationId, text: "list the files" });
				await client.next(isEvent("agent_settled"));

				client.send({ type: "deleteSession", sessionPath: created.sessionPath, requestId: "r2" });
				const deleted = await client.next((frame) => frame.type === "result" && frame.requestId === "r2");
				// The refreshed list rides along with the ack: the sidebar is the only caller, and what it
				// needs next is the list without the deleted row in it.
				expect(deleted.type === "result" && deleted.sessions).toEqual([]);
				expect(existsSync(created.sessionPath)).toBe(false);

				// The conversation went with the file, so anything sent to it is now an error frame.
				client.send({ type: "prompt", conversationId: created.conversationId, text: "still there?", requestId: "r3" });
				const failed = await client.next((frame) => frame.type === "error" && frame.requestId === "r3");
				expect(failed.type === "error" && failed.message).toMatch(/unknown conversation/);
			} finally {
				await client.close();
				await handle.close();
			}
		} finally {
			h.cleanup();
		}
	});

	it("refuses to delete a session outside .flypi/sessions", async () => {
		const h = await harness(toolTurn());
		try {
			const handle = await start(h.registry);
			const client = await connect(handle.url, handle.token);
			try {
				client.send({ type: "deleteSession", sessionPath: join(h.root, "elsewhere.jsonl"), requestId: "r1" });
				const failed = await client.next((frame) => frame.type === "error" && frame.requestId === "r1");
				expect(failed.type === "error" && failed.message).toMatch(/not inside/);
			} finally {
				await client.close();
				await handle.close();
			}
		} finally {
			h.cleanup();
		}
	});

	// The settings view's other command, and like the files it is not about a conversation. The servers are
	// asked, and an answer that is bad news still comes back as a result: a server being down is data, not a
	// failed request (docs/protocol.md).
	it("asks the MCP servers over the socket and answers with what they said", async () => {
		const h = await harness(toolTurn());
		try {
			writeFileSync(
				join(h.root, ".flypi", "agent", "mcp.json"),
				JSON.stringify({ mcpServers: { gone: { url: "http://127.0.0.1:1/mcp" }, off: { command: "true", enabled: false } } }),
			);
			const handle = await start(h.registry);
			const client = await connect(handle.url, handle.token);
			try {
				client.send({ type: "mcpStatus", requestId: "r1" });
				const answered = await client.next((frame) => frame.type === "result" && frame.requestId === "r1");
				if (answered.type !== "result" || !answered.mcpStatus) throw new Error("no mcpStatus");
				expect(answered.mcpStatus.servers).toEqual([
					{ name: "gone", state: "failed", transport: "http", error: expect.any(String), tools: [] },
					// Left off in the file is a state of its own: the panel must not call it broken.
					{ name: "off", state: "disabled", transport: "stdio", tools: [] },
				]);
				// No session ran and no log was written, and that is said rather than left blank.
				expect(answered.mcpStatus.log).toBe("");
			} finally {
				await client.close();
			}
		} finally {
			h.cleanup();
		}
	});

	// The sign-in half of the same panel (docs/architecture.md Phase 5, risk 5): the URL goes out as its own
	// frame while the request is still open, the pasted redirect finishes the flow, and the ack is the status
	// taken afterwards. The OAuth servers are the real fake ones — pi's flow, driven over flypi's socket.
	it("signs an MCP server in over the socket: URL out, redirect back, status in", async () => {
		const fake = await startFakeOAuth();
		const h = await harness(toolTurn());
		try {
			writeFileSync(join(h.root, ".flypi", "agent", "mcp.json"), JSON.stringify({ mcpServers: { sentry: { url: fake.mcpUrl } } }));
			const handle = await start(h.registry);
			const client = await connect(handle.url, handle.token);
			try {
				client.send({ type: "mcpSignIn", name: "sentry", requestId: "r1" });
				const auth = await client.next((frame) => frame.type === "mcpAuth");
				if (auth.type !== "mcpAuth") throw new Error("no mcpAuth frame");
				expect(auth.name).toBe("sentry");
				// The paste, as a browser would have produced it: the redirect URI and state this sign-in asked for.
				const params = new URL(auth.url).searchParams;
				client.send({ type: "mcpRedirect", name: "sentry", url: `${params.get("redirect_uri")}?code=the-code&state=${params.get("state")}` });

				const answered = await client.next((frame) => frame.type === "result" && frame.requestId === "r1");
				if (answered.type !== "result" || !answered.mcpStatus) throw new Error("no mcpStatus in the sign-in's ack");
				// The token landed in flypi's own agent dir (never the host `~/.pi`, risk 1), and the status that
				// came back with the ack was taken with it in hand — the fake server accepts no token, so the row
				// says it was refused rather than never offered.
				expect(readFileSync(join(h.root, ".flypi", "agent", "mcp-auth.json"), "utf8")).toContain(FAKE_ACCESS_TOKEN);
				expect(answered.mcpStatus.servers).toEqual([
					{ name: "sentry", state: "needs-auth", transport: "http", error: expect.any(String), tools: [] },
				]);
				expect(fake.asked).toContain("POST /token");
			} finally {
				await client.close();
				await handle.close();
			}
		} finally {
			h.cleanup();
			await fake.close();
		}
	});

	// Both refusals are sentences about the entry, not a stack trace: one is a server that cannot be signed
	// in to, the other is a paste that arrived with no sign-in waiting for it.
	it("refuses a sign-in for a server that has none, and a redirect nobody asked for", async () => {
		const h = await harness(toolTurn());
		try {
			writeFileSync(join(h.root, ".flypi", "agent", "mcp.json"), JSON.stringify({ mcpServers: { local: { command: "true" } } }));
			const handle = await start(h.registry);
			const client = await connect(handle.url, handle.token);
			try {
				client.send({ type: "mcpSignIn", name: "local", requestId: "r1" });
				const refused = await client.next((frame) => frame.type === "error" && frame.requestId === "r1");
				expect(refused.type === "error" && refused.message).toMatch(/command flypi starts locally/);

				client.send({ type: "mcpRedirect", name: "local", url: "http://127.0.0.1:1/callback?code=x", requestId: "r2" });
				const stray = await client.next((frame) => frame.type === "error" && frame.requestId === "r2");
				expect(stray.type === "error" && stray.message).toMatch(/no sign-in is waiting/);
			} finally {
				await client.close();
				await handle.close();
			}
		} finally {
			h.cleanup();
		}
	});

	// Config files belong to the agent dir, so the panel works before there is a conversation at all — and what
	// it writes is what the next conversation will read.
	it("reads and edits the agent dir's config files over the socket", async () => {
		const h = await harness(toolTurn());
		try {
			writeFileSync(
				join(h.root, ".flypi", "agent", "models.json"),
				JSON.stringify({ providers: { lmstudio: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", models: [{ id: "qwen3", compat: { supportsTools: false } }] } } }),
			);
			const handle = await start(h.registry);
			const client = await connect(handle.url, handle.token);
			try {
				client.send({ type: "getConfig", requestId: "r1" });
				const first = await client.next((frame) => frame.type === "result" && frame.requestId === "r1");
				if (first.type !== "result" || !first.config) throw new Error("no config");
				expect(first.config.endpoints).toEqual([{ name: "lmstudio", baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "", models: ["qwen3"] }]);
				expect(first.config.mcpServers).toEqual([]);
				expect(first.config.errors).toEqual([]);
				// The default pair comes back too — empty here, because this root has no settings.json: the
				// panel shows "no default yet" rather than failing the snapshot (src/agent/runtime.ts needs both
				// keys before a new conversation can start).
				expect(first.config.defaults).toEqual({ provider: "", model: "" });

				client.send({
					type: "saveConfig",
					mcpServers: [
						{
							name: "flypi-memory",
							url: "http://127.0.0.1:8790/mcp",
							authorization: "Bearer ${FLYPI_MEMORY_TOKEN}",
							exposure: "direct",
							env: { FLYPI_TOKEN: "${FLYPI_MEMORY_TOKEN}" },
							toolExposure: { memory_cite: "hidden" },
						},
					],
					requestId: "r2",
				});
				const saved = await client.next((frame) => frame.type === "result" && frame.requestId === "r2");
				if (saved.type !== "result" || !saved.config) throw new Error("no config after saving");
				// The refreshed files come back with the ack, so what the panel shows after a save is what is
				// on disk — not what the form contained. The maps are in that snapshot whole, which is what lets
				// the panel edit an entry's `env` without erasing the entries it did not show.
				expect(saved.config.mcpServers).toEqual([
					{ name: "flypi-memory", url: "http://127.0.0.1:8790/mcp", command: "", args: [], authorization: "Bearer ${FLYPI_MEMORY_TOKEN}", env: { FLYPI_TOKEN: "${FLYPI_MEMORY_TOKEN}" }, cwd: "", description: "", exposure: "direct", toolExposure: { memory_cite: "hidden" }, oauth: { clientId: "", clientSecret: "", callbackUrl: "", scope: "" }, enabled: true },
				]);
				// And the file the next conversation reads (src/agent/runtime.ts hands this exact file to pi's MCP
				// extension) holds them as pi reads them: a reference, and a per-tool exception.
				expect(JSON.parse(readFileSync(join(h.root, ".flypi", "agent", "mcp.json"), "utf8")).mcpServers["flypi-memory"]).toEqual({
					url: "http://127.0.0.1:8790/mcp",
					headers: { Authorization: "Bearer ${FLYPI_MEMORY_TOKEN}" },
					env: { FLYPI_TOKEN: "${FLYPI_MEMORY_TOKEN}" },
					exposure: "direct",
					toolExposure: { memory_cite: "hidden" },
				});

				// A rejected edit is an error frame carrying the request id, so the panel can say which row
				// failed instead of leaving a form that silently did nothing.
				client.send({ type: "saveConfig", endpoints: [{ name: "chatgml", models: [] }], requestId: "r3" });
				const failed = await client.next((frame) => frame.type === "error" && frame.requestId === "r3");
				expect(failed.type === "error" && failed.message).toMatch(/baseUrl/);

				// Setting the default travels on the same command, and the model it names may be one that the
				// same request just added — the pair is checked against the files as they are afterwards.
				client.send({
					type: "saveConfig",
					endpoints: [{ name: "chatgml", baseUrl: "https://chatgml.dev/v1", api: "openai-completions", models: ["gpt-4o-mini"] }],
					defaults: { provider: "chatgml", model: "gpt-4o-mini" },
					requestId: "r4",
				});
				const defaulted = await client.next((frame) => frame.type === "result" && frame.requestId === "r4");
				if (defaulted.type !== "result" || !defaulted.config) throw new Error("no config after setting the default");
				expect(defaulted.config.defaults).toEqual({ provider: "chatgml", model: "gpt-4o-mini" });
				expect(JSON.parse(readFileSync(join(h.root, ".flypi", "agent", "settings.json"), "utf8"))).toMatchObject({
					defaultProvider: "chatgml",
					defaultModel: "gpt-4o-mini",
				});

				// A default the next conversation could not resolve is refused here, where the message can say
				// what to fix, rather than breaking the next new session.
				client.send({ type: "saveConfig", defaults: { provider: "nowhere", model: "m" }, requestId: "r5" });
				const badDefault = await client.next((frame) => frame.type === "error" && frame.requestId === "r5");
				expect(badDefault.type === "error" && badDefault.message).toMatch(/names no endpoint/);
			} finally {
				await client.close();
				await handle.close();
			}
		} finally {
			h.cleanup();
		}
	});

	// Extensions are pi's own packages, and the settings view installs them (docs/protocol.md `packages` /
	// `savePackages`). What the socket has to guarantee is the part a file edit cannot do on its own: the
	// conversation already on screen gets the extension, and a source that will not install is refused with a
	// message rather than a list that quietly did not change.
	it("installs an extension package and puts it in the conversation that is open", async () => {
		// `pkg_tool` is in the allowlist because the harness runs its conversations with one: an allowlist is what
		// decides whether a tool an extension registers reaches the model (pi's AgentSession options), and the
		// point here is the reload, not the gate.
		const h = await harness(toolTurn(), { tools: ["read", "bash", "pkg_tool"] });
		try {
			const dir = join(h.root, "my-pkg");
			mkdirSync(join(dir, "extensions"), { recursive: true });
			writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "my-pkg", version: "1.0.0", pi: { extensions: ["extensions/tool.ts"] } }));
			writeFileSync(join(dir, "extensions", "tool.ts"), "export default function (pi) {\n\tpi.registerTool({ name: \"pkg_tool\", description: \"d\", parameters: {}, execute: async () => ({ content: [{ type: \"text\", text: \"ok\" }], details: undefined }) });\n}\n");
			const handle = await start(h.registry);
			const client = await connect(handle.url, handle.token);
			try {
				client.send({ type: "newSession", requestId: "r1" });
				const opened = await client.next((frame) => frame.type === "result" && frame.requestId === "r1");
				if (opened.type !== "result" || !opened.conversationId) throw new Error("no conversation");
				const conversationId = opened.conversationId;

				client.send({ type: "packages", requestId: "r2" });
				const empty = await client.next((frame) => frame.type === "result" && frame.requestId === "r2");
				if (empty.type !== "result" || !empty.packages) throw new Error("no packages");
				expect(empty.packages.packages).toEqual([]);
				expect(empty.packages.errors).toEqual([]);

				client.send({ type: "savePackages", install: [dir], requestId: "r3" });
				const installed = await client.next((frame) => frame.type === "result" && frame.requestId === "r3");
				if (installed.type !== "result" || !installed.packages) throw new Error("no packages after installing");
				// The refreshed list, as `.flypi/agent/settings.json` now holds it — pi's own relative form, and
				// where the code is (src/agent/packages.ts).
				expect(installed.packages.packages).toEqual([{ source: expect.any(String), scope: "user", installed: true, path: dir, version: "1.0.0" }]);
				expect(JSON.parse(readFileSync(join(h.root, ".flypi", "agent", "settings.json"), "utf8")).packages).toHaveLength(1);

				// The chat on screen is the point: the registry reloaded it, so the tool the page just installed is
				// in it rather than only in the next conversation.
				client.send({ type: "debug", conversationId, requestId: "r4" });
				const debug = await client.next((frame) => frame.type === "result" && frame.requestId === "r4" && !!frame.debug?.activeTools.includes("pkg_tool"));
				if (debug.type !== "result") throw new Error("the open conversation never got pkg_tool");

				// A source pi cannot install is said, with the request id, so the panel can put the sentence where
				// the typed source was.
				client.send({ type: "savePackages", install: [join(h.root, "not-a-package")], requestId: "r5" });
				const refused = await client.next((frame) => frame.type === "error" && frame.requestId === "r5");
				expect(refused.type === "error" && refused.message).toMatch(/not-a-package/);

				client.send({ type: "savePackages", remove: [dir], requestId: "r6" });
				const removed = await client.next((frame) => frame.type === "result" && frame.requestId === "r6");
				if (removed.type !== "result" || !removed.packages) throw new Error("no packages after removing");
				expect(removed.packages.packages).toEqual([]);
			} finally {
				await client.close();
				await handle.close();
			}
		} finally {
			h.cleanup();
		}
	});
});

/**
 * The parts of the server that only a daemon has (docs/architecture.md Phase 4.5): the health page, the
 * job queue, and the answer to “was a turn in this chat cut short when flypi went away?”.
 */
describe("the daemon's surface", () => {
	it("has no health page when this process is not a daemon", async () => {
		const h = await harness(toolTurn());
		try {
			const handle = await startFlypiServer({ registry: h.registry });
			// `npm run serve` is a foreground process with no queue and no memory store: it says so rather
			// than pretending to be a service.
			const response = await fetch(`http://${handle.host}:${handle.port}/healthz`);
			expect(response.status).toBe(404);
			await handle.close();
		} finally {
			h.cleanup();
		}
	});

	it("answers the health page without a token, because a service manager polls it", async () => {
		const h = await harness(toolTurn());
		try {
			const handle = await startFlypiServer({
				registry: h.registry,
				health: () => ({ pid: 4242, startedAt: "2026-10-11T09:00:00.000Z", jobs: 2 }),
			});
			const response = await fetch(`http://${handle.host}:${handle.port}/healthz`);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ ok: true, pid: 4242, startedAt: "2026-10-11T09:00:00.000Z", jobs: 2 });
			await handle.close();
		} finally {
			h.cleanup();
		}
	});

	it("says which pi it runs, and refuses to move pi where there is no pointer", async () => {
		const h = await harness(toolTurn());
		const versions = { running: "1.4.0", pinned: true, bundled: "1.0.4", trees: ["1.4.0", "1.3.0"], next: "1.5.0" };
		const manages = await startFlypiServer({
			registry: h.registry,
			piVersions: () => versions,
			piCheck: async () => ({ ...versions, checkedAt: "2026-10-23T00:00:00.000Z" }),
			usePi: async () => null,
		});
		const headless = await startFlypiServer({ registry: h.registry });
		const client = await connect(manages.url, manages.token);
		try {
			client.send({ type: "piVersions", requestId: "r1" });
			const shown = await client.next((frame) => frame.type === "result" && frame.requestId === "r1");
			expect(shown.type === "result" && shown.pi).toEqual(versions);
			client.send({ type: "usePi", version: "1.5.0", requestId: "r2" });
			const ack = await client.next((frame) => (frame.type === "result" || frame.type === "error") && frame.requestId === "r2");
			// The ack goes out before the restart, because the restart closes this socket: what the page learns
			// afterwards is which version came back, not a promise about this one.
			expect(ack.type).toBe("result");
			// "Check now": the registry asked again, and the fresh stamp arrives as the same `pi` frame.
			client.send({ type: "piCheck", requestId: "r4" });
			const checked = await client.next((frame) => frame.type === "result" && frame.requestId === "r4");
			expect(checked.type === "result" && checked.pi?.checkedAt).toBe("2026-10-23T00:00:00.000Z");
		} finally {
			await client.close();
		}
		const client2 = await connect(headless.url, headless.token);
		try {
			client2.send({ type: "piVersions", requestId: "r3" });
			const refused = await client2.next((frame) => frame.type === "error" && frame.requestId === "r3");
			expect(refused.type === "error" && refused.message).toMatch(/does not manage pi versions/);
			client2.send({ type: "piCheck", requestId: "r5" });
			const refusedCheck = await client2.next((frame) => frame.type === "error" && frame.requestId === "r5");
			expect(refusedCheck.type === "error" && refusedCheck.message).toMatch(/does not manage pi versions/);
		} finally {
			await client2.close();
			await manages.close();
			await headless.close();
			h.cleanup();
		}
	});

	it("shows the job queue, and says when this process does not have one", async () => {
		const h = await harness(toolTurn());
		const snapshot = {
			jobs: [{ kind: "memory.consolidate", nextRunAt: "2026-10-11T10:00:00.000Z", running: false }],
			jobRuns: [{ kind: "memory.reembed", status: "ok" as const, startedAt: "2026-10-11T09:00:00.000Z", finishedAt: "2026-10-11T09:00:02.000Z", detail: "re-embedded 4" }],
		};
		const withQueue = await startFlypiServer({ registry: h.registry, scheduler: () => snapshot });
		const withoutQueue = await startFlypiServer({ registry: h.registry });
		const client = await connect(withQueue.url, withQueue.token);
		try {
			client.send({ type: "scheduler", requestId: "r1" });
			const shown = await client.next((frame) => frame.type === "result" && frame.requestId === "r1");
			// The queue is the daemon's, not a conversation's: no conversationId is needed to ask for it.
			expect(shown.type === "result" && shown.scheduler).toEqual(snapshot);
		} finally {
			await client.close();
		}
		const client2 = await connect(withoutQueue.url, withoutQueue.token);
		try {
			client2.send({ type: "scheduler", requestId: "r2" });
			const refused = await client2.next((frame) => frame.type === "error" && frame.requestId === "r2");
			// An empty table would read as “nothing to do”; this says the truth: there is no scheduler here.
			expect(refused.type === "error" && refused.message).toMatch(/no scheduler/);
		} finally {
			await client2.close();
			await withQueue.close();
			await withoutQueue.close();
			h.cleanup();
		}
	});

	it("says which turn was cut short, when a client opens that session", async () => {
		const h = await harness(toolTurn());
		try {
			const handle = await startFlypiServer({
				registry: h.registry,
				// Stands in for `runs.interruptedFor`: the backend's own store answers it from its `runs` table
				// (tests/server/run-store.test.ts); what is proved here is that the answer reaches the chat.
				interruptedRun: (sessionFile) => (sessionFile.endsWith(".jsonl") ? { at: "2026-10-11T09:00:00.000Z" } : undefined),
			});
			const client = await connect(handle.url, handle.token);
			try {
				client.send({ type: "newSession", requestId: "r1" });
				const created = await client.next((frame) => frame.type === "result" && frame.requestId === "r1");
				if (created.type !== "result" || !created.conversationId || !created.sessionPath) throw new Error("no conversation");

				client.send({ type: "switchSession", conversationId: created.conversationId, sessionPath: created.sessionPath, requestId: "r2" });
				const opened = await client.next((frame) => frame.type === "result" && frame.requestId === "r2");
				// With the session it opens, not as a separate message: the chat is about to render a half-finished
				// answer, and this is the only thing that explains it.
				expect(opened.type === "result" && opened.interrupted).toEqual({ at: "2026-10-11T09:00:00.000Z" });
			} finally {
				await client.close();
				await handle.close();
			}
		} finally {
			h.cleanup();
		}
	});
});
