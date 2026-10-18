/**
 * The live speed metrics (docs/testing.md: a 100%-coverage choke point, like the transcript mapper —
 * a wrong number here is the UI lying about what the model did).
 *
 * The clock is scripted, because the whole module is event arrival times: `now` is injected per call,
 * exactly as the transcript reducer does it for tool durations.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { applyPerfEvent, emptyPerf, formatRate, rate, speedsOf, type Perf } from "../../src/shared/metrics.ts";

const FIXTURE = join(import.meta.dirname, "..", "fixtures", "transcript-log");
const events = JSON.parse(readFileSync(join(FIXTURE, "events.json"), "utf8")) as AgentSessionEvent[];

/** Usage as pi reports it: a prompt is uncached input + cache reads + cache writes. */
const usage = { input: 1000, cacheRead: 500, cacheWrite: 0, output: 200, totalTokens: 1700, cost: { total: 0 } };

const assistant = (over: Record<string, unknown> = {}) => ({ role: "assistant", content: [], usage, ...over });
const at = (ms: number) => () => ms;

/** One clean request: sent at 0, stream opens at 100, first token at 1000, done at 3000. */
function oneTurn(state: Perf, firstToken = 1000): Perf {
	let next = applyPerfEvent(state, { type: "turn_start" } as AgentSessionEvent, at(0));
	next = applyPerfEvent(next, { type: "message_start", message: assistant() } as unknown as AgentSessionEvent, at(100));
	next = applyPerfEvent(next, {
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", partial: { usage: { ...usage, output: 20 } } },
	} as unknown as AgentSessionEvent, at(firstToken));
	return applyPerfEvent(next, { type: "message_end", message: assistant() } as unknown as AgentSessionEvent, at(3000));
}

describe("prefill and decode", () => {
	it("measures prefill from the request start to the first token, and decode from there to the end", () => {
		const perf = oneTurn(emptyPerf());
		expect(perf.live).toBeNull();
		expect(perf.last).toEqual({ promptTokens: 1500, outputTokens: 200, prefillMs: 1000, decodeMs: 2000 });
		expect(speedsOf(perf, 9999)).toEqual({
			prefill: 1500, // 1500 prompt tokens in 1000ms
			decode: 100, // 200 output tokens in 2000ms
		});
	});

	it("starts a response at `turn_start` if one arrived, otherwise at its own `message_start`", () => {
		const unmarked = applyPerfEvent(
			emptyPerf(),
			{ type: "message_start", message: assistant() } as unknown as AgentSessionEvent,
			at(100),
		);
		expect(unmarked.live).toEqual({ requestStart: 100, firstTokenAt: null, promptTokens: 0, outputTokens: 0 });
	});

	it("ignores a `turn_start` that asks the model nothing, and messages that are not the model's", () => {
		const state = applyPerfEvent(emptyPerf(), { type: "turn_start" } as AgentSessionEvent, at(0));
		expect(state.live).toBeNull();
		expect(speedsOf(state, 5000)).toEqual({ prefill: null, decode: null });

		const toolResult = applyPerfEvent(state, { type: "message_end", message: { role: "toolResult" } } as unknown as AgentSessionEvent, at(10));
		const user = applyPerfEvent(state, { type: "message_start", message: { role: "user" } } as unknown as AgentSessionEvent, at(10));
		expect(toolResult.live).toBeNull();
		expect(user.live).toBeNull();
	});

	it("counts a prompt as input + cache reads + cache writes", () => {
		const small = { input: 10, cacheRead: 20, cacheWrite: 30, output: 4 };
		let perf = applyPerfEvent(emptyPerf(), { type: "turn_start" } as AgentSessionEvent, at(0));
		perf = applyPerfEvent(perf, { type: "message_start", message: { role: "assistant", content: [], usage: small } } as unknown as AgentSessionEvent, at(0));
		perf = applyPerfEvent(perf, {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", partial: { usage: small } },
		} as unknown as AgentSessionEvent, at(1000));
		perf = applyPerfEvent(perf, { type: "message_end", message: { role: "assistant", content: [], usage: small } } as unknown as AgentSessionEvent, at(2000));
		expect(speedsOf(perf, 2000)).toEqual({ prefill: 60, decode: 4 });
	});

	it("holds the last measured numbers when the provider reports usage only at the end", () => {
		// What LM Studio and vLLM do: every chunk says zero tokens and the real counts arrive with the last
		// one. Nothing of this answer is counted until it reports itself, so nothing is claimed about it —
		// the strip holds the last numbers it measured, and shows nothing at all when it has measured none.
		const none = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, totalTokens: 0, cost: { total: 0 } };
		const answering = (u: unknown) => ({ role: "assistant", content: [], usage: u });
		let perf = applyPerfEvent(emptyPerf(), { type: "turn_start" } as AgentSessionEvent, at(0));
		perf = applyPerfEvent(perf, { type: "message_start", message: answering(none) } as unknown as AgentSessionEvent, at(100));
		for (const [ms, delta] of [
			[1000, "Once upon"],
			[1500, " a time, "],
			[2000, "the end."],
		] as const) {
			perf = applyPerfEvent(
				perf,
				{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta, partial: { usage: none } } } as unknown as AgentSessionEvent,
				at(ms),
			);
		}
		// A second of streaming text, and no rate to show for it: an answer counted from characters is a guess
		// about what the provider is doing, not a measurement of it.
		expect(speedsOf(perf, 2000)).toEqual({ prefill: null, decode: null });

		// The measured usage lands with the answer, and its windows are the first thing on screen.
		perf = applyPerfEvent(perf, { type: "message_end", message: answering(usage) } as unknown as AgentSessionEvent, at(3000));
		expect(perf.last).toEqual({ promptTokens: 1500, outputTokens: 200, prefillMs: 1000, decodeMs: 2000 });
		expect(speedsOf(perf, 3000)).toEqual({ prefill: 1500, decode: 100 });
	});
});

