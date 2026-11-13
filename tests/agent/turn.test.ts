/**
 * The turn seam driven without pi (docs/deepening.md 11.3 T31): a real `createTurnDriver`, a real `EventLog`, and
 * a session that is only a recording (`tests/helpers/scripted-turn.ts`).
 *
 * What this proves, the fixture's 77 events of one real turn carry — the recorded turn is the same one
 * `tests/server/server.test.ts` streams over a socket and `tests/secrets/session.test.ts` redacts through a real
 * session. The difference is what the seam is *for*: those need pi, a model and a server, so the properties below
 * were only ever provable expensively. Here they are milliseconds, and they are provable at all because the seam
 * takes a session rather than building one — the file imports no `createFlypiSession`, no `ModelRuntime` and no
 * stub model, and nothing here can spawn a pi process.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { flypiPaths } from "../../src/agent/paths.ts";
import { createTurnDriver, turnInput, type TurnDriver, type TurnHost } from "../../src/agent/turn.ts";
import { openMemoryDb } from "../../src/memory/db.ts";
import { openSecretVault } from "../../src/secrets/vault.ts";
import { EventLog } from "../../src/server/event-log.ts";
import type { FlypiAttachment } from "../../src/shared/attachments.ts";
import { createTempFlypiRoot } from "../helpers/flypi-root.ts";
import { recordedEvents, scriptedSession, SCRIPTED_PROMPT, type ScriptedTurn } from "../helpers/scripted-turn.ts";

/** What the host of a `TurnHost` hears, counted. The counters are the assertions. */
type ScriptedHost = TurnHost & {
	log: EventLog<AgentSessionEvent>;
	/** What `onEvent` saw, in the order it saw it: what the registry would fan out to the sockets. */
	seen: { seq: number; event: AgentSessionEvent; at: number }[];
	/** The run statuses, in the order the driver said them. */
	runs: string[];
	/** `log.lastSeq` as it stood at each of those calls — the ordering the run row is written against. */
	seqAtRun: number[];
	turnStarts: number;
	/** `session.prompts.length` when `onTurnStart` fired: 0 means the prompt had not been handed over yet. */
	promptsAtTurnStart: number;
	disposes: number;
};

function scriptedHost(turn: ScriptedTurn): ScriptedHost {
	const log = new EventLog<AgentSessionEvent>();
	const host: ScriptedHost = {
		session: turn.session,
		log,
		seen: [],
		runs: [],
		seqAtRun: [],
		turnStarts: 0,
		promptsAtTurnStart: -1,
		disposes: 0,
		onEvent: (seq, event, at) => host.seen.push({ seq, event, at }),
		onRun: (status) => {
			host.runs.push(status);
			host.seqAtRun.push(log.lastSeq);
		},
		onTurnStart: () => {
			host.turnStarts += 1;
			host.promptsAtTurnStart = turn.prompts.length;
		},
		onDispose: () => {
			host.disposes += 1;
		},
	};
	return host;
}

/** The whole seam, assembled: a driver over a scripted session and a real event log, with nothing pi in it. */
function scriptedTurn(events?: AgentSessionEvent[]): { turn: ScriptedTurn; host: ScriptedHost; driver: TurnDriver } {
	const turn = scriptedSession(events);
	const host = scriptedHost(turn);
	return { turn, host, driver: createTurnDriver(host) };
}

/**
 * A wait with a deadline, never a sleep. The replay advances one macrotask at a time and so does this, so it
 * catches the turn a few frames in rather than after it.
 */
async function until(what: string, ready: () => boolean): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!ready()) {
		if (Date.now() > deadline) throw new Error(`the scripted turn never got to ${what}`);
		await new Promise((resolve) => setImmediate(resolve));
	}
}

const textOf = (event: unknown): string =>
	String(((event as { message?: { content?: { text?: string }[] } }).message?.content ?? [])[0]?.text);

/** A streamed frame the way pi's agent loop builds one: `message` is a *shallow* copy of the one mutable partial,
 *  so its `content` array is still the array pi keeps growing between frames. */
const streamed = (message: { content: unknown[] }, assistantMessageEvent: object): AgentSessionEvent =>
	({ type: "message_update", message: { ...message }, assistantMessageEvent }) as unknown as AgentSessionEvent;

