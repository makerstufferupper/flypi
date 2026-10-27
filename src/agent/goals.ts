/**
 * Phase 9 — goals and tasks (docs/goals.md). This file holds 9.1, `task_write`; the `goal` tool of 9.2
 * lands in the same place.
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
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

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