describe("a question answered by several responses", () => {
	/** One answer on the scripted clock: sent, first token, done. */
	function answer(state: Perf, sent: number, first: number, end: number, prompt: number, output: number): Perf {
		const tokens = { input: prompt, cacheRead: 0, cacheWrite: 0, output, totalTokens: prompt + output, cost: { total: 0 } };
		const message = { role: "assistant", content: [], usage: tokens };
		let next = applyPerfEvent(state, { type: "turn_start" } as AgentSessionEvent, at(sent));
		next = applyPerfEvent(next, { type: "message_start", message } as unknown as AgentSessionEvent, at(sent + 1));
		next = applyPerfEvent(next, {
			type: "message_update",
			assistantMessageEvent: { type: "text_start", partial: { usage: tokens } },
		} as unknown as AgentSessionEvent, at(first));
		return applyPerfEvent(next, { type: "message_end", message } as unknown as AgentSessionEvent, at(end));
	}

	/** The frames between two answers: pi runs the tools after `message_end` and before the next turn. */
	function toolCall(state: Perf, from: number, to: number): Perf {
		let next = applyPerfEvent(state, { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} } as unknown as AgentSessionEvent, at(from));
		next = applyPerfEvent(next, { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: {}, isError: false } as unknown as AgentSessionEvent, at(to));
		return applyPerfEvent(next, { type: "turn_end", message: assistant(), toolResults: [] } as unknown as AgentSessionEvent, at(to));
	}

	it("averages the answers that streamed and keeps the wait between them out of both windows", () => {
		// 1000 prompt tokens in 1000ms, 200 output in 2000ms; then a 5000ms tool call; then 1000 prompt
		// tokens in 500ms and 100 output in 500ms.
		let perf = answer(emptyPerf(), 0, 1000, 3000, 1000, 200);
		perf = toolCall(perf, 3000, 8000);
		perf = answer(perf, 8000, 8500, 9000, 1000, 100);
		expect(speedsOf(perf, 9000)).toEqual({
			prefill: 2000 / 1.5, // 2000 prompt tokens over 1500ms of prefill, not over 6500ms
			decode: 120, // 300 output tokens over 2500ms of stream, not over 7500ms
		});
	});

	it("counts the answer still streaming, as far as it has got", () => {
		let perf = answer(emptyPerf(), 0, 1000, 3000, 1000, 200);
		perf = toolCall(perf, 3000, 8000);
		perf = applyPerfEvent(perf, { type: "turn_start" } as AgentSessionEvent, at(8000));
		perf = applyPerfEvent(perf, { type: "message_start", message: assistant() } as unknown as AgentSessionEvent, at(8001));
		// Still in prefill: the first answer's numbers stand, and this request's open window is not counted.
		expect(speedsOf(perf, 20000)).toEqual({ prefill: 1000, decode: 100 });
		const tokens = { input: 1000, cacheRead: 0, cacheWrite: 0, output: 100, totalTokens: 1100, cost: { total: 0 } };
		perf = applyPerfEvent(perf, {
			type: "message_update",
			assistantMessageEvent: { type: "text_start", partial: { usage: tokens } },
		} as unknown as AgentSessionEvent, at(8500));
		expect(speedsOf(perf, 9000)).toEqual({ prefill: 2000 / 1.5, decode: 120 });
	});

	it("keeps an answer with no token counts yet out of the averages it would only drag down", () => {
		// What LM Studio and vLLM do: every chunk reports zero tokens and the real counts arrive with the
		// last one. This answer's prefill window is real but has no prompt count to put over it, so summing
		// the milliseconds alone slid both numbers down through a tool round, then handed the old value back
		// when the usage landed. Only the measured window is allowed to join the average.
		const none = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, totalTokens: 0, cost: { total: 0 } };
		let perf = answer(emptyPerf(), 0, 1000, 3000, 1000, 200);
		perf = toolCall(perf, 3000, 8000);
		perf = applyPerfEvent(perf, { type: "turn_start" } as AgentSessionEvent, at(8000));
		perf = applyPerfEvent(
			perf,
			{ type: "message_start", message: { role: "assistant", content: [], usage: none } } as unknown as AgentSessionEvent,
			at(8001),
		);
		perf = applyPerfEvent(
			perf,
			{
				type: "message_update",
				assistantMessageEvent: { type: "toolcall_delta", delta: "writing the tool call", partial: { usage: none } },
			} as unknown as AgentSessionEvent,
			at(9000),
		);
		// Nothing of this answer has been counted yet, so both numbers are still the ones the first answer
		// measured — they do not slide down on the way to being measured.
		expect(speedsOf(perf, 12000)).toEqual({ prefill: 1000, decode: 100 });

		// The answer ends with its real counts, and now both halves of its window are measured: 1000 prompt
		// tokens in 1000ms and 100 output tokens in 4000ms, averaged with the first answer's.
		perf = applyPerfEvent(
			perf,
			{
				type: "message_end",
				message: { role: "assistant", stopReason: "toolUse", usage: { input: 1000, cacheRead: 0, cacheWrite: 0, output: 100 } },
			} as unknown as AgentSessionEvent,
			at(13000),
		);
		expect(speedsOf(perf, 13000)).toEqual({ prefill: 1000, decode: 50 });
	});

	it("starts a new question's average from nothing", () => {
		let perf = answer(emptyPerf(), 0, 1000, 3000, 1000, 200);
		expect(speedsOf(perf, 3000)).toEqual({ prefill: 1000, decode: 100 });
		// The next prompt: `agent_start` opens the run, and the numbers on screen are the previous answer's
		// until this question has streamed something of its own.
		perf = applyPerfEvent(perf, { type: "agent_start" } as AgentSessionEvent, at(4000));
		expect(speedsOf(perf, 4000)).toEqual({ prefill: 1000, decode: 100 });
		perf = answer(perf, 4000, 4000, 5000, 500, 200);
		expect(speedsOf(perf, 5000)).toEqual({ prefill: null, decode: 200 });
	});
});

