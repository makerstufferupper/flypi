/**
 * The goal's pure phase machine (docs/goals.md 9.2): the names a goal is made of and the two questions every
 * caller asks about it — does this action apply here, and what phase does it leave the goal in.
 *
 * That rule was spelled twice. `GOAL_ACTION_PHASES` sat inside `src/agent/goals.ts` and `ui/ActivityPanel.svelte`
 * kept its own `PHASE` table, because the tool module also reads `node:crypto` and `node:fs` and pi's
 * `SessionManager`, and none of that belongs in the browser bundle. `src/shared/transcript.ts` re-spelled
 * `GOAL_ROUND_ENTRY` for the same reason, in a comment apologising for it. Two copies of one machine, and both
 * caused by the pure half of the goal having nowhere to live. This is that place.
 *
 * **The rule: no runtime imports in this file.** Not `node:*`, not pi, not another module that pulls either in;
 * a type-only import is fine because it is gone after compilation. Nothing in the build enforces it — the browser
 * bundle would simply gain node builtins and keep working until something ran it — so
 * `tests/shared/goal-phase.test.ts` asserts it against this file's own text.
 */

/** The session entry the goal lives in: durable, excluded from model context, and the only record. */
export const GOAL_ENTRY = "flypi-goal";
/** The round prompt 9.3 appends. Counting the ones that name a goal is how its round number is derived. */
export const GOAL_ROUND_ENTRY = "flypi-goal-round";

/** The phases a goal can be in. Only `active` continues on its own (9.3). */
export const GOAL_PHASES = ["active", "paused", "blocked", "complete"] as const;
export type GoalPhase = (typeof GOAL_PHASES)[number];

/** The `goal` tool's seven actions, as its typebox schema enumerates them. */
export const GOAL_ACTIONS = ["create", "edit", "pause", "resume", "complete", "blocked", "clear"] as const;
export type GoalAction = (typeof GOAL_ACTIONS)[number];

/** Which phases each action may act on. `applies` is the reader; what a refusal says is each caller's own business. */
export const GOAL_ACTION_PHASES: Record<Exclude<GoalAction, "create">, readonly GoalPhase[]> = {
	edit: ["active", "paused", "blocked", "complete"],
	pause: ["active"],
	resume: ["paused", "blocked"],
	complete: ["active", "paused", "blocked"],
	blocked: ["active"],
	clear: ["active", "paused", "blocked", "complete"],
};

/** `goals.maxRounds` stopped the loop, recorded in the goal's `blockedReason`. */
export const ROUND_LIMIT = "round-limit";
/** The same pattern as `ROUND_LIMIT`: a reason a round stopped, recorded in the goal's `blockedReason`. */
export const TURN_FAILED = "turn-failed";

/**
 * Whether `action` applies to a goal in `phase`, where `undefined` phase means the conversation has no goal.
 * The tool refuses with the phase it found, and the panel repaints only a card marked `done`, so both callers
 * answer this one question and cannot disagree about the answer.
 */
export function applies(action: GoalAction, phase: GoalPhase | undefined): boolean {
	// `create` is the only action that reads "no goal" — and a finished goal is free to be replaced.
	if (action === "create") return phase === undefined || phase === "complete";
	// The `blocked` action's "not before 3 rounds" floor is deliberately not here: it reads `rounds`, which this
	// module has no business knowing, so that one stays in `decide`.
	// The lookup is into this build's vocabulary while the action arrives as recorded text — the typebox enum
	// guards a live call, not a `goal` call some other build wrote down — so an unknown name applies to nothing.
	return phase !== undefined && (GOAL_ACTION_PHASES[action]?.includes(phase) ?? false);
}

/**
 * The phase `action` leaves a goal in.
 *
 * `clear` is absent from the signature because it is not a phase transition in either caller: the panel resets
 * the objective and the cap with it, and the tool appends a `GoalCleared` entry instead of a snapshot. Both call
 * sites answer `clear` before asking, and `edit` answers with the phase it was given.
 *
 * The `default` arm is what answers for anything else, and it is load-bearing rather than belt-and-braces: the
 * switch is exhaustive over `GoalAction`, so TypeScript never asks for it, while a `done` card rebuilt from a
 * session file can name an action this build never saw — the typebox schema guards a live call only.
 */
export function nextPhase(action: Exclude<GoalAction, "clear">, phase: GoalPhase): GoalPhase {
	switch (action) {
		case "create":
		case "resume":
			return "active";
		case "pause":
			return "paused";
		case "complete":
			return "complete";
		case "blocked":
			return "blocked";
		case "edit":
			return phase; // a reword does not move the goal.
		default:
			// An action name this file has never seen reaches here from a card another build recorded. It leaves the
			// goal where it was, which is what the panel did before the table moved here; falling through instead
			// would answer `undefined` and blank the phase chip for the rest of the walk.
			return phase;
	}
}
