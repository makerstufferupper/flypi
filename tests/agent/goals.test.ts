/**
 * Phase 9.1 — `task_write` (docs/goals.md). Driven through a real session with the stub model rather than by
 * calling the tool, because the claims are about what reaches the session file and what a card rebuilt from
 * that file shows: a tool that returns the right object and lands nothing durable would pass the cheaper test.
 */
import { describe, expect, it } from "vitest";
import { SessionManager, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createTaskExtension, TASK_TOOL, type TaskDetails, type TaskItem } from "../../src/agent/goals.ts";
import { createFlypiSession, type FlypiSession } from "../../src/agent/runtime.ts";
import { flypiPaths } from "../../src/agent/paths.ts";
import { reduceEvents } from "../../src/shared/transcript.ts";
import { createTempFlypiRoot } from "../helpers/flypi-root.ts";
import { createStubModel, fauxAssistantMessage, fauxText, fauxToolCall } from "../helpers/stub-model.ts";

const LIST: TaskItem[] = [
	{ content: "read the failing test", status: "completed" },
	{ content: "fix the comparator", status: "in_progress" },
	{ content: "re-run the suite", status: "pending" },
];

/** One scripted turn per payload: the model calls `task_write` with each list in turn, then answers. */
type Write = { tasks: { content: string; status: string }[] };

function scripted(payloads: Write[]) {
	return [
		...payloads.map((payload, i) =>
			fauxAssistantMessage([fauxToolCall(TASK_TOOL, payload, { id: `call-${i + 1}` })], { stopReason: "toolUse", timestamp: 0 }),
		),
		fauxAssistantMessage([fauxText("planned")], { timestamp: 0 }),
	];
}

async function run(root: string, payloads: Write[]) {
	const stub = await createStubModel({ responses: scripted(payloads) });
	const { session } = await createFlypiSession({ root, modelRuntime: stub.modelRuntime, model: stub.model });
	const events: AgentSessionEvent[] = [];
	const detach = session.subscribe((event) => events.push(event));
	await session.prompt("plan this");
	detach();
	return { session, stub, transcript: reduceEvents(events) };
}

/**
 * Every `task_write` result on the branch that carries a list, in order. A rejected write has `details.error`
 * and no list, so this is also the proof that a rejection changed nothing: the last list stays the last
 * accepted one.
 */
function listsOnBranch(session: FlypiSession): TaskItem[][] {
	return session.sessionManager.getBranch().flatMap((entry) => {
		if (entry.type !== "message") return [];
		const message = entry.message as unknown as { role?: string; toolName?: string; details?: TaskDetails };
		if (message.role !== "toolResult" || message.toolName !== TASK_TOOL) return [];
		const details = message.details as { tasks?: TaskItem[] } | undefined;
		return details?.tasks ? [details.tasks] : [];
	});
}

describe("task_write", () => {
	it("is registered, and its guidance reaches the model in the tool description", async () => {
		const root = createTempFlypiRoot();
		const { session, stub } = await run(root, [{ tasks: LIST }]);
		try {
			expect(session.getActiveToolNames()).toContain(TASK_TOOL);
			// The cache claim of 9.0: the judgment is a constant string in the request's tool set, not a prompt
			// section that appears once a list exists.
			expect(JSON.stringify(stub.requests[0])).toContain("skip it for trivial single-step tasks");
		} finally {
			session.dispose();
		}
	});

	it("lands a tool card whose details hold the list", async () => {
		const root = createTempFlypiRoot();
		const { session, transcript } = await run(root, [{ tasks: LIST }]);
		try {
			const card = transcript.tools["call-1"];
			expect(card).toMatchObject({ name: TASK_TOOL, state: "done" });
			expect(card?.output).toBe("3 tasks: 1 completed, 1 in progress, 1 pending");
			expect(listsOnBranch(session)).toEqual([LIST]);
		} finally {
			session.dispose();
		}
	});

	it("shows the list again in a session reopened from its file", async () => {
		const root = createTempFlypiRoot();
		const first = await run(root, [{ tasks: LIST }]);
		const file = first.session.sessionFile!;
		first.session.dispose();

		// The way the registry reopens one: open the file, and seed the transcript from its messages as
		// `message_end` events (`seedHistory` in src/server/session-registry.ts).
		const stub = await createStubModel({ responses: [] });
		const reopened = await createFlypiSession({
			root,
			sessionManager: SessionManager.open(file, flypiPaths(root).sessionsDir),
			modelRuntime: stub.modelRuntime,
			model: stub.model,
		});
		try {
			const seeded = reopened.session.messages.map((message) => ({ type: "message_end", message }) as AgentSessionEvent);
			const card = Object.values(reduceEvents(seeded).tools).find((candidate) => candidate.name === TASK_TOOL);
			expect(card).toMatchObject({ state: "done", args: { tasks: LIST } });
			expect(listsOnBranch(reopened.session)).toEqual([LIST]);
		} finally {
			reopened.session.dispose();
		}
	});

	// Each rejection is checked against a session that already holds a list: "writes nothing" is only a claim
	// when there is something to keep.
	const rejections: { label: string; tasks: Write["tasks"]; says: string }[] = [
		{ label: "blank content", tasks: [{ content: "   ", status: "pending" }], says: "non-empty `content`" },
		{ label: "a duplicate content", tasks: [{ content: "fix the comparator", status: "pending" }, { content: "fix the comparator", status: "completed" }], says: "duplicate task" },
		{ label: "two in_progress", tasks: [{ content: "a", status: "in_progress" }, { content: "b", status: "in_progress" }], says: "only one task may be" },
	];
	for (const { label, tasks, says } of rejections) {
		it(`refuses ${label}, tells the model why, and leaves the list alone`, async () => {
			const root = createTempFlypiRoot();
			const { session, transcript } = await run(root, [{ tasks: LIST }, { tasks }]);
			try {
				const card = transcript.tools["call-2"];
				expect(card).toMatchObject({ name: TASK_TOOL, state: "error" });
				expect(card?.output).toContain(says);
				expect(listsOnBranch(session)).toEqual([LIST]);
			} finally {
				session.dispose();
			}
		});
	}

	it("counts one task in the singular", async () => {
		const root = createTempFlypiRoot();
		const { session, transcript } = await run(root, [{ tasks: [{ content: "one step", status: "in_progress" }] }]);
		try {
			expect(transcript.tools["call-1"]?.output).toBe("1 task: 0 completed, 1 in progress, 0 pending");
		} finally {
			session.dispose();
		}
	});

	it("registers one tool, under the name the UI filters its cards by", () => {
		const names: string[] = [];
		createTaskExtension()({ registerTool: (tool: { name: string }) => names.push(tool.name) } as never);
		expect(names).toEqual([TASK_TOOL]);
	});
});
