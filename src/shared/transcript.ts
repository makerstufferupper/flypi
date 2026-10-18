/**
 * The one transcript mapper (docs/architecture.md Phase 2).
 *
 * `renderMessage()` maps a single pi message to view blocks, and `applyEvent()` folds a pi
 * session event stream into a transcript view model. The browser, `scripts/smoke.mjs` and the
 * golden test all go through these two functions — if the UI and the snapshot disagree, one of
 * them is wrong, which is the whole reason they share a mapper.
 *
 * It is pure and DOM-free on purpose: the streaming reducer can then be fed the recorded event
 * log (tests/fixtures/transcript-log) and asserted outside a browser, and the component tests
 * assert what the reducer produced rather than re-testing the reducer.
 *
 * Streaming needs no delta arithmetic: every `message_update` carries `assistantMessageEvent.partial`,
 * the message as far as it has got, so the streaming view is `renderMessage(partial)` and
 * `message_end` replaces it with the final message. Delta counts are timing-dependent (docs/pi-api.md)
 * and this design never looks at them.
 */
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

/** Derived from pi's own event types, so no transitive pi-ai / pi-agent-core import is needed here. */
type MessageEndEvent = Extract<AgentSessionEvent, { type: "message_end" }>;
type MessageStartEvent = Extract<AgentSessionEvent, { type: "message_start" }>;
type MessageUpdateEvent = Extract<AgentSessionEvent, { type: "message_update" }>;
type ToolStartEvent = Extract<AgentSessionEvent, { type: "tool_execution_start" }>;
type ToolUpdateEvent = Extract<AgentSessionEvent, { type: "tool_execution_update" }>;
type ToolEndEvent = Extract<AgentSessionEvent, { type: "tool_execution_end" }>;
type QueueUpdateEvent = Extract<AgentSessionEvent, { type: "queue_update" }>;

export type FlypiMessage = MessageEndEvent["message"];

/** pi's `Usage`, flattened to the two numbers a chat UI shows. */
export interface RenderedUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

export type RenderedBlock =
	| { kind: "text"; text: string }
	| { kind: "image"; data: string; mimeType: string }
	| { kind: "thinking"; text: string }
	| { kind: "tool-call"; id: string; name: string; args: unknown }
	| { kind: "tool-result"; id: string; name: string; output: string; isError: boolean };

export interface RenderedMessage {
	role: string;
	blocks: RenderedBlock[];
	usage?: RenderedUsage;
	/**
	 * The event `seq` this message arrived on, when the caller passed one. It is what the UI sends back
	 * to name the message (fork), so the server resolves the very message on screen instead of a position
	 * both sides counted separately. `renderMessage()` never sets it: only the socket knows the seq.
	 */
	seq?: number;
}

/** A tool card's live state, keyed by pi's toolCallId. */
export interface ToolCard {
	id: string;
	name: string;
	args: unknown;
	output: string;
	state: "pending" | "running" | "done" | "error";
	/** Set when the run starts. A card created from a tool call in a message has none yet. */
	startedAt?: number;
	endedAt?: number;
}

export interface Transcript {
	messages: RenderedMessage[];
	/** The assistant message as far as it has streamed; rendered exactly like a finished one. */
	streaming: RenderedMessage | null;
	tools: Record<string, ToolCard>;
	/** pi's `queue_update`: what the user steered in, and what is waiting for the turn. */
	queue: { steering: string[]; followUp: string[] };
	running: boolean;
	/** Usage/cost for the current turn, and for the whole conversation. */
	turn: RenderedUsage;
	total: RenderedUsage;
}

export function emptyTranscript(): Transcript {
	return {
		messages: [],
		streaming: null,
		tools: {},
		queue: { steering: [], followUp: [] },
		running: false,
		turn: emptyUsage(),
		total: emptyUsage(),
	};
}

export function emptyUsage(): RenderedUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
}

