/**
 * The Phase 2 UI tests (docs/testing.md): the recorded transcript goes in through the transport and
 * the assertions are made on the DOM that ends up on screen — not on a stream of intermediate
 * events. The tool-card states, the queue, abort/steer and the split between the chat and the
 * activity panel are each driven by the frames the real server sends.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import App from "./App.svelte";
import type { ClientCommand, ConfigSnapshot, DebugInfo, ServerFrame } from "../src/server/protocol.ts";
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from "../src/shared/attachments.ts";
import { parsePath } from "../src/shared/views.ts";
import type { Transport } from "./lib/client.ts";
import { currentTheme } from "./lib/theme.ts";

type Signal = ServerFrame | { type: "connected" } | { type: "disconnected" };

class FakeTransport implements Transport {
	sent: ClientCommand[] = [];
	#handlers = new Set<(signal: Signal) => void>();

	on(handler: (signal: Signal) => void): () => void {
		this.#handlers.add(handler);
		return () => this.#handlers.delete(handler);
	}

	send(command: ClientCommand): void {
		this.sent.push(command);
	}

	emit(signal: Signal): void {
		for (const handler of this.#handlers) handler(signal);
	}
}

const FIXTURE = join(import.meta.dirname, "..", "tests", "fixtures", "transcript-log");
const recordedEvents = JSON.parse(readFileSync(join(FIXTURE, "events.json"), "utf8")) as AgentSessionEvent[];

let current: FakeTransport;

async function mount(): Promise<FakeTransport> {
	const transport = new FakeTransport();
	current = transport;
	render(App as Parameters<typeof render>[0], { props: { transport } });
	return transport;
}

async function frames(transport: FakeTransport, events: AgentSessionEvent[], from = 0) {
	events.forEach((event, index) => transport.emit({ type: "event", conversationId: "c1", seq: from + index + 1, event }));
	await tick();
}

/** Frames from the fixture, sent through the transport of the mounted app. */
async function replay(transport: FakeTransport) {
	await frames(transport, recordedEvents);
}

/**
 * The real startup: the socket connects, the app asks for a conversation, the server gives one.
 *
 * `frames()` addresses the transcript's events to `c1`, so binding is what makes a stream visible — the page
 * renders the chat its conversation belongs to, and only that one.
 */
async function bind(transport: FakeTransport) {
	transport.emit({ type: "connected" });
	await tick();
	transport.emit({ type: "result", requestId: "r1", conversationId: "c1", sessionPath: "/tmp/s.jsonl" });
	await tick();
}

function sent(transport: FakeTransport, type: string): ClientCommand[] {
	return transport.sent.filter((command) => command.type === type);
}

/** Which session the address bar says is on screen — its file name, in `/sessions/<id>` (ui/lib/route.ts). */
function sessionInUrl(): string | null {
	return parsePath(location.pathname).session;
}

function submit(selector: string) {
	fireEvent.submit(document.querySelector(selector) as Element);
}

/**
 * Click the sidebar row for a session the page already holds. Its path is what rows are keyed by, and the
 * row's label is whatever the session was called — so the path is what the lookup uses.
 */
function openRowByPath(path: string): void {
	const name = path.split("/").pop()!;
	// A session that has never been named or given a first message is listed by its path, and the row you are
	// in is the rename field rather than a button — so only the others can be clicked.
	const button = [...document.querySelectorAll(".sessions button.session")].find((candidate) => (candidate.textContent ?? "").includes(name));
	if (!button) throw new Error(`no clickable sidebar row for ${path}`);
	fireEvent.click(button);
}

/**
 * A file paste. The clipboard's `files` is a read-only part of the event, so it is defined on the event
 * rather than passed through the event init, and the promise chain is let settle by `waitFor`.
 */
function pasteFiles(target: HTMLElement, files: File[]): void {
	const event = new Event("paste", { bubbles: true, cancelable: true }) as unknown as ClipboardEvent;
	Object.defineProperty(event, "clipboardData", { value: { files, getData: () => "" } });
	fireEvent(target, event);
}

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	// The page's own settings are per-test too: no width or theme leaks into the next one.
	localStorage.removeItem("flypi.theme");
	localStorage.removeItem("flypi.sidebarWidth");
	localStorage.removeItem("flypi.activityWidth");
	localStorage.removeItem("flypi.lastAnswers");
	history.replaceState(null, "", "/");
});

let seq = 0;

/** One event frame, continuing the sequence — for the tests that need the events one at a time. */
function emit(transport: FakeTransport, event: AgentSessionEvent): void {
	transport.emit({ type: "event", conversationId: "c1", seq: ++seq, event });
}

describe("the chat", () => {
	it("renders the recorded multi-tool turn as the final DOM", async () => {
		const transport = await mount();
		await bind(transport);
		await replay(transport);

		// The user's own prompt, from the stream — the UI never appends it twice.
		expect(screen.getByText("fix the failing test in this repo")).toBeTruthy();
		const cards = document.querySelectorAll(".tool-card");
		expect([...cards].map((card) => card.getAttribute("data-tool"))).toEqual(["read", "read", "edit", "bash"]);
		expect([...cards].every((card) => card.getAttribute("data-state") === "done")).toBe(true);
		expect(document.querySelector('.tool-card[data-tool="bash"] [data-role="output"]')?.textContent).toContain("pass 1");
		expect(screen.getByText(/comparing numbers as strings/)).toBeTruthy();
		// Markdown became structure, not text.
		expect(document.querySelector(".markdown strong, .markdown code, .markdown p")).toBeTruthy();
		// Nothing is left mid-stream: the final message replaced the partial one.
		expect(document.querySelector(".streaming")).toBeNull();
	});

	it("shows a partial assistant message while it streams, then removes it", async () => {
		const transport = await mount();
		await bind(transport);
		const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], usage: { input: 1, output: 1, cost: { total: 0 } } });
		await frames(transport, [
			{ type: "agent_start" },
			{ type: "message_start", message: assistant("") } as unknown as AgentSessionEvent,
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hal", partial: assistant("half a sentence") } } as unknown as AgentSessionEvent,
		]);
		expect(document.querySelector(".streaming")?.textContent).toContain("half a sentence");
		await frames(transport, [{ type: "message_end", message: assistant("half a sentence") } as unknown as AgentSessionEvent], recordedEvents.length);
		expect(document.querySelectorAll(".msg")).toHaveLength(1);
		expect(document.querySelector(".streaming")).toBeNull();
	});

	it("forks the session from the answer you point at, and never offers it on a prompt", async () => {
		const transport = await mount();
		await bind(transport);
		const said = (role: string, text: string) => ({ type: "message_end", message: { role, content: [{ type: "text", text }] } }) as unknown as AgentSessionEvent;
		await frames(transport, [said("user", "first"), said("assistant", "first answer"), said("user", "second"), said("assistant", "second answer")]);

		// One button per answer, and nothing of the kind on the user's own messages.
		expect([...document.querySelectorAll('.msg[data-role="user"] button')]).toEqual([]);
		const buttons = screen.getAllByRole("button", { name: "Fork from this answer" });
		expect(buttons).toHaveLength(2);

		// Each command names its answer by the seq its frame carried (event 2 and event 4), not by a
		// position the UI counted — that is the number the server resolves the message from.
		buttons[0]!.click();
		buttons[1]!.click();
		await tick();
		expect(sent(transport, "fork")).toEqual([
			expect.objectContaining({ conversationId: "c1", messageSeq: 2 }),
			expect.objectContaining({ conversationId: "c1", messageSeq: 4 }),
		]);
	});

	it("keeps thinking expanded in the activity panel", async () => {
		const transport = await mount();
		await bind(transport);
		await frames(transport, [
			{
				type: "message_end",
				message: { role: "assistant", content: [{ type: "thinking", thinking: "should I read the file first" }], usage: {} },
			} as unknown as AgentSessionEvent,
		]);
		// It is a panel of nothing but machinery, so there is nothing to keep folded away.
		const details = document.querySelector("details.thinking") as HTMLDetailsElement;
		expect(details.open).toBe(true);
		expect(details.textContent).toContain("should I read the file first");
	});

	it("renders a tool result that arrived with no matching card", async () => {
		const transport = await mount();
		await bind(transport);
		await frames(transport, [
			{
				type: "message_end",
				message: { role: "toolResult", toolCallId: "gone", toolName: "bash", content: [{ type: "text", text: "output from before the reload" }], isError: false },
			} as unknown as AgentSessionEvent,
		]);
		expect(document.querySelector(".orphan-result")?.textContent).toContain("output from before the reload");
	});

	it("keeps the newest message on screen until you scroll up to read an older one", async () => {
		const transport = await mount();
		await bind(transport);
		const say = (text: string) =>
			({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text }], usage: {} },
			}) as unknown as AgentSessionEvent;
		await frames(transport, [say("first")]);
		const list = document.querySelector(".messages") as HTMLElement;
		Object.defineProperty(list, "scrollHeight", { value: 5000, configurable: true });
		await frames(transport, [say("second")], 1);
		expect(list.scrollTop).toBe(5000);
		list.scrollTop = 10;
		fireEvent.scroll(list);
		await frames(transport, [say("third")], 2);
		expect(list.scrollTop).toBe(10);
	});

	// The list is one DOM node reused as chats change underneath it, so a switch used to inherit the
	// previous session's scrollTop and its "follow the newest" flag: the new chat opened at an old place
	// and then the follow effect dragged it to the end. Each session keeps its own place.
	it("keeps each session's place in the list instead of inheriting the last one's", async () => {
		const transport = await mount();
		await bind(transport);
		const said = (text: string) =>
			({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text }], usage: {} },
			}) as unknown as AgentSessionEvent;
		const at = "2026-01-01T00:00:00.000Z";
		transport.emit({
			type: "result",
			requestId: "rows",
			sessions: [
				{ path: "/tmp/s.jsonl", name: "s.jsonl", modified: at, messageCount: 2, firstMessage: "" },
				{ path: "/tmp/b.jsonl", name: "b.jsonl", modified: at, messageCount: 1, firstMessage: "" },
			],
		});
		await tick();
		await frames(transport, [said("first")]);

		const list = document.querySelector(".messages") as HTMLElement;
		Object.defineProperty(list, "scrollHeight", { value: 5000, configurable: true });
		await frames(transport, [said("second")], 1);
		expect(list.scrollTop).toBe(5000); // following the newest message

		// The reader scrolls up in the first session to read something older.
		list.scrollTop = 1200;
		fireEvent.scroll(list);
		await tick();

		// A second session, handed over by the server: it has its own transcript, so it starts at its newest.
		transport.emit({ type: "result", requestId: "bind-b", conversationId: "c2", sessionPath: "/tmp/b.jsonl" });
		await tick();
		expect(list.scrollTop).toBe(5000);

		// Back to the first: it is where it was left — not at the end, and not where the second chat was.
		openRowByPath("/tmp/s.jsonl");
		await tick();
		expect(list.scrollTop).toBe(1200);
	});
});

describe("tool cards", () => {
	it("goes running → done with live output and a duration", async () => {
		const transport = await mount();
		await bind(transport);
		const call = { type: "toolCall", id: "c1", name: "bash", arguments: { command: "node --test" } };
		await frames(transport, [
			{ type: "message_end", message: { role: "assistant", content: [call], usage: {} } } as unknown as AgentSessionEvent,
			{ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "node --test" } } as AgentSessionEvent,
		]);
		const running = document.querySelector('.tool-card[data-tool="bash"]');
		expect(running?.getAttribute("data-state")).toBe("running");
		expect(running?.querySelector('[data-role="args"]')?.textContent).toContain("node --test");
		await frames(transport, [{ type: "tool_execution_update", toolCallId: "c1", toolName: "bash", partialResult: "still running" } as AgentSessionEvent]);
		expect(document.querySelector('.tool-card [data-role="output"]')?.textContent).toBe("still running");
		await frames(transport, [{ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: "1 pass", isError: false } as AgentSessionEvent]);
		const done = document.querySelector('.tool-card[data-tool="bash"]');
		expect(done?.getAttribute("data-state")).toBe("done");
		expect(done?.querySelector('[data-role="output"]')?.textContent).toBe("1 pass");
		// Timed from the two event timestamps, so a card always says how long the call took.
		expect(done?.querySelector(".tool-state")?.textContent).toMatch(/done · \d+\.\d+s/);
	});

	it("shows a failed call as an error", async () => {
		const transport = await mount();
		await bind(transport);
		await frames(transport, [
			{ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "nope" } }], usage: {} } } as unknown as AgentSessionEvent,
			{ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "nope" } } as AgentSessionEvent,
			{ type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: "not found", isError: true } as AgentSessionEvent,
		]);
		expect(document.querySelector(".tool-card")?.getAttribute("data-state")).toBe("error");
	});
});

