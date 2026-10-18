/**
 * Auto-capture v1 (docs/memory.md Phase 4: "heuristic capture on `agent_end` … cheap rules, no extra
 * model call"). Two kinds of durable fact are recoverable without understanding anything: a sentence the
 * user wrote *as* an instruction ("remember …", "we never …"), and a command the agent watched fail and
 * then work on the second try.
 *
 * The body of a captured fact stays the user's own words. Rewriting it would put flypi's paraphrase in
 * front of a model later and lose what was actually said — and the write gate (`NEAR_DUPLICATE`,
 * `valueSwap` in store.ts) is what stops a capture from becoming a second copy of a fact the model
 * already stored. Provenance is code's as everywhere else: the user's words are `owner`, what the agent
 * watched happen is `agent`, and neither is an argument a caller can pass.
 */
import type { OriginClass } from "./store.ts";

export interface CapturedFact {
	body: string;
	kind: string;
	origin: OriginClass;
}

/** What one turn's tools did, in order — the parts of pi's `tool_result` event a rule can use. */
export interface ToolOutcome {
	name: string;
	/** A shell command, when the tool ran one. That is the only outcome worth comparing. */
	command?: string;
	isError: boolean;
}

/** One turn is not a place to write an essay about. */
const MAX_FACTS = 3;
/** "not anymore" is a fragment; a fact needs a subject and something said about it. */
const MIN_WORDS = 4;
/** The MCP surface caps a body at 8000; a captured sentence never needs near that much. */
const MAX_CHARS = 500;

/**
 * The user writing something down on purpose. Global because one prompt can state two facts. It stops at a
 * sentence end — a period followed by space or the end — so one statement cannot swallow the next one,
 * while a dotted path inside the fact stays part of it.
 */
const STATED = /\b(?:remember|note that|note this|keep in mind|from now on|going forward)\b[:,]?\s*(?:that\s+)?((?:[^.!?]|\.(?!\s|$))+)/gi;
/** The marker on its own, for the sentence-level test below (a global regex is stateful in `.test`). */
const STATED_MARK = /\b(?:remember|note that|note this|keep in mind|from now on|going forward)\b/i;
/** A standing instruction or a correction — the "user corrections" half, in the words people use for it. */
const STANDING = /\b(never|always|no longer|not anymore|anymore|instead of|prefer|only use|do not|don't|does not|doesn't|must not|use instead)\b/i;
// shortcut: a word list, so it reads "I never said anything about it" as an instruction and misses a
// correction phrased unusually. If that noise shows up in the store, the upgrade is the NLI judge already
// sitting behind the write gate (src/memory/judge.ts) judging these too, not a longer list here.

/**
 * What this turn is worth remembering, in the order it was said. Deliberately conservative: a capture
 * that writes junk costs a row and a retrieval slot forever, while a fact it misses is one the model can
 * still be asked to store — so every rule here has to be something a sentence states outright.
 */
export function captureFromTurn(prompt: string, tools: ToolOutcome[] = []): CapturedFact[] {
	const facts: CapturedFact[] = [];
	const add = (fact: CapturedFact | undefined) => {
		if (fact && !facts.some((existing) => existing.body === fact.body)) facts.push(fact);
	};

	for (const match of prompt.matchAll(STATED)) add(factOf(match[1], "fact", "owner"));
	for (const sentence of sentences(prompt)) {
		// Already handled as a stated fact: capturing it twice, once with the "remember" prefix and once
		// without, is two rows for one instruction.
		if (STATED_MARK.test(sentence)) continue;
		if (STANDING.test(sentence)) add(factOf(sentence, "preference", "owner"));
	}

	// Failed-then-fixed: the second command working after the first failed is a fact the agent earned, so it
	// is `agent`-origin even though nobody typed it. Matched on the attempt — the same arguments, whatever
	// runs them — because `npm run build` then `pnpm run build` is one fix, while `ls` then `cat` are two
	// unrelated commands and calling the second one a fix would invent a fact.
	const commands = tools.flatMap((tool) => (tool.command ? [{ command: tool.command, isError: tool.isError }] : []));
	for (const failed of commands.filter((tool) => tool.isError)) {
		const fix = commands.find((tool) => !tool.isError && tool.command !== failed.command && sameAttempt(failed.command, tool.command));
		if (fix) add(factOf(`\`${failed.command}\` failed; \`${fix.command}\` worked`, "fact", "agent"));
	}
	return facts.slice(0, MAX_FACTS);
}

/** Sentence boundaries, kept simple: a captured fact must not run across two instructions. */
function sentences(prompt: string): string[] {
	return prompt
		.split(/(?<=[.!?])\s+|\n+/)
		.map((sentence) => sentence.trim())
		.filter(Boolean);
}

function factOf(text: string | undefined, kind: string, origin: OriginClass): CapturedFact | undefined {
	const raw = (text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_CHARS);
	// A question is someone asking, not someone telling: "don't we use pnpm?" states no preference.
	if (!raw || raw.endsWith("?") || wordCount(raw) < MIN_WORDS) return undefined;
	// One shape for every rule: some patterns match a sentence with its period, some stop before it, and a
	// store where "use pnpm" and "use pnpm." are two different strings invites the reader to dedupe them.
	const body = raw.replace(/[.!?]+$/, "").trim();
	return { body, kind, origin };
}

const wordCount = (text: string): number => (text.match(/[\p{L}\p{N}]+/gu) ?? []).length;
/** A command without its runner or its flags: what makes two of them the same attempt. */
const shape = (command: string): string[] => command.trim().split(/\s+/).slice(1).filter((token) => !token.startsWith("-"));
/**
 * Two commands are the same attempt when the only difference is what runs them. Both empty is *not* a match:
 * `false` then `true` is two commands with nothing in common, and calling that a fix would invent a fact.
 */
const sameAttempt = (failed: string, fix: string): boolean => {
	const tried = new Set(shape(failed));
	return shape(fix).some((token) => tried.has(token));
};