/**
 * The single message mapper. Handles every role pi puts in the stream — user, assistant
 * (text/images/thinking/tool calls) and tool results — and ignores what Phase 2 has no view for
 * (extension-authored message types) rather than inventing one.
 */
export function renderMessage(message: FlypiMessage): RenderedMessage {
	const record = message as unknown as Record<string, unknown>;
	const role = typeof record.role === "string" ? record.role : "unknown";
	const blocks: RenderedBlock[] = [];

	if (role === "toolResult") {
		blocks.push({
			kind: "tool-result",
			id: typeof record.toolCallId === "string" ? record.toolCallId : "",
			name: typeof record.toolName === "string" ? record.toolName : "",
			output: textOf(record.content),
			isError: record.isError === true,
		});
	} else {
		const content = record.content;
		if (typeof content === "string") {
			if (content) blocks.push({ kind: "text", text: content });
		} else if (Array.isArray(content)) {
			for (const part of content) blocks.push(...renderBlock(part));
		}
	}

	const rendered: RenderedMessage = { role, blocks };
	const usage = usageOf(record.usage);
	if (usage) rendered.usage = usage;
	return rendered;
}

function renderBlock(part: unknown): RenderedBlock[] {
	if (!part || typeof part !== "object") return [];
	const block = part as Record<string, unknown>;
	switch (block.type) {
		case "text":
			return typeof block.text === "string" && block.text ? [{ kind: "text", text: block.text }] : [];
		// A pasted image: pi keeps the bytes in the message, so the chat can show what was sent without
		// holding a second copy of it.
		case "image":
			return typeof block.data === "string" && typeof block.mimeType === "string"
				? [{ kind: "image", data: block.data, mimeType: block.mimeType }]
				: [];
		case "thinking":
			return typeof block.thinking === "string" && block.thinking
				? [{ kind: "thinking", text: block.thinking }]
				: [];
		case "toolCall":
			return [
				{
					kind: "tool-call",
					id: typeof block.id === "string" ? block.id : "",
					name: typeof block.name === "string" ? block.name : "",
					args: block.arguments,
				},
			];
		default:
			return [];
	}
}

/** Flattens pi's `Usage`, or returns undefined for a message that has none (user, tool results). */
export function usageOf(usage: unknown): RenderedUsage | undefined {
	if (!usage || typeof usage !== "object") return undefined;
	const u = usage as Record<string, unknown>;
	return {
		input: num(u.input),
		output: num(u.output),
		cacheRead: num(u.cacheRead),
		cacheWrite: num(u.cacheWrite),
		totalTokens: num(u.totalTokens),
		cost: costOf(u.cost),
	};
}

/** Usage fields are optional in some providers' partial messages; a missing number is 0, never NaN. */
function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function costOf(cost: unknown): number {
	if (typeof cost === "number") return cost;
	if (cost && typeof cost === "object") return num((cost as Record<string, unknown>).total);
	return 0;
}

/** Tool output arrives as a result object, a content array, or a plain string depending on the tool. */
function textOf(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join("\n");
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		if ("content" in record) return textOf(record.content);
		if ("text" in record && typeof record.text === "string") return record.text;
		return JSON.stringify(value, null, 2);
	}
	return "";
}

export function addUsage(base: RenderedUsage, addition: RenderedUsage): RenderedUsage {
	return {
		input: base.input + addition.input,
		output: base.output + addition.output,
		cacheRead: base.cacheRead + addition.cacheRead,
		cacheWrite: base.cacheWrite + addition.cacheWrite,
		totalTokens: base.totalTokens + addition.totalTokens,
		cost: base.cost + addition.cost,
	};
}

/**
 * Fold one pi session event into the transcript. Returns a new object (never mutates), so a
 * Svelte 5 `$state` assignment and a test's equality check both work off the same function.
 * Unknown event types are ignored: pi may add events, and an unknown one must never blank a
 * transcript.
 *
 * `now` is injectable so tool-card durations are testable; the UI passes the real clock.
 * `seq` is the number the event carried on the wire, recorded on the message it appends (see `RenderedMessage`).
 */