describe("which panel shows what", () => {
	it("keeps the conversation in the middle and the thinking and tool output on the right", async () => {
		const transport = await mount();
		await bind(transport);
		await frames(transport, [
			{
				type: "message_end",
				message: { role: "assistant", content: [{ type: "thinking", thinking: "read the test first" }, { type: "toolCall", id: "c1", name: "bash", arguments: {} }], usage: {} },
			} as unknown as AgentSessionEvent,
			{ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: {} } as AgentSessionEvent,
			{ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: "1 pass", isError: false } as AgentSessionEvent,
			{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "the test passes now" }], usage: {} } } as unknown as AgentSessionEvent,
		]);
		const chat = document.querySelector(".chat") as HTMLElement;
		expect(chat.textContent).toContain("the test passes now");
		expect(chat.querySelector(".tool-card")).toBeNull();
		expect(chat.querySelector("details.thinking")).toBeNull();
		const panel = document.querySelector(".activity-panel") as HTMLElement;
		expect(panel.querySelector("details.thinking")?.textContent).toContain("read the test first");
		expect(panel.querySelector('.tool-card[data-tool="bash"] [data-role="output"]')?.textContent).toBe("1 pass");
		// An assistant message that only ran tools has nothing to say, so it makes no row in the chat.
		expect(chat.querySelectorAll(".msg")).toHaveLength(1);
	});

	it("keeps the newest entry on screen until you scroll up to read an older one", async () => {
		const transport = await mount();
		await bind(transport);
		const thinking = (text: string) =>
			({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "thinking", thinking: text }], usage: {} },
			}) as unknown as AgentSessionEvent;
		await frames(transport, [thinking("first")]);
		const list = document.querySelector(".activity") as HTMLElement;
		// There is no layout in a headless DOM, so the height to scroll to is the thing we supply.
		Object.defineProperty(list, "scrollHeight", { value: 5000, configurable: true });
		await frames(transport, [thinking("second")], 1);
		expect(list.scrollTop).toBe(5000);
		list.scrollTop = 10;
		fireEvent.scroll(list);
		await frames(transport, [thinking("third")], 2);
		expect(list.scrollTop).toBe(10);
	});
});

describe("the conversation the page is on", () => {
	// One transcript, one activity panel, one resume cursor: they belong to the conversation on screen,
	// so frames addressed to another one must not be folded into them.
	it("keeps a conversation the page left out of the chat, the activity panel and the resume cursor", async () => {
		const transport = await mount();
		await bind(transport);
		const emitTo = (conversationId: string, seq: number, event: AgentSessionEvent) =>
			transport.emit({ type: "event", conversationId, seq, event });
		const thought = (text: string) =>
			({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: text }], usage: {} } }) as unknown as AgentSessionEvent;
		const said = (text: string) =>
			({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage: {} } }) as unknown as AgentSessionEvent;

		await frames(transport, [thought("planning the first session")]);
		expect(document.querySelector(".activity")?.textContent).toContain("planning the first session");

		// The sidebar's “+”: a second conversation, while the first is still answering. Its frames are
		// already on the wire when the page moves.
		transport.emit({ type: "result", requestId: "r7", conversationId: "c2", sessionPath: "/tmp/b.jsonl" });
		await tick();
		emitTo("c1", 900, thought("the first session's thinking, arriving late"));
		emitTo("c1", 901, said("the first session's answer, arriving late"));
		emitTo("c1", 902, { type: "agent_start" } as AgentSessionEvent);
		emitTo("c2", 1, thought("planning the second session"));
		await tick();

		expect(document.querySelector(".activity")?.textContent).toContain("planning the second session");
		expect(document.body.textContent).not.toContain("arriving late");
		// The abandoned turn's agent_start must not put a Stop button on this conversation either.
		expect(document.querySelector(".stop")).toBeNull();

		// The conversation the page left is still followed — a turn in flight in it must not be cut short — so
		// a reconnect resumes both, each from its own cursor, and neither one's seq is the other's.
		transport.emit({ type: "disconnected" });
		transport.emit({ type: "connected" });
		await tick();
		expect(sent(transport, "resume").at(-1)).toEqual(expect.objectContaining({ conversationId: "c2", afterSeq: 1 }));
		// Its cursor is the last event *it* was sent (900 was a gap-carrying seq the stream skipped), so coming
		// back to it asks for what it actually missed rather than for a number it never saw.
		expect(sent(transport, "resume")).toContainEqual(expect.objectContaining({ conversationId: "c1", afterSeq: 902 }));
	});

	// A row click rebinds the conversation on screen, and rebinding disposes the session behind it — so a turn
	// still running would lose its answer: neither the screen nor the session file gets it (the second session
	// came back blank, with its prompt on disk and no reply). While a turn is in flight the row therefore opens
	// the session the way the “+” button opens one, in a conversation of its own, and leaves the answering one
	// alone to finish.
	it("asks the server to open a clicked session, and adopts the conversation it answers with", async () => {
		const transport = await mount();
		await bind(transport);
		await frames(transport, [{ type: "agent_start" } as AgentSessionEvent]);
		const at = "2026-01-01T00:00:00.000Z";
		transport.emit({
			type: "result",
			requestId: "r2",
			sessions: [
				{ path: "/tmp/s.jsonl", name: "this one", modified: at, messageCount: 2, firstMessage: "" },
				{ path: "/tmp/a.jsonl", name: "Fix the sort", modified: at, messageCount: 4, firstMessage: "fix the sort" },
			],
		});
		await tick();
		screen.getByText("Fix the sort").click();
		await tick();
		// Whether that means reusing the conversation already answering the session or opening one of its own is
		// the server's call — this page only asks, mid-turn or not.
		const asked = sent(transport, "switchSession").at(-1) as { sessionPath: string; requestId: string };
		expect(asked).toMatchObject({ sessionPath: "/tmp/a.jsonl" });

		// The conversation the server names is the one this page is on from then on: its log is what arrives next.
		transport.emit({ type: "result", requestId: asked.requestId, conversationId: "c2", sessionPath: "/tmp/a.jsonl" });
		await tick();
		expect(sent(transport, "resume").at(-1)).toMatchObject({ conversationId: "c2", afterSeq: 0 });
	});

	it("keeps an extension's note and dialog in the conversation that produced them", async () => {
		const transport = await mount();
		await bind(transport);
		transport.emit({ type: "result", requestId: "r7", conversationId: "c2", sessionPath: "/tmp/b.jsonl" });
		await tick();
		transport.emit({ type: "extensionUi", conversationId: "c1", kind: "notify", message: "a note from the session you left" });
		transport.emit({ type: "extensionUi", conversationId: "c1", kind: "select", title: "Pick one", message: "", options: ["alpha"], dialogId: "d1" });
		await tick();
		expect(document.body.textContent).not.toContain("a note from the session you left");
		expect(document.body.textContent).not.toContain("Pick one");

		// And going back to the first conversation shows the note where it was said: extension output belongs to
		// the conversation that produced it, so it was kept rather than dropped — and so was the question the
		// extension is still parked on, which is the one thing here that must not be lost.
		transport.emit({
			type: "result",
			requestId: "r9",
			sessions: [
				{ path: "/tmp/s.jsonl", name: "s.jsonl", modified: "2026-01-01T00:00:00.000Z", messageCount: 2, firstMessage: "" },
				{ path: "/tmp/b.jsonl", name: "b.jsonl", modified: "2026-01-01T00:00:00.000Z", messageCount: 1, firstMessage: "" },
			],
		});
		await tick();
		openRowByPath("/tmp/s.jsonl");
		await tick();
		expect(document.body.textContent).toContain("a note from the session you left");
		// Including the question it was waiting on: it was never answered, so it is still the chat's to answer.
		expect(document.body.textContent).toContain("Pick one");
	});

	// The four symptoms of one design: a chat and a pi session are one thing, so an answer can only land
	// where it was asked for, leaving a chat cannot stop it, and what you typed stays where you typed it.
	it("keeps a background turn running, and its answer, in the session that started it", async () => {
		const transport = await mount();
		await bind(transport);
		const said = (text: string) =>
			({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage: {} } }) as unknown as AgentSessionEvent;

		// The first session starts a turn, and the page leaves it for a new one before the answer lands.
		await frames(transport, [{ type: "agent_start" } as AgentSessionEvent]);
		transport.emit({ type: "result", requestId: "r7", conversationId: "c2", sessionPath: "/tmp/b.jsonl" });
		await tick();
		expect(sent(transport, "unsubscribe")).toEqual([]); // the turn is still running: it is not detached

		// The answer arrives while the page is looking at the other chat. It must not be printed here...
		transport.emit({ type: "event", conversationId: "c1", seq: 700, event: said("the first session's answer") });
		await tick();
		expect(document.body.textContent).not.toContain("the first session's answer");

		// ...and the session it belongs to is marked as running in the sidebar, so a turn with nobody looking
		// at it is still visible.
		const at = "2026-01-01T00:00:00.000Z";
		transport.emit({
			type: "result",
			requestId: "r8",
			sessions: [
				{ path: "/tmp/s.jsonl", name: "s.jsonl", modified: at, messageCount: 2, firstMessage: "", running: true },
				{ path: "/tmp/b.jsonl", name: "b.jsonl", modified: at, messageCount: 1, firstMessage: "" },
			],
		});
		await tick();
		const rows = [...document.querySelectorAll(".sessions li")];
		expect(rows[0]?.querySelector(".run-dot")).toBeTruthy();
		expect(rows[1]?.querySelector(".run-dot")).toBeNull();

		// Going back shows it: the answer is in the chat that asked for it, and nowhere else. The chat was
		// already held, so nothing is asked of the server — and what it holds is its own transcript.
		openRowByPath("/tmp/s.jsonl");
		await tick();
		expect(document.body.textContent).toContain("the first session's answer");
		expect(sent(transport, "switchSession")).toEqual([]);
	});

	it("keeps what is typed in the session it was typed in", async () => {
		const transport = await mount();
		await bind(transport);
		const box = () => screen.getByRole("textbox", { name: "Prompt" }) as HTMLTextAreaElement;

		fireEvent.input(box(), { target: { value: "half a thought" } });
		await tick();
		// Open another session: the box is that session's, so this draft is not on screen — and neither is
		// anything else the first chat was holding.
		transport.emit({ type: "result", requestId: "r7", conversationId: "c2", sessionPath: "/tmp/b.jsonl" });
		await tick();
		expect(box().value).toBe("");
		fireEvent.input(box(), { target: { value: "a second thought" } });
		await tick();

		// And coming back brings it back — it was never thrown away, only put down, and the other chat's draft
		// did not follow it here.
		transport.emit({
			type: "result",
			requestId: "r9",
			sessions: [
				{ path: "/tmp/s.jsonl", name: "s.jsonl", modified: "2026-01-01T00:00:00.000Z", messageCount: 2, firstMessage: "" },
				{ path: "/tmp/b.jsonl", name: "b.jsonl", modified: "2026-01-01T00:00:00.000Z", messageCount: 1, firstMessage: "" },
			],
		});
		await tick();
		openRowByPath("/tmp/s.jsonl");
		await tick();
		expect(box().value).toBe("half a thought");
		openRowByPath("/tmp/b.jsonl");
		await tick();
		expect(box().value).toBe("a second thought");
	});
});

