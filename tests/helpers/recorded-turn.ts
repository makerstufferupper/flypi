/**
 * The recorded multi-tool turn (docs/testing.md "Fixtures"): fix a failing numeric sort — read the test,
 * read the source, fix it, run the test, explain. `scripts/record-transcript.ts` records it into
 * `tests/fixtures/transcript-log`, and `tests/memory/prompt-prefix.test.ts` replays it against a real
 * memory server. It lives here because a fixture the two drive separately is a fixture that drifts.
 *
 * The repo it runs in is a throwaway checkout the caller writes with `FIXED_THE_FAILING_TEST_FILES`.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "./stub-model.ts";

export const BROKEN_SORT = `export function sort(values) {
  return values.sort();
}
`;

export const SORT_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { sort } from "./sort.mjs";

test("sorts numbers ascending", () => {
  assert.deepEqual(sort([10, 9, 2]), [2, 9, 10]);
});
`;

/** Write the checkout the turn expects: a source whose sort compares as strings, and the test that fails. */
export function writeFailingTestRepo(root: string): void {
	writeFileSync(join(root, "sort.mjs"), BROKEN_SORT);
	writeFileSync(join(root, "sort.test.mjs"), SORT_TEST);
}

/** The task the plan's Phase 2 gate names: "fix this failing test in <repo>". */
export const FIX_THE_FAILING_TEST = "fix the failing test in this repo";

/** One turn: read the test, read the source, fix it, run the test, explain. */
export function fixTheFailingTest(): FauxResponseStep[] {
	return [
		fauxAssistantMessage([fauxToolCall("read", { path: "sort.test.mjs" }, { id: "call-1" })], { stopReason: "toolUse", timestamp: 0 }),
		fauxAssistantMessage([fauxToolCall("read", { path: "sort.mjs" }, { id: "call-2" })], { stopReason: "toolUse", timestamp: 0 }),
		fauxAssistantMessage(
			[fauxToolCall("edit", { path: "sort.mjs", edits: [{ oldText: "return values.sort();", newText: "return values.sort((a, b) => a - b);" }] }, { id: "call-3" })],
			{ stopReason: "toolUse", timestamp: 0 },
		),
		fauxAssistantMessage([fauxToolCall("bash", { command: "node --test" }, { id: "call-4" })], { stopReason: "toolUse", timestamp: 0 }),
		fauxAssistantMessage([fauxText("sort() was comparing numbers as strings, so [10, 9, 2] stayed put. Numeric comparator added; node --test passes.")], { timestamp: 0 }),
	];
}