export function applyEvent(state: Transcript, event: AgentSessionEvent, now: () => number = Date.now, seq?: number): Transcript {
	switch (event.type) {
		case "agent_start":
			return { ...state, running: true, turn: emptyUsage() };
		case "agent_settled":
			return { ...state, running: false, streaming: null, queue: { steering: [], followUp: [] } };
		case "message_start":
			return isAssistant((event as MessageStartEvent).message)
				? { ...state, streaming: renderMessage((event as MessageStartEvent).message) }
				: state;
		case "message_update": {
			const partial = (event as MessageUpdateEvent).assistantMessageEvent as { partial?: FlypiMessage } | undefined;
			if (!partial?.partial) return state;
			return { ...state, streaming: renderMessage(partial.partial) };
		}
		case "message_end": {
			const rendered = renderMessage((event as MessageEndEvent).message);
			// A system message is not part of the conversation; the system prompt belongs in the debug panel.
			if (rendered.role === "system") return state;
			// Neither is a recalled memory block (src/memory/recall.ts, Phase 4.7 C2): it is context the model was
			// given, not something anyone said. What a turn was shown is on the debug panel, and the session file
			// holds the bytes themselves.
			if (rendered.role === "custom") return state;
			if (rendered.role === "toolResult") {
				// A tool result is a card's output, not a message. `renderMessage()` always puts exactly one
				// tool-result block here, so the card is looked up by that block's id: it lands on the card
				// when the card exists, and stays a message of its own when it does not (a replay gap).
				const result = rendered.blocks[0] as Extract<RenderedBlock, { kind: "tool-result" }>;
				const card = state.tools[result.id];
				if (card) {
					return {
						...state,
						tools: { ...state.tools, [result.id]: { ...card, output: result.output, state: result.isError ? "error" : "done" } },
					};
				}
			}
			if (seq !== undefined) rendered.seq = seq;
			const usage = rendered.usage ? addUsage(state.turn, rendered.usage) : state.turn;
			// A tool call in a message is a card too, not only a `tool_execution_start`: a session opened
			// from disk is seeded with messages only, and its cards must still take their results.
			const tools = { ...state.tools };
			for (const block of rendered.blocks) {
				if (block.kind === "tool-call" && !tools[block.id]) {
					tools[block.id] = { id: block.id, name: block.name, args: block.args, output: "", state: "pending" };
				}
			}
			return {
				...state,
				messages: [...state.messages, rendered],
				streaming: null,
				tools,
				turn: usage,
				total: rendered.usage ? addUsage(state.total, rendered.usage) : state.total,
			};
		}
		case "tool_execution_start": {
			const start = event as ToolStartEvent;
			const existing = state.tools[start.toolCallId];
			return {
				...state,
				tools: {
					...state.tools,
					[start.toolCallId]: {
						id: start.toolCallId,
						name: start.toolName,
						args: start.args,
						output: existing?.output ?? "",
						state: "running",
						startedAt: existing?.startedAt ?? now(),
					},
				},
			};
		}
		case "tool_execution_update": {
			const update = event as ToolUpdateEvent;
			const card = state.tools[update.toolCallId];
			if (!card) return state;
			return { ...state, tools: { ...state.tools, [update.toolCallId]: { ...card, output: textOf(update.partialResult) } } };
		}
		case "tool_execution_end": {
			const end = event as ToolEndEvent;
			const card = state.tools[end.toolCallId];
			const finished: ToolCard = {
				id: end.toolCallId,
				name: end.toolName,
				args: card?.args,
				output: textOf(end.result),
				state: end.isError ? "error" : "done",
				startedAt: card?.startedAt ?? now(),
				endedAt: now(),
			};
			return { ...state, tools: { ...state.tools, [end.toolCallId]: finished } };
		}
		case "queue_update": {
			const queue = event as QueueUpdateEvent;
			return { ...state, queue: { steering: [...queue.steering], followUp: [...queue.followUp] } };
		}
		default:
			return state;
	}
}