describe("the response currently streaming", () => {
	it("takes its token counts from the partial message so the numbers move while it streams", () => {
		let perf = applyPerfEvent(emptyPerf(), { type: "turn_start" } as AgentSessionEvent, at(0));
		perf = applyPerfEvent(perf, { type: "message_start", message: assistant() } as unknown as AgentSessionEvent, at(100));
		expect(speedsOf(perf, 900)).toEqual({ prefill: null, decode: null });

		perf = applyPerfEvent(perf, {
			type: "message_update",
			assistantMessageEvent: { type: "text_start", partial: { usage } },
		} as unknown as AgentSessionEvent, at(1000));
		expect(speedsOf(perf, 2000)).toEqual({ prefill: 1500, decode: 200 });
	});

	it("ignores sub-events that are not tokens, and a partial that carries no usage", () => {
		let perf = applyPerfEvent(emptyPerf(), { type: "message_start", message: assistant() } as unknown as AgentSessionEvent, at(0));
		perf = applyPerfEvent(perf, { type: "message_update", assistantMessageEvent: { type: "stream_start" } } as unknown as AgentSessionEvent, at(500));
		expect(perf.live?.firstTokenAt).toBeNull();
		perf = applyPerfEvent(perf, {
			type: "message_update",
			assistantMessageEvent: { type: "toolcall_delta", partial: { usage: { input: 40 } } },
		} as unknown as AgentSessionEvent, at(600));
		expect(perf.live).toEqual({ requestStart: 0, firstTokenAt: 600, promptTokens: 40, outputTokens: 0 });
	});

	it("ignores a frame that carries no assistant sub-event at all", () => {
		let perf = applyPerfEvent(emptyPerf(), { type: "message_start", message: assistant() } as unknown as AgentSessionEvent, at(0));
		perf = applyPerfEvent(perf, { type: "message_update" } as unknown as AgentSessionEvent, at(500));
		expect(perf.live).toEqual({ requestStart: 0, firstTokenAt: null, promptTokens: 0, outputTokens: 0 });
		// …and a final message from a provider that reported no usage: recorded, but with no rate.
		const done = applyPerfEvent(perf, { type: "message_end", message: { role: "assistant", content: [] } } as unknown as AgentSessionEvent, at(900));
		expect(speedsOf(done, 900)).toEqual({ prefill: null, decode: null });
	});

	it("reports an aborted response as no rate at all, not as zero", () => {
		let perf = applyPerfEvent(emptyPerf(), { type: "message_start", message: { role: "assistant", content: [], usage: { input: 10 } } } as unknown as AgentSessionEvent, at(0));
		perf = applyPerfEvent(perf, { type: "message_end", message: { role: "assistant", content: [], usage: { input: 10 } } } as unknown as AgentSessionEvent, at(900));
		expect(speedsOf(perf, 900)).toEqual({ prefill: null, decode: null });
	});

	it("does not let an answer that reports no usage erase what was already measured", () => {
		// A provider that sends no usage at all (this repo's LM Studio entry has supportsUsageInStreaming off,
		// and every chunk of a real run through it reported zeros), or an answer that errored before any token:
		// it measures nothing, so it joins no average and does not replace the answer that was measured — which
		// is what a reopened chat restores.
		const none = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, totalTokens: 0, cost: { total: 0 } };
		const silent = () => ({ role: "assistant", content: [], usage: none });
		let perf = oneTurn(emptyPerf());
		perf = applyPerfEvent(perf, { type: "agent_start" } as AgentSessionEvent, at(5000));
		perf = applyPerfEvent(perf, { type: "turn_start" } as AgentSessionEvent, at(5000));
		perf = applyPerfEvent(perf, { type: "message_start", message: silent() } as unknown as AgentSessionEvent, at(5100));
		perf = applyPerfEvent(perf, {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "text", partial: { usage: none } },
		} as unknown as AgentSessionEvent, at(6000));
		perf = applyPerfEvent(perf, { type: "message_end", message: silent() } as unknown as AgentSessionEvent, at(7000));

		expect(perf.run).toEqual({ promptTokens: 0, outputTokens: 0, prefillMs: 0, decodeMs: 0 });
		expect(perf.last).toEqual({ promptTokens: 1500, outputTokens: 200, prefillMs: 1000, decodeMs: 2000 });
		// This question measured nothing, so the last answer that was measured is what stands — not a blank.
		expect(speedsOf(perf, 7000)).toEqual({ prefill: 1500, decode: 100 });
	});

	it("drops the live gauge when the turn settles without an answer", () => {
		const perf = applyPerfEvent(
			applyPerfEvent(emptyPerf(), { type: "message_start", message: assistant() } as unknown as AgentSessionEvent, at(0)),
			{ type: "agent_settled" } as AgentSessionEvent,
			at(500),
		);
		expect(perf).toEqual(emptyPerf());
	});

	it("leaves a frame with no view here alone", () => {
		expect(applyPerfEvent(emptyPerf(), { type: "queue_update", steering: ["x"], followUp: [] } as AgentSessionEvent, at(0))).toEqual(emptyPerf());
	});
});

describe("rates", () => {
	it("is unknown when the window is empty or there is nothing to count", () => {
		expect(rate(1000, 0)).toBeNull();
		expect(rate(1000, -5)).toBeNull();
		expect(rate(0, 1000)).toBeNull();
		expect(rate(1500, 1000)).toBe(1500);
	});

	it("has nothing to show before any response", () => {
		expect(speedsOf(emptyPerf(), 1000)).toEqual({ prefill: null, decode: null });
	});

	it("prints whole numbers once the rate is big enough for them", () => {
		expect(formatRate(87.65)).toBe("87.7");
		expect(formatRate(1234.5)).toBe("1235");
	});
});

describe("the recorded multi-tool turn", () => {
	it("produces rates for every answer, and none for the frames that are not answers", () => {
		let clock = 0;
		let perf = emptyPerf();
		for (const event of events) perf = applyPerfEvent(perf, event, () => (clock += 7));
		expect(perf.live).toBeNull();
		const speeds = speedsOf(perf, clock);
		expect(speeds.prefill).not.toBeNull();
		expect(speeds.decode).not.toBeNull();
	});
});
