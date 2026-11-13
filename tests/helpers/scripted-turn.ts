/**
 * The second adapter for the turn seam (docs/deepening.md 11.3 T31).
 *
 * `src/agent/turn.ts` takes a `TurnSession` — `prompt`, `abort`, `subscribe`, `isIdle`, `dispose`. With only the
 * real pi session as its adapter, that seam is a hypothesis; this file is the other one: a session that *is* a
 * recording. No pi runtime, no model, no provider and no process — the events are the ones `npm run record`
 * captured from one real turn (tests/fixtures/transcript-log), replayed as they were sent.
 *
 * The turn replayed is `tests/helpers/recorded-turn.ts`'s: the same script the fixture was recorded from and the
 * same one `scripts/record-transcript.ts` drives, so the fixture and the script cannot drift.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { TurnSession } from "../../src/agent/turn.ts";
import { FIX_THE_FAILING_TEST, fixTheFailingTest } from "./recorded-turn.ts";

/** The prompt of the recorded turn — the sentence the real turn was driven with. */
export const SCRIPTED_PROMPT = FIX_THE_FAILING_TEST;

const EVENTS = join(import.meta.dirname, "..", "fixtures", "transcript-log", "events.json");

const role = (event: AgentSessionEvent): string | undefined => (event as { message?: { role?: string } }).message?.role;

/**
 * A fresh copy of the recorded turn: fresh because the frames are mutable (pi's are, and the driver copies them
 * for that reason), and one test growing its copy must not rewrite what the next one replays.
 *
 * The fixture is checked against the script that produced it. A recording of some other turn would replay just
 * as cleanly and prove something else, so a mismatch fails here, with the command that fixes it.
 */
export function recordedEvents(): AgentSessionEvent[] {
	const events = JSON.parse(readFileSync(EVENTS, "utf8")) as AgentSessionEvent[];
	const asked = events.find((event) => event.type === "message_start" && role(event) === "user") as
		| { message?: { content?: { text?: string }[] } }
		| undefined;
	const answers = events.filter((event) => event.type === "message_end" && role(event) === "assistant").length;
	const steps = fixTheFailingTest().length;
	if (asked?.message?.content?.[0]?.text !== FIX_THE_FAILING_TEST || answers !== steps) {
		throw new Error(
			`tests/fixtures/transcript-log is not the turn tests/helpers/recorded-turn.ts scripts ` +
				`(asked ${JSON.stringify(asked?.message?.content?.[0]?.text)}, ${answers} answers, ${steps} expected) — regenerate it with \`npm run record\``,
		);
	}
	return events;
}

export interface ScriptedTurn {
	/** The session a turn driver drives. */
	readonly session: TurnSession;
	/** Every event it emitted, in the order it emitted them: what the log is expected to hold. */
	readonly replayed: AgentSessionEvent[];
	/** The text of each `prompt()` it was handed, in order. */
	readonly prompts: string[];
	/** How many times `dispose()` ran. The driver's latch makes this 1 after two calls, not 2. */
	disposeCalls: number;
}

/**
 * Replay a recorded turn as a pi session would stream it.
 *
 * One event per macrotask, so a client can drop mid-turn and `abort()` can overtake the replay instead of
 * arriving after it; when it does, the session ends the way pi ends a stopped run — `agent_end`, then
 * `agent_settled` with `aborted`.
 *
 * Events are handed to the listeners by reference, as pi hands them: a script whose frames share one message
 * object replays the way pi streams — one mutable object, grown between frames, carried by every frame of the
 * turn. Growing it between frames is what `tests/agent/turn.test.ts` does, from a second subscriber.
 */
export function scriptedSession(events: AgentSessionEvent[] = recordedEvents()): ScriptedTurn {
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const replayed: AgentSessionEvent[] = [];
	const prompts: string[] = [];
	let cursor = 0;
	let replaying = false;
	let stopped = false;
	let finish = () => {};
	let running: Promise<void> = Promise.resolve();

	const emit = (event: AgentSessionEvent): void => {
		replayed.push(event);
		// A copy of the set, as pi's emitter does: a listener that unsubscribes itself must not skip its neighbour.
		for (const listener of [...listeners]) listener(event);
	};

	const replay = async (): Promise<void> => {
		while (!stopped && cursor < events.length) {
			await new Promise((resolve) => setImmediate(resolve));
			if (stopped) break;
			emit(events[cursor++]!);
		}
		if (stopped) {
			emit({ type: "agent_end", messages: [], willRetry: false });
			emit({ type: "agent_settled", aborted: true });
		}
		replaying = false;
		stopped = false;
		finish();
	};

	const session: TurnSession = {
		prompt: (text, options) => {
			prompts.push(text);
			// pi answers the disposition once the run's messages are prepared — before its first request and before
			// any event. That is the only moment early enough for the crash record (docs/architecture.md 4.5), so
			// the adapter has to answer it at the same moment or the seam would be tested against a laxer pi.
			options?.preflightResult?.("started");
			replaying = true;
			stopped = false;
			running = new Promise<void>((resolve) => {
				finish = resolve;
			});
			void replay();
			return running;
		},
		abort: async () => {
			if (!replaying) return;
			stopped = true;
			await running;
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		get isIdle() {
			// pi's `isIdle` means "nothing at all is running" — compaction and retries included. This session does
			// none of those, so "not replaying" is the whole of what it can honestly say.
			return !replaying;
		},
		dispose: () => {
			// Counted, not latched: the latch belongs to the driver, and seeing one call here after two `dispose()`s
			// on the driver is the point.
			turn.disposeCalls += 1;
			listeners.clear();
		},
	};
	const turn: ScriptedTurn = { session, replayed, prompts, disposeCalls: 0 };
	return turn;
}
