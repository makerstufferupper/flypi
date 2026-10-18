/**
 * The `renderMessage()` golden (docs/testing.md: it is a 100%-coverage choke point).
 *
 * `tests/fixtures/transcript-log/events.json` is one real multi-tool turn. The reducer's output
 * rendered to text must equal `transcript.txt`, byte for byte — and `scripts/smoke.mjs` prints
 * exactly this, so the snapshot, the test and the browser cannot drift apart.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
	applyEvent,
	emptyTranscript,
	emptyUsage,
	formatCache,
	formatUsage,
	promptTokensOf,
	reduceEvents,
	renderMessage,
	renderTranscriptText,
	type FlypiMessage,
} from "../../src/shared/transcript.ts";

const FIXTURE = join(import.meta.dirname, "..", "fixtures", "transcript-log");
const events = JSON.parse(readFileSync(join(FIXTURE, "events.json"), "utf8")) as AgentSessionEvent[];
const golden = readFileSync(join(FIXTURE, "transcript.txt"), "utf8");

describe("the recorded multi-tool turn", () => {
	it("is a real read + edit + bash turn, not a fixture we made up", () => {
		// The Phase 2 gate says "including edit/read/bash tool output", so the fixture owes it.
		const called = events
			.filter((event) => event.type === "tool_execution_end")
			.map((event) => (event as { toolName: string }).toolName);
		expect(called).toEqual(["read", "read", "edit", "bash"]);
		for (const event of events.filter((entry) => entry.type === "tool_execution_end")) {
			expect(JSON.stringify((event as { result: unknown }).result)).toContain("sort");
		}
	});

	it("renders to the committed golden through the shared mapper", () => {
		expect(renderTranscriptText(reduceEvents(events))).toBe(golden);
	});

	it("reaches the same transcript whether events arrive one at a time or in one replay", () => {
		// A reconnect replays the ring buffer in one go; a live client sees them one per frame.
		const oneAtATime = events.reduce((state, event) => applyEvent(state, event, () => 0), emptyTranscript());
		expect(renderTranscriptText(reduceEvents(events))).toBe(renderTranscriptText(oneAtATime));
	});

	it("renders the user's own prompt from the stream, so the UI never appends it twice", () => {
		const transcript = reduceEvents(events);
		expect(transcript.messages[0]?.role).toBe("user");
		expect(transcript.messages[0]?.blocks).toEqual([{ kind: "text", text: "fix the failing test in this repo" }]);
		expect(transcript.messages.every((message) => message.role !== "system")).toBe(true);
	});

	it("adds up usage per turn and per conversation", () => {
		const transcript = reduceEvents(events);
		const sum = transcript.messages.reduce((total, message) => total + (message.usage?.input ?? 0), 0);
		expect(transcript.total.input).toBe(sum);
		// The fixture is one run, so its turn total is the conversation total; agent_start resets it.
		expect(transcript.turn.input).toBe(sum);
		expect(transcript.turn.totalTokens).toBeGreaterThan(0);
	});
});

describe("renderMessage()", () => {
	it("maps assistant text, thinking and tool calls to view blocks", () => {
		const message = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "checking the test first" },
				{ type: "text", text: "let me read it" },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "sort.mjs" } },
			],
			usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { total: 0.01 } },
		} as unknown as FlypiMessage;
		expect(renderMessage(message)).toEqual({
			role: "assistant",
			blocks: [
				{ kind: "thinking", text: "checking the test first" },
				{ kind: "text", text: "let me read it" },
				{ kind: "tool-call", id: "call-1", name: "read", args: { path: "sort.mjs" } },
			],
			usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: 0.01 },
		});
	});

	it("accepts a user message whose content is a plain string", () => {
		expect(renderMessage({ role: "user", content: "hi" } as unknown as FlypiMessage).blocks).toEqual([{ kind: "text", text: "hi" }]);
	});

	// A pasted image lives in the user message as pi image content, so the chat can show what was sent.
	it("maps an image block alongside its text", () => {
		const rendered = renderMessage({
			role: "user",
			content: [{ type: "text", text: "what is this?" }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
		} as unknown as FlypiMessage);
		expect(rendered.blocks).toEqual([
			{ kind: "text", text: "what is this?" },
			{ kind: "image", data: "aGVsbG8=", mimeType: "image/png" },
		]);
	});

	it("ignores an image block with no bytes or no mime type", () => {
		expect(renderMessage({ role: "user", content: [{ type: "image" }, { type: "image", data: "a", mimeType: 7 }] } as unknown as FlypiMessage).blocks).toEqual([]);
	});

	it("maps a tool result message, including an error one", () => {
		const ok = renderMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text", text: "done" }],
			isError: false,
		} as unknown as FlypiMessage);
		expect(ok.blocks).toEqual([{ kind: "tool-result", id: "call-1", name: "bash", output: "done", isError: false }]);
		const failed = renderMessage({
			role: "toolResult",
			toolCallId: "call-2",
			toolName: "read",
			content: "not found",
			isError: true,
		} as unknown as FlypiMessage);
		expect(failed.blocks[0]).toMatchObject({ isError: true, output: "not found" });
	});

	it("ignores empty text, unknown block types and non-objects instead of guessing", () => {
		const rendered = renderMessage({
			role: "assistant",
			content: [
				{ type: "text", text: "" },
				{ type: "thinking", thinking: "" },
				{ type: "image" },
				{ type: "mystery", text: "unheard of" },
				"not an object",
			],
		} as unknown as FlypiMessage);
		expect(rendered.blocks).toEqual([]);
	});

	it("treats a message with no role or no usage as having neither", () => {
		expect(renderMessage({ content: "x" } as unknown as FlypiMessage)).toEqual({ role: "unknown", blocks: [{ kind: "text", text: "x" }] });
	});

	it("reads usage from a partial message where numbers are missing", () => {
		const rendered = renderMessage({ role: "assistant", content: [], usage: { input: 5 } } as unknown as FlypiMessage);
		expect(rendered.usage).toEqual({ ...emptyUsage(), input: 5 });
	});
});

describe("applyEvent()", () => {
	const assistant = (text: string, usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } }) =>
		({ role: "assistant", content: [{ type: "text", text }], usage }) as unknown as FlypiMessage;

	it("streams from message_update partials, then replaces them with the final message", () => {
		let state = emptyTranscript();
		state = applyEvent(state, { type: "agent_start" } as AgentSessionEvent);
		expect(state.running).toBe(true);
		state = applyEvent(state, { type: "message_start", message: assistant("") } as AgentSessionEvent);
		state = applyEvent(state, {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "he", partial: assistant("hello") },
		} as unknown as AgentSessionEvent);
		expect(state.streaming?.blocks).toEqual([{ kind: "text", text: "hello" }]);
		expect(state.messages).toHaveLength(0);
		state = applyEvent(state, { type: "message_end", message: assistant("hello") } as AgentSessionEvent);
		expect(state.streaming).toBeNull();
		expect(state.messages).toHaveLength(1);
	});

	// A recalled memory block is a session entry of its own now (src/memory/recall.ts, Phase 4.7 C2), and it
	// reaches the browser like any other message. It is context the model was shown, not something anyone said,
	// so it must not join the conversation — what a turn was shown belongs on the debug panel.
	it("keeps a recalled memory block out of the conversation it renders", () => {
		const block = {
			role: "custom",
			customType: "flypi-memory-block",
			content: "<relevant_memories>\n#1 (preference): the package manager is pnpm, never npm\n</relevant_memories>",
			display: false,
			details: { digest: "6b86b273ff34fce1" },
			timestamp: 0,
		} as unknown as FlypiMessage;
		let state = emptyTranscript();
		state = applyEvent(state, { type: "agent_start" } as AgentSessionEvent);
		state = applyEvent(state, { type: "message_start", message: block } as AgentSessionEvent);
		state = applyEvent(state, { type: "message_end", message: block } as AgentSessionEvent);
		expect(state.messages).toEqual([]);
		expect(state.streaming).toBeNull();
	});

	it("ignores a message_update that carries no partial", () => {
		const state = applyEvent(emptyTranscript(), { type: "message_update", assistantMessageEvent: { type: "text_start" } } as unknown as AgentSessionEvent);
		expect(state).toEqual(emptyTranscript());
	});

	it("runs a tool card from start through live output to done, and times it", () => {
		const clock = [1_000, 2_500];
		let state = emptyTranscript();
		state = applyEvent(
			state,
			{ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } } as AgentSessionEvent,
			() => clock[0]!,
		);
		expect(state.tools.c1).toMatchObject({ state: "running", name: "bash" });
		state = applyEvent(
			state,
			{ type: "tool_execution_update", toolCallId: "c1", toolName: "bash", partialResult: "partial output" } as AgentSessionEvent,
			() => clock[0]!,
		);
		expect(state.tools.c1?.output).toBe("partial output");
		state = applyEvent(
			state,
			{ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", args: { command: "ls" }, result: "final", isError: false } as AgentSessionEvent,
			() => clock[1]!,
		);
		expect(state.tools.c1).toMatchObject({ state: "done", output: "final", startedAt: 1_000, endedAt: 2_500 });
	});

	it("marks a failed tool call as an error", () => {
		let state = applyEvent(emptyTranscript(), { type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: {} } as AgentSessionEvent);
		state = applyEvent(state, { type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: "nope", isError: true } as AgentSessionEvent);
		expect(state.tools.c1?.state).toBe("error");
	});

	it("ignores a live update for a card it never saw start", () => {
		const state = applyEvent(emptyTranscript(), { type: "tool_execution_update", toolCallId: "ghost", toolName: "bash", partialResult: "x" } as AgentSessionEvent);
		expect(state.tools.ghost).toBeUndefined();
	});

	it("attaches a tool result to its card, and keeps it as a message when the card is missing", () => {
		const result = {
			type: "message_end",
			message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "out" }], isError: false },
		} as unknown as AgentSessionEvent;
		const withCard = applyEvent(
			applyEvent(emptyTranscript(), { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: {} } as AgentSessionEvent),
			result,
		);
		expect(withCard.messages).toHaveLength(0);
		expect(withCard.tools.c1).toMatchObject({ output: "out", state: "done" });

		const afterGap = applyEvent(emptyTranscript(), result);
		expect(afterGap.messages[0]?.blocks[0]).toMatchObject({ kind: "tool-result", output: "out" });
	});

	it("shows what the user queued while the turn ran", () => {
		const state = applyEvent(emptyTranscript(), { type: "queue_update", steering: ["use pnpm"], followUp: ["then run the tests"] } as AgentSessionEvent);
		expect(state.queue).toEqual({ steering: ["use pnpm"], followUp: ["then run the tests"] });
		expect(applyEvent(state, { type: "agent_settled" } as AgentSessionEvent).queue).toEqual({ steering: [], followUp: [] });
	});

	it("reads tool output from a string, a content array, a result object, or nothing at all", () => {
		const outputOf = (result: unknown) =>
			applyEvent(emptyTranscript(), { type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result } as AgentSessionEvent).tools["c1"]!.output;
		expect(outputOf("plain")).toBe("plain");
		expect(outputOf([{ type: "text", text: "one" }, { type: "text", text: "two" }])).toBe("one\ntwo");
		expect(outputOf({ content: "nested" })).toBe("nested");
		expect(outputOf({ text: "a text field" })).toBe("a text field");
		expect(outputOf({ exitCode: 1 })).toBe('{\n  "exitCode": 1\n}');
		expect(outputOf(undefined)).toBe("");
		const running = applyEvent(emptyTranscript(), { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: {} } as AgentSessionEvent);
		expect(applyEvent(running, { type: "tool_execution_update", toolCallId: "c1", toolName: "bash", partialResult: "half" } as AgentSessionEvent).tools["c1"]!.output).toBe("half");
		expect(applyEvent(emptyTranscript(), { type: "tool_execution_update", toolCallId: "nope", toolName: "bash", partialResult: "x" } as AgentSessionEvent).tools).toEqual({});
	});

	// The shapes pi and its tools send that no one asked for: half a tool result, no content, a cost
	// as a bare number. Each one is a transcript that must still render rather than break.
	it("keeps rendering when the message is only half there", () => {
		const render = (message: unknown) => renderMessage(message as FlypiMessage);
		// A tool result that does not say which call it answers, or which tool ran.
		expect(render({ role: "toolResult", content: "orphaned" }).blocks).toEqual([{ kind: "tool-result", id: "", name: "", output: "orphaned", isError: false }]);
		// No content at all, and an empty string: a message with nothing in it, not a crash.
		expect(render({ role: "assistant" }).blocks).toEqual([]);
		expect(render({ role: "user", content: "" }).blocks).toEqual([]);
		// A tool call with no id or name — the card still exists, it just has nothing to show.
		expect(render({ role: "assistant", content: [{ type: "toolCall" }] }).blocks).toEqual([{ kind: "tool-call", id: "", name: "", args: undefined }]);
		// Providers disagree about cost: a bare number is as valid as an object.
		expect(render({ role: "assistant", content: [], usage: { input: 1, cost: 0.5 } }).usage).toMatchObject({ cost: 0.5 });
		expect(render({ role: "assistant", content: [], usage: { input: 1 } }).usage).toMatchObject({ cost: 0 });

		// A result that says it failed, landing on a card that is already there: the card turns red.
		const withCard = applyEvent(emptyTranscript(), {
			type: "message_end",
			message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }] },
		} as unknown as AgentSessionEvent);
		expect(
			applyEvent(withCard, {
				type: "message_end",
				message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: "exit 1", isError: true },
			} as unknown as AgentSessionEvent).tools["c1"],
		).toMatchObject({ state: "error", output: "exit 1" });
		// And a successful result with no card of its own stays a line of its own.
		expect(renderTranscriptText(applyEvent(emptyTranscript(), {
			type: "message_end",
			message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: "fine" },
		} as unknown as AgentSessionEvent))).toContain("tool-result bash [done]: fine");
	});

	it("starts a fresh turn usage on agent_start and never lets an unknown event blank the transcript", () => {
		let state = applyEvent(emptyTranscript(), { type: "message_end", message: assistant("first") } as AgentSessionEvent);
		const touched = state.turn;
		state = applyEvent(state, { type: "compaction_start", reason: "manual" } as unknown as AgentSessionEvent);
		expect(state.turn).toBe(touched);
		expect(state.messages).toHaveLength(1);
		state = applyEvent(state, { type: "agent_start" } as AgentSessionEvent);
		expect(state.turn).toEqual(emptyUsage());
		expect(state.total.input).toBe(1);
	});

	it("formats usage the same way everywhere it is shown", () => {
		expect(formatUsage({ input: 1200, output: 340, cacheRead: 0, cacheWrite: 0, totalTokens: 1540, cost: 0.0123 })).toBe("1.2k in / 340 out · $0.0123");
		expect(formatUsage({ input: 5, output: 1, cacheRead: 1900, cacheWrite: 0, totalTokens: 6, cost: 0 })).toBe("5 in / 1 out / 1.9k cached · $0.0000");
	});

	// The prompt-cache line (docs/prompt-cache.md Phase 4.6 A2): zeros stay, and the share of the prompt
	// that was served from cache is what makes the count readable.
	it("formats the cache numbers, including the cold turn and the route that reports none", () => {
		expect(formatCache({ input: 1000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 1010, cost: 0 })).toBe("0 read / 0 write · 0% of the prompt from cache");
		expect(formatCache({ input: 200, output: 10, cacheRead: 1000, cacheWrite: 0, totalTokens: 1210, cost: 0 })).toBe("1.0k read / 0 write · 83% of the prompt from cache");
		// A turn whose provider reported nothing is not a turn that cost nothing.
		expect(formatCache(emptyUsage())).toBe("the provider reported no usage");
	});

	it("counts a prompt the way the prefill window does", () => {
		expect(promptTokensOf({ input: 200, output: 10, cacheRead: 1000, cacheWrite: 50, totalTokens: 1260, cost: 0 })).toBe(1250);
	});
});

// What smoke.mjs prints and what the golden compares against, block by block: this is the text
// twin of the DOM the UI builds, so every block kind owes a line here.
describe("renderTranscriptText()", () => {
	it("renders every block kind, a card with and without a result, and the queue", () => {
		const call = { type: "toolCall", id: "c1", name: "read", arguments: { path: "sort.mjs" } };
		const orphan = { type: "toolCall", id: "c-no-card", name: "bash", arguments: { command: "ls" } };
		let state = applyEvent(emptyTranscript(), {
			type: "message_end",
			message: { role: "user", content: "fix the sort" },
		} as unknown as AgentSessionEvent);
		state = applyEvent(state, {
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "read the test first" },
					call,
					orphan,
					{ type: "text", text: "here is the fix" },
				],
				usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { total: 0.02 } },
			},
		} as unknown as AgentSessionEvent);
		// A result for the first call, none for the other: the card fills in, the block stays pending.
		state = applyEvent(state, { type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: "it sorts backwards" } as AgentSessionEvent);
		// A result with no card of its own is its own message — what a replay gap leaves behind.
		state = applyEvent(state, {
			type: "message_end",
			message: { role: "toolResult", toolCallId: "c-gone", toolName: "bash", content: "no such file", isError: true },
		} as unknown as AgentSessionEvent);
		state = applyEvent(state, { type: "queue_update", steering: ["use pnpm"], followUp: ["then test"] } as AgentSessionEvent);

		const text = renderTranscriptText(state);
		expect(text).toContain("user:\n  text: fix the sort");
		expect(text).toContain("  thinking: (collapsed)");
		expect(text).toContain('  tool read [done] {"path":"sort.mjs"}\n    output: it sorts backwards');
		expect(text).toContain('  tool bash [pending] {"command":"ls"}');
		expect(text).toContain("  text: here is the fix");
		expect(text).toContain("  usage 3 in / 2 out · $0.0200");
		expect(text).toContain("toolResult:\n  tool-result bash [error]: no such file");
		expect(text).toContain("queued steering: use pnpm\nqueued followUp: then test");
		expect(text.trimEnd().split("\n").at(-1)).toBe("total 3 in / 2 out · $0.0200");
	});

	it("shows the streaming tail as it streams, before the final message replaces it", () => {
		const partial = {
			role: "assistant",
			content: [{ type: "text", text: "half an ans" }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "sort.mjs" } }],
			usage: { input: 1, output: 1 },
		};
		const state = applyEvent(emptyTranscript(), {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "half an ans", partial },
		} as unknown as AgentSessionEvent);
		expect(renderTranscriptText(state)).toContain("assistant (streaming):\n  text: half an ans");
		// A tool call that is only half streamed has no card yet: it shows as pending, not blank.
		expect(renderTranscriptText(state)).toContain('  tool read [pending] {"path":"sort.mjs"}');
		// No usage line for a partial that has none, and the totals stay at zero.
		expect(renderTranscriptText(applyEvent(emptyTranscript(), { type: "message_end", message: { role: "user", content: "hi" } } as unknown as AgentSessionEvent))).toBe(
			"user:\n  text: hi\ntotal 0 in / 0 out · $0.0000\n",
		);
	});

	// A pasted image is part of what the turn contained, so the text form says it was there — without
	// pasting megabytes of base64 into a snapshot nobody can read.
	it("names an attached image instead of printing its bytes", () => {
		const state = applyEvent(emptyTranscript(), {
			type: "message_end",
			message: { role: "user", content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] },
		} as unknown as AgentSessionEvent);
		expect(renderTranscriptText(state)).toBe("user:\n  image: image/png\ntotal 0 in / 0 out · $0.0000\n");
	});
});
