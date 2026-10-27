/**
 * Phase 9 — goals and tasks (docs/goals.md): 9.1 `task_write`, 9.2 the `goal` tool and 9.3 the round driver.
 * The driver belongs to neither tool and is opt-in per process, so `createFlypiSession` registers it alone.
 *
 * The goal has no store either: every accepted action appends one `flypi-goal` session entry and `readGoal`
 * takes the last one on the active branch, so the conversation log is the only state. That is what makes a
 * reopen, a branch and a fork each report the goal that belongs to them with nothing to keep in sync, and it
 * is what makes a goal a compaction dropped simply gone — the loop stops rather than continuing blind.
 *
 * `task_write` replaces the whole list on every call, which is what makes it stateless: there is no list to
 * read, no per-item edit, no store and nothing to reconstruct at `session_start`. The list lives in the tool
 * result's `details` — pi's own shape for "state that follows the active branch" (its `todo.ts` example) — so
 * a branch, a reopen and a fork each get the list that belongs to them for free.
 *
 * The judgment about *when* to make a list is in the description, and the description is a constant. pi puts
 * the tool set in the transcript's first system message and appends changes after it, so a constant
 * description sits in the cached prefix and is paid once per conversation, while guidance that appears only
 * when a list exists invalidates everything behind it (docs/prompt-cache.md, risk 2).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { type ExtensionFactory, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { FlypiPaths } from "./paths.ts";

export const TASK_TOOL = "task_write";

export const TASK_STATUSES = ["pending", "in_progress", "completed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TaskItem {
	content: string;
	status: TaskStatus;
}

/**
 * An accepted write carries the list. A rejected one carries `{ error }` and no `tasks` key, which is how
 * "a rejected write changes nothing" holds for every reader: each one takes the last result that has a list,
 * and a rejection has none to be taken.
 */
export type TaskDetails = { tasks: TaskItem[] } | { error: string };

/** The whole answer to "it doesn't always make a list for a small task" (docs/goals.md 9.1). */
export const TASK_TOOL_DESCRIPTION =
	"Replace this conversation's whole task list: every call writes the full list, and there is no read or per-item edit. " +
	"Plan multi-step work; skip it for trivial single-step tasks. Add one task per concrete step before you start. " +
	"Keep exactly one task in_progress while work remains, and mark each completed as soon as it is done.";

export function createTaskExtension(): ExtensionFactory {
	return (pi) => {
		pi.registerTool({
			name: TASK_TOOL,
			label: "Task list",
			description: TASK_TOOL_DESCRIPTION,
			parameters: Type.Object({
				tasks: Type.Array(
					Type.Object({
						content: Type.String({ description: "One concrete step, in a few words" }),
						status: Type.String({ enum: [...TASK_STATUSES], description: "pending | in_progress | completed" }),
					}),
					{ description: "The whole list. Every call replaces it." },
				),
			}),
			execute: async (_id, { tasks }): Promise<TaskResult> => {
				const list: TaskItem[] = (tasks as TaskItem[]).map((task) => ({ content: task.content.trim(), status: task.status }));
				const problem = rejection(list);
				if (problem) return { content: [{ type: "text", text: problem }], details: { error: problem }, isError: true };
				return { content: [{ type: "text", text: counts(list) }], details: { tasks: list } };
			},
		});
	};
}

/** What the tool answers: the counts line plus the list, or the reason it refused and no list. */
type TaskResult = { content: { type: "text"; text: string }[]; details: TaskDetails; isError?: true };

/** The three rules the model can break past the schema; `undefined` means the list is accepted. */
function rejection(list: TaskItem[]): string | undefined {
	const seen = new Set<string>();
	let inProgress = 0;
	for (const task of list) {
		if (!task.content) return "every task needs a non-empty `content`";
		if (seen.has(task.content)) return `duplicate task "${task.content}" — the list is written whole, so name each step once`;
		seen.add(task.content);
		if (task.status === "in_progress") inProgress += 1;
	}
	if (inProgress > 1) return "only one task may be `in_progress` at a time — finish or set the others back to pending";
	return undefined;
}

/** The counts line the model is shown; the list itself is in `details`, which is where the UI reads it. */
function counts(list: TaskItem[]): string {
	const done = list.filter((task) => task.status === "completed").length;
	const active = list.filter((task) => task.status === "in_progress").length;
	const rest = list.length - done - active;
	return `${list.length} task${list.length === 1 ? "" : "s"}: ${done} completed, ${active} in progress, ${rest} pending`;
}

