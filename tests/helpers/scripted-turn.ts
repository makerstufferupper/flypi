/**
 * The second adapter for the turn seam (docs/deepening.md 11.3 T31).
 *
 * `src/agent/turn.ts` takes a `TurnSession` — `prompt`, `abort`, `subscribe`, `isIdle`, `dispose`. With only the
 * real pi session as its adapter, that seam is a hypothesis; this file is the other one: a session that *is* a
 * recording. It constructs no pi session, model or provider, makes no network call and spawns no pi process —
 * pi's modules are in the process (the script comes through `stub-model.ts`, which value-imports them) and none
 * of them is built. The events are the ones `npm run record` captured from one real turn
 * (tests/fixtures/transcript-log), replayed as they were sent.
 *
 * Where pi has a behaviour the double could skip, the double has it: `prompt` answers the disposition pi answers
 * (`started`, or `queued` for input that joins a running turn) and rejects the second mode-less prompt pi
 * rejects. The point of a second adapter is to be as demanding as the first.
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
	/** The text of each `prompt()` call it was handed, in order — including a second one it refused. */
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
		// pi clears `_isAgentRunActive` *before* it emits `agent_settled` (`agent-session.js:684-690`), so a listener
		// that asks `isIdle` while the settle is being delivered already gets true. Matched rather than approximated:
		// a double still reporting busy would let code that polls `isIdle` from a settle listener pass here, on the
		// one run-status write the crash record depends on, and fail against pi.
		if (event.type === "agent_settled") replaying = false;
		// A copy of the set, which makes this double *stricter* than pi: pi's `_emit` (`agent-session.js:649`) walks
		// the live listener list, so a listener that unsubscribes one behind it makes that one miss the event.
		// The seam's subscription is dropped by `dispose()` mid-life, so it should not depend on that happening.
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
		prompt: async (text, options) => {
			prompts.push(text);
			if (replaying) {
				// pi's dispositions while it is already streaming: no mode is a refusal — `Agent is already
				// processing…` (`agent-session.js:1667`), and `src/server/index.ts` turns that rejection into the
				// socket's error frame — and a mode queues into the running turn and answers `queued` (`:1675`),
				// resolving once queued rather than once answered. Either way the replay keeps its cursor: restarting
				// it here would reassign `finish` and leave the *first* caller's promise unresolved, so a steer test
				// written against this double would time out instead of failing.
				if (!options?.streamingBehavior) throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
				options.preflightResult?.("queued");
				return;
			}
			// pi marks the run active first (`_startRun` sets `_isAgentRunActive = true` at :1424) and answers the
			// disposition once the run's messages are prepared (`:1441` `onStarted`), before its first request and
			// before any event. That is the only moment early enough for the crash record (docs/architecture.md 4.5),
			// so the adapter answers it at the same moment — with the replay already flagged as running, because
			// `isIdle` is already false at that point on pi and a double that said idle would hide a read of it there.
			replaying = true;
			stopped = false;
			options?.preflightResult?.("started");
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
