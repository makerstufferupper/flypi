/**
 * The goal and task view (docs/goals.md 9.4): the objective, the round the driver reached and the checklist,
 * all derived from the two tools' cards rather than from a frame of its own. What is asserted here is the
 * page's half of that choice — a write the tool refused leaves the list as it was, `clear` takes the goal away,
 * and a session reopened from its file still shows the goal and the list, because the cards are rebuilt from
 * the messages the replay carries. What the tools accept and refuse is covered in tests/agent/goals.test.ts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import App from "./App.svelte";
import type { ClientCommand, ServerFrame } from "../src/server/protocol.ts";
import type { Transport } from "./lib/client.ts";

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

let seq = 0;

/** One conversation on screen, the way `ui/app.test.ts` binds one: connect, ask, get `c1`. */
async function bind(transport: FakeTransport): Promise<void> {
	transport.emit({ type: "connected" });
	await tick();
	transport.emit({ type: "result", requestId: "r1", conversationId: "c1", sessionPath: "/tmp/goal.jsonl" });
	await tick();
}

/** The frames the server sends for one finished tool call: the call, then its result. */
function call(id: string, name: string, args: unknown, output: string, isError = false): AgentSessionEvent[] {
	return [
		{ type: "tool_execution_start", toolCallId: id, toolName: name, args } as AgentSessionEvent,
		{ type: "tool_execution_end", toolCallId: id, toolName: name, result: output, isError } as AgentSessionEvent,
	];
}

const goalCall = (id: string, args: unknown, output = "goal active", isError = false) => call(id, "goal", args, output, isError);
const taskCall = (id: string, tasks: unknown, output = "3 tasks: 0 completed", isError = false) => call(id, "task_write", { tasks }, output, isError);

/** The round entry the driver appends (`src/agent/goals.ts`): `display: false`, so the entry is its only view. */
const roundEntry = (round: number, maxRounds = 16): AgentSessionEvent =>
	({
		type: "entry_appended",
		entry: { type: "custom_message", customType: "flypi-goal-round", content: `round ${round} of ${maxRounds}`, display: false, details: { goalId: "g1", round } },
	}) as unknown as AgentSessionEvent;

async function send(transport: FakeTransport, events: AgentSessionEvent[]): Promise<void> {
	for (const event of events) transport.emit({ type: "event", conversationId: "c1", seq: ++seq, event });
	await tick();
}

/** Mount the page with one bound conversation and a goal already created. */
async function mountWithGoal(): Promise<FakeTransport> {
	const transport = new FakeTransport();
	render(App as Parameters<typeof render>[0], { props: { transport } });
	await bind(transport);
	await send(transport, goalCall("g", { action: "create", objective: "ship the goal view", max_rounds: 16 }, 'goal active: "ship the goal view" — round 0/16'));
	return transport;
}

const text = (selector: string) => document.querySelector(selector)?.textContent ?? "";
const taskRows = () => [...document.querySelectorAll("[data-role='tasks'] li")].map((row) => row.textContent ?? "");

afterEach(() => {
	cleanup();
	seq = 0;
});