// --- 9.2: the `goal` tool -----------------------------------------------------------------------------

export const GOAL_TOOL = "goal";
/** The session entry the goal lives in: durable, excluded from model context, and the only record. */
export const GOAL_ENTRY = "flypi-goal";
/** The round prompt 9.3 appends. Counting the ones that name a goal is how its round number is derived. */
export const GOAL_ROUND_ENTRY = "flypi-goal-round";

export const GOAL_PHASES = ["active", "paused", "blocked", "complete"] as const;
export type GoalPhase = (typeof GOAL_PHASES)[number];

export const GOAL_ACTIONS = ["create", "edit", "pause", "resume", "complete", "blocked", "clear"] as const;
export type GoalAction = (typeof GOAL_ACTIONS)[number];

/** dh ships 256, which is 256 paid runs. `goals.maxRounds` in settings.json overrides this default. */
export const DEFAULT_MAX_ROUNDS = 16;
/** A per-goal override is still a cap: an unbounded one is not a cap (docs/goals.md, the new risk). */
export const MAX_ROUNDS_CAP = 128;
/** Difficulty is not a blocker: giving up is refused before this many rounds (docs/goals.md 9.2). */
export const BLOCKED_MIN_ROUNDS = 3;

/** The snapshot one `flypi-goal` entry carries: the goal as of the action that appended it. */
export interface GoalSnapshot {
	id: string;
	objective: string;
	phase: GoalPhase;
	maxRounds: number;
	revision: number;
	at: string;
	blockedReason?: string;
}

/** `clear` appends this instead of a snapshot, so the log says there is no goal and the reader stops there. */
export interface GoalCleared {
	cleared: true;
	at: string;
}

export type GoalEntry = GoalSnapshot | GoalCleared;

/** What `readGoal` answers: the stored snapshot plus the round count, which is never stored (9.2). */
export type GoalState = GoalSnapshot & { rounds: number };

/** The whole answer to "when should a conversation have a goal", and a constant, for the same reason 9.1's is. */
export const GOAL_TOOL_DESCRIPTION =
	"One objective for this conversation, kept current: create it for long-running work even when the user did not call it a goal, " +
	"and not for single-turn questions. edit rewords the objective; pause stops the loop without losing the goal; resume starts it again; " +
	`complete only when the objective is actually achieved — read it back and gather the evidence first. blocked needs a reason and is refused before ${BLOCKED_MIN_ROUNDS} rounds: difficulty is not a blocker. clear drops the goal.`;

/**
 * The goal as the branch has it: the last `flypi-goal` entry on the active branch, with the round count
 * derived from the round prompts that name that goal. Read from the branch on every call rather than cached,
 * which is why `session_start`, `session_tree`, a reopen and a fork need no handling of their own.
 */
export function readGoal(sessionManager: Pick<SessionManager, "getBranch">): GoalState | undefined {
	const entries = sessionManager.getBranch();
	let snapshot: GoalSnapshot | undefined;
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (!entry || entry.type !== "custom" || entry.customType !== GOAL_ENTRY) continue;
		const data = entry.data as GoalEntry | undefined;
		if (data && "cleared" in data) return undefined;
		if (data && typeof data.id === "string") snapshot = data;
		break;
	}
	if (!snapshot) return undefined;
	const rounds = entries.filter(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === GOAL_ROUND_ENTRY &&
			(entry.details as { goalId?: string } | undefined)?.goalId === snapshot.id,
	).length;
	return { ...snapshot, rounds };
}

/**
 * The `goal` tool. `defaultMaxRounds` is `goals.maxRounds` from settings.json, resolved once at session start
 * (9.0) and passed in, so a `create` with no override lands the cap this process was started with.
 */
export function createGoalExtension(defaultMaxRounds: number): ExtensionFactory {
	return (pi) => {
		pi.registerTool({
			name: GOAL_TOOL,
			label: "Goal",
			description: GOAL_TOOL_DESCRIPTION,
			parameters: Type.Object({
				action: Type.String({ enum: [...GOAL_ACTIONS], description: "What to do with this conversation's goal" }),
				objective: Type.Optional(Type.String({ description: "What will be true once this is done. Needed by create and edit." })),
				max_rounds: Type.Optional(
					Type.Number({
						minimum: 1,
						maximum: MAX_ROUNDS_CAP,
						description: `Rounds before the goal is recorded blocked. Default ${defaultMaxRounds}.`,
					}),
				),
				blocked_reason: Type.Optional(Type.String({ description: "Why the objective cannot be reached. Needed by blocked." })),
			}),
			execute: async (_id, args, _signal, _onUpdate, ctx): Promise<GoalResult> => {
				const decision = decide(readGoal(ctx.sessionManager), args as GoalArgs, defaultMaxRounds);
				if ("error" in decision) {
					return { content: [{ type: "text", text: decision.error }], details: { error: decision.error }, isError: true };
				}
				// One entry per accepted action: the log is the state, and the last one on the branch wins.
				pi.appendEntry(GOAL_ENTRY, decision.entry);
				return { content: [{ type: "text", text: decision.says }], details: { goal: decision.entry } };
			},
		});
	};
}