/** Replay a whole recorded event log. This is what the fixture tests and `smoke.mjs` call. */
export function reduceEvents(events: AgentSessionEvent[], now: () => number = () => 0): Transcript {
	return events.reduce((state, event) => applyEvent(state, event, now), emptyTranscript());
}

/** Whether a message from the stream is one the model produced. */
export function isAssistant(message: unknown): boolean {
	return (message as { role?: string } | undefined)?.role === "assistant";
}

/** Compact token count for the UI: "14.2k". One formatter, so no two places round differently. */
export function compact(value: number): string {
	return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

/** "1.2k in / 340 out · $0.02" — one formatter, so the sidebar and the debug panel cannot disagree. */
export function formatUsage(usage: RenderedUsage): string {
	const tokens = `${compact(usage.input)} in / ${compact(usage.output)} out`;
	const cache = usage.cacheRead ? ` / ${compact(usage.cacheRead)} cached` : "";
	return `${tokens}${cache} · $${usage.cost.toFixed(4)}`;
}

/** A prompt is everything the request carried: uncached input, cache reads and cache writes. */
export function promptTokensOf(usage: RenderedUsage): number {
	return usage.input + usage.cacheRead + usage.cacheWrite;
}

/**
 * The prompt-cache numbers for one turn or one whole conversation (docs/prompt-cache.md Phase 4.6 A2).
 * `formatUsage` hides a zero cache read because it is describing one answer; this is describing the
 * cache, so the zeros stay and the share of the prompt that was served from cache is spelled out — a
 * bare count is not a measurement anyone can read. A turn whose provider reported no usage at all says
 * so, because "nothing reported" is a different fact from a cold turn that reported zero hits.
 */
export function formatCache(usage: RenderedUsage): string {
	const prompt = promptTokensOf(usage);
	if (!prompt) return "the provider reported no usage";
	return `${compact(usage.cacheRead)} read / ${compact(usage.cacheWrite)} write · ${Math.round((usage.cacheRead / prompt) * 100)}% of the prompt from cache`;
}

/**
 * The text form of a transcript: what `scripts/smoke.mjs` prints and what the golden fixture
 * compares against. Deliberately structurally identical to what the DOM renders.
 */
export function renderTranscriptText(transcript: Transcript): string {
	const lines: string[] = [];
	for (const message of transcript.messages) {
		lines.push(`${message.role}:`);
		for (const block of message.blocks) lines.push(...describeBlock(block, transcript));
		if (message.usage) lines.push(`  usage ${formatUsage(message.usage)}`);
	}
	if (transcript.streaming) {
		lines.push("assistant (streaming):");
		for (const block of transcript.streaming.blocks) lines.push(...describeBlock(block, transcript));
	}
	if (transcript.queue.steering.length || transcript.queue.followUp.length) {
		lines.push(`queued steering: ${transcript.queue.steering.join(" | ")}`);
		lines.push(`queued followUp: ${transcript.queue.followUp.join(" | ")}`);
	}
	lines.push(`total ${formatUsage(transcript.total)}`);
	return `${lines.join("\n")}\n`;
}

function describeBlock(block: RenderedBlock, transcript: Transcript): string[] {
	switch (block.kind) {
		case "text":
			return [`  text: ${block.text}`];
		case "image":
			// The bytes are not part of a text rendering; that a paste reached the model is (docs/testing.md).
			return [`  image: ${block.mimeType}`];
		case "thinking":
			return ["  thinking: (collapsed)"];
		case "tool-call": {
			// A tool call with no card (a seeded history, a replay gap) renders as pending, not blank.
			const card = transcript.tools[block.id] ?? { state: "pending" as const, output: "" };
			return [`  tool ${block.name} [${card.state}] ${JSON.stringify(block.args)}`, ...(card.output ? [`    output: ${card.output}`] : [])];
		}
		case "tool-result":
			return [`  tool-result ${block.name} [${block.isError ? "error" : "done"}]: ${block.output}`];
	}
}
