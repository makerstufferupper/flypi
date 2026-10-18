import { describe, expect, it } from "vitest";
import { modelCalls, spread, summarise } from "../../src/shared/turn-boundary.ts";

/**
 * A two-turn session log in pi's own shape: `session` and `model_change` entries, then messages. Turn 1 makes
 * two model calls (the second follows a tool result), turn 2 makes one. The usage numbers are the two shapes
 * the real routes report — llama_a leaves `cacheWrite` at 0 and reports what it re-read in `input`, llama_d
 * left `input` at 0 and reported it in `cacheWrite` — because the split has to mean the same thing either way.
 */
const SESSION = [
	{ type: "session", version: 3, id: "s" },
	{ type: "model_change", id: "m", provider: "p", modelId: "route" },
	{ type: "message", message: { role: "system", content: "prompt" } },
	{ type: "message", message: { role: "user", content: "one" } },
	{
		type: "message",
		message: { role: "assistant", model: "route", usage: { input: 100, output: 20, cacheRead: 900, cacheWrite: 0, totalTokens: 1020 } },
	},
	{ type: "message", message: { role: "toolResult", content: "result" } },
	{
		// No `model` field: a call still counts, and its model is simply unknown.
		type: "message",
		message: { role: "assistant", usage: { input: 5, output: 30, cacheRead: 1020, cacheWrite: 0, totalTokens: 1055 } },
	},
	{ type: "message", message: { role: "user", content: "two" } },
	{
		// The boundary call: the previous turn's context is in the request, but only part of it is a cache hit.
		type: "message",
		message: { role: "assistant", model: "route", usage: { input: 600, output: 40, cacheRead: 455, cacheWrite: 0, totalTokens: 1095 } },
	},
	{ type: "message", message: { role: "toolResult", content: "result" } },
	{
		// A route that reports its re-read tokens as `cacheWrite` instead of `input`.
		type: "message",
		message: { role: "assistant", model: "other", usage: { input: 0, output: 15, cacheRead: 0, cacheWrite: 1095, totalTokens: 1110 } },
	},
	// A message entry the harness never numbers, and an assistant message with no usage at all: neither is a call.
	{ type: "message", message: { role: "user", content: "three" } },
	{ type: "message", message: { role: "assistant", model: "route" } },
];

// A real session file is one entry per line and ends with a newline, so an empty line is not an entry.
const log = `${SESSION.map((entry) => JSON.stringify(entry)).join("\n")}\n`;

describe("turn-boundary (docs/prompt-cache.md C1)", () => {
	it("reads the model calls out of a session log, skipping everything with no numbers", () => {
		const calls = modelCalls(log);
		expect(calls.map((call) => call.model)).toEqual(["route", "unknown", "route", "other"]);
		// The provider's own numbers, added up rather than re-counted.
		expect(calls[0]).toMatchObject({ prompt: 1000, reused: 900, repaid: 100, carry: 0 });
		// Every call after the first carries the previous call's whole prompt+completion.
		expect(calls.slice(1).map((call) => call.carry)).toEqual([1020, 1055, 1095]);
	});

	it("counts what a boundary re-paid as what a within-turn call re-pays, whichever field a route uses", () => {
		const calls = modelCalls(log);
		expect(calls.filter((call) => call.firstCallOfTurn).map((call) => call.repaid)).toEqual([100, 600]);
		// Inside a turn the new bytes are the tool result, so the re-paid figure is small; a route that names
		// those bytes `cacheWrite` rather than `input` still lands on the same number.
		expect(calls.filter((call) => !call.firstCallOfTurn).map((call) => call.repaid)).toEqual([5, 1095]);
	});

	it("summarises a conversation so the boundary is separable from the rest of it", () => {
		const summary = summarise(modelCalls(log));
		// Turn 1's first call is the start of the conversation, not a break — there is nothing to lose yet.
		expect(summary.boundaries).toBe(1);
		expect(summary.paid).toEqual([600]);
		expect(summary.carry).toEqual([1055]);
		expect(summary.withinTurn).toEqual([5, 1095]);
	});

	it("finds no boundary in a single-turn conversation", () => {
		expect(summarise(modelCalls(SESSION.slice(0, 6).map((entry) => JSON.stringify(entry)).join("\n"))).boundaries).toBe(0);
	});

	// The numbers the doc quotes are min / median / max, so an even-length set has to average the two middle
	// values — `sorted[Math.floor(n / 2)]` alone took the upper-middle element (code-review.md finding 3).
	it("medians an even-length set by averaging its two middle values", () => {
		expect(spread([])).toBe("none");
		expect(spread([7])).toBe("7 / 7 / 7");
		expect(spread([9, 1, 5])).toBe("1 / 5 / 9");
		// The even case: the old helper printed 6 here, the upper-middle element.
		expect(spread([10, 1, 4, 6])).toBe("1 / 5 / 10");
	});
});