describe("steering, queueing and stopping", () => {
	it("stops a running turn, and the Stop button only exists while one is running", async () => {
		const transport = await mount();
		await bind(transport);
		expect(document.querySelector(".stop")).toBeNull();
		await frames(transport, [{ type: "agent_start" } as AgentSessionEvent]);
		expect(document.querySelector(".stop")).toBeTruthy();
		screen.getByText("Stop").click();
		expect(transport.sent).toContainEqual({ type: "abort", conversationId: "c1" });
	});

	it("types into the box and sends a prompt when idle, a steer while running", async () => {
		const transport = await mount();
		await bind(transport);
		const box = screen.getByRole("textbox", { name: "Prompt" }) as HTMLTextAreaElement;
		fireEvent.input(box, { target: { value: "use pnpm" } });
		submit("form.composer");
		await tick();
		expect(sent(transport, "prompt")).toContainEqual({ type: "prompt", conversationId: "c1", text: "use pnpm", mode: "steer" });
		await frames(transport, [{ type: "agent_start" } as AgentSessionEvent]);
		fireEvent.input(box, { target: { value: "actually, pnpm -w" } });
		submit("form.composer");
		await tick();
		expect(sent(transport, "prompt")).toHaveLength(2);
	});

	it("attaches a pasted image and a pasted file, and sends them with the next prompt", async () => {
		const transport = await mount();
		await bind(transport);
		const box = screen.getByRole("textbox", { name: "Prompt" }) as HTMLTextAreaElement;
		pasteFiles(box, [
			new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" }),
			new File(["the report"], "report.txt", { type: "text/plain" }),
		]);

		// Both wait above the box as chips — the image by its thumbnail — and neither is typed into it.
		await waitFor(() => expect(document.querySelectorAll(".attachment")).toHaveLength(2));
		expect([...document.querySelectorAll(".attachment .name")].map((name) => name.textContent)).toEqual(["shot.png", "report.txt"]);
		expect(document.querySelector(".attachment .thumb")?.getAttribute("src")).toBe("data:image/png;base64,iVBORw==");
		expect(box.value).toBe("");

		// Removing a chip is the only thing you can do to it before it is sent.
		const extra = document.querySelectorAll(".attachment .remove")[1] as HTMLButtonElement;
		fireEvent.click(extra);
		await tick();
		expect(document.querySelectorAll(".attachment")).toHaveLength(1);
		pasteFiles(box, [new File(["the report"], "report.txt", { type: "text/plain" })]);
		await waitFor(() => expect(document.querySelectorAll(".attachment")).toHaveLength(2));

		fireEvent.input(box, { target: { value: "what is this?" } });
		submit("form.composer");
		await tick();
		expect(sent(transport, "prompt")).toContainEqual({
			type: "prompt",
			conversationId: "c1",
			text: "what is this?",
			mode: "steer",
			attachments: [
				{ name: "shot.png", mimeType: "image/png", data: "iVBORw==" },
				{ name: "report.txt", mimeType: "text/plain", data: "dGhlIHJlcG9ydA==" },
			],
		});
		// Sent means gone: the composer is empty again for the next prompt.
		expect(document.querySelectorAll(".attachment")).toHaveLength(0);
	});

	it("sends an image with no text at all, and refuses a file over the size limit", async () => {
		const transport = await mount();
		await bind(transport);
		const box = screen.getByRole("textbox", { name: "Prompt" }) as HTMLTextAreaElement;

		pasteFiles(box, [new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], "huge.png", { type: "image/png" })]);
		await waitFor(() => expect(document.querySelector('[data-role="attachment"]')?.textContent).toContain("huge.png is over 4 MB"));
		expect(document.querySelectorAll(".attachment")).toHaveLength(0);

		pasteFiles(box, [new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" })]);
		await waitFor(() => expect(document.querySelectorAll(".attachment")).toHaveLength(1));
		submit("form.composer");
		await tick();
		// An attachment alone is the question: the prompt carries no text but does carry the image.
		expect(sent(transport, "prompt")).toEqual([{ type: "prompt", conversationId: "c1", text: "", attachments: [{ name: "shot.png", mimeType: "image/png", data: "iVBORw==" }], mode: "steer" }]);
	});

	// The same limit the schema enforces, said in a sentence instead of a JSON-path error.
	// pi-ai replaces an image with "(image omitted: model does not support images)" when the model's own
	// config has no image input, so the paste would be invisible to the model and the answer would read like
	// a refusal. The chat knows the model only from the debug snapshot, so the paste is refused there instead.
	it("refuses an image the model in front of you cannot see, and takes it once a model can", async () => {
		const transport = await mount();
		await bind(transport);
		const model = (input: string[]) => ({
			type: "result" as const,
			requestId: "r9",
			conversationId: "c1",
			debug: { systemPrompt: "p", activeTools: [], commands: [], models: [], model: { provider: "lmstudio", modelId: "qwen3", input }, thinkingLevel: "off", memoryBlock: null },
		});
		transport.emit(model(["text"]));
		await tick();
		const box = screen.getByRole("textbox", { name: "Prompt" }) as HTMLTextAreaElement;

		pasteFiles(box, [new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" })]);
		await waitFor(() => expect(document.querySelector('[data-role="attachment"]')?.textContent).toContain("qwen3 has no image input"));
		expect(document.querySelectorAll(".attachment")).toHaveLength(0);
		// Only images belong to the model. A document still goes to the file tools, image input or not.
		pasteFiles(box, [new File(["the report"], "report.txt", { type: "text/plain" })]);
		await waitFor(() => expect(document.querySelectorAll(".attachment")).toHaveLength(1));

		// Switching to a model that declares image input is the fix, and the same paste works.
		transport.emit(model(["text", "image"]));
		await tick();
		pasteFiles(box, [new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" })]);
		await waitFor(() => expect(document.querySelectorAll(".attachment")).toHaveLength(2));
	});

	it("keeps at most the allowed number of attachments", async () => {
		const transport = await mount();
		await bind(transport);
		const box = screen.getByRole("textbox", { name: "Prompt" }) as HTMLTextAreaElement;
		pasteFiles(box, Array.from({ length: MAX_ATTACHMENTS + 3 }, (_, i) => new File(["x"], `f${i}.txt`, { type: "text/plain" })));
		await waitFor(() => expect(document.querySelector('[data-role="attachment"]')?.textContent).toBe(`at most ${MAX_ATTACHMENTS} attachments`));
		expect(document.querySelectorAll(".attachment")).toHaveLength(MAX_ATTACHMENTS);
	});

	it("shows a pasted image in the conversation it was sent from", async () => {
		const transport = await mount();
		await bind(transport);
		await frames(transport, [
			{
				type: "message_end",
				message: { role: "user", content: [{ type: "text", text: "look at this" }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" }] },
			} as unknown as AgentSessionEvent,
		]);
		const image = document.querySelector('.msg[data-role="user"] .attachment-image');
		expect(image?.getAttribute("src")).toBe("data:image/png;base64,aGVsbG8=");
		expect(screen.getByText("look at this")).toBeTruthy();
	});

	it("sends on Enter, keeps the newline on Shift+Enter", async () => {
		const transport = await mount();
		await bind(transport);
		const box = screen.getByRole("textbox", { name: "Prompt" }) as HTMLTextAreaElement;
		fireEvent.input(box, { target: { value: "ship it" } });
		fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
		expect(sent(transport, "prompt")).toHaveLength(0);
		fireEvent.keyDown(box, { key: "Enter" });
		await tick();
		expect(sent(transport, "prompt")).toContainEqual({ type: "prompt", conversationId: "c1", text: "ship it", mode: "steer" });
	});

	it("shows what the user queued while the turn was running", async () => {
		const transport = await mount();
		await bind(transport);
		await frames(transport, [{ type: "queue_update", steering: ["use pnpm"], followUp: ["then run the tests"] } as AgentSessionEvent]);
		expect([...document.querySelectorAll(".queued")].map((item) => item.textContent)).toEqual(["use pnpm", "then run the tests"]);
	});

	it("reports an error frame instead of going quiet", async () => {
		const transport = await mount();
		transport.emit({ type: "error", message: "unknown conversation c9" });
		await tick();
		expect(screen.getByRole("alert").textContent).toContain("unknown conversation c9");
	});

	// The registry is in-memory, so any server restart forgets the conversation the page is holding. Without
	// this the page errors at every later click and shows one frozen transcript until you reload by hand.
	// The code is what says so: a refusal for the same conversation (a prompt the model would not take) is
	// reported and nothing else. A restart is not news — "unknown conversation <uuid>" is not something a
	// user can act on, and it stayed on screen for the rest of the page's life — so the recovery is silent
	// and the chat carries the explanation (the reopened session names the turn the restart cut short).
	it("reopens the session a forgotten conversation was showing, as a conversation of its own", async () => {
		const transport = await mount();
		await bind(transport);
		await frames(transport, [{ type: "agent_start" } as AgentSessionEvent]);
		const said = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "half an answer" }], usage: {} } } as unknown as AgentSessionEvent;
		await frames(transport, [said]);
		expect(document.querySelectorAll("section.chat .msg")).toHaveLength(1); // control: it was on screen, so the reopen is what keeps it there
		transport.emit({ type: "error", message: "unknown conversation c1", code: "unknownConversation", conversationId: "c1" });
		await tick();
		// Nothing to act on, so nothing is said: the page recovers by itself.
		expect(screen.queryByRole("alert")).toBeNull();
		// No second conversation is created — the session is reopened, so the chat keeps its transcript.
		expect(sent(transport, "newSession")).toHaveLength(1);
		const reopened = sent(transport, "switchSession").at(-1) as { sessionPath: string; requestId: string };
		expect(reopened).toMatchObject({ sessionPath: "/tmp/s.jsonl" });
		// The server opens that file as a conversation of its own; the page lands on it and re-reads its log.
		transport.emit({ type: "result", requestId: reopened.requestId, conversationId: "c2", sessionPath: "/tmp/s.jsonl" });
		await tick();
		expect(sent(transport, "resume").at(-1)).toMatchObject({ conversationId: "c2", afterSeq: 0 });
		// The same chat is still on screen — it was reopened, not replaced — and its transcript is rebuilt from
		// the replay the resume asks for, which is why the cursor goes back to zero.
		expect(screen.getByRole("region", { name: "Chat" })).toBeTruthy();
	
	});

	it("does not replace the conversation for a failure that is not about it", async () => {
		const transport = await mount();
		await bind(transport);
		transport.emit({ type: "error", message: "a prompt needs text or an attachment", conversationId: "c1", requestId: "r9" });
		await tick();
		expect(screen.getByRole("alert").textContent).toContain("a prompt needs text");
		// Only the one from connecting — an unrelated failure must not throw the conversation away.
		expect(sent(transport, "newSession")).toHaveLength(1);
	});

	it("says so when the server speaks another protocol", async () => {
		const transport = await mount();
		transport.emit({ type: "hello", protocolVersion: 2, serverVersion: "9.9.9" });
		await tick();
		expect(screen.getByRole("alert")?.textContent).toContain("this UI speaks v1");
	});
});

describe("the address bar", () => {
	it("says which session is on screen, and follows the one you click", async () => {
		const transport = await mount();
		await bind(transport);
		expect(sessionInUrl()).toBe("s.jsonl");
		const at = "2026-01-01T00:00:00.000Z";
		transport.emit({
			type: "result",
			requestId: "r2",
			sessions: [
				{ path: "/tmp/s.jsonl", name: "This one", modified: at, messageCount: 2, firstMessage: "" },
				{ path: "/tmp/a.jsonl", name: "Fix the sort", modified: at, messageCount: 4, firstMessage: "fix the sort" },
			],
		});
		await tick();
		screen.getByText("Fix the sort").click();
		await tick();
		// Still the old session until the server says the conversation moved; then the address bar moves with it.
		expect(sessionInUrl()).toBe("s.jsonl");
		const requestId = (sent(transport, "switchSession")[0] as { requestId: string }).requestId;
		transport.emit({ type: "result", requestId, conversationId: "c1", sessionPath: "/tmp/a.jsonl" });
		await tick();
		expect(sessionInUrl()).toBe("a.jsonl");
	});

	it("opens the session the address bar opened the page on", async () => {
		history.replaceState(null, "", "/sessions/a.jsonl");
		const transport = await mount();
		transport.emit({ type: "connected" });
		await tick();
		// Opening a session means rebinding a conversation, so the deep link waits for the startup
		// conversation the socket hands out, then replaces it instead of leaving an empty chat on screen.
		transport.emit({ type: "result", requestId: "r1", conversationId: "c1", sessionPath: "/tmp/fresh.jsonl" });
		await tick();
		// The address names the session by its file name; the server resolves it inside .flypi/sessions, and
		// answers with the conversation that file has — a new one, since nothing was answering it.
		expect(sent(transport, "switchSession")).toEqual([expect.objectContaining({ sessionPath: "a.jsonl" })]);
		// The address bar is the page's own record of what it was showing, so a reload names that session.
		// That is a starting point, not a pin: once the page has landed there, another row has to stick.
		// Watching the URL instead of applying it once made every click snap back to the session named in it.
		const opened = sent(transport, "switchSession")[0] as { requestId: string };
		transport.emit({ type: "result", requestId: opened.requestId, conversationId: "c2", sessionPath: "/tmp/a.jsonl" });
		await tick();
		const at = "2026-01-01T00:00:00.000Z";
		transport.emit({
			type: "result",
			requestId: "r8",
			sessions: [
				{ path: "/tmp/a.jsonl", name: "Where the URL opened", modified: at, messageCount: 2, firstMessage: "" },
				{ path: "/tmp/s.jsonl", name: "Somewhere else", modified: at, messageCount: 3, firstMessage: "somewhere else" },
			],
		});
		await tick();
		screen.getByText("Somewhere else").click();
		await tick();
		const moved = sent(transport, "switchSession")[1] as { requestId: string };
		transport.emit({ type: "result", requestId: moved.requestId, conversationId: "c3", sessionPath: "/tmp/s.jsonl" });
		await tick();
		// Two switches, and no third one back to /tmp/a.jsonl.
		expect(sent(transport, "switchSession")).toHaveLength(2);
		expect(sessionInUrl()).toBe("s.jsonl");
		history.replaceState(null, "", "/");
	});
});

describe("the sidebar", () => {
	it("shows a chat in the list only once its first message has been sent", async () => {
		const transport = await mount();
		await bind(transport);
		const asked = () => sent(transport, "listSessions").length;
		// A chat you have only started has no file, so there is nothing to ask for it a second time.
		expect(asked()).toBe(1);
		// The first user message is what earns the row — the one event that proves pi has written the file.
		await frames(transport, recordedEvents.slice(0, 6));
		expect(asked()).toBe(2);
		// And the answer is what puts it on screen, as the current row: named by the first message.
		transport.emit({
			type: "result",
			requestId: "r9",
			sessions: [{ path: "/tmp/s.jsonl", modified: "2026-01-01T00:00:00.000Z", messageCount: 1, firstMessage: "fix the failing test in this repo" }],
		});
		await tick();
		expect((document.querySelector(".sessions input.name") as HTMLInputElement).value).toBe("fix the failing test in this repo");
		// The rest of the turn asks once more — when it settles, so the list's own `running` flag is current —
		// and not for any message before that.
		await frames(transport, recordedEvents, 6);
		expect(asked()).toBe(3);
	});

	it("lists every session by itself, marks the one you are in, and opens the one you click", async () => {
		const transport = await mount();
		await bind(transport);
		expect(sent(transport, "newSession")).toHaveLength(1);
		// The list comes with the conversation — there is no Open button to press first.
		expect(sent(transport, "listSessions")).toHaveLength(1);
		expect(screen.queryByText("Open")).toBeNull();
		const at = "2026-01-01T00:00:00.000Z";
		transport.emit({
			type: "result",
			requestId: "r2",
			sessions: [
				{ path: "/tmp/s.jsonl", name: "This one", modified: at, messageCount: 2, firstMessage: "" },
				{ path: "/tmp/a.jsonl", name: "Fix the sort", modified: at, messageCount: 4, firstMessage: "fix the sort" },
			],
		});
		await tick();
		// Nowhere in the sidebar is the session's file path: the row you are in is a rename field, and
		// that is how you know which one you are in.
		expect(document.body.textContent).not.toContain("/tmp/s.jsonl");
		// The row you are in is the inline rename field; the others are plain text rows, no counts.
		expect((document.querySelector(".sessions input.name") as HTMLInputElement).value).toBe("This one");
		expect(document.querySelector(".sessions .session")?.textContent).toBe("Fix the sort");
		expect(document.body.textContent).not.toContain("msgs");
		screen.getByText("Fix the sort").click();
		await tick();
		expect(sent(transport, "switchSession")).toEqual([expect.objectContaining({ sessionPath: "/tmp/a.jsonl" })]);
		// The + on the title row is what starts a session; there is no New button.
		expect(screen.queryByText("New")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "New session" }));
		await tick();
		expect(sent(transport, "newSession")).toHaveLength(2);
	});

	// A finished turn must stop the row blinking even when the list still says it is running: the list was
	// fetched mid-turn, and the chat this page holds is the truth about its own session.
	it("stops the running dot when a turn settles, and marks a background chat unread instead", async () => {
		const transport = await mount();
		await bind(transport);
		const at = "2026-01-01T00:00:00.000Z";
		const rows = (running: boolean) => [
			{ path: "/tmp/s.jsonl", name: "s.jsonl", modified: at, messageCount: 2, firstMessage: "", running },
			{ path: "/tmp/b.jsonl", name: "b.jsonl", modified: at, messageCount: 1, firstMessage: "", running: false },
		];
		const rowFor = (name: string) =>
			[...document.querySelectorAll(".sessions li")].find(
				(item) => (item.textContent ?? "").includes(name) || (item.querySelector("input.name") as HTMLInputElement | null)?.value === name,
			);

		await frames(transport, [{ type: "agent_start" } as AgentSessionEvent]);
		transport.emit({ type: "result", requestId: "rows", sessions: rows(true) });
		await tick();
		expect(rowFor("s.jsonl")?.querySelector(".run-dot")).toBeTruthy();

		// Watched from the chat on screen: finishing is not news, so it is not unread either.
		transport.emit({ type: "event", conversationId: "c1", seq: 40, event: { type: "agent_settled" } as AgentSessionEvent });
		await tick();
		expect(rowFor("s.jsonl")?.querySelector(".run-dot")).toBeNull();
		expect(rowFor("s.jsonl")?.querySelector(".unread-dot")).toBeNull();

		// A second turn, and the page moves to another chat before it finishes. The list still says `running`
		// (it was fetched during the turn) — the stale flag must not keep the dot blinking.
		await frames(transport, [{ type: "agent_start" } as AgentSessionEvent], 40);
		transport.emit({ type: "result", requestId: "bind-b", conversationId: "c2", sessionPath: "/tmp/b.jsonl" });
		await tick();
		transport.emit({ type: "event", conversationId: "c1", seq: 41, event: { type: "agent_settled" } as AgentSessionEvent });
		await tick();

		expect(rowFor("s.jsonl")?.querySelector(".run-dot")).toBeNull();
		expect(rowFor("s.jsonl")?.querySelector(".unread-dot")).toBeTruthy();
		expect(rowFor("s.jsonl")?.classList.contains("unread")).toBe(true);

		// Opening it reads it: the still dot and the bold go away.
		openRowByPath("/tmp/s.jsonl");
		await tick();
		expect(rowFor("s.jsonl")?.querySelector(".unread-dot")).toBeNull();
		expect(rowFor("s.jsonl")?.classList.contains("unread")).toBe(false);
	});

	it("notifies the desktop when a background turn finishes, and lets the bell turn it off", async () => {
		const shown: { title: string; body?: string }[] = [];
		class FakeNotification {
			static permission: NotificationPermission = "granted";
			static requestPermission = async (): Promise<NotificationPermission> => "granted";
			onclick: (() => void) | null = null;
			closed = false;
			constructor(title: string, options: NotificationOptions = {}) {
				shown.push({ title, body: options.body });
			}
			close(): void {
				this.closed = true;
			}
		}
		vi.stubGlobal("Notification", FakeNotification);
		const transport = await mount();
		await bind(transport);

		// The bell is on, because permission is granted and the page has no stored preference.
		const bell = screen.getByRole("button", { name: /desktop notifications/i });
		expect(bell.getAttribute("aria-pressed")).toBe("true");

		// A turn that finishes in the chat on screen is not a notification: you watched it.
		transport.emit({ type: "event", conversationId: "c1", seq: 9, event: { type: "agent_settled" } as AgentSessionEvent });
		await tick();
		expect(shown).toHaveLength(0);

		// One that finishes in the chat you left is, and it says which session and what it said.
		transport.emit({ type: "result", requestId: "bind-b", conversationId: "c2", sessionPath: "/tmp/b.jsonl" });
		await tick();
		transport.emit({
			type: "event",
			conversationId: "c1",
			seq: 10,
			event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "the sort is fixed" }], usage: {} } } as unknown as AgentSessionEvent,
		});
		transport.emit({ type: "event", conversationId: "c1", seq: 11, event: { type: "agent_settled" } as AgentSessionEvent });
		await tick();
		expect(shown).toHaveLength(1);
		expect(shown[0]!.title).toContain("s.jsonl");
		expect(shown[0]!.body).toBe("the sort is fixed");

		// The bell turns them off, and the preference outlives the page.
		fireEvent.click(bell);
		await tick();
		expect(bell.getAttribute("aria-pressed")).toBe("false");
		expect(localStorage.getItem("flypi.notifications")).toBe("off");
	});

	it("deletes a session row, and starts a new conversation when you delete the one you are in", async () => {
		const transport = await mount();
		await bind(transport);
		const at = "2026-01-01T00:00:00.000Z";
		// The current row's path is the one `bind()` handed the app, so the rows cover both cases.
		const row = (name: string) => ({ path: name === "this-one" ? "/tmp/s.jsonl" : `/tmp/${name}.jsonl`, name, modified: at, messageCount: 3, firstMessage: name });
		transport.emit({ type: "result", requestId: "r2", sessions: [row("this-one"), row("fix-the-sort")] });
		await tick();

		// A row you are not in: one click deletes the file — there is no confirmation step — and the list
		// that comes back with the ack is what takes it off the screen. The session you are in stays put.
		fireEvent.click(screen.getByRole("button", { name: "Delete fix-the-sort" }));
		await tick();
		expect(sent(transport, "deleteSession")).toEqual([{ type: "deleteSession", sessionPath: "/tmp/fix-the-sort.jsonl", requestId: expect.any(String) }]);
		const requestId = (sent(transport, "deleteSession")[0] as { requestId: string }).requestId;
		transport.emit({ type: "result", requestId, sessions: [row("this-one")] });
		await tick();
		expect(document.querySelectorAll(".sessions .session")).toHaveLength(0);
		expect((document.querySelector(".sessions input.name") as HTMLInputElement).value).toBe("this-one");

		// The row you *are* in: the conversation went with the file, so the app starts a fresh one
		// rather than sending prompts to a conversation id the server has already forgotten.
		const before = sent(transport, "newSession").length;
		fireEvent.click(screen.getByRole("button", { name: "Delete this-one" }));
		await tick();
		const current = sent(transport, "deleteSession").at(-1) as { requestId: string };
		transport.emit({ type: "result", requestId: current.requestId, sessions: [] });
		await tick();
		expect(sent(transport, "newSession")).toHaveLength(before + 1);
	});

	it("sends the model and thinking-level you pick", async () => {
		const transport = await mount();
		await bind(transport);
		expect(sent(transport, "debug")).toHaveLength(1);
		transport.emit({
			type: "result",
			requestId: "r2",
			conversationId: "c1",
			debug: {
				systemPrompt: "you are flypi",
				activeTools: ["read", "bash"],
				commands: [],
				models: [{ provider: "stub", modelId: "stub-model", input: ["text"] }],
				model: { provider: "stub", modelId: "stub-model", input: ["text"] },
				thinkingLevel: "medium",
			},
		});
		await tick();
		const model = screen.getByRole("combobox", { name: "Model" }) as HTMLSelectElement;
		expect([...model.options].map((o) => o.textContent)).toContain("stub/stub-model");
		fireEvent.change(model, { target: { value: "stub/stub-model" } });
		fireEvent.change(screen.getByRole("combobox", { name: "Thinking" }), { target: { value: "high" } });
		await tick();
		expect(sent(transport, "setModel")).toEqual([expect.objectContaining({ conversationId: "c1", provider: "stub", modelId: "stub-model" })]);
		expect(sent(transport, "setThinkingLevel")).toEqual([expect.objectContaining({ conversationId: "c1", level: "high" })]);
	});

	it("renames the session from inside its own row", async () => {
		const transport = await mount();
		await bind(transport);
		const at = "2026-01-01T00:00:00.000Z";
		transport.emit({
			type: "result",
			requestId: "r2",
			sessions: [{ path: "/tmp/s.jsonl", name: "", modified: at, messageCount: 3, firstMessage: "fix the sort" }],
		});
		await tick();
		const box = screen.getByRole("textbox", { name: "Session name" }) as HTMLInputElement;
		// The field holds the name if there is one, otherwise the first-message hint.
		expect(box.value).toBe("fix the sort");
		fireEvent.input(box, { target: { value: "afternoon session" } });
		fireEvent.keyDown(box, { key: "Enter" });
		await tick();
		expect(sent(transport, "renameSession")).toEqual([expect.objectContaining({ conversationId: "c1", name: "afternoon session" })]);
		// A rename re-lists, so the row carries the new name and clicking away sends nothing again.
		transport.emit({
			type: "result",
			requestId: "r3",
			sessions: [{ path: "/tmp/s.jsonl", name: "afternoon session", modified: at, messageCount: 3, firstMessage: "fix the sort" }],
		});
		await tick();
		fireEvent.blur(box);
		await tick();
		expect(sent(transport, "renameSession")).toHaveLength(1);
		// Escape puts back what the row said.
		fireEvent.input(box, { target: { value: "nope" } });
		fireEvent.keyDown(box, { key: "Escape" });
		expect(box.value).toBe("afternoon session");
	});

	it("the rename field holds the first-message hint, and nothing for a session that has not started", async () => {
		const transport = await mount();
		await bind(transport);
		const at = "2026-01-01T00:00:00.000Z";
		const field = () => screen.getByRole("textbox", { name: "Session name" }) as HTMLInputElement;
		const row = (name: string, firstMessage: string) => ({ path: "/tmp/s.jsonl", name, modified: at, messageCount: firstMessage ? 1 : 0, firstMessage });
		transport.emit({ type: "result", requestId: "r2", sessions: [row("", "")] });
		await tick();
		expect(field().value).toBe("");
		expect(field().placeholder).toBe("New session");
		transport.emit({ type: "result", requestId: "r3", sessions: [row("", "fix the sort")] });
		await tick();
		expect(field().value).toBe("fix the sort");
		// A name you gave it wins over the hint.
		transport.emit({ type: "result", requestId: "r4", sessions: [row("The fix", "fix the sort")] });
		await tick();
		expect(field().value).toBe("The fix");
	});

	it("shows usage and cost on the turn that earned them, and no totals in the sidebar", async () => {
		const transport = await mount();
		await bind(transport);
		await replay(transport);
		const lines = [...document.querySelectorAll('.msg [data-role="usage"]')].map((node) => node.textContent ?? "");
		expect(lines.some((line) => line.includes("in /") && line.includes("$"))).toBe(true);
		// The "turn"/"total" lines were removed from the chat: the numbers stay with the answer they
		// describe, and the aggregates live in the debug panel (see the prompt-cache tests below).
		expect(document.querySelector(".sidebar [data-role=usage], [data-role=usage-total]")).toBeNull();
	});
});