const TOKEN = "ghp_AAAAAAAAAAAAAAAAAA11111111";
const MARK = "[secret:github_token]";

describe("the turn seam, driven without pi", () => {
	it("recorded: every event of the turn lands in the log, and the host sees each one exactly once", async () => {
		const recorded = recordedEvents();
		const { turn, host, driver } = scriptedTurn();

		await driver.start({ body: SCRIPTED_PROMPT });

		expect(recorded).toHaveLength(77);
		expect(turn.replayed).toEqual(recorded);
		// The log holds the turn, in order, with nothing added and nothing dropped.
		expect(host.log.replayAfter(0).events.map((entry) => entry.event)).toEqual(recorded);
		// And the fan-out saw exactly what the log was given, once each: one subscription, one push, one listener
		// call per event — two of any of those is what makes a reconnecting client see a turn twice.
		expect(host.seen.map((entry) => entry.seq)).toEqual(host.log.replayAfter(0).events.map((entry) => entry.seq));
		expect(host.seen).toHaveLength(recorded.length);
		expect(driver.idle).toBe(true);
	});

	it("sequenced: the log numbers the turn 1..77, and resuming at 40 replays exactly the tail", async () => {
		const recorded = recordedEvents();
		const { host, driver } = scriptedTurn();

		await driver.start({ body: SCRIPTED_PROMPT });

		const seqs = host.log.replayAfter(0).events.map((entry) => entry.seq);
		// Equal to 1..77, which is contiguity and monotonicity at once: no hole, no duplicate, no restart. This is
		// what `tests/server/server.test.ts` proves through a real socket and a dropped client.
		expect(seqs).toEqual(Array.from({ length: recorded.length }, (_unused, index) => index + 1));
		expect(host.log.lastSeq).toBe(recorded.length);

		// The client's cursor: everything after 40, and no apology for what it already had.
		const tail = host.log.replayAfter(40);
		expect(tail.gap).toBe(false);
		expect(tail.events.map((entry) => entry.seq)).toEqual(seqs.slice(40));
		expect(tail.events.map((entry) => entry.event)).toEqual(recorded.slice(40));
	});

	it("redacted: no buffered frame holds the value, and a buffered copy does not follow the message as it grows", async () => {
		// The vault the way the daemon opens one, so `redactSecrets` answers from a real row (docs/secrets.md 5.5).
		const root = createTempFlypiRoot();
		const db = openMemoryDb(join(root, ".flypi", "memory", "flypi.db"));
		const vault = openSecretVault(flypiPaths(root), { db, write: true });
		try {
			vault.put({ name: "github_token", value: TOKEN, kind: "password", actor: "test" });

			// One streamed answer, on one mutable message: the first frame is written before the value has
			// streamed at all, and the frames after it carry the value in each of the places pi puts text —
			// the accumulated `partial`, this chunk's `delta`, and `text_end`'s finished `content`.
			const block = { type: "text", text: "the token is " };
			const partial = { role: "assistant", content: [block], api: "faux", provider: "flypi-stub", model: "stub", stopReason: "pending" };
			const script = [
				streamed(partial, { type: "text_start", contentIndex: 0, partial }),
				streamed(partial, { type: "text_delta", contentIndex: 0, delta: TOKEN, partial }),
				streamed(partial, { type: "text_end", contentIndex: 0, content: `the token is ${TOKEN}`, partial }),
				{ type: "agent_end", messages: [], willRetry: false },
				{ type: "agent_settled", aborted: false },
			] as unknown as AgentSessionEvent[];
			const { turn, host, driver } = scriptedTurn(script);
			// pi grows that one object between frames — which is why a frame the log only *points* at would be
			// replayed later holding text it was never sent with. This listener is handed each frame as the
			// driver's was (a `Set`, in the order it was subscribed), so the growth lands after the first frame is
			// buffered and before the next one is emitted.
			turn.session.subscribe(() => {
				block.text = `the token is ${TOKEN}`;
			});

			await driver.start({ body: "what is the token?" });

			const buffered = host.log.replayAfter(0).events;
			expect(buffered.map((entry) => entry.event.type)).toEqual(["message_update", "message_update", "message_update", "agent_end", "agent_settled"]);
			// The load-bearing one: not one frame the log holds, at any depth, carries the plaintext — and that is
			// what a reconnect replays, so a hole here puts the value back in the browser.
			expect(buffered.map((entry) => JSON.stringify(entry.event)).join("\n")).not.toContain(TOKEN);
			// The object pi went on growing does hold it. What the log holds is the copy, frozen at the frame that
			// was really sent: `redactStream`'s comment is about exactly this, and nothing but a copy keeps it true.
			expect(JSON.stringify(script[0])).toContain(TOKEN);
			expect(textOf(buffered[0]!.event)).toBe("the token is ");
			expect((buffered[0]!.event as { message: unknown }).message).not.toBe(partial);
			// And the frames that streamed the value carry the placeholder in every text field pi sends: what the
			// UI renders is the same sentence with the value named in it, not blanked.
			expect(JSON.stringify(buffered[1]!.event)).toContain(MARK);
			expect(JSON.stringify(buffered[2]!.event)).toContain(`the token is ${MARK}`);
		} finally {
			vault.close();
			db.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("run status: the crash record sees `running` before the first event, and the settle one seq early", async () => {
		const { host, driver } = scriptedTurn();

		await driver.start({ body: SCRIPTED_PROMPT });

		expect(host.runs).toEqual(["running", "idle"]);
		// `running` at seq 0: `preflightResult` answered before the turn's first event, which is the whole reason a
		// process that dies mid-turn leaves a row saying so (docs/architecture.md 4.5, tests/daemon/daemon.test.ts).
		expect(host.seqAtRun[0]).toBe(0);
		// `idle` is written *before* `agent_settled` is pushed, so the row's seq is the last event of the turn and
		// not the settle itself — the number `tests/server/session-registry.test.ts` pins through the registry.
		expect(host.seqAtRun[1]).toBe(host.log.lastSeq - 1);
	});

	it("run status: an abort mid-replay is running, aborted, idle, and the replay stops where the abort landed", async () => {
		const { turn, host, driver } = scriptedTurn();

		const running = driver.start({ body: SCRIPTED_PROMPT });
		await until("the turn to start", () => host.seen.length >= 3);
		await driver.abort();
		await running;

		// `aborted` before the abort lands, so a process that died on the way says why the turn stopped; `idle`
		// when the settle arrives, and the store keeps the aborted through it.
		expect(host.runs).toEqual(["running", "aborted", "idle"]);
		// The session stopped replaying rather than ran out of script, and ended the way a stopped run ends.
		expect(turn.replayed.length).toBeLessThan(recordedEvents().length);
		expect(turn.replayed.slice(-2).map((event) => event.type)).toEqual(["agent_end", "agent_settled"]);
		expect((turn.replayed.at(-1) as { aborted?: boolean }).aborted).toBe(true);
	});

	it("onTurnStart fires before the prompt is handed to the session", async () => {
		const { turn, host, driver } = scriptedTurn();

		await driver.start({ body: SCRIPTED_PROMPT });

		// The registry clears last turn's memory block here; after `prompt` the turn is already running and the
		// panel would show a block this turn was not given (src/server/session-registry.ts `onTurnStart`).
		expect(host.turnStarts).toBe(1);
		expect(host.promptsAtTurnStart).toBe(0);
		// And what the session was handed is the body, unchanged.
		expect(turn.prompts).toEqual([SCRIPTED_PROMPT]);
	});

	it("dispose is exactly once: the session is disposed once and the host released once", () => {
		const { turn, host, driver } = scriptedTurn();

		driver.dispose();
		driver.dispose();

		expect(turn.disposeCalls).toBe(1);
		expect(host.disposes).toBe(1);
	});

	// pi's agent loop turns a stream's `done` into `message_end`, but `AssistantMessageEvent` keeps `done` and
	// `error` in the union the frame carries, with the finished `message` where a delta frame has `partial` —
	// pi's own `toJsonAssistantMessageEvent` guards that with the same `!("partial" in event)` test. The filter
	// must leave such a frame alone apart from copying it, rather than invent a `partial` that was never sent.
	it("records a streamed frame that carries no `partial` as the frame it was", async () => {
		const finished = { role: "assistant", content: [{ type: "text", text: "the test passes now" }], api: "faux", provider: "flypi-stub", model: "stub", stopReason: "stop" };
		const frame = { type: "message_update", message: { ...finished }, assistantMessageEvent: { type: "done", reason: "stop", message: finished } };

		const { host, driver } = scriptedTurn([
			frame,
			{ type: "message_end", message: finished },
			{ type: "agent_end", messages: [finished], willRetry: false },
			{ type: "agent_settled", aborted: false },
		] as unknown as AgentSessionEvent[]);
		await driver.start({ body: SCRIPTED_PROMPT });

		const buffered = host.log.replayAfter(0).events[0]!.event as unknown as {
			message: unknown;
			assistantMessageEvent: { type: string; message?: unknown };
		};
		expect(buffered.assistantMessageEvent.type).toBe("done");
		expect("partial" in buffered.assistantMessageEvent).toBe(false);
		// Copied, not rewritten: the message the log holds is a snapshot of the mutable one, and nothing was lost.
		expect(buffered.message).not.toBe(frame.message);
		expect(buffered.message).toEqual(frame.message);
		expect(host.runs).toEqual(["running", "idle"]);
	});

	// The filter's own guard: a message with no `content` array comes back as it was. pi's agent loop streams
	// assistant messages today, but `message_update.message` is typed `AgentMessage`, and `UserMessage.content`
	// is `string | (Text|Image)[]` — a prompt typed rather than pasted is stored as that string — so walking a
	// message that is not a streamed assistant one must hand it back, not build a message out of a non-array.
	it("leaves a message with no content array as it arrived", async () => {
		const asked = { role: "user", content: "fix the failing test in this repo", timestamp: 0 };
		const frame = { type: "message_update", message: asked, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "fix", partial: asked } };

		const { host, driver } = scriptedTurn([frame, { type: "agent_settled", aborted: false }] as unknown as AgentSessionEvent[]);
		await driver.start({ body: SCRIPTED_PROMPT });

		const buffered = host.log.replayAfter(0).events[0]!.event as unknown as { message: unknown };
		expect(buffered.message).toBe(asked);
	});

	it("turnInput refuses a prompt with neither text nor attachment", () => {
		const written: string[] = [];
		const refuse = () => turnInput("   ", [], (file) => {
			written.push(file.name);
			return `/tmp/${file.name}`;
		});
		// The sentence is protocol: the UI shows it and a test quotes it (tests/server/session-registry.test.ts).
		expect(refuse).toThrow("a prompt needs text or an attachment");
		expect(written).toEqual([]);

		// An image alone is a prompt: the model has something to look at even with no text.
		const png: FlypiAttachment = { name: "screenshot.png", mimeType: "image/png", data: "cG5n" };
		expect(turnInput("", [png], () => "unused").images).toEqual([{ type: "image", data: "cG5n", mimeType: "image/png" }]);
	});

	it("turnInput gives the model the images, names the files by path, and leaves writing them to the caller", () => {
		const png: FlypiAttachment = { name: "screenshot.png", mimeType: "image/png", data: "cG5n" };
		const csv: FlypiAttachment = { name: "sort.csv", mimeType: "text/csv", data: "YSxiCg==" };
		const written: string[] = [];
		const input = turnInput("  look at these  ", [png, csv], (file) => {
			written.push(`/tmp/uploads/${file.name}`);
			return `/tmp/uploads/${file.name}`;
		});

		// Images are pi image content, because that is what the model looks at.
		expect(input.images).toEqual([{ type: "image", data: "cG5n", mimeType: "image/png" }]);
		// Every other file is a path the agent opens with its own tools — flypi never decides what a CSV is.
		expect(input.body).toBe("look at these\n[attached file: /tmp/uploads/sort.csv]");
		// `saveFile` is the caller's, because `.flypi/uploads` is layout, not a turn — and the image never went
		// to it, because nothing wrote that file out.
		expect(written).toEqual(["/tmp/uploads/sort.csv"]);
	});
});
