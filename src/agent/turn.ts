/**
 * Driving a turn (docs/deepening.md Phase 11.3).
 *
 * A turn touches four members of a pi session — `prompt`, `abort`, `subscribe`, `isIdle` — plus `dispose`,
 * which is what teardown needs and the only fifth member this seam owns. Everything else flypi does with a
 * session (`setModel`, `reload`, `bindExtensions`, `messages`, `sessionManager`, `extensionRunner`,
 * `promptTemplates`, `getContextUsage`, `debugInfo`, `fork`) is *inspecting* a conversation and stays with
 * whoever holds it; wrapping it here too would be a facade with a new name.
 *
 * So the registry keeps conversation bookkeeping and this module keeps the turn: the one subscription, the
 * numbering of what it carries, the last-resort redaction of it, the prompt options and the run-status calls
 * that say a turn is in flight. Nothing here knows about sockets, session files or the `runs` table.
 *
 * pi is imported by `import type` only, and `FlypiSession` with it: the types are erased, so a test can drive
 * a turn over its own session object without loading pi's runtime.
 */
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { redactSecrets } from "../secrets/redact.ts";
import { isImage, type FlypiAttachment } from "../shared/attachments.ts";
import type { FlypiSession } from "./runtime.ts";

/**
 * The slice of a pi session that driving a turn touches. `dispose` is the fifth member, and the only one that
 * is not a turn's own: it is what teardown does to the session. Derived from `FlypiSession` rather than
 * re-declared, so a pi change in any of the five breaks the build at the seam.
 */
export type TurnSession = Pick<FlypiSession, "prompt" | "abort" | "subscribe" | "isIdle" | "dispose">;

/** Sequencing sink for the redacted stream. Structurally satisfied by `EventLog<AgentSessionEvent>`; declared
 *  here so `src/agent` never imports `src/server`. `push` stays the only place a `seq` is ever assigned. */
export interface TurnLog {
	push(event: AgentSessionEvent): { seq: number; at: number };
	readonly lastSeq: number;
}

export type TurnEventListener = (seq: number, event: AgentSessionEvent, at: number) => void;

/** One request to drive, attachments already resolved to a body and images. */
export interface TurnInput {
	body: string;
	images?: { type: "image"; data: string; mimeType: string }[];
	/** How to queue input while a turn streams. Absent + streaming ⇒ pi rejects; that rejection is the error frame. */
	mode?: "steer" | "followUp";
}

/** What the driver needs from the conversation it drives. The registry builds this; nothing here is pi's type. */
export interface TurnHost {
	readonly session: TurnSession;
	readonly log: TurnLog;
	/** Called for every event *after* the log holds it — the registry fans out to sockets and records the
	 *  forkable message here. Kept as a hook so `messages.set` stays in the same slot it occupies today. */
	onEvent: TurnEventListener;
	/** `running` from `preflightResult` (before any event), `aborted` before the abort lands, `idle` on
	 *  `agent_settled` **before** that event is pushed — the run row's seq excludes the settle. */
	onRun: (status: "running" | "idle" | "aborted") => void;
	/** Fires first thing in `start()`: the panel must not show last turn's memory block as this turn's. */
	onTurnStart: () => void;
}

export interface TurnDriver {
	start(input: TurnInput): Promise<void>;
	abort(): Promise<void>;
	/** Drop the subscription and dispose the session. Exactly-once — this is the latch `teardown()` is today. */
	dispose(): void;
	/** pi's own `isIdle`, forwarded: no run, compaction, retry or queued work. Not "no turn started by me". */
	readonly idle: boolean;
}

/**
 * One per conversation. Subscribes immediately, from the moment the conversation exists until it is disposed:
 * an event before `start()` must not be missed, and a second subscription — e.g. one per turn — would number
 * the same event twice, so a client that reconnected would replay every frame of it twice.
 */
export function createTurnDriver(host: TurnHost): TurnDriver {
	let disposed = false;
	const unsubscribe = host.session.subscribe((raw) => {
		const event = redactStream(raw);
		// Before the push, so the run row's `last_event_seq` is the last event of the turn and not the settle.
		if (event.type === "agent_settled") host.onRun("idle");
		const buffered = host.log.push(event);
		host.onEvent(buffered.seq, event, buffered.at);
	});
	return {
		async start(input: TurnInput): Promise<void> {
			host.onTurnStart();
			// The daemon needs to know a turn is in flight before the first event of it can fire: a process that
			// dies mid-turn leaves the row `running`, and that is what a restart reconciles (Phase 4.5). pi's
			// `preflightResult` is where that is knowable — it fires once the run's messages are prepared, before
			// its first request and before any event — and it answers "handled" for input that starts no run at
			// all, which is what an extension command is, and what a refused prompt is.
			// No mode + already streaming ⇒ pi rejects rather than guessing. That rejection is the error frame.
			await host.session.prompt(input.body, {
				...(input.images?.length ? { images: input.images } : {}),
				...(input.mode ? { streamingBehavior: input.mode } : {}),
				preflightResult: (disposition) => {
					if (disposition !== "handled") host.onRun("running");
				},
			});
		},
		async abort(): Promise<void> {
			// Recorded before the abort lands: if the process dies on the way, the row says why the turn stopped.
			host.onRun("aborted");
			await host.session.abort();
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			unsubscribe();
			host.session.dispose();
		},
		get idle(): boolean {
			return host.session.isIdle;
		},
	};
}

