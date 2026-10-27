/**
 * Phase 9 — goals and tasks (docs/goals.md). Driven through a real session with the stub model rather than by
 * calling the tools, because the claims are about what reaches the session file, what a card rebuilt from that
 * file shows, and — for 9.3 — whether pi starts the next run. A tool that returns the right object and lands
 * nothing durable, or a settle handler that asks for a round pi never runs, would pass the cheaper test.
 */
import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
	createTaskExtension,
	GOAL_ROUND_ENTRY,
	GOAL_TOOL,
	goalsConfig,
	MAX_ROUNDS_CAP,
	parseGoalsConfig,
	readGoal,
	TASK_TOOL,
	type GoalState,
	type TaskDetails,
	type TaskItem,
} from "../../src/agent/goals.ts";
import { createFlypiSession, type FlypiSession } from "../../src/agent/runtime.ts";
import { flypiPaths } from "../../src/agent/paths.ts";
import { reduceEvents } from "../../src/shared/transcript.ts";
import { createTempFlypiRoot } from "../helpers/flypi-root.ts";
import { createStubModel, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "../helpers/stub-model.ts";

const LIST: TaskItem[] = [
	{ content: "read the failing test", status: "completed" },
	{ content: "fix the comparator", status: "in_progress" },
	{ content: "re-run the suite", status: "pending" },
];

/** One scripted turn per payload: the model calls `task_write` with each list in turn, then answers. */
type Write = { tasks: { content: string; status: string }[] };

/** One scripted `goal` call. */
type GoalCall = { action: string; objective?: string; max_rounds?: number; blocked_reason?: string };

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
	function goalScript(calls: GoalCall[]) {		return [
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

/**
 * Phase 9.3 — the round driver (docs/goals.md). Asserted on the run loop: which requests the stub was asked to
 * answer, what the branch holds when the run settles, and how many times `agent_settled` fires. Calling the
 * handler and checking its return value would prove nothing about whether pi starts the next run, which is the
 * whole feature.
 */
describe("the goal round driver", () => {
	/** `goal create`, then one plain-text answer per response. */
	function roundScript(calls: GoalCall[], answers: number) {
		return [
			...calls.map((call, i) =>
				fauxAssistantMessage([fauxToolCall(GOAL_TOOL, call, { id: `goal-${i + 1}` })], { stopReason: "toolUse", timestamp: 0 }),
			),
			...Array.from({ length: answers }, (_unused, i) => fauxAssistantMessage([fauxText(`step ${i + 1}`)], { timestamp: 0 })),
		];
	}

	async function runDriver(responses: FauxResponseStep[], options: { goalDriver?: boolean; goals?: unknown } = {}) {
		const root = createTempFlypiRoot();
		if (options.goals !== undefined) {
			writeFileSync(join(root, ".flypi", "agent", "settings.json"), JSON.stringify({ goals: options.goals }));
		}
		const stub = await createStubModel({ responses });
		const { session } = await createFlypiSession({
			root,
			modelRuntime: stub.modelRuntime,
			model: stub.model,
			...(options.goalDriver ? { goalDriver: true } : {}),
		});
		const events: AgentSessionEvent[] = [];
		const detach = session.subscribe((event) => events.push(event));
		await session.prompt("carry this on");
		detach();
		return { session, stub, events };
	}

	/** The round prompts on the branch, as the model saw them: what 9.4's round counter reads. */
	function roundsOnBranch(session: FlypiSession) {
		return session.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom_message" && entry.customType === GOAL_ROUND_ENTRY)
			.map((entry) => {
				const round = entry as { display: boolean; details?: { goalId: string; round: number } };
				return { display: round.display, ...round.details };
			});
	}

	it("keeps the run going: every answer is followed by a round prompt that reaches the model", async () => {
		const { session, stub, events } = await runDriver(
			[
				...roundScript([{ action: "create", objective: "ship T18" }], 2),
				fauxAssistantMessage([fauxToolCall(GOAL_TOOL, { action: "complete" }, { id: "goal-close" })], { stopReason: "toolUse", timestamp: 0 }),
				fauxAssistantMessage([fauxText("done")], { timestamp: 0 }),
			],
			{ goalDriver: true },
		);
		try {
			// One human prompt, three runs: the answer, round 1, round 2 — and `complete` ends it.
			expect(stub.requests.length).toBe(5);
			// The objective rides the round message rather than the system prompt: an `edit` never re-pays the
			// conversation (docs/goals.md 9.0).
			expect(JSON.stringify(stub.requests[2])).toContain("ship T18");
			expect(JSON.stringify(stub.requests[2])).toContain("round 1 of 16");
			expect(JSON.stringify(stub.requests[3])).toContain("round 2 of 16");
			expect(roundsOnBranch(session)).toEqual([
				{ display: false, goalId: expect.any(String), round: 1 },
				{ display: false, goalId: expect.any(String), round: 2 },
			]);
			expect(readGoal(session.sessionManager)).toMatchObject({ phase: "complete", rounds: 2 });
			// The run is one run: `agent_settled` fires once, so `markRun(id, "idle")` and the UI's stop button
			// stay meaningful across every round.
			expect(events.filter((event) => event.type === "agent_settled")).toHaveLength(1);
		} finally {
			session.dispose();
		}
	});

	it("stops at the cap and records the goal blocked: round-limit", async () => {
		const { session, stub } = await runDriver(roundScript([{ action: "create", objective: "loop", max_rounds: 2 }], 3), {
			goalDriver: true,
		});
		try {
			// create, then three answers: rounds 1 and 2 are paid for, and the settle after the third is the cap.
			expect(stub.requests.length).toBe(4);
			expect(roundsOnBranch(session)).toHaveLength(2);
			expect(readGoal(session.sessionManager)).toMatchObject({
				phase: "blocked",
				blockedReason: "round-limit",
				maxRounds: 2,
				revision: 2,
				rounds: 2,
			});
		} finally {
			session.dispose();
		}
	});

	it("starts no further round when the run is aborted mid-round", async () => {
		const stub = await createStubModel({ responses: roundScript([{ action: "create", objective: "stop me" }], 3) });
		const { session } = await createFlypiSession({
			root: createTempFlypiRoot(),
			modelRuntime: stub.modelRuntime,
			model: stub.model,
			goalDriver: true,
		});
		// Let round 1 start, then abort inside it: the loop is already running, so this is the stop button in
		// the case that matters. pi's own settle-abort guard ends it — the goal stays active and nothing is
		// appended to continue it, so the brake covers the whole run and not only its first turn.
		let ends = 0;
		const detach = session.subscribe((event) => {
			if (event.type !== "agent_end" || event.willRetry || ++ends < 2) return;
			void session.abort();
		});
		try {
			await session.prompt("carry this on");
			expect(stub.requests.length).toBe(3);
			expect(roundsOnBranch(session).map((round) => round.round)).toEqual([1]);
			expect(readGoal(session.sessionManager)).toMatchObject({ phase: "active", rounds: 1 });
		} finally {
			session.dispose();
		}
	});

	// The one item in the phase that can cost money, so the opt-in is asserted as hard as the loop is: a probe,
	// a daemon job, a review fork and any other process that never asked for the driver cannot loop unattended.
	it("starts no round at all for a session that did not ask for the driver", async () => {
		const { session, stub } = await runDriver(roundScript([{ action: "create", objective: "unattended", max_rounds: 2 }], 3));
		try {
			// The run settles where the model stopped it: one prompt, two requests, no round prompt anywhere.
			expect(stub.requests.length).toBe(2);
			expect(JSON.stringify(stub.requests.map((request) => request.messages))).not.toContain("round 1 of");
			expect(roundsOnBranch(session)).toEqual([]);
			expect(readGoal(session.sessionManager)).toMatchObject({ phase: "active", rounds: 0 });
		} finally {
			session.dispose();
		}
	});

	it("starts no round when goals.autoContinue is off", async () => {
		const { session, stub } = await runDriver(roundScript([{ action: "create", objective: "hands off", max_rounds: 2 }], 3), {
			goalDriver: true,
			goals: { autoContinue: false },
		});
		try {
			expect(stub.requests.length).toBe(2);
			expect(roundsOnBranch(session)).toEqual([]);
		} finally {
			session.dispose();
		}
	});

	it("gives a create the cap from goals.maxRounds, resolved once at session start", async () => {
		const { session } = await runDriver(roundScript([{ action: "create", objective: "capped" }], 1), { goals: { maxRounds: 3 } });
		try {
			expect(readGoal(session.sessionManager)).toMatchObject({ maxRounds: 3 });
		} finally {
			session.dispose();
		}
	});

	describe("goals config", () => {
		it("defaults to auto-continue at 16 rounds, and reads `goals` from settings.json", () => {
			expect(parseGoalsConfig({})).toEqual({ autoContinue: true, maxRounds: 16 });
			expect(parseGoalsConfig({ goals: { autoContinue: false } })).toEqual({ autoContinue: false, maxRounds: 16 });
			expect(parseGoalsConfig({ goals: { maxRounds: 3 } })).toEqual({ autoContinue: true, maxRounds: 3 });
			expect(parseGoalsConfig({ goals: { maxRounds: MAX_ROUNDS_CAP } })).toEqual({ autoContinue: true, maxRounds: MAX_ROUNDS_CAP });
			// A round is a paid run, so a value that is not a whole number inside the schema's ceiling is the
			// default rather than a licence: `true` must not become 1, and 1e9 must not mean unbounded.
			for (const written of [0, -1, 2.5, 1e9, MAX_ROUNDS_CAP + 1, true, "8", null]) {
				expect(parseGoalsConfig({ goals: { maxRounds: written } }).maxRounds).toBe(16);
			}
		});

		it("falls back to the defaults when settings.json is not there yet", () => {
			expect(goalsConfig(flypiPaths("/nonexistent-flypi-root"))).toEqual({ autoContinue: true, maxRounds: 16 });
		});
	});
});
