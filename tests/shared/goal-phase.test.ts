/**
 * The goal's phase machine, asserted directly (docs/goals.md 9.2, T25).
 *
 * This is the test the duplicated table made impossible: `GOAL_ACTION_PHASES` was module-private to
 * `src/agent/goals.ts`, so the only way to ask it a question was to drive the real tool through a stub model —
 * and `ui/ActivityPanel.svelte`'s copy could drift from it with nothing failing. Here the rule is the subject:
 * which actions apply to which phase, and which phase each one leaves behind.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applies, GOAL_ACTIONS, nextPhase, type GoalAction, type GoalPhase } from "../../src/shared/goal-phase.ts";

describe("which action applies to which phase", () => {
	it("resumes a blocked goal, refuses to block a paused one and refuses a second create while one is active", () => {
		expect(applies("resume", "blocked")).toBe(true);
		expect(applies("blocked", "paused")).toBe(false);
		expect(applies("create", "active")).toBe(false);
	});

	it("reads `create` as the action for a conversation with no goal, and lets it replace a complete one", () => {
		expect(applies("create", undefined)).toBe(true);
		expect(applies("create", "complete")).toBe(true);
	});

	// `undefined` is the no-goal case for every action, and only `create` is allowed to see it.
	it("refuses every other action when the conversation has no goal", () => {
		for (const action of GOAL_ACTIONS.filter((action) => action !== "create")) {
			expect(applies(action, undefined)).toBe(false);
		}
	});

	// The one reading of the table the product depends on beyond the cases above: `complete` is the end of the
	// spending, so this transition must never restart it (docs/goals.md 9.2). Pinned as a literal, because a test
	// that asked `applies` to agree with `GOAL_ACTION_PHASES` would only prove both were written by the same hand.
	it("refuses to resume a goal that is complete", () => {
		expect(applies("resume", "complete")).toBe(false);
	});

	// The same foreign card as the `nextPhase` case below. `applies` is public and the shipped package exports it,
	// so a caller reading an action out of another build's record gets "does not apply" rather than a TypeError
	// out of a table lookup — the two halves of the machine must not disagree about an action neither knows.
	it("refuses an action it has never heard of", () => {
		const foreign = "nonsense" as GoalAction;
		expect(applies(foreign, "active")).toBe(false);
		expect(applies(foreign, undefined)).toBe(false);
	});
});

describe("the phase each action leaves the goal in", () => {
	it("moves the goal where the tool records it, and leaves `edit` where it was", () => {
		const moved: [Exclude<GoalAction, "clear">, GoalPhase][] = [
			["create", "active"],
			["pause", "paused"],
			["complete", "complete"],
			["blocked", "blocked"],
		];
		for (const [action, phase] of moved) {
			expect(nextPhase(action, "blocked")).toBe(phase);
		}
		// The two the panel needs most: a blocked goal comes back active, and a reword does not move it.
		expect(nextPhase("resume", "blocked")).toBe("active");
		expect(nextPhase("edit", "paused")).toBe("paused");
	});

	// A `done` card is the *recorded* result of a call, so a session file written by another build names actions
	// this one never saw, and the switch above is exhaustive over `GoalAction` so TypeScript cannot ask for that
	// case. Without the `default` arm this returns `undefined`, the panel's chip goes blank and stays blank.
	it("leaves the goal where an action it has never heard of found it", () => {
		// The cast has to name the parameter's type rather than `GoalAction`, since that union still has `clear`.
		const foreign = "verify" as Exclude<GoalAction, "clear">;
		expect(nextPhase(foreign, "active")).toBe("active");
		expect(nextPhase(foreign, "paused")).toBe("paused");
	});
});

describe("the module's one rule", () => {
	// A runtime import here would put node builtins into the browser bundle, and no other test could see it: the
	// page would still build while the module stopped being one any UI can reach. Today it imports nothing at all.
	it("has no runtime import, so `ui/` and the browser bundle can reach it", () => {
		const source = readFileSync(new URL("../../src/shared/goal-phase.ts", import.meta.url), "utf8");
		for (const line of source.split("\n").filter((line) => /^\s*import\s/.test(line))) {
			expect(line).toMatch(/^\s*import\s+type\s/);
		}
	});
});