describe("the debug panel", () => {
	it("shows the system prompt, the active tools, and the memory block that was injected", async () => {
		const transport = await mount();
		await bind(transport);
		transport.emit({
			type: "result",
			requestId: "r2",
			conversationId: "c1",
			debug: {
				systemPrompt: "you are flypi, a coding agent",
				activeTools: ["read", "bash"],
				commands: [],
				models: [],
				thinkingLevel: "off",
				memoryBlock: '<relevant_memories>\n- sort() must compare numerically\n</relevant_memories>',
			},
		});
		screen.getByText("Debug").click();
		await tick();
		expect(document.querySelector(".system-prompt")?.textContent).toContain("you are flypi, a coding agent");
		expect([...document.querySelectorAll(".active-tools li")].map((li) => li.textContent)).toEqual(["read", "bash"]);
		// What actually went into the turn — the Phase 4 contract, visible from Phase 2.
		expect(document.querySelector(".memory-block")?.textContent).toContain("sort() must compare numerically");
	});

	it("says there is no memory block yet rather than inventing one", async () => {
		const transport = await mount();
		await bind(transport);
		transport.emit({
			type: "result",
			requestId: "r2",
			conversationId: "c1",
			debug: { systemPrompt: "p", activeTools: [], commands: [], models: [], thinkingLevel: "off", memoryBlock: null },
		});
		screen.getByText("Debug").click();
		await tick();
		expect(document.querySelector(".memory-block")?.textContent).toBe("no memory block injected");
	});
});

