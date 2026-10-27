/**
 * Phase 9.1 — `task_write` (docs/goals.md). Driven through a real session with the stub model rather than by
 * calling the tool, because the claims are about what reaches the session file and what a card rebuilt from
 * that file shows: a tool that returns the right object and lands nothing durable would pass the cheaper test.
 */
import { describe, expect, it } from "vitest";
import { SessionManager, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createTaskExtension, GOAL_ROUND_ENTRY, GOAL_TOOL, readGoal, TASK_TOOL, type GoalState, type TaskDetails, type TaskItem } from "../../src/agent/goals.ts";
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

/**
 * Phase 9.2 — the `goal` tool (docs/goals.md). Asserted through a session rather than against `decide`,
 * because the claim is that the session branch is the whole state: what a write appends, what a refusal
 * leaves out, and what a conversation reopened from its file reports.
 */
describe("goal", () => {
	type GoalCall = { action: string; objective?: string; max_rounds?: number; blocked_reason?: string };

	function goalScript(calls: GoalCall[]) {
		return [
			...calls.map((call, i) =>
				fauxAssistantMessage([fauxToolCall(GOAL_TOOL, call, { id: `goal-${i + 1}` })], { stopReason: "toolUse", timestamp: 0 }),
			),
			fauxAssistantMessage([fauxText("noted")], { timestamp: 0 }),
		];
	}

	async function runGoal(root: string, calls: GoalCall[]) {
		const stub = await createStubModel({ responses: goalScript(calls) });
		const { session } = await createFlypiSession({ root, modelRuntime: stub.modelRuntime, model: stub.model });
		const events: AgentSessionEvent[] = [];
		const detach = session.subscribe((event) => events.push(event));
		await session.prompt("carry this on");
		detach();
		return { session, stub, transcript: reduceEvents(events) };
	}

	/**
	 * The round prompts 9.3 will append at the settle boundary, put on the branch by hand. The round count is
	 * derived from them rather than stored, so this is how a test reaches round 3 before the loop exists.
	 */
	function advanceRounds(session: FlypiSession, rounds: number): void {
		const goal = readGoal(session.sessionManager);
		expect(goal).toBeDefined();
		for (let round = 1; round <= rounds; round += 1) {
			session.sessionManager.appendCustomMessageEntry(GOAL_ROUND_ENTRY, `round ${round}`, false, { goalId: goal!.id, round });
		}
	}

	it("is registered, and its guidance reaches the model in the tool description", async () => {
		const root = createTempFlypiRoot();
		const { session, stub } = await runGoal(root, [{ action: "create", objective: "ship T17" }]);
		try {
			expect(session.getActiveToolNames()).toContain(GOAL_TOOL);
			expect(JSON.stringify(stub.requests[0])).toContain("difficulty is not a blocker");
			expect(readGoal(session.sessionManager)).toMatchObject({
				objective: "ship T17",
				phase: "active",
				maxRounds: 16,
				revision: 1,
				rounds: 0,
			});
		} finally {
			session.dispose();
		}
	});

	it("refuses a create with no objective, and writes no goal", async () => {
		const root = createTempFlypiRoot();
		const { session, transcript } = await runGoal(root, [{ action: "create" }]);
		try {
			expect(transcript.tools["goal-1"]).toMatchObject({ name: GOAL_TOOL, state: "error" });
			expect(transcript.tools["goal-1"]?.output).toContain("needs an `objective`");
			expect(readGoal(session.sessionManager)).toBeUndefined();
		} finally {
			session.dispose();
		}
	});

	it("keeps one goal per conversation: a second create is refused until the first is complete", async () => {
		const root = createTempFlypiRoot();
		const { session, transcript } = await runGoal(root, [
			{ action: "create", objective: "first" },
			{ action: "create", objective: "second" },
			{ action: "complete" },
			{ action: "create", objective: "second" },
		]);
		try {
			expect(transcript.tools["goal-2"]?.state).toBe("error");
			expect(transcript.tools["goal-2"]?.output).toContain("already has a goal that is active");
			expect(readGoal(session.sessionManager)).toMatchObject({ objective: "second", phase: "active", revision: 1 });
		} finally {
			session.dispose();
		}
	});

	it("edits, pauses and resumes the same goal, and refuses an action that has no goal to act on", async () => {
		const root = createTempFlypiRoot();
		const { session, transcript } = await runGoal(root, [
			{ action: "resume" },
			{ action: "create", objective: "first" },
			{ action: "edit", objective: "reworded" },
			{ action: "pause" },
			{ action: "resume" },
		]);
		try {
			expect(transcript.tools["goal-1"]?.output).toContain("there is no goal to resume");
			const goal = readGoal(session.sessionManager);
			expect(goal).toMatchObject({ objective: "reworded", phase: "active", revision: 4 });
		} finally {
			session.dispose();
		}
	});

	it("will not resume a goal that is complete", async () => {
		const root = createTempFlypiRoot();
		const { session, transcript } = await runGoal(root, [
			{ action: "create", objective: "done work" },
			{ action: "complete" },
			{ action: "resume" },
		]);
		try {
			expect(transcript.tools["goal-3"]?.state).toBe("error");
			expect(transcript.tools["goal-3"]?.output).toContain("the goal is complete, so resume does not apply");
			expect(readGoal(session.sessionManager)).toMatchObject({ phase: "complete" });
		} finally {
			session.dispose();
		}
	});

	// The guard against giving up on round one: difficulty is not a blocker (docs/goals.md 9.2).
	it("refuses `blocked` at round 1 and accepts it at round 3, with its reason", async () => {
		const early = await runGoal(createTempFlypiRoot(), [{ action: "create", objective: "hard thing" }]);
		try {
			advanceRounds(early.session, 1);
			early.stub.append([...goalScript([{ action: "blocked", blocked_reason: "the API is down" }])]);
			await early.session.prompt("how is it going");
			expect(readGoal(early.session.sessionManager)).toMatchObject({ phase: "active", rounds: 1 });
		} finally {
			early.session.dispose();
		}

		const late = await runGoal(createTempFlypiRoot(), [{ action: "create", objective: "hard thing" }]);
		try {
			advanceRounds(late.session, 3);
			late.stub.append([...goalScript([{ action: "blocked", blocked_reason: "the API is down" }])]);
			await late.session.prompt("how is it going");
			expect(readGoal(late.session.sessionManager)).toMatchObject({ phase: "blocked", blockedReason: "the API is down", rounds: 3 });
		} finally {
			late.session.dispose();
		}
	});

	it("clear leaves the conversation with no goal", async () => {
		const root = createTempFlypiRoot();
		const { session } = await runGoal(root, [
			{ action: "create", objective: "drop me" },
			{ action: "clear" },
		]);
		try {
			expect(readGoal(session.sessionManager)).toBeUndefined();
		} finally {
			session.dispose();
		}
	});

	it("reports the same goal, phase and round count in a session reopened from its file", async () => {
		const root = createTempFlypiRoot();
		const first = await runGoal(root, [{ action: "create", objective: "outlive the process", max_rounds: 4 }]);
		advanceRounds(first.session, 2);
		first.stub.append([...goalScript([{ action: "pause" }])]);
		await first.session.prompt("hold on");
		const before: GoalState | undefined = readGoal(first.session.sessionManager);
		const file = first.session.sessionFile!;
		first.session.dispose();
		expect(before).toMatchObject({ objective: "outlive the process", phase: "paused", maxRounds: 4, rounds: 2 });

		const stub = await createStubModel({ responses: [] });
		const reopened = await createFlypiSession({
			root,
			sessionManager: SessionManager.open(file, flypiPaths(root).sessionsDir),
			modelRuntime: stub.modelRuntime,
			model: stub.model,
		});
		try {
			expect(readGoal(reopened.session.sessionManager)).toEqual(before);
		} finally {
			reopened.session.dispose();
		}
	});
});