describe("the goal and task view", () => {
	it("renders the objective, its phase, the round and the checklist", async () => {
		const transport = new FakeTransport();
		render(App as Parameters<typeof render>[0], { props: { transport } });
		await bind(transport);
		// No goal tool has run, so neither block is on the page: the panel is not a box waiting to be filled.
		expect(document.querySelector("[data-role='goal']")).toBeNull();
		expect(document.querySelector("[data-role='tasks']")).toBeNull();

		await send(transport, [
			...goalCall("g", { action: "create", objective: "ship the goal view", max_rounds: 16 }, 'goal active: "ship the goal view" — round 0/16'),
			roundEntry(2),
			...taskCall("t", [
				{ content: "read the panel", status: "completed" },
				{ content: "derive the goal from the cards", status: "in_progress" },
				{ content: "style it", status: "pending" },
			]),
		]);

		expect(text("[data-role='goal'] [data-role='goal-phase']")).toBe("active");
		expect(text(".goal-objective")).toBe("ship the goal view");
		expect(text("[data-role='goal-round']")).toBe("Round 2/16");
		expect(taskRows()).toEqual(["✓ read the panel", "◐ derive the goal from the cards", "○ style it"]);
		expect([...document.querySelectorAll("[data-role='tasks'] li")].map((row) => row.getAttribute("data-status"))).toEqual([
			"completed",
			"in_progress",
			"pending",
		]);
	});

	it("the next task_write moves a row to ✓, and the next round moves the counter", async () => {
		const transport = await mountWithGoal();
		await send(transport, [
			...taskCall("t1", [
				{ content: "read the panel", status: "in_progress" },
				{ content: "style it", status: "pending" },
			]),
			roundEntry(1),
		]);
		expect(taskRows()).toEqual(["◐ read the panel", "○ style it"]);
		expect(text("[data-role='goal-round']")).toBe("Round 1/16");

		await send(transport, [
			...taskCall("t2", [
				{ content: "read the panel", status: "completed" },
				{ content: "style it", status: "in_progress" },
			]),
			roundEntry(2),
		]);
		expect(taskRows()).toEqual(["✓ read the panel", "◐ style it"]);
		expect(text("[data-role='goal-round']")).toBe("Round 2/16");
	});

	it("a refused write leaves the list as it was, and a refused goal action leaves the phase alone", async () => {
		const transport = await mountWithGoal();
		const before = [
			{ content: "read the panel", status: "completed" },
			{ content: "style it", status: "pending" },
		];
		await send(transport, taskCall("t1", before, "2 tasks: 1 completed, 0 in progress, 1 pending"));
		expect(taskRows()).toEqual(["✓ read the panel", "○ style it"]);

		// The tool refuses a duplicate and two `in_progress`, and the goal refuses `resume` on an active goal:
		// an error card carries no list and no phase, so nothing on screen moves.
		await send(transport, [
			...taskCall("t2", [{ content: "read the panel", status: "completed" }], 'duplicate task "read the panel"', true),
			...goalCall("g2", { action: "resume" }, "the goal is active, so resume does not apply", true),
		]);
		expect(taskRows()).toEqual(["✓ read the panel", "○ style it"]);
		expect(text("[data-role='goal-phase']")).toBe("active");
	});

	it("follows the goal through edit, pause and clear", async () => {
		const transport = await mountWithGoal();
		await send(transport, goalCall("g2", { action: "edit", objective: "ship the goal view and its tests" }, 'goal edited: "ship the goal view and its tests"'));
		expect(text(".goal-objective")).toBe("ship the goal view and its tests");
		expect(text("[data-role='goal-phase']")).toBe("active");

		await send(transport, goalCall("g3", { action: "pause" }, "goal paused"));
		expect(text("[data-role='goal-phase']")).toBe("paused");

		await send(transport, goalCall("g4", { action: "clear" }, "goal cleared"));
		expect(document.querySelector("[data-role='goal']")).toBeNull();
	});

	it("shows the round without a cap when `create` did not name one", async () => {
		const transport = new FakeTransport();
		render(App as Parameters<typeof render>[0], { props: { transport } });
		await bind(transport);
		await send(transport, [...goalCall("g", { action: "create", objective: "answer the next three questions" }), roundEntry(1)]);
		expect(text("[data-role='goal-round']")).toBe("Round 1");
	});

	// What the view does with a card that carries nothing it can read: pi can end a call before its arguments
	// arrive, and a session file written by an older flypi can hold a status this one has never heard of.
	it("reads nothing from a card that carried no arguments, and no glyph from a status it does not know", async () => {
		const transport = await mountWithGoal();
		await send(transport, [
			...call("bad1", "goal", undefined, ""),
			...call("bad2", "goal", {}, ""),
			...call("bad3", "task_write", undefined, ""),
			...call("bad4", "task_write", {}, ""),
			...taskCall("t", [{ content: "something from an older build", status: "skipped" }]),
		]);
		// The goal the conversation created is still the goal: a card with nothing readable in it changes nothing.
		expect(text(".goal-objective")).toBe("ship the goal view");
		expect(taskRows()).toEqual(["○ something from an older build"]);
	});

	it("renders goal and tasks from the cards alone, as a reopened session has them", async () => {
		// A reopen replays the conversation's messages: no `tool_execution_*`, no entries. The mapper rebuilds a
		// card from each tool call in a message and attaches the tool result to it, and that is all the view has.
		const transport = new FakeTransport();
		render(App as Parameters<typeof render>[0], { props: { transport } });
		await bind(transport);
		await send(transport, [
			{ type: "message_end", message: { role: "user", content: "build the goal view" } } as unknown as AgentSessionEvent,
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "c1", name: "goal", arguments: { action: "create", objective: "ship the goal view", max_rounds: 16 } },
						{
							type: "toolCall",
							id: "c2",
							name: "task_write",
							arguments: { tasks: [{ content: "derive it from the cards", status: "in_progress" }, { content: "test it", status: "pending" }] },
						},
					],
				},
			} as unknown as AgentSessionEvent,
			{
				type: "message_end",
				message: { role: "toolResult", toolCallId: "c1", toolName: "goal", content: [{ type: "text", text: "goal active" }], isError: false },
			} as unknown as AgentSessionEvent,
			{
				type: "message_end",
				message: { role: "toolResult", toolCallId: "c2", toolName: "task_write", content: [{ type: "text", text: "2 tasks: 0 completed" }], isError: false },
			} as unknown as AgentSessionEvent,
		]);

		expect(text("[data-role='goal-phase']")).toBe("active");
		expect(text(".goal-objective")).toBe("ship the goal view");
		expect(taskRows()).toEqual(["◐ derive it from the cards", "○ test it"]);
		// The round prompt is an entry, and entries are not replayed — so the round line is absent rather than a
		// number the reopened conversation cannot know.
		expect(document.querySelector("[data-role='goal-round']")).toBeNull();
	});
});