// A2 of the prompt-cache phase (docs/prompt-cache.md): the numbers the provider reported have to be
// readable next to the block that costs them. They are the reducer's own per-turn and per-conversation
// sums, so driving the frames drives the real thing.
function cacheLines(): string[] {
	return (document.querySelector('[data-role="cache"]')?.textContent ?? "")
		.split("\n")
		.map((line) => line.trim());
}

describe("the prompt cache in the debug panel", () => {
	const answer = (usage: { input: number; cacheRead: number }) =>
		({
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			usage: { ...usage, output: 10, cacheWrite: 0, totalTokens: usage.input + usage.cacheRead + 10, cost: { total: 0 } },
		}) as unknown as AgentSessionEvent;

	async function oneTurn(transport: FakeTransport, usage: { input: number; cacheRead: number }) {
		const message = answer(usage);
		emit(transport, { type: "agent_start" } as AgentSessionEvent);
		emit(transport, { type: "message_start", message } as unknown as AgentSessionEvent);
		emit(transport, { type: "message_end", message } as unknown as AgentSessionEvent);
		emit(transport, { type: "agent_settled" } as AgentSessionEvent);
		await tick();
	}

	it("shows cache read/write for the last turn and for the whole conversation", async () => {
		const transport = await mount();
		await bind(transport);
		// Turn 1 is cold; turn 2 has turn 1's prompt served from cache — the shape A0 measured.
		await oneTurn(transport, { input: 1000, cacheRead: 0 });
		await oneTurn(transport, { input: 200, cacheRead: 1000 });
		screen.getByText("Debug").click();
		await tick();
		expect(cacheLines()).toEqual([
			"last turn: 1.0k read / 0 write · 83% of the prompt from cache",
			"this conversation: 1.0k read / 0 write · 45% of the prompt from cache",
			]);
	});

	it("names the turn while it runs, and says so when the provider reported nothing", async () => {
		const transport = await mount();
		await bind(transport);
		screen.getByText("Debug").click();
		await tick();
		expect(cacheLines()).toEqual([
			"last turn: the provider reported no usage",
			"this conversation: the provider reported no usage",
			]);
		emit(transport, { type: "agent_start" } as AgentSessionEvent);
		await tick();
		expect(cacheLines()[0]).toMatch(/^this turn: /);
	});
});

// The daemon's job queue, in the activity panel (docs/architecture.md Phase 4.5).
describe("the scheduler section", () => {
	it("asks for the queue when the panel opens, and lists what is queued and what ran", async () => {
		const transport = await mount();
		await bind(transport);
		screen.getByText("Debug").click();
		await tick();
		// Asked once, when opened — the queue belongs to the daemon, not the conversation, so it is its own
		// command rather than part of the debug snapshot.
		const request = sent(transport, "scheduler")[0] as { requestId: string };
		expect(request).toBeTruthy();
		// Until it answers the section says so; "nothing queued" and "there is no scheduler here" must not
		// look the same.
		expect(document.querySelector(".scheduler-empty")?.textContent).toBe("no scheduler info yet");

		transport.emit({
			type: "result",
			requestId: request.requestId,
			scheduler: {
				jobs: [{ kind: "memory.consolidate", nextRunAt: "2026-10-12T10:00:00.000Z", running: false }],
				jobRuns: [{ kind: "memory.reembed", status: "ok", startedAt: "2026-10-12T09:00:00.000Z", finishedAt: "2026-10-12T09:00:02.000Z", detail: "re-embedded 4, skipped 0" }],
			},
		});
		await tick();
		expect([...document.querySelectorAll("[data-role='scheduler-jobs'] li")].map((li) => li.textContent)).toEqual(["memory.consolidate — due 2026-10-12T10:00:00.000Z"]);
		// The attempt history, with what the job changed — the reason `job_runs` exists.
		const run = document.querySelector("[data-role='scheduler-runs'] li") as HTMLElement;
		expect([run.dataset.kind, run.dataset.status]).toEqual(["memory.reembed", "ok"]);
		expect(run.textContent).toContain("re-embedded 4, skipped 0");
	});

	it("says an empty queue is empty, and a run with nothing to report says only what it did", async () => {
		const transport = await mount();
		await bind(transport);
		screen.getByText("Debug").click();
		await tick();
		const request = sent(transport, "scheduler")[0] as { requestId: string };
		transport.emit({
			type: "result",
			requestId: request.requestId,
			scheduler: { jobs: [{ kind: "wiki.render", nextRunAt: "2026-10-12T10:00:00.000Z", running: true }], jobRuns: [{ kind: "wiki.render", status: "failed", startedAt: "2026-10-12T09:00:00.000Z", finishedAt: "2026-10-12T09:00:01.000Z" }] },
		});
		await tick();
		// A claim in flight is shown as in flight — the point of `locked_at` is that a run survives its
		// process, and the page should not pretend a dead worker's job is still going.
		expect([...document.querySelectorAll("[data-role='scheduler-jobs'] li")].map((li) => li.textContent)).toEqual(["wiki.render — running"]);
		const run = document.querySelector("[data-role='scheduler-runs'] li") as HTMLElement;
		expect([run.dataset.kind, run.dataset.status]).toEqual(["wiki.render", "failed"]);
		// No detail, so no trailing dash and nothing invented.
		expect(run.textContent).toBe("wiki.render failed");

		// A queue with nothing in it is a real answer, said plainly. It is not the same as this process
		// having no scheduler, which the test above covers.
		transport.emit({ type: "result", requestId: request.requestId, scheduler: { jobs: [], jobRuns: [] } });
		await tick();
		expect([...document.querySelectorAll("[data-role='scheduler-jobs'] li, [data-role='scheduler-runs'] li")].map((li) => li.textContent)).toEqual(["nothing queued", "no job has run yet"]);
	});

	it("keeps a queue that refused to answer in its own section, not on the chat", async () => {
		const transport = await mount();
		await bind(transport);
		screen.getByText("Debug").click();
		await tick();
		const request = sent(transport, "scheduler")[0] as { requestId: string };
		transport.emit({ type: "error", requestId: request.requestId, message: "this flypi process has no scheduler — `flypi start` runs one" });
		await tick();
		expect(document.querySelector("[data-role='scheduler-error']")?.textContent).toContain("no scheduler");
		// A process that is not a daemon is not a failed turn.
		expect(document.querySelector('[role="alert"]')).toBeNull();
	});
});

// The parts that only show up when something is missing, half-finished, or not answered yet.
describe("the edges", () => {
	it("sends nothing before there is a conversation to send it to", async () => {
		const transport = await mount();
		// There is no session row to rename yet either, so the rename field does not exist.
		expect(screen.queryByRole("textbox", { name: "Session name" })).toBeNull();
		fireEvent.input(screen.getByRole("textbox", { name: "Prompt" }), { target: { value: "hello" } });
		submit("form.composer");
		await tick();
		// The socket asked for a conversation on connecting and has not been given one: there is nothing to
		// send a prompt to, and no fork button because no transcript is on screen.
		expect(screen.queryByRole("button", { name: "Fork from this answer" })).toBeNull();
		expect(transport.sent.filter((command) => command.type === "fork" || command.type === "prompt")).toEqual([]);
	});

	it("does not send an empty prompt, or rename a session to nothing or to the same name", async () => {
		const transport = await mount();
		await bind(transport);
		submit("form.composer");
		transport.emit({
			type: "result",
			requestId: "r2",
			sessions: [{ path: "/tmp/s.jsonl", name: "This one", modified: "2026-01-01T00:00:00.000Z", messageCount: 2, firstMessage: "" }],
		});
		await tick();
		const box = screen.getByRole("textbox", { name: "Session name" }) as HTMLInputElement;
		fireEvent.input(box, { target: { value: "   " } });
		fireEvent.keyDown(box, { key: "Enter" });
		fireEvent.input(box, { target: { value: "This one" } });
		fireEvent.blur(box);
		await tick();
		expect(transport.sent.filter((command) => command.type === "prompt" || command.type === "renameSession")).toEqual([]);
	});

	it("queues a follow-up instead of steering when the box says so", async () => {
		const transport = await mount();
		await bind(transport);
		await frames(transport, [{ type: "agent_start" } as AgentSessionEvent]);
		fireEvent.click(screen.getByRole("checkbox", { name: /follow up/i }));
		fireEvent.input(screen.getByRole("textbox", { name: "Prompt" }), { target: { value: "and then commit it" } });
		submit("form.composer");
		await tick();
		expect(sent(transport, "prompt")).toEqual([expect.objectContaining({ text: "and then commit it", mode: "followUp" })]);
	});

	it("shows nothing for a tool call that is only half streamed", async () => {
		const transport = await mount();
		await bind(transport);
		await frames(transport, [
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "toolcall_end",
					contentIndex: 0,
					partial: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }], usage: {} },
				},
			} as unknown as AgentSessionEvent,
		]);
		expect(document.querySelector(".msg")).toBeNull();
		expect(document.querySelector(".tool-card")).toBeNull();
	});

	it("shows a card whose tool call had no arguments without an empty args element", async () => {
		const transport = await mount();
		await bind(transport);
		await frames(transport, [
			{ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash" }], usage: {} } } as unknown as AgentSessionEvent,
		]);
		expect(document.querySelector(".tool-card[data-tool=bash]")).toBeTruthy();
		expect(document.querySelector("[data-role=args]")).toBeNull();
	});

	it("opens the debug panel before the server has answered, and asks again each time it opens", async () => {
		const transport = await mount();
		await bind(transport);
		screen.getByText("Debug").click();
		await tick();
		expect(document.querySelector(".debug-empty")?.textContent).toBe("no debug info yet");
		screen.getByText("Hide debug").click();
		await tick();
		expect(document.querySelector(".debug-empty")).toBeNull();
		screen.getByText("Debug").click();
		await tick();
		expect(sent(transport, "debug")).toHaveLength(3); // once when the conversation was bound, twice on open
	});

	it("marks the model the session is using and sends the one you pick", async () => {
		const transport = await mount();
		await bind(transport);
		transport.emit({
			type: "result",
			requestId: "r2",
			debug: {
				systemPrompt: "p",
				activeTools: [],
				commands: [],
				model: { provider: "anthropic", modelId: "opus", input: ["text", "image"] },
				models: [{ provider: "anthropic", modelId: "opus", input: ["text", "image"] }, { provider: "lmstudio", modelId: "qwen3", input: ["text"] }],
				thinkingLevel: "low",
			},
		});
		await tick();
		expect(screen.getByText("opus (current)")).toBeTruthy();
		const thinking = screen.getByRole("combobox", { name: "Thinking" }) as HTMLSelectElement;
		expect(thinking.options[2]?.selected).toBe(true); // off, minimal, low
		fireEvent.change(screen.getByRole("combobox", { name: "Model" }), { target: { value: "lmstudio/qwen3" } });
		await tick();
		expect(sent(transport, "setModel")).toEqual([expect.objectContaining({ provider: "lmstudio", modelId: "qwen3" })]);
	});

	it("names a session row by its name, then its first message, then its path", async () => {
		const transport = await mount();
		await bind(transport);
		const at = "2026-01-01T00:00:00.000Z";
		transport.emit({
			type: "result",
			requestId: "r2",
			sessions: [
				{ path: "/tmp/named.jsonl", name: "The one with the fix", modified: at, messageCount: 9, firstMessage: "fix the sort" },
				{ path: "/tmp/unnamed.jsonl", modified: at, messageCount: 2, firstMessage: "just a question" },
				{ path: "/tmp/empty.jsonl", modified: at, messageCount: 0, firstMessage: "" },
			],
		});
		await tick();
		expect(screen.getByText("The one with the fix")).toBeTruthy();
		expect(screen.getByText("just a question")).toBeTruthy();
		expect(screen.getByText("/tmp/empty.jsonl")).toBeTruthy();
		expect(document.querySelectorAll(".sessions .session")).toHaveLength(3);
	});

	it("says which turn flypi's restart cut short, and stops saying it about an older one", async () => {
		const transport = await mount();
		transport.emit({ type: "connected" });
		await tick();
		// What the server answers when the page opens a chat whose run record was left `running`.
		transport.emit({ type: "result", requestId: "r1", conversationId: "c1", sessionPath: "/tmp/s.jsonl", interrupted: { at: "2026-10-12T09:00:00.000Z" } });
		await tick();
		expect(document.querySelector('[data-role="interrupted"]')?.textContent).toContain("2026-10-12T09:00:00.000Z");
		// A notice, not an error: nothing failed, the turn simply did not finish.
		expect(document.querySelector('[role="alert"]')).toBeNull();

		// A chat with no such record says nothing: the page does not keep warning about an old stop.
		transport.emit({ type: "result", requestId: "r2", conversationId: "c2", sessionPath: "/tmp/other.jsonl" });
		await tick();
		expect(document.querySelector('[data-role="interrupted"]')).toBeNull();
	});
	it("says it is reconnecting when the socket drops, and re-attaches to the same conversation when it returns", async () => {
		const transport = await mount();
		await bind(transport);
		const started = sent(transport, "newSession").length;
		transport.emit({ type: "disconnected" });
		await tick();
		expect(document.querySelector(".offline")?.textContent).toBe("reconnecting…");
		transport.emit({ type: "connected" });
		await tick();
		// A reconnect re-attaches: the server replays what the page missed, it does not open a second chat.
		expect(sent(transport, "resume").at(-1)).toMatchObject({ conversationId: "c1" });
		expect(sent(transport, "newSession")).toHaveLength(started);
	});
});

