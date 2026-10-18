/**
 * `FLYPI_CACHE_PROBE=1` — the message hash A3 deferred and C1 needs (docs/prompt-cache.md). A prefix cache
 * keys on request bytes, so a cache miss has exactly two possible causes: the bytes changed, or the route
 * dropped what it already had. That is the difference between "flypi has something to fix" and "this route
 * is not worth optimising for", and no amount of prefix reasoning settles it — two runs of the same probe,
 * diffed, do. So this prints one hash per request and one per message inside it, in wire order.
 *
 * It hashes what the provider was actually given (pi's `agent.onPayload` seam), not pi's internal context:
 * the adapter drops the fields a prefix cache never sees (timestamps, usage) and adds the ones it does.
 */
import { createHash } from "node:crypto";

/** The flag. Only `1` counts, so a stray `FLYPI_CACHE_PROBE=` in a shell cannot turn it on. */
export const cacheProbeEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.FLYPI_CACHE_PROBE === "1";

/** sha256, first 12 hex: identical for identical bytes across runs, short enough to read side by side. */
export function hashOf(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex").slice(0, 12);
}

/**
 * The lines for one provider request. `payload` is the whole thing — its hash answers the run-to-run
 * question on one line. Then the messages array in wire order, which is the region a prefix runs over: the
 * first index whose hash differs from the other run's is where the reusable prefix ended. Then a hash for
 * every other top-level key (`tools`, `model`, sampling), so a change outside the messages is named rather
 * than only implied. `chars` is the JSON length — the size C1 prices the break in.
 */
export function cacheProbeLines(payload: unknown): string[] {
	const body = JSON.stringify(payload) ?? "undefined";
	const lines = [`payload sha=${hashOf(payload)} chars=${body.length}`];
	const messages = (payload as { messages?: unknown } | undefined | null)?.messages;
	if (Array.isArray(messages)) {
		for (const [index, message] of messages.entries()) {
			const role = (message as { role?: unknown } | undefined | null)?.role ?? "?";
			const json = JSON.stringify(message) ?? "undefined";
			lines.push(`message ${index} role=${role} sha=${hashOf(message)} chars=${json.length}`);
		}
	}
	if (payload && typeof payload === "object" && !Array.isArray(payload)) {
		for (const [key, value] of Object.entries(payload)) {
			// `undefined` fields are what JSON.stringify does with them: absent. Printing a hash for them would
			// be two lines that look identical and mean nothing.
			if (key !== "messages" && value !== undefined) lines.push(`${key} sha=${hashOf(value)}`);
		}
	}
	return lines;
}