type GoalArgs = { action: GoalAction; objective?: string; max_rounds?: number; blocked_reason?: string };
/** What `decide` answers: the entry to append and the line to show, or the reason it refused. */
type Decision = { entry: GoalEntry; says: string } | { error: string };
/** The goal in `details` on an accepted action; a refusal carries `{ error }` and no goal, as 9.1's writes do. */
type GoalResult = { content: { type: "text"; text: string }[]; details: { goal: GoalEntry } | { error: string }; isError?: true };

const says = (text: string, entry: GoalEntry): Decision => ({ says: text, entry });
const refuses = (error: string): Decision => ({ error });

/** Which phases each action may act on; anything else is refused with the phase it found. */
const GOAL_ACTION_PHASES: Record<Exclude<GoalAction, "create">, readonly GoalPhase[]> = {
	edit: ["active", "paused", "blocked", "complete"],
	pause: ["active"],
	resume: ["paused", "blocked"],
	complete: ["active", "paused", "blocked"],
	blocked: ["active"],
	clear: ["active", "paused", "blocked", "complete"],
};

/** One goal per conversation, and the transitions between its phases. `undefined` current means none yet. */
function decide(current: GoalState | undefined, args: GoalArgs, defaultMaxRounds: number): Decision {
	const at = new Date().toISOString();
	if (args.action === "create") {
		const objective = args.objective?.trim();
		if (!objective) return refuses("`create` needs an `objective`: say what will be true once it is done");
		if (current && current.phase !== "complete") {
			return refuses(`this conversation already has a goal that is ${current.phase}: "${current.objective}" — complete, pause or clear it before starting another`);
		}
		const maxRounds = args.max_rounds ?? defaultMaxRounds;
		const entry: GoalSnapshot = { id: randomUUID(), objective, phase: "active", maxRounds, revision: 1, at };
		return says(`goal active: "${objective}" — round 0/${maxRounds}`, entry);
	}

	if (!current) return refuses(`there is no goal to ${args.action}`);
	if (!GOAL_ACTION_PHASES[args.action].includes(current.phase)) {
		return refuses(`the goal is ${current.phase}, so ${args.action} does not apply`);
	}
	// Same id, one revision newer, and no leftover `blockedReason`: only `blocked` puts one back.
	const kept = { id: current.id, objective: current.objective, maxRounds: current.maxRounds, revision: current.revision + 1, at };
	switch (args.action) {
		case "edit": {
			const objective = args.objective?.trim();
			if (!objective) return refuses("`edit` needs the new `objective`");
			return says(`goal edited: "${objective}"`, { ...kept, objective, phase: current.phase });
		}
		case "pause":
			return says(`goal paused: "${current.objective}" — nothing continues until it is resumed`, { ...kept, phase: "paused" });
		case "resume":
			return says(`goal active: "${current.objective}" — round ${current.rounds}/${current.maxRounds}`, { ...kept, phase: "active" });
		case "complete":
			return says(`goal complete: "${current.objective}"`, { ...kept, phase: "complete" });
		case "blocked": {
			const reason = args.blocked_reason?.trim();
			if (!reason) return refuses("`blocked` needs a `blocked_reason`: say what makes the objective unreachable");
			// shortcut: "3 consecutive rounds" is counted as the goal's own round count, so a pause does not
			// reset it. Split the count if a goal ever restarts its rounds.
			if (current.rounds < BLOCKED_MIN_ROUNDS) {
				return refuses(`round ${current.rounds} of ${current.maxRounds}: a goal is not blocked before ${BLOCKED_MIN_ROUNDS} rounds — say what you tried and keep going, or clear it`);
			}
			return says(`goal blocked: ${reason}`, { ...kept, phase: "blocked", blockedReason: reason });
		}
		case "clear":
			return says(`goal cleared: "${current.objective}"`, { cleared: true, at });
	}
}