describe("the page's own settings", () => {
	it("switches between light and dark from the icon on the title row", async () => {
		await mount();
		const toggle = () => screen.getByRole("button", { name: /theme/i });
		// With no stored choice the page is whatever it resolved to, and the icon offers the other one.
		expect(toggle().getAttribute("aria-label")).toBe(`Switch to ${currentTheme() === "dark" ? "light" : "dark"} theme`);
		fireEvent.click(toggle());
		await tick();
		expect(document.documentElement.dataset.theme).toBe("dark");
		// The logo follows the palette: each file is opaque and tinted for one theme only.
		expect(document.querySelector(".panel-head .logo")?.getAttribute("src")).toBe("/flypi-logo-dark.jpeg");
		expect(toggle().getAttribute("aria-label")).toBe("Switch to light theme");
		fireEvent.click(toggle());
		await tick();
		expect(document.documentElement.dataset.theme).toBe("light");
		expect(document.querySelector(".panel-head .logo")?.getAttribute("src")).toBe("/flypi-logo-light.jpeg");
		// Theme never touches the socket: it is the page's business, not the server's.
		expect(current.sent).toEqual([]);
	});

	it("resizes the side panels from the gutters, and remembers what they were set to", async () => {
		await mount();
		const layout = document.querySelector(".layout") as HTMLElement;
		// +80px at the default root size is +5rem; the right-hand gutter grows leftwards.
		fireEvent.pointerDown(screen.getByRole("slider", { name: "Resize the sidebar" }), { clientX: 240 });
		fireEvent.pointerMove(window, { clientX: 320 });
		fireEvent.pointerUp(window);
		fireEvent.pointerDown(screen.getByRole("slider", { name: "Resize the activity panel" }), { clientX: 900 });
		fireEvent.pointerMove(window, { clientX: 860 });
		fireEvent.pointerUp(window);
		await tick();
		expect(layout.style.getPropertyValue("--sidebar-w")).toBe("20rem");
		expect(layout.style.getPropertyValue("--activity-w")).toBe("24.5rem");
		// Same as the theme: the page's own setting, so nothing goes over the socket.
		expect(localStorage.getItem("flypi.sidebarWidth")).toBe("20");
		expect(current.sent).toEqual([]);
	});

	it("keeps a saved width, and never lets a panel be dragged past its limits", async () => {
		localStorage.setItem("flypi.activityWidth", "30");
		await mount();
		const layout = document.querySelector(".layout") as HTMLElement;
		expect(layout.style.getPropertyValue("--activity-w")).toBe("30rem");
		const right = screen.getByRole("slider", { name: "Resize the activity panel" });
		// Keyboard-only resize: the same clamp the drag goes through.
		fireEvent.keyDown(right, { key: "ArrowRight" });
		await tick();
		expect(layout.style.getPropertyValue("--activity-w")).toBe("29rem");
		for (let i = 0; i < 40; i++) fireEvent.keyDown(right, { key: "ArrowRight" });
		await tick();
		expect(layout.style.getPropertyValue("--activity-w")).toBe("14rem"); // the limit, not below it
		localStorage.removeItem("flypi.activityWidth");
	});
});

