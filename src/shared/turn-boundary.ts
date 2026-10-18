/**
 * C1's measurement (docs/prompt-cache.md Phase 4.7): what a turn boundary costs in the conversations that
 * really happened.
 *
 * `npm run probe:turn` measures one synthetic conversation on a live route. This reads what the app already
 * recorded: pi's session log carries the provider's usage on every assistant message, and `turns.usage_json`
 * is the same accounting summed per turn (Phase 4.6 A1). The only place the prompt cache is allowed to break
 * is the first model call of a turn, so the calls are split there and counted — no model, no server, and no
 * new token counting anywhere.
 */
import { usageOf } from "./transcript.ts";

/**
 * One model call, as pi recorded it. The numbers are the provider's own (`usageOf`), never re-counted.
 */
export interface ModelCall {
	/** The first model call of a turn — the point where the prefix is allowed to break. Turn 1's first call
	 *  has no earlier turn to break away from, which is what `carry` separates it by. */
	firstCallOfTurn: boolean;
	model: string;
	/** What the request cost the route: served from cache plus read again. */
	prompt: number;
	/** Served from the provider's prefix cache. */
	reused: number;
	/** Read again. `input + cacheWrite`: routes differ about which field they report (A0 — llama_a leaves
	 *  `cacheWrite` at 0, llama_d left `input` at 0), and the sum is the same number either way. */
	repaid: number;
	/** prompt + completion of the previous model call: the region this request would have carried unchanged
	 *  had nothing transient been dropped from it. 0 for the first call in the file, so a call with `carry`
	 *  above 0 is a turn boundary with something to lose. */
	carry: number;
}

/**
 * pi's session log (append-only JSONL, one entry per line) as its model calls. Entries that are not
 * messages, and assistant messages a provider gave no numbers for, carry no numbers and are left out.
 */
export function modelCalls(jsonl: string): ModelCall[] {
	const calls: ModelCall[] = [];
	let previousRole = "";
	let carry = 0;
	for (const line of jsonl.split("\n")) {
		if (!line.trim()) continue;
		const entry = JSON.parse(line) as { type?: string; message?: { role?: string; model?: string; usage?: unknown } };
		const message = entry.type === "message" ? entry.message : undefined;
		if (!message?.role) continue;
		if (message.role === "assistant") {
			const usage = usageOf(message.usage);
			if (usage) {
				// A turn's later calls follow a tool result; only a user message starts one.
				calls.push({
					firstCallOfTurn: previousRole === "user",
					model: message.model ?? "unknown",
					prompt: usage.input + usage.cacheRead + usage.cacheWrite,
					reused: usage.cacheRead,
					repaid: usage.input + usage.cacheWrite,
					carry,
				});
				carry = usage.totalTokens;
			}
		}
		previousRole = message.role;
	}
	return calls;
}

/** What one conversation's boundaries cost, as the doc quotes it: the break's tokens are what was read
 *  again where the previous turn's context was there to be reused. */
export interface BoundarySummary {
	boundaries: number;
	/** The boundary calls after the first turn — the ones that had a prefix to lose. */
	paid: number[];
	/** What the route could have served from cache at those boundaries instead. */
	carry: number[];
	/** The same turns' later calls, for contrast: inside a turn the only new bytes are the tool result. */
	withinTurn: number[];
}

export function summarise(calls: ModelCall[]): BoundarySummary {
	const boundaries = calls.filter((call) => call.firstCallOfTurn && call.carry > 0);
	return {
		boundaries: boundaries.length,
		paid: boundaries.map((call) => call.repaid),
		carry: boundaries.map((call) => call.carry),
		withinTurn: calls.filter((call) => !call.firstCallOfTurn).map((call) => call.repaid),
	};
}

/** min / median / max, which is the only honest way to state a number a route varies run to run by.
 *  An even count averages the two middle values: `sorted[Math.floor(n / 2)]` on its own takes the
 *  upper-middle element, which shifts every even-length set the probe prints (code-review.md finding 3). */
export function spread(values: number[]): string {
	if (values.length === 0) return "none";
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const median = sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
	return `${sorted[0]!} / ${median} / ${sorted[sorted.length - 1]!}`;
}