// --- 9.3: the round driver ---------------------------------------------------------------------------

/** `goals` in `.flypi/agent/settings.json`. */
export interface GoalsConfig {
	/** Off means the conversation stops when the model stops, whatever the goal says. */
	autoContinue: boolean;
	/** The cap a `create` with no `max_rounds` gets. A round is a paid model run. */
	maxRounds: number;
}

export const ROUND_LIMIT = "round-limit";

/** Read once at session start, never per call: 9.0. A cap that can move mid-run is not a cap. */
export function goalsConfig(paths: FlypiPaths): GoalsConfig {
	let settings: unknown;
	try {
		settings = JSON.parse(readFileSync(paths.settingsPath, "utf8"));
	} catch {
		settings = {}; // no settings file yet: the defaults have to work
	}
	return parseGoalsConfig(settings);
}

export function parseGoalsConfig(settings: unknown): GoalsConfig {
	const goals = (settings as { goals?: Record<string, unknown> } | undefined)?.goals;
	// A round is a paid run, so a value that is not a whole number inside the schema's ceiling is the default
	// rather than a licence: `true` must not become 1, and 1e9 must not become "unbounded".
	const written = goals?.maxRounds;
	const maxRounds =
		typeof written === "number" && Number.isInteger(written) && written >= 1 && written <= MAX_ROUNDS_CAP ? written : DEFAULT_MAX_ROUNDS;
	return { autoContinue: goals?.autoContinue !== false, maxRounds };
}

/**
 * The round that does not stop (docs/goals.md 9.3): one handler at pi's settle boundary. While the
 * conversation's goal is `active` it appends the round prompt and asks pi for another run; pi owns the loop,
 * so there is no scheduler of ours to race with it — `agent_settled` still fires only when the run truly
 * settles, and pi's own abort guard means the stop button ends the loop for free.
 *
 * Registered only for a process a human is watching (`goalDriver` in `createFlypiSession`, which only the WS
 * server's conversations pass), and only when `goals.autoContinue` says so: a daemon job or a review fork
 * holding a goal must never loop unattended and spend money with nobody there.
 *
 * At the cap the goal is recorded `blocked: round-limit` rather than stopping quietly, so the reason a run
 * ended is in the transcript and the UI, not only in the absence of another round.
 */
export function createGoalDriverExtension(): ExtensionFactory {
	return (pi) => {
		pi.on("agent_before_settle", (_event, ctx) => {
			// One `readGoal` call: 9.2 derives the round count from the round prompts, so there is no counter
			// of ours to keep in sync, and a goal a compaction dropped reads as no goal — the loop stops.
			const goal = readGoal(ctx.sessionManager);
			if (!goal || goal.phase !== "active") return undefined;
			if (goal.rounds >= goal.maxRounds) {
				return {
					entries: [
						{
							type: "custom",
							customType: GOAL_ENTRY,
							// The same snapshot shape the tool appends — including no `rounds`, which is derived.
							data: {
								id: goal.id,
								objective: goal.objective,
								maxRounds: goal.maxRounds,
								revision: goal.revision + 1,
								phase: "blocked",
								at: new Date().toISOString(),
								blockedReason: ROUND_LIMIT,
							} satisfies GoalSnapshot,
						},
					],
					continue: false,
				};
			}
			const round = goal.rounds + 1;
			return {
				entries: [
					{
						type: "custom_message",
						customType: GOAL_ROUND_ENTRY,
						content: roundPrompt(goal, round),
						display: false,
						// The `goalId` is what `readGoal` counts the rounds by, and `round` is what the UI shows.
						details: { goalId: goal.id, round },
					},
				],
				continue: true,
			};
		});
	};
}

/**
 * 9.0 rule 3: the round prompt is the only cold bytes a round adds, so it stays small — the objective, the
 * round number, and the same verify-before-claiming sentence the tool description carries. Byte-identical for
 * one (goal revision, round) pair, so a retry re-hits the cache rather than re-paying it.
 */
function roundPrompt(goal: GoalState, round: number): string {
	return (
		`Goal ${JSON.stringify(goal.objective)} — round ${round} of ${goal.maxRounds}. Take the next step towards it now; do not stop at a plan. ` +
		"Before you say the objective is met, read it back and gather the evidence: `goal complete` only if it holds, `goal blocked` with a reason " +
		"if it cannot be reached, and `pause` or `clear` if the work has moved on."
	);
}