describe("the live metrics on the send row", () => {
	// The rates come from when events arrive, so the clock is the fixture here: fake Date only, so the
	// component's own refresh interval stays real.
	const usage = { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 1200, cost: { total: 0 } };
	const assistant = () => ({ role: "assistant", content: [{ type: "text", text: "done" }], usage }) as unknown as AgentSessionEvent;

	async function streamOneResponse(transport: FakeTransport): Promise<void> {
		emit(transport, { type: "agent_start" } as AgentSessionEvent);
		emit(transport, { type: "turn_start" } as AgentSessionEvent);
		vi.advanceTimersByTime(100); // the request is sent, the stream opens
		emit(transport, { type: "message_start", message: assistant() } as unknown as AgentSessionEvent);
		vi.advanceTimersByTime(900); // 1000ms of prompt, then the first token
		emit(transport, {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "don", partial: assistant() },
		} as unknown as AgentSessionEvent);
		vi.advanceTimersByTime(2000); // 200 output tokens over 2000ms
		emit(transport, { type: "message_end", message: assistant() } as unknown as AgentSessionEvent);
		emit(transport, { type: "turn_end", message: assistant(), toolResults: [] } as unknown as AgentSessionEvent);
		emit(transport, { type: "agent_settled" } as AgentSessionEvent);
		await tick();
	}

	it("sits on the send row, after the Send button", async () => {
		const transport = await mount();
		await bind(transport);
		const strip = document.querySelector<HTMLElement>(".metrics");
		const send = document.querySelector<HTMLButtonElement>("form.composer button[type=submit]");
		// The right alignment is CSS; what a headless test can pin down is that the strip shares the
		// buttons' row and comes after them in the DOM, which is what the margin-left: auto hangs off.
		expect(strip?.closest("form.composer .controls")).not.toBeNull();
		expect(send && strip && (send.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING)).toBeTruthy();
	});

	it("measures prefill and decode from when the events arrive", async () => {
		vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
		const transport = await mount();
		await bind(transport);
		await streamOneResponse(transport);

		// 1000 prompt tokens in the 1000ms before the first token; 200 output tokens in the 2000ms after.
		expect(document.querySelector('[data-role="prefill"]')?.textContent).toContain("1000 tok/s");
		expect(document.querySelector('[data-role="decode"]')?.textContent).toContain("100 tok/s");
	});

	/** A debug snapshot naming one model, and the other it could be switched to — as the server sends it. */
	function snapshot(model: string): DebugInfo {
		const [provider = "", modelId = ""] = model.split("/");
		return {
			systemPrompt: "p",
			activeTools: [],
			commands: [],
			models: [{ provider, modelId, input: [] }, { provider, modelId: "other", input: [] }],
			model: { provider, modelId, input: [] },
			thinkingLevel: "off",
			memoryBlock: null,
		};
	}

	/**
	 * Opens another session the way the page does — clicking its row — and lets the server answer with the
	 * conversation that answers that file. Each session gets its own conversation, which is what makes the
	 * numbers on the strip this chat's own.
	 */
	let opened = 0;
	const known = ["/tmp/s.jsonl"];
	async function open(transport: FakeTransport, sessionPath: string, model?: string): Promise<void> {
		if (!known.includes(sessionPath)) known.push(sessionPath);
		// A chat the page already holds is shown by its row; one it has never seen asks the server for a
		// conversation — and the server answers with one of its own, not the one on screen.
		if (sessionInUrl() !== sessionPath.replace(/^.*\//, "")) {
			const at = "2026-01-01T00:00:00.000Z";
			transport.emit({ type: "result", requestId: `rows-${opened}`, sessions: known.map((path) => ({ path, modified: at, messageCount: 1, firstMessage: path })) });
			await tick();
			screen.getByText(sessionPath).click();
			await tick();
			const asked = sent(transport, "switchSession").at(-1) as { requestId: string };
			transport.emit({ type: "result", requestId: asked.requestId, conversationId: `c-${sessionPath}`, sessionPath });
			await tick();
		}
		if (model) {
			// The snapshot answers the debug request the page just made for the chat it opened.
			const askedFor = sent(transport, "debug").at(-1) as { requestId: string };
			transport.emit({ type: "result", requestId: askedFor.requestId, debug: snapshot(model) });
			await tick();
		}
		opened += 1;
	}

	const stored = () => JSON.parse(localStorage.getItem("flypi.lastAnswers") ?? "{}") as Record<string, unknown>;
	const decode = () => document.querySelector('[data-role="decode"]')?.textContent ?? "";
	const prefill = () => document.querySelector('[data-role="prefill"]')?.textContent ?? "";

	it("moves while the answer is still streaming, before it ends", async () => {
		vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
		const transport = await mount();
		await bind(transport);
		emit(transport, { type: "agent_start" } as AgentSessionEvent);
		emit(transport, { type: "turn_start" } as AgentSessionEvent);
		vi.advanceTimersByTime(100);
		emit(transport, { type: "message_start", message: assistant() } as unknown as AgentSessionEvent);
		vi.advanceTimersByTime(900);
		emit(transport, {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "don", partial: assistant() },
		} as unknown as AgentSessionEvent);
		await tick();
		// The prompt is over: 1000 tokens arrived in the 1000ms before the first token. No output has been
		// timed yet, so decode stays unknown rather than showing a rate divided by nothing.
		expect(prefill()).toContain("1000 tok/s");
		expect(decode()).toContain("—");

		// A second token, a second later, and the decode number moves — 200 output tokens over 1000ms.
		vi.advanceTimersByTime(1000);
		emit(transport, {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "e", partial: assistant() },
		} as unknown as AgentSessionEvent);
		await tick();
		expect(decode()).toContain("200 tok/s");
	});

	// A replay — a reconnect, or opening a session this page was not holding — delivers minutes of a
	// response in one burst. Measured by arrival that is a thousands-of-tokens/second rate; the events
	// carry the backend's own stamps, so the window is the one the model actually took.
	it("measures a response delivered as a replay on the backend's clock", async () => {
		vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
		const transport = await mount();
		await bind(transport);
		const started = 1_000_000;
		const replay = (seq: number, at: number, event: AgentSessionEvent) => transport.emit({ type: "event", conversationId: "c1", seq, at, event });
		// 1000 prompt tokens in the first second, then 200 output tokens over the next two — received now,
		// all of it, as a resume hands it over.
		replay(1, started, { type: "agent_start" } as AgentSessionEvent);
		replay(2, started, { type: "turn_start" } as AgentSessionEvent);
		replay(3, started, { type: "message_start", message: assistant() } as unknown as AgentSessionEvent);
		replay(4, started + 1000, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "don", partial: assistant() } } as unknown as AgentSessionEvent);
		replay(5, started + 3000, { type: "message_end", message: assistant() } as unknown as AgentSessionEvent);
		await tick();
		expect(prefill()).toContain("1000 tok/s");
		expect(decode()).toContain("100 tok/s");
	});

	it("holds the measured numbers while an answer's usage has not arrived", async () => {
		// LM Studio and vLLM report zero tokens in every chunk and the real counts with the last one. The
		// strip does not guess what the text so far is worth: it keeps showing what it already measured and
		// moves when the answer reports itself.
		vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
		const none = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } };
		const silent = () => ({ role: "assistant", content: [{ type: "text", text: "hi" }], usage: none }) as unknown as AgentSessionEvent;
		const transport = await mount();
		await bind(transport);
		await streamOneResponse(transport);
		expect(decode()).toContain("100 tok/s");
		expect(prefill()).toContain("1000 tok/s");

		// The next answer of the same question — a tool ran between them. Three chunks arrive, and each one
		// reports zero tokens.
		emit(transport, { type: "turn_start" } as AgentSessionEvent);
		emit(transport, { type: "message_start", message: silent() } as unknown as AgentSessionEvent);
		for (const [ms, delta] of [
			[1000, "Writing "],
			[500, "the "],
			[500, "answer"],
		] as const) {
			vi.advanceTimersByTime(ms);
			emit(transport, {
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta, partial: silent() },
			} as unknown as AgentSessionEvent);
		}
		await tick();
		// Two seconds into this answer, the first answer's numbers still stand: nothing of this one has been
		// counted, and a rate built from the character count of a partial answer would be a guess.
		expect(decode()).toContain("100 tok/s");
		expect(prefill()).toContain("1000 tok/s");

		// The answer ends with the counts the model actually reported — 2000 prompt tokens over 1000ms of
		// prefill, 50 output tokens over 1000ms — and both averages move with them.
		const reported = { input: 2000, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 2050, cost: { total: 0 } };
		emit(transport, {
			type: "message_end",
			message: { role: "assistant", content: [], usage: reported },
		} as unknown as AgentSessionEvent);
		emit(transport, { type: "turn_end", message: assistant(), toolResults: [] } as unknown as AgentSessionEvent);
		await tick();
		expect(decode()).toContain("83.3 tok/s"); // 250 output tokens over 3000ms, across both answers
		expect(prefill()).toContain("1500 tok/s"); // 3000 prompt tokens over 2000ms of prefill
	});

	it("keeps the numbers when the snapshot that follows a turn names the same model", async () => {
		vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
		const transport = await mount();
		await bind(transport);
		// The page asks for a snapshot when a conversation binds, and the server answers with the model in use.
		const askedAtBind = sent(transport, "debug").at(-1)?.requestId;
		transport.emit({ type: "result", requestId: askedAtBind ?? "r11", debug: snapshot("faux/big") });
		await tick();
		await streamOneResponse(transport);
		expect(decode()).toContain("100 tok/s");

		// A settling turn asks for a fresh snapshot, and the server answers it with the model the chat is
		// already on. Those numbers were measured on that model, so a second snapshot must not read as
		// evidence that they belong to another one and clear them off the strip before they were ever seen.
		const askedAtSettle = sent(transport, "debug").at(-1)?.requestId;
		transport.emit({ type: "result", requestId: askedAtSettle ?? "r12", debug: snapshot("faux/big") });
		await tick();
		expect(decode()).toContain("100 tok/s");
		expect(prefill()).toContain("1000 tok/s");
		// Still this chat's own numbers, kept under its path for the next time it is opened.
		expect(stored()["/tmp/s.jsonl"]).toMatchObject({ model: "faux/big", promptTokens: 1000, outputTokens: 200 });
	});

	it("keeps a chat's own numbers across a reload, and has none for another chat", async () => {
		vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
		const transport = await mount();
		await bind(transport);
		await streamOneResponse(transport);
		expect(decode()).toContain("100 tok/s");
		// What the browser kept is that chat's timings, in the units the reducer works in, under its path.
		expect(stored()["/tmp/s.jsonl"]).toMatchObject({ promptTokens: 1000, outputTokens: 200, prefillMs: 1000, decodeMs: 2000 });

		// A reload, back into the same chat: those numbers are timings this browser took, so no round trip
		// could bring them back any other way.
		cleanup();
		const reloaded = await mount();
		await bind(reloaded);
		await tick();
		expect(decode()).toContain("100 tok/s");
		expect(document.querySelector('[data-role="prefill"]')?.textContent).toContain("1000 tok/s");

		// Another chat has its own numbers — which is to say, none. A rate belongs to one chat answering on
		// one model, so carrying it over would be the UI making a claim it never measured.
		await open(reloaded, "/tmp/other.jsonl");
		expect(decode()).toContain("—");
		await open(reloaded, "/tmp/s.jsonl");
		expect(decode()).toContain("100 tok/s");
	});

	it("retires the numbers when the chat moves to another model, and brings them back with the model", async () => {
		vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
		const transport = await mount();
		await bind(transport);
		await open(transport, "/tmp/s.jsonl", "faux/big");
		await streamOneResponse(transport);
		expect(decode()).toContain("100 tok/s");
		expect(document.querySelector('[data-role="decode"]')?.getAttribute("title")).toBe("measured on faux/big in this chat");
		expect(stored()["/tmp/s.jsonl"]).toMatchObject({ model: "faux/big" });

		// The model picker: a tokens/second figure describes a model, so the old number stops being this
		// chat's number the moment the chat is answering on another one.
		const picker = screen.getByRole("combobox", { name: "Model" }) as HTMLSelectElement;
		fireEvent.change(picker, { target: { value: "faux/other" } });
		await tick();
		expect(decode()).toContain("—");
		// And it was kept, not lost: back on the model that measured it, the number is there again.
		fireEvent.change(picker, { target: { value: "faux/big" } });
		await tick();
		expect(decode()).toContain("100 tok/s");
	});

	it("forgets a chat's numbers with the chat", async () => {
		vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
		const transport = await mount();
		await bind(transport);
		await streamOneResponse(transport);
		expect(stored()["/tmp/s.jsonl"]).toBeTruthy();

		const at = "2026-01-01T00:00:00.000Z";
		transport.emit({ type: "result", requestId: "r2", sessions: [{ path: "/tmp/s.jsonl", name: "this-one", modified: at, messageCount: 3, firstMessage: "hi" }] });
		await tick();
		fireEvent.click(screen.getByRole("button", { name: "Delete this-one" }));
		await tick();
		expect(stored()).toEqual({});
	});

	it("starts clean, not confused, when what it remembers is not an answer", async () => {
		for (const junk of ["", "{ not json", "null", "[]", '["/tmp/s.jsonl"]', '{"/tmp/s.jsonl": {"promptTokens": "ten"}}', '{"/tmp/s.jsonl": {"promptTokens": 1}}']) {
			localStorage.setItem("flypi.lastAnswers", junk);
			cleanup();
			const transport = await mount();
			await bind(transport);
			expect(decode()).toContain("—");
		}
	});

	it("says so when a response had no measurable window, instead of inventing a rate", async () => {
		vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
		const transport = await mount();
		await bind(transport);
		emit(transport, { type: "turn_start" } as AgentSessionEvent);
		emit(transport, { type: "message_start", message: assistant() } as unknown as AgentSessionEvent);
		emit(transport, { type: "agent_settled" } as AgentSessionEvent);
		await tick();
		expect(document.querySelector('[data-role="decode"]')?.textContent).toContain("—");
		expect(document.querySelector(".streaming")).toBeNull();
	});

	it("shows the context window as a ring, from pi's own estimate", async () => {
		const transport = await mount();
		await bind(transport);
		transport.emit({
			type: "result",
			requestId: "r9",
			debug: {
				systemPrompt: "p",
				activeTools: [],
				commands: [],
				models: [],
				thinkingLevel: "off",
				memoryBlock: null,
				context: { tokens: 24_000, contextWindow: 200_000, percent: 12.4 },
			},
		});
		await tick();

		const meter = screen.getByRole("meter", { name: "Context window used" });
		expect(meter.getAttribute("aria-valuenow")).toBe("12");
		expect(meter.getAttribute("aria-valuetext")).toContain("24.0k / 200.0k in context · 12%");
		expect(document.querySelector(".gauge .fill")?.getAttribute("style")).toContain("12.4");
		expect(document.querySelector('[data-role="context"]')?.textContent).toContain("24.0k / 200.0k");
	});

	it("asks for a fresh context reading when the turn settles, and says when the count is unknown", async () => {
		vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
		const transport = await mount();
		await bind(transport);
		const before = sent(transport, "debug").length;
		await streamOneResponse(transport);
		// The gauge is the server's estimate, and it is only trustworthy once the answer landed.
		expect(sent(transport, "debug").length).toBe(before + 1);

		// Right after a compaction pi cannot know the count; the UI says so rather than showing 0%.
		transport.emit({
			type: "result",
			requestId: "r10",
			debug: { systemPrompt: "p", activeTools: [], commands: [], models: [], thinkingLevel: "off", memoryBlock: null, context: { tokens: null, contextWindow: 200_000, percent: null } },
		});
		await tick();
		expect(document.querySelector('[data-role="context"]')?.textContent).toBe("context unknown");
		expect(screen.getByRole("meter", { name: "Context window used" }).getAttribute("aria-valuenow")).toBe("0");
	});

	it("keeps the numbers of a question asked before the first model snapshot has landed", async () => {
		vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
		const transport = await mount();
		await bind(transport);
		// The page asks for a snapshot when a conversation binds; this one has not answered yet, so the app
		// has no idea which model this question is being answered on.
		await streamOneResponse(transport);
		expect(prefill()).toContain("1000 tok/s");
		// The snapshot the app asked for at settle names the model. Numbers whose model was never known were
		// measured here, so it names them — it does not get to decide they came from somewhere else.
		const asked = sent(transport, "debug").at(-1)?.requestId ?? "rd";
		transport.emit({ type: "result", requestId: asked, debug: snapshot("faux/big") });
		await tick();
		expect(prefill()).toContain("1000 tok/s");
		expect(decode()).toContain("100 tok/s");
		// And they survive a reload with this, rather than being dropped by it.
		expect(stored()["/tmp/s.jsonl"]).toMatchObject({ model: "faux/big" });
	});

	it("keeps the numbers measured on a model you just picked", async () => {
		vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
		const transport = await mount();
		await bind(transport);
		await open(transport, "/tmp/s.jsonl", "faux/big");
		const picker = screen.getByRole("combobox", { name: "Model" }) as HTMLSelectElement;
		// The model was picked here, so the app knows it; the snapshot on screen is still the old model's.
		fireEvent.change(picker, { target: { value: "faux/other" } });
		await tick();
		await streamOneResponse(transport);
		const asked = sent(transport, "debug").at(-1)?.requestId ?? "rd";
		transport.emit({ type: "result", requestId: asked, debug: snapshot("faux/other") });
		await tick();
		expect(decode()).toContain("100 tok/s");
		expect(document.querySelector('[data-role="decode"]')?.getAttribute("title")).toBe("measured on faux/other in this chat");
	});
});

/**
 * The first-run modal (ui/Chat.svelte). A fresh install has no endpoint and no default, so the first prompt
 * can only fail with `settings.json must set defaultProvider and defaultModel`; the chat says that first and
 * points at the one place that fixes it. The config files are asked for on connect — that is what lets the
 * chat know at all.
 */
