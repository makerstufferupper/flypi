/**
 * Each chat's last measured answer, kept in localStorage like the settings that belong to the page rather
 * than the server (ui/lib/theme.ts, ui/lib/panels.ts). The rates are timings taken from when events
 * arrived in *this* browser (`src/shared/metrics.ts`), so nothing on the server could hand them back
 * after a reload — and a page that forgot the only answer you had measured is worse than one that
 * remembers it. Context usage needs none of this: the server sends a fresh reading when a conversation
 * binds.
 *
 * Keyed by session path, because a rate describes one chat answering on one model: switching chats shows
 * that chat's own numbers, or nothing. That is also why each record carries the model that produced it —
 * `ui/lib/app-state.svelte.ts` drops a record once it sees the chat is on a different model now.
 */
import type { ResponsePerf } from "../../src/shared/metrics.ts";
import type { DebugInfo } from "../../src/server/protocol.ts";

const KEY = "flypi.lastAnswers";

/** The model a debug snapshot names, in the form a record stores it in. */
export function modelName(debug: DebugInfo): string | null {
	return debug.model ? `${debug.model.provider}/${debug.model.modelId}` : null;
}

/** A chat's last measured answer, and the model that produced it ("provider/modelId", null if unknown). */
export interface LastAnswer extends ResponsePerf {
	model: string | null;
}

export function loadLastAnswer(sessionPath: string): LastAnswer | null {
	return read()[sessionPath] ?? null;
}

export function saveLastAnswer(sessionPath: string, answer: LastAnswer): void {
	const all = read();
	all[sessionPath] = answer;
	write(all);
}

/** A deleted chat's numbers go with it — which is also what keeps the map from growing for ever. */
export function forgetLastAnswer(sessionPath: string): void {
	const all = read();
	if (!(sessionPath in all)) return;
	delete all[sessionPath];
	write(all);
}

function write(all: Record<string, LastAnswer>): void {
	try {
		localStorage.setItem(KEY, JSON.stringify(all));
	} catch {
		// Private mode, or a full quota: the numbers last as long as the tab, which is fine.
	}
}

/** Valid records only: anything the page did not write reads as "this chat has no numbers". */
function read(): Record<string, LastAnswer> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(localStorage.getItem(KEY) ?? "");
	} catch {
		return {}; // nothing stored, or not JSON we wrote
	}
	if (!parsed || typeof parsed !== "object") return {};
	const valid: Record<string, LastAnswer> = {};
	for (const [path, value] of Object.entries(parsed as Record<string, unknown>)) {
		const answer = asAnswer(value);
		if (answer) valid[path] = answer;
	}
	return valid;
}

function asAnswer(value: unknown): LastAnswer | null {
	const record = value as Partial<LastAnswer> | null;
	if (!record || typeof record !== "object") return null;
	const { promptTokens, outputTokens, prefillMs, decodeMs } = record;
	if (!(finite(promptTokens) && finite(outputTokens) && finite(prefillMs) && finite(decodeMs))) return null;
	return { promptTokens, outputTokens, prefillMs, decodeMs, model: typeof record.model === "string" ? record.model : null };
}

function finite(value: unknown): value is number {
	return Number.isFinite(value);
}
