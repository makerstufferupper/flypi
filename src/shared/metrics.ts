/**
 * Live model speed metrics, read out of the same pi event stream the transcript mapper reads
 * (`src/shared/transcript.ts`).
 *
 * pi reports tokens, never tokens/second, so the only clock available is when the events arrived here.
 * That decides what each number honestly means:
 *
 * - **prefill** — the provider request up to the first content token, over the prompt tokens that
 *   request carried. pi emits `turn_start` once per provider request, which is the closest the stream
 *   gets to "request sent". The window also contains pi's request preparation and the network, so this
 *   is a ceiling on the model's prompt-eval rate, not the number a benchmark would print.
 * - **decode** — the response's output tokens over the time from its first token to its end.
 *
 * A question is usually answered by several responses with tool calls between them (pi runs the tools
 * after `message_end` and before the next `turn_start`), so the rates shown are the **average over the
 * answers that streamed**: their windows are summed, tokens over milliseconds. Nothing that happens
 * outside a response's own stream is in a window, so a long tool call, a compaction or an idle pause
 * cannot pull either rate down.
 *
 * `now` is injectable for the same reason the transcript reducer takes one: the numbers are testable
 * without a clock. A response with no measurable window (both events inside one ms, which a local model
 * does) reports `null`, not a huge number — an unknown rate is shown as unknown.
 *
 * A response that is still streaming is counted only from what the provider reported about it. Providers
 * differ in when they report: some carry usage in every chunk, so those numbers move as the answer streams;
 * a local server (LM Studio and vLLM do this) reports usage with the last chunk, so nothing of that answer
 * is known until it ends and the strip keeps showing the last thing it actually measured. Guessing what the
 * text so far is worth would make the rates drift while the app was waiting — which is what this replaced.
 *
 * A half-window joins an average only once it has a token count next to it: milliseconds with an empty
 * numerator (the request is timed, its prompt size is not reported yet) would slide the rate down on the way
 * to being measured.
 */
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { isAssistant, promptTokensOf, usageOf, type RenderedUsage } from "./transcript.ts";

type MessageStartEvent = Extract<AgentSessionEvent, { type: "message_start" }>;
type MessageUpdateEvent = Extract<AgentSessionEvent, { type: "message_update" }>;
type MessageEndEvent = Extract<AgentSessionEvent, { type: "message_end" }>;

/** What the sub-events of `message_update` look like, flattened to what a rate needs. */
type AssistantSubEvent = { type?: string; partial?: { usage?: Record<string, unknown> } };

/** The sub-events that mean "the model has produced something". */
const FIRST_TOKEN = new Set(["text_start", "text_delta", "thinking_start", "thinking_delta", "toolcall_start", "toolcall_delta"]);

/** A completed provider response, and how long each half of it took. */
export interface ResponsePerf {
	promptTokens: number;
	outputTokens: number;
	prefillMs: number;
	decodeMs: number;
}

/** The response currently streaming. `firstTokenAt` is null while the request is still being answered. */
export interface LivePerf {
	requestStart: number;
	firstTokenAt: number | null;
	promptTokens: number;
	outputTokens: number;
}

export interface Perf {
	live: LivePerf | null;
	/** The most recent completed response — kept so a reopened chat can still show its own numbers. */
	last: ResponsePerf | null;
	/** Every answer of the current question, summed. The rates on screen are this sum's rates. */
	run: ResponsePerf;
	/** When the last `turn_start` arrived; becomes the request start of the next response. */
	pendingStart?: number;
}

/** Rates for whatever the UI should be showing right now: the response streaming, or the last one. */
export interface Speeds {
	prefill: number | null;
	decode: number | null;
}

const NO_WINDOWS: ResponsePerf = { promptTokens: 0, outputTokens: 0, prefillMs: 0, decodeMs: 0 };

/**
 * Whether a set of windows measured anything at all: a turn that never got a response, or one from a
 * provider that reports no usage, leaves zeros — and so does a chat that has never measured one. Zeros are
 * not kept, are not averaged into the next answer's numbers, and must not be recorded as belonging to the
 * model on screen.
 */
export function hasMeasurement(windows: ResponsePerf | null): boolean {
	return windows !== null && (windows.promptTokens > 0 || windows.outputTokens > 0);
}

export function emptyPerf(): Perf {
	return { live: null, last: null, run: { ...NO_WINDOWS } };
}