/**
 * A prompt as the model receives it: the text, and the attachments split the way the model needs them. Images
 * are pi image content, because that is what the model looks at; every other file is whatever `saveFile` did
 * with it, named by path, so the agent opens it with its own tools. flypi never decides what a PDF or a
 * spreadsheet contains.
 *
 * `saveFile` is the caller's: writing to `.flypi/uploads` is layout, not a turn (docs/deepening.md 11.3 T30).
 */
export function turnInput(
	text: string,
	attachments: FlypiAttachment[],
	saveFile: (attachment: FlypiAttachment) => string,
): TurnInput {
	const images = attachments.filter(isImage).map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType }));
	const files = attachments.filter((attachment) => !isImage(attachment)).map(saveFile);
	const body = [text.trim(), ...files.map((path) => `[attached file: ${path}]`)].filter(Boolean).join("\n");
	if (!body && images.length === 0) throw new Error("a prompt needs text or an attachment");
	return { body, images };
}

/**
 * The review fork's turn (src/agent/runtime.ts): a session with no log, no client and no run row, asking one
 * question of a copied context. It passes **no** prompt options — the fork's request bytes must stay exactly
 * what they were before this module existed, because reusing the parent's prefix is its whole cost argument
 * (docs/prompt-cache.md). A rejection propagates: the caller's `finally` still disposes the fork.
 */
export function runSilentTurn(session: TurnSession, body: string): Promise<void> {
	return session.prompt(body);
}

/**
 * The last-resort filter on the live stream (docs/secrets.md Phase 5.5). The `message_end` hook in
 * `src/secrets/extension.ts` is what keeps the session file clean, but the UI renders the frames that
 * arrive *before* that, and whatever is pushed here is what a reconnect replays — so a value the model
 * repeats would be on screen for a second and in the replay log for the life of the conversation.
 *
 * Every text field of the frame is rewritten, not just the one the reducer reads: the frame also carries
 * pi's in-progress `message`, the finished block at `text_end.content` and this chunk's `delta`, and a
 * value left in any of those is a copy of it sitting in the browser. The partials are the accumulated text,
 * which is why the filter reads them rather than the deltas: a value split across two chunks is caught as
 * soon as its last piece lands. The gap that stays open is the part of the value that has not streamed yet,
 * and the Secrets view says so.
 *
 * The rewrite also *copies*. pi grows one mutable message object across the whole turn and hands every frame
 * the same reference, so a frame that was filtered while its text was still short would later be read back
 * from the log holding the finished value — which is exactly what a reconnect replays.
 *
 * shortcut: re-snapshots the partial on every delta, so a long streamed answer costs one copy per chunk; if
 * that ever shows up in the timings, copy only from the last text block onwards.
 */
function redactStream(event: AgentSessionEvent): AgentSessionEvent {
	if (event.type !== "message_update") return event;
	const streamed = event.assistantMessageEvent;
	// A streamed frame carries the in-progress `partial`; pi's own `done`/`error` frame carries the finished
	// `message` under that key instead. Both are copies of the same mutable object, so both are rewritten.
	const partial = "partial" in streamed ? { partial: redactText(streamed.partial) } : {};
	// `text_end`/`thinking_end` carry their block as one string, and `*_delta` carries a chunk: a chunk that
	// happens to hold a whole value would otherwise be the one place it survives the frame.
	const text = "content" in streamed ? { content: redactSecrets(streamed.content) } : {};
	const delta = "delta" in streamed ? { delta: redactSecrets(streamed.delta) } : {};
	return {
		...event,
		message: redactText(event.message),
		assistantMessageEvent: { ...streamed, ...partial, ...text, ...delta },
	} as AgentSessionEvent;
}

/**
 * A copy of an in-progress assistant message with its text and thinking blocks redacted. The copy is made even
 * when nothing matched, because the object pi gave us is mutable and shared by every frame of the turn — see
 * `redactStream`. Anything that is not such a message (no `content` array) comes back as it was.
 */
function redactText(message: unknown): unknown {
	const content = (message as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) return message;
	return { ...(message as object), content: content.map((block) => {
		const part = block as { type?: string; text?: string; thinking?: string };
		const field = part?.type === "text" ? "text" : part?.type === "thinking" ? "thinking" : undefined;
		if (field === undefined || typeof part[field] !== "string") return block;
		return { ...part, [field]: redactSecrets(part[field]!) };
	}) };
}