describe("the no-endpoint setup modal", () => {
	const config = (over: Partial<ConfigSnapshot> = {}): ConfigSnapshot => ({
		endpoints: [],
		mcpServers: [],
		defaults: { provider: "", model: "" },
		files: [
			{ name: "models", text: "{}\n" },
			{ name: "settings", text: "{}\n" },
		],
		errors: [],
		...over,
	});

	/** The real startup: connect, the conversation, and the config the app asks for when it connects. */
	async function started(transport: FakeTransport, snapshot: ConfigSnapshot): Promise<void> {
		transport.emit({ type: "connected" });
		await tick();
		transport.emit({ type: "result", requestId: "r1", conversationId: "c1", sessionPath: "/tmp/s.jsonl" });
		transport.emit({ type: "result", requestId: "r2", config: snapshot });
		await tick();
	}

	const modal = () => document.querySelector("[data-role='no-endpoint']") as HTMLDialogElement | null;

	it("asks for the config files when the socket connects", async () => {
		const transport = await mount();
		transport.emit({ type: "connected" });
		await tick();
		expect(sent(transport, "getConfig")).toHaveLength(1);
	});

	it("offers the settings page when nothing can start a conversation", async () => {
		const transport = await mount();
		await started(transport, config());

		const box = modal();
		expect(box?.tagName).toBe("DIALOG");
		expect(box?.open).toBe(true);
		expect(box?.textContent).toContain("no built-in default model");

		fireEvent.click(box?.querySelector("[data-role='no-endpoint-settings']") as HTMLAnchorElement);
		await tick();
		// A real link to the settings view, followed inside the page: the address bar says so too.
		expect(box?.querySelector("a")?.getAttribute("href")).toBe("/settings");
		expect(document.querySelector("[data-role='settings-view']")).toBeTruthy();
		expect(location.pathname).toBe("/settings");
	});

	it("says nothing when an endpoint is configured", async () => {
		const transport = await mount();
		await started(
			transport,
			config({ endpoints: [{ name: "lmstudio", baseUrl: "http://127.0.0.1:8000/v1", api: "openai-completions", apiKey: "", models: ["qwen3"] }], defaults: { provider: "lmstudio", model: "qwen3" } }),
		);
		expect(modal()).toBeNull();
	});

	it("says nothing when no endpoint is configured but a default names a built-in provider", async () => {
		// pi's own providers are never keys in models.json, and a conversation does start on one — so an empty
		// list on its own is not the state worth interrupting anyone for.
		const transport = await mount();
		await started(transport, config({ defaults: { provider: "anthropic", model: "claude-sonnet-4-5" } }));
		expect(modal()).toBeNull();
	});

	it("gets out of the way when dismissed, and stops asking once an endpoint is added", async () => {
		const transport = await mount();
		await started(transport, config());
		fireEvent.click(modal()?.querySelector("[data-role='no-endpoint-dismiss']") as HTMLButtonElement);
		await tick();
		expect(modal()).toBeNull();

		// The chat's own answer to the same problem, once the settings view has added an endpoint.
		transport.emit({ type: "result", requestId: "r3", config: config({ endpoints: [{ name: "lmstudio", baseUrl: "http://127.0.0.1:8000/v1", api: "openai-completions", apiKey: "", models: ["qwen3"] }], defaults: { provider: "lmstudio", model: "qwen3" } }) });
		await tick();
		expect(modal()).toBeNull();
	});
});

describe("the update the daemon reports", () => {
	// The page asks `/healthz` what the daemon knows (ui/App.svelte) — the same answer `flypi status` prints,
	// so no socket frame is involved, and the page only reports what the daemon decided on its own.
	function health(body: unknown): void {
		vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => body }) as unknown as Response);
	}
	const line = () => document.querySelector("[data-role='update']")?.textContent ?? "";

	it("names the newer flypi the daemon found", async () => {
		health({ version: "0.1.0", updateAvailable: "0.2.0" });
		await mount();
		await waitFor(() => expect(line()).toContain("flypi 0.2.0 is available"));
	});

	it("names the pi the daemon loaded, and says when a pin chose it (Phase 8.1)", async () => {
		// The loaded version, not the range flypi's package.json declares — and the installed tree's version
		// beside it, because the two disagreeing is what the line is for.
		health({ version: "0.1.0", pi: { version: "1.4.0", pinned: true, bundled: "1.0.4" } });
		await mount();
		const line = () => document.querySelector("[data-role='pi-version']")?.textContent ?? "";
		await waitFor(() => expect(line()).toContain("pi 1.4.0 (pinned)"));
		expect(line()).toContain("installed tree holds 1.0.4");
	});

	it("says the downloaded one installs by itself, which is the state that matters to the reader", async () => {
		health({ version: "0.1.0", updateAvailable: "0.2.0", updateReady: "0.2.0" });
		await mount();
		await waitFor(() => expect(line()).toContain("flypi 0.2.0 is downloaded"));
		expect(line()).toContain("installs when nothing is running");
	});

	it("says nothing when the daemon has nothing to report", async () => {
		health({ version: "0.1.0" });
		const transport = await mount();
		await bind(transport);
		await tick();
		expect(line()).toBe("");
	});

	it("says nothing when there is no health page to ask", async () => {
		// A headless server, or a page opened somewhere that has no daemon behind it: the answer is silence,
		// not an error strip in the chat.
		vi.stubGlobal("fetch", async () => {
			throw new TypeError("fetch failed");
		});
		const transport = await mount();
		await bind(transport);
		await tick();
		expect(line()).toBe("");
	});

	it("installs the update when asked, and puts a refusal where the line is", async () => {
		health({ version: "0.1.0", updateAvailable: "0.2.0", updateReady: "0.2.0" });
		const transport = await mount();
		await bind(transport);
		await waitFor(() => expect(document.querySelector("[data-role='install-update']")).toBeTruthy());
		fireEvent.click(document.querySelector("[data-role='install-update']") as HTMLButtonElement);
		await tick();
		const asked = sent(transport, "installUpdate") as unknown as { requestId?: string }[];
		expect(asked).toHaveLength(1);
		// The install restarts the daemon out from under this page, so the chat is not worth showing: what the
		// page waits for is a new process on `/healthz`, not an answer that says the install worked.
		expect(document.querySelector("[data-role='updating']")).toBeTruthy();
		expect(document.querySelector("[data-role='install-update']")).toBeNull();

		transport.emit({ type: "error", requestId: asked[0]?.requestId ?? "", message: "this flypi process does not manage its own updates" });
		await tick();
		expect(document.querySelector("[data-role='update-error']")?.textContent).toContain("does not manage its own updates");
		// The refusal belongs to the update line, not the chat's error strip — and it is the way back to the page.
		expect(document.querySelector("[data-role='install-update']")).toBeTruthy();
		expect(document.querySelector("[data-role='updating']")).toBeNull();
	});

	/**
	 * `/healthz` whose answer changes between calls: the daemon going away (an `Error` — a fetch that fails) and
	 * a different one answering. The page polls it once a second while an install is in flight (ui/App.svelte).
	 */
	function healthChanges(answers: unknown[]): void {
		let n = 0;
		vi.stubGlobal("fetch", async () => {
			const answer = answers[Math.min(n++, answers.length - 1)];
			if (answer instanceof Error) throw answer;
			return { ok: true, json: async () => answer } as unknown as Response;
		});
	}

	/** The address bar's own reload, which is what the page asks for when the new build is being served. */
	function stubReload(): ReturnType<typeof vi.fn> {
		const reload = vi.fn();
		vi.stubGlobal("location", { pathname: "/", search: "", hash: "", reload });
		return reload;
	}

	it("holds the updating page while the daemon is gone, and reloads into the version that replaces it", async () => {
		healthChanges([{ version: "0.1.0", startedAt: "2026-10-17T00:00:00Z", updateReady: "0.2.0" }, new TypeError("fetch failed"), { version: "0.2.0", startedAt: "2026-10-17T00:01:00Z" }]);
		vi.useFakeTimers({ toFake: ["Date", "setInterval", "setTimeout"] });
		const transport = await mount();
		await bind(transport);
		await vi.advanceTimersByTimeAsync(0);
		await tick();
		fireEvent.click(document.querySelector("[data-role='install-update']") as HTMLButtonElement);
		await tick();
		const reload = stubReload();

		// The old process is gone and nothing answers yet: the page stays where it is, saying what is happening.
		await vi.advanceTimersByTimeAsync(1000);
		await tick();
		expect(document.querySelector("[data-role='updating']")).toBeTruthy();
		expect(reload).not.toHaveBeenCalled();

		// A new process, on the version the page was told to expect — its assets have different names, so the
		// only page that works is a fresh one.
		await vi.advanceTimersByTimeAsync(1000);
		await tick();
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it("comes back to the chat when the daemon restarts onto the version it had", async () => {
		// The install failed, or the restart was for something else: the build this page already holds is the
		// one still being served, so it goes back to work instead of reloading.
		healthChanges([{ version: "0.1.0", startedAt: "2026-10-17T00:00:00Z", updateReady: "0.2.0" }, { version: "0.1.0", startedAt: "2026-10-17T00:01:00Z", updateReady: "0.2.0" }]);
		vi.useFakeTimers({ toFake: ["Date", "setInterval", "setTimeout"] });
		const transport = await mount();
		await bind(transport);
		await vi.advanceTimersByTimeAsync(0);
		await tick();
		fireEvent.click(document.querySelector("[data-role='install-update']") as HTMLButtonElement);
		await tick();
		const reload = stubReload();

		await vi.advanceTimersByTimeAsync(1000);
		await tick();
		expect(reload).not.toHaveBeenCalled();
		expect(document.querySelector("[data-role='updating']")).toBeNull();
		expect(document.querySelector("[data-role='install-update']")).toBeTruthy();
	});
});

describe("extension slash commands", () => {
	it("lists the commands this conversation has while the box holds a /…, and completes the name", async () => {
		const transport = await mount();
		await bind(transport);
		transport.emit({
			type: "result",
			requestId: "r7",
			conversationId: "c1",
			debug: {
				systemPrompt: "p",
				activeTools: [],
				commands: [
					{ name: "ping", description: "Say pong", source: "extension" },
					{ name: "notes", description: "", source: "prompt" },
				],
				models: [],
				thinkingLevel: "off",
			},
		});
		await tick();
		expect(document.querySelector('[data-role="commands"]')).toBeNull();
		const box = screen.getByRole("textbox", { name: "Prompt" }) as HTMLTextAreaElement;
		fireEvent.input(box, { target: { value: "/p" } });
		await tick();
		const hints = [...document.querySelectorAll("[data-role='command']")].map((button) => button.textContent ?? "");
		expect(hints.some((hint) => hint.includes("/ping") && hint.includes("Say pong"))).toBe(true);
		expect(hints.some((hint) => hint.includes("/notes"))).toBe(false);
		// Clicking only completes the name; what runs is what gets sent, and pi answers the command.
		fireEvent.click(document.querySelector("[data-role='command']") as HTMLButtonElement);
		await tick();
		expect(box.value).toBe("/ping ");
		submit("form.composer");
		await tick();
		expect(sent(transport, "prompt")).toContainEqual({ type: "prompt", conversationId: "c1", text: "/ping", mode: "steer" });
	});

	it("shows what an extension said and answers the question it asks", async () => {
		const transport = await mount();
		await bind(transport);
		transport.emit({ type: "extensionUi", conversationId: "c1", kind: "notify", message: "pong hi", level: "warning" });
		await tick();
		const notes = document.querySelector("[data-role='extension-output']");
		expect(notes?.textContent).toContain("pong hi");
		expect(notes?.querySelector("[data-level='warning']")).toBeTruthy();

		// A `select`: the option is the answer, and the dialog leaves as soon as it is sent.
		transport.emit({ type: "extensionUi", conversationId: "c1", kind: "select", title: "Pick one", message: "", options: ["alpha", "beta"], dialogId: "d1" });
		await tick();
		fireEvent.click(document.querySelectorAll("[data-role='extension-choice']")[1] as HTMLButtonElement);
		await tick();
		// `confirm`: Yes answers, and Cancel is what pi's dialogs report as dismissed.
		transport.emit({ type: "extensionUi", conversationId: "c1", kind: "confirm", title: "Sure?", message: "do it", dialogId: "d2" });
		await tick();
		fireEvent.click(document.querySelector("[data-role='extension-yes']") as HTMLButtonElement);
		await tick();
		transport.emit({ type: "extensionUi", conversationId: "c1", kind: "confirm", title: "Sure?", message: "do it", dialogId: "d3" });
		await tick();
		fireEvent.click(document.querySelector("[data-role='extension-cancel']") as HTMLButtonElement);
		await tick();
		// `input`: the text the box holds.
		transport.emit({ type: "extensionUi", conversationId: "c1", kind: "input", title: "Type it", message: "optional", dialogId: "d4" });
		await tick();
		fireEvent.input(screen.getByRole("textbox", { name: "Answer" }), { target: { value: "typed" } });
		fireEvent.click(document.querySelector("[data-role='extension-submit']") as HTMLButtonElement);
		await tick();

		expect(sent(transport, "extensionReply")).toEqual([
			{ type: "extensionReply", conversationId: "c1", dialogId: "d1", value: "beta" },
			{ type: "extensionReply", conversationId: "c1", dialogId: "d2", value: "yes" },
			{ type: "extensionReply", conversationId: "c1", dialogId: "d3", value: null },
			{ type: "extensionReply", conversationId: "c1", dialogId: "d4", value: "typed" },
		]);
		expect(document.querySelector("[data-role='extension-dialog']")).toBeNull();
	});

	it("leaves extension output behind when the conversation changes", async () => {
		const transport = await mount();
		await bind(transport);
		transport.emit({ type: "extensionUi", conversationId: "c1", kind: "notify", message: "pong" });
		await tick();
		expect(document.querySelector("[data-role='extension-output']")?.textContent).toContain("pong");
		transport.emit({ type: "result", requestId: "r8", conversationId: "c2", sessionPath: "/tmp/other.jsonl" });
		await tick();
		expect(document.querySelector("[data-role='extension-output']")).toBeNull();
	});
});