/** Fold one pi event into the metrics. Returns a new object, never mutates — as the transcript reducer does. */
export function applyPerfEvent(state: Perf, event: AgentSessionEvent, now: () => number = Date.now): Perf {
	switch (event.type) {
		// A new question starts its average from nothing. `last` stays, so the strip keeps showing the
		// previous answer until this question has a window worth showing.
		case "agent_start":
			return { ...state, pendingStart: undefined, live: null, run: { ...NO_WINDOWS } };
		// The start of a provider request. Recorded rather than made live: a turn can emit tool-result
		// messages before it asks the model anything, and those are not a response being streamed.
		case "turn_start":
			return { ...state, pendingStart: now() };
		case "message_start": {
			if (!isAssistant((event as MessageStartEvent).message)) return state;			return {
				...state,
				pendingStart: undefined,
				live: { requestStart: state.pendingStart ?? now(), firstTokenAt: null, promptTokens: 0, outputTokens: 0 },
			};
		}
		case "message_update": {
			if (!state.live) return state;
			const sub = (event as MessageUpdateEvent).assistantMessageEvent as AssistantSubEvent | undefined;
			const usage = usageOf(sub?.partial?.usage);
			// Only the provider's own counts are kept: an answer whose usage has not arrived yet contributes
			// nothing, and the strip holds the last measured numbers (see the note above).
			return {
				...state,
				live: {
					...state.live,
					firstTokenAt: state.live.firstTokenAt ?? (FIRST_TOKEN.has(sub?.type ?? "") ? now() : null),
					promptTokens: usage ? promptTokensOf(usage) : state.live.promptTokens,
					outputTokens: usage && usage.output > 0 ? usage.output : state.live.outputTokens,
				},
			};
		}
		case "message_end": {
			const message = (event as MessageEndEvent).message;
			if (!isAssistant(message) || !state.live) return state;
			const usage = usageOf((message as { usage?: unknown }).usage);
			const first = state.live.firstTokenAt;
			const prompt = usage ? promptTokensOf(usage) : 0;
			const output = usage?.output ?? 0;
			const window: ResponsePerf = {
				promptTokens: prompt,
				outputTokens: output,
				prefillMs: first === null ? 0 : timed(prompt, first - state.live.requestStart),
				decodeMs: first === null ? 0 : timed(output, now() - first),
			};
			// A response that never produced a token (aborted, errored, or a provider that reports no usage at
			// all) has no windows and joins no average: recording it as zero tokens/second would be a lie. It
			// does not replace the last measured answer either — that is what a reopened chat restores.
			return {
				...state,
				pendingStart: undefined,
				live: null,
				last: hasMeasurement(window) ? window : state.last,
				run: first === null ? state.run : sumWindows(state.run, window),
			};
		}
		// A turn that ends without an assistant message_end (aborted mid-request, a dropped stream) must
		// not leave a live gauge counting against a response that stopped existing.
		case "agent_settled":
			// The question is over; its average stays on screen. Only the live gauge closes.
			return { ...state, pendingStart: undefined, live: null };
		default:
			return state;
	}
}

/**
 * What to show: the average over every answer this question streamed, counting the answer currently
 * streaming as far as its provider has reported about it. `at` is the UI's tick, so a live decode window
 * keeps growing between events. A question that has measured nothing yet falls back to the last answer it
 * measured, which is all a reopened chat has (ui/lib/last-answer.ts).
 */
export function speedsOf(perf: Perf, at: number): Speeds {
	const live = perf.live;
	// A live answer has no prefill window before its first token and no decode window to end yet, so its
	// unfinished prefill counts as nothing rather than as a slow prefill.
	const totals =
		live?.firstTokenAt == null
			? perf.run
			: sumWindows(perf.run, {
					promptTokens: live.promptTokens,
					outputTokens: live.outputTokens,
					prefillMs: timed(live.promptTokens, live.firstTokenAt - live.requestStart),
					decodeMs: timed(live.outputTokens, at - live.firstTokenAt),
				});
	if (totals.promptTokens === 0 && totals.outputTokens === 0) {
		const last = perf.last;
		if (!last) return { prefill: null, decode: null };
		return { prefill: rate(last.promptTokens, last.prefillMs), decode: rate(last.outputTokens, last.decodeMs) };
	}
	return { prefill: rate(totals.promptTokens, totals.prefillMs), decode: rate(totals.outputTokens, totals.decodeMs) };
}

function sumWindows(a: ResponsePerf, b: ResponsePerf): ResponsePerf {
	return {
		promptTokens: a.promptTokens + b.promptTokens,
		outputTokens: a.outputTokens + b.outputTokens,
		prefillMs: a.prefillMs + b.prefillMs,
		decodeMs: a.decodeMs + b.decodeMs,
	};
}

/** A window only counts when it has tokens to average; see the note above about empty numerators. */
function timed(tokens: number, ms: number): number {
	return tokens > 0 ? ms : 0;
}

/** tokens/second, or null when the window is too short to mean anything. */
export function rate(tokens: number, ms: number): number | null {
	return ms > 0 && tokens > 0 ? (tokens * 1000) / ms : null;
}

/** "1.2k" for a rate — whole numbers where they are big enough to be, one decimal where they are not. */
export function formatRate(value: number): string {
	return value >= 100 ? String(Math.round(value)) : value.toFixed(1);
}
