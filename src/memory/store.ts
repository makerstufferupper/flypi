/**
 * `MemoryStore` — the one writer over the memory database (docs/memory.md Phase 3).
 *
 * Everything that reaches this class is SQL with bound parameters, never concatenated text. The two
 * rules the rest of the design leans on live here and nowhere else:
 *   - `active → superseded` is the only automatic transition; `deleted` needs an explicit call
 *     (docs/memory.md "Status rules"), and every automated mutation writes its pre-image first.
 *   - A vector is only comparable to another vector from the same model and quantization, so
 *     `vectorSearch` filters on the index identity rather than trusting the config (risk 7).
 */
import type { DatabaseSync } from "node:sqlite";
import { cosine, type Embedder, type EmbedIdentity, type EmbedResult, noneEmbedder } from "./embed.ts";
import type { MediaKind, MemoryMedia } from "./media.ts";
import { redactSecrets } from "../secrets/redact.ts";

export type OriginClass = "owner" | "agent" | "untrusted" | "system";
export type SessionKind = "interactive" | "background" | "subagent" | "unknown";

/**
 * The only rows automatic injection may use: a fact the user stated, or one this agent wrote. Authority
 * is set by code at write time, never by prose, so a body saying "the user said so" does not earn a place
 * in a prompt nobody asked for — `untrusted` (a web page, another agent's transcript) and `system` rows
 * reach the model only through a search someone explicitly made (docs/memory.md Phase 4).
 * shortcut: a fixed store policy, not a per-query list; a browser that filters by origin is Phase 6's.
 */
export const INJECTABLE_ORIGINS: readonly OriginClass[] = ["owner", "agent"];

/**
 * How close two vectors have to be to be called the same fact. Measured against EG2 (q8) on 2026-10-11:
 * the same fact worded differently sits at 0.96–0.97 and genuinely different facts at 0.74. The 0.9 this
 * used — tuned on bge-small — swallowed “the deploy target is 10.0.0.7” when a fuller version of it was
 * written (0.9023), and a swallowed fact is invisible: the write returns the *other* row's id. A
 * duplicate that survives is the cheaper mistake, so the gate sits above the reworded pair.
 * What it cannot do: tell a copy from a correction. Measured the same way, a value swap sits *above*
 * this threshold (“the deploy port is 9090” next to “…is 8080” is 0.9510, “…/v2” vs “…/v1” is 0.9793,
 * “we do not use pnpm” vs “we use pnpm” is 0.9835) — being that similar is what a changed value *is*.
 * That is what `valueSwap` below decides; cosine alone would drop the correction and hand back the id
 * of the row it replaced.
 * shortcut: measured on a handful of pairs, not a corpus — Phase 4's recall corpus settles it.
 */
export const NEAR_DUPLICATE = 0.95;
/** The contradiction micro-call sees at most this many rows, in one pass, never recursively. */
const CONTRADICTION_CANDIDATES = 5;

/** What a contradiction classifier is shown: the nearest active rows, with their bodies. */
export interface ContradictionCandidate {
	id: number;
	body: string;
	score: number;
}

export type ContradictionVerdict = "new" | "extend" | "duplicate" | "contradict";

/**
 * The classifier seam (docs/memory.md). It is asked flypi's own model, never as a user turn, and never
 * a second time for the same write: a check that triggered another check could chain until the turn's
 * budget was gone. Naming a row it was not shown is not a verdict.
 */
export type ContradictionClassifier = (
	body: string,
	candidates: ContradictionCandidate[],
) => Promise<{ verdict: ContradictionVerdict; target?: number }>;

export interface MemoryRow {
	id: number;
	kind: string;
	body: string;
	tags: string[];
	status: "active" | "superseded" | "deleted";
	origin_class: OriginClass;
	session_kind: SessionKind;
	supersedes: number | null;
	superseded_by: number | null;
	merged_from: number[];
	strength: number;
	use_count: number;
	cited_count: number;
	created_at: string;
	last_verified_at: string | null;
	session_id: string | null;
	turn_id: number | null;
	/** The index this row's vector belongs to, or null when it has none. */
	embed: EmbedIdentity & { dims: number } | null;
	/** What was embedded: the text, or the bytes of an image or recording. */
	modality: "text" | MediaKind;
	media: { id: number; kind: MediaKind; mime: string; path: string; bytes_size: number } | null;
}

export interface NewMemory {
	kind: string;
	body: string;
	tags?: string[];
	origin_class: OriginClass;
	session_kind: SessionKind;
	strength?: number;
	session_id?: string;
	turn_id?: number;
	supersedes?: number;
	actor: string;
	reason?: string;
	/** An image or recording to remember; `body` stays its caption, and keyword search reads that. */
	media?: MemoryMedia;
}

export interface ScoredMemory extends MemoryRow {
	score: number;
	matched_by: "fts" | "vector" | "both";
}

export type AuditAction = "create" | "edit" | "supersede" | "forget" | "verify" | "reembed";

export interface AuditEntry {
	/** The audit row's own id — what the browser's undo names, so an undo says which change it reverses. */
	id: number;
	action: AuditAction;
	actor: string;
	pre_image: unknown;
	reason: string | null;
	created_at: string;
}

export interface SearchOptions {
	query: string;
	limit?: number;
	/** Retrieval counts: `use_count` moves when a row is retrieved (docs/memory.md Phase 4). */
	count?: boolean;
	/** Hard cap on injected text; a block is dropped whole, never split mid-sentence. */
	maxTokens?: number;
	/**
	 * Only `INJECTABLE_ORIGINS` rows are eligible — what flypi's per-turn recall asks for. Left out, every
	 * origin is searchable, which is right for a caller that can see the provenance and judge it itself.
	 */
	injectableOnly?: boolean;
}

export interface SearchResult {
	results: ScoredMemory[];
	/** True when the semantic half did not run — never a silent downgrade (risk 8). */
	partial: boolean;
	note?: string;
}

/** Rough token count for a block of text. Good enough for a budget that must not be exceeded. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/**
 * How a row's worth decays with time, in days from its last verification: a row this old ranks half as
 * high and is still returned (staleness lowers rank, it never removes a memory).
 * shortcut: a constant, not the `memory_config` row the design names — that table has no reader yet, and
 * a setting nobody can set is a second mechanism. Read it from settings when Phase 8 does.
 */
const DECAY_HALF_LIFE_DAYS = 120;

/**
 * Freshness bands, per `kind` (docs/memory.md Phase 6): a convention or a preference does not go stale by
 * sitting in the store, a situational fact does. `Infinity` means age is not a factor for that kind —
 * `0.5 ** (age / Infinity)` is 1, so the row stops decaying rather than being removed.
 * shortcut: `kind` is free-form text (the model and the review fork choose it), so this is a keyword match
 * on the kind rather than a schema. A kind named with none of these words gets the default band, which is
 * the one every kind had before this existed.
 */
const EVERGREEN_KIND = /convention|preference|rule|style|choice|identity|location|who|name/;
const halfLifeDaysFor = (kind: string): number => (EVERGREEN_KIND.test(kind) ? Number.POSITIVE_INFINITY : DECAY_HALF_LIFE_DAYS);

/**
 * What a row that clears the promotion gates is raised to (docs/memory.md Phase 6). Promotion is a rank
 * change and nothing else: it writes no new fact and removes none, so a promoted row keeps the id a
 * conversation cited it by.
 */
export const PROMOTED_STRENGTH = 1.5;

/**
 * Relevance comes from the merge; these decide worth *among* what the merge found. They multiply rather
 * than add so none of them can rescue a row the search did not match, and at the defaults (strength 1.0,
 * verified now, never cited) the product is exactly 1.0 — the ranking moves only once the store has
 * actually learned something about a row. Citations use `log` because the hundredth one says very little
 * more than the tenth, and a count the model could inflate would rank politeness.
 */
function rankFactors(row: MemoryRow, halfLifeDays: number): number {
	const verified = Date.parse(row.last_verified_at ?? row.created_at);
	const ageDays = Number.isNaN(verified) ? 0 : Math.max(0, (Date.now() - verified) / 86_400_000);
	return row.strength * 0.5 ** (ageDays / halfLifeDays) * (1 + Math.log1p(row.cited_count) / 3);
}

/**
 * Two rows that state the same fact cost the model the same tokens twice. Token containment, not a model
 * call — this runs on every turn — and `min` in the denominator is deliberate: "we use pnpm" inside "we
 * use pnpm, never npm" is one fact stated twice, and the higher-ranked copy is the one that stays.
 * The write gate already refuses near-identical bodies; this catches the paraphrases it missed and the
 * rows a consolidation pass has not merged yet. The cutoff is high on purpose: two rows that differ in
 * one value ("the api url is X" / "... is Y") are a correction, not a duplicate, and hiding one of them
 * from the model would lose the fact.
 */
const SAME_FACT = 0.9;
/** Exported for the consolidation sweep: the rule that hides a duplicate at read time is what it merges. */
export function sameFact(a: string, b: string): boolean {
	const tokens = (text: string) => new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
	const x = tokens(a);
	const y = tokens(b);
	if (x.size === 0 || y.size === 0) return false;
	let shared = 0;
	for (const token of x) if (y.has(token)) shared += 1;
	return shared / Math.min(x.size, y.size) >= SAME_FACT;
}

/** Reciprocal-rank fusion: rank-based, so BM25's unbounded scores and cosine's need not agree. */
export function fuseRrf(lists: number[][], k = 60): { id: number; score: number }[] {
	const scores = new Map<number, number>();
	for (const ranked of lists) {
		ranked.forEach((id, index) => {
			scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
		});
	}
	// Score desc, then id desc: without the second key a tie would order by insertion history.
	return [...scores.entries()]
		.sort((a, b) => b[1] - a[1] || b[0] - a[0])
		.map(([id, score]) => ({ id, score }));
}

/** Drop the lowest-ranked blocks until the text fits, never splitting a block. */
export function applyTokenBudget<T extends { body: string }>(ranked: T[], maxTokens: number): T[] {
	let used = 0;
	const kept: T[] = [];
	for (const item of ranked) {
		used += estimateTokens(item.body);
		if (used > maxTokens) break;
		kept.push(item);
	}
	return kept;
}

/** Words, lower-cased: FTS tokens and frame tokens are the same thing, and case is not a value. */
function wordTokens(text: string): string[] {
	return (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((word) => word.length > 0);
}

/** FTS5 query syntax is not user text: quote each word so a `"` or `:` cannot break the match. */
function ftsQuery(query: string): string {
	return wordTokens(query).map((term) => `"${term}"`).join(" OR ");
}

/**
 * The origin rule as SQL, so both halves of a search ask the same question. Bound parameters, because the
 * values are the four `origin_class` names the schema's CHECK constraint already allows.
 */
function originFilter(origins?: readonly OriginClass[]): string {
	return origins?.length ? ` AND memories.origin_class IN (${origins.map(() => "?").join(", ")})` : "";
}

/** What differs between two rows that otherwise say the same thing: `8080` was, `9090` is now. */
export interface ValueSwap {
	/** Only in the row already stored. */
	was: string[];
	/** Only in the write that replaces it. */
	now: string[];
}

/** Shared tokens below this are not the same fact about the same thing, just similar wording. */
const FRAME_TOKENS = 3;
/** A longer difference than this is a different fact, not the value of the same one. Measured
 * (`scripts/benchmark-nli.ts`, 2026-10-11): every real value swap in the pair set differs by 1–2 tokens
 * (port, version, path, time, count, host name, polarity); 3-token spans were reworded copies —
 * "deployments go to the small box" against "the deploy target is the small box" — which the rule used to
 * retire as if the value had changed. */
const VALUE_TOKENS = 2;

/**
 * The one contradiction that needs no model: two rows that agree on every token except a short value
 * span are the same fact with a new value. This is a token-frame test, not a meaning test — it decides
 * the class that cosine cannot (a value swap measures 0.95–0.98, above `NEAR_DUPLICATE`) and nothing
 * else: “prefer bun over pnpm” against “we use pnpm, never npm” shares no frame and is the judge's
 * work (docs/memory.md Phase 4). The shared-frame guard is what keeps “the deploy port is 8080” and
 * "the deploy host is 10.0.0.5" — same shape, different key — from looking like a changed value.
 * shortcut: token-level, so paraphrase and negation-with-reordering are out of reach by construction —
 * the NLI judge behind the `classify` seam owns those, not a wider threshold here.
 */
export function valueSwap(body: string, other: string): ValueSwap | undefined {
	const diff = frameDiff(body, other);
	return diff?.swap ? { was: diff.was, now: diff.now } : undefined;
}

/**
 * The token frame: the words two rows share are the fact's frame, the words they do not are its value.
 * `swap` asks whether that difference is small enough to be one changed value. One side empty means one
 * row contains all the other's tokens — an extension, not a conflict — and no shared frame means these
 * are not the same fact at all, so there is nothing to compare.
 */
function frameDiff(body: string, other: string): { was: string[]; now: string[]; swap: boolean } | undefined {
	const words = new Set(wordTokens(body));
	const theirs = new Set(wordTokens(other));
	if ([...words].filter((word) => theirs.has(word)).length < FRAME_TOKENS) return undefined;
	const now = [...words].filter((word) => !theirs.has(word));
	const was = [...theirs].filter((word) => !words.has(word));
	if (now.length === 0 || was.length === 0) return undefined;
	return { was, now, swap: now.length <= VALUE_TOKENS && was.length <= VALUE_TOKENS };
}

/**
 * Same frame, and the difference is bigger than one value can be: these are two facts about different
 * keys — "the deploy port is 8080" against "the deploy host is 10.0.0.5". The NLI judge calls that pair
 * a contradiction at 1.00 confidence (measured, `scripts/benchmark-nli.ts`), because "does B follow from
 * A" is not the question "are these different facts". This is what answers that, and it is the reason a
 * judge may be allowed near the supersede path at all.
 */
export function differentKey(body: string, other: string): boolean {
	const diff = frameDiff(body, other);
	return diff !== undefined && !diff.swap;
}

const now = () => new Date().toISOString();

/**
 * Actors that are not a human in a live conversation: `fork` is the review fork's mount principal
 * (src/memory/mcp.ts) and `sweep` is the consolidation pass's. Neither may tombstone a row.
 */
const UNATTENDED_ACTORS: readonly string[] = ["sweep", "fork"];

/**
 * How long a write waits for the judge. A fact must not be held hostage by a model: 2 s is ~300 pairs at
 * measured latency, so it only fires when the model is broken or the process is starved. The row is then
 * written with no judgment, and `notJudged` says so (docs/memory.md, "the row is written whatever the
 * judge does"). Injectable only so a test can prove the bound without waiting two seconds.
 */
const JUDGE_BUDGET_MS = 2000;

export class MemoryStore {
	private readonly embedder: Embedder;

	constructor(
		private readonly db: DatabaseSync,
		embedder: Embedder = noneEmbedder(),
		options: { classify?: ContradictionClassifier; judgeBudgetMs?: number } = {},
	) {
		this.embedder = embedder;
		this.classify = options.classify;
		this.judgeBudgetMs = options.judgeBudgetMs ?? JUDGE_BUDGET_MS;
	}

	private readonly classify?: ContradictionClassifier;
	private readonly judgeBudgetMs: number;

	/**
	 * One pass over the nearest rows, one classifier call, no recursion. A classifier that throws, or one
	 * that does not answer inside its budget, is a store with no opinion: the write still happens and the
	 * result says why nothing was judged, because losing a fact is worse than missing a contradiction
	 * (docs/memory.md, "a daemon crash must never lose a fact").
	 */
	private async judgeContradiction(
		body: string,
		candidates: { id: number; score: number }[],
	): Promise<{ verdict?: { verdict: ContradictionVerdict; target: number }; reason?: string }> {
		if (!this.classify || candidates.length === 0) return {};
		const shown = candidates.map((candidate) => ({ ...candidate, body: this.memory(candidate.id)?.body ?? "" }));
		const pending = this.classify(body, shown);
		// Abandoning the call must not leave an unhandled rejection behind.
		pending.catch(() => undefined);
		let budget: ReturnType<typeof setTimeout> | undefined;
		try {
			const verdict = await Promise.race([
				pending,
				new Promise<undefined>((resolve) => {
					budget = setTimeout(() => resolve(undefined), this.judgeBudgetMs);
					budget.unref?.();
				}),
			]);
			if (!verdict) return { reason: `no contradiction judgment: the judge did not answer in ${this.judgeBudgetMs} ms` };
			const target = shown.find((candidate) => candidate.id === verdict.target);
			if (!target) return {};
			// The frame test outranks the model on one question it was not trained for: two rows about
			// different keys are not a contradiction, however confidently the judge says so.
			if (verdict.verdict === "contradict" && differentKey(body, target.body)) return {};
			return { verdict: { verdict: verdict.verdict, target: target.id } };
		} catch (error) {
			return { reason: `no contradiction judgment: ${(error as Error).message}` };
		} finally {
			if (budget) clearTimeout(budget);
		}
	}

	createConversation(conversation: { id: string; cwd: string; title?: string; sessionFile?: string }): void {
		this.db
			.prepare("INSERT INTO conversations (id, cwd, title, pi_session_file, created_at) VALUES (?, ?, ?, ?, ?)")
			.run(conversation.id, conversation.cwd, conversation.title ?? null, conversation.sessionFile ?? null, now());
	}

	/**
	 * The conversation row a turn refers to, created only if it is not there. This is the first thing the
	 * memory server ever hears about a flypi conversation, so it has to be able to name one — and a turn
	 * after a restart must not fail on the row the first turn already wrote.
	 */
	ensureConversation(conversation: { id: string; cwd?: string; sessionFile?: string }): void {
		this.db
			.prepare(
				`INSERT INTO conversations (id, cwd, title, pi_session_file, created_at) VALUES (?, ?, NULL, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET pi_session_file = COALESCE(conversations.pi_session_file, excluded.pi_session_file)`,
			)
			.run(conversation.id, conversation.cwd ?? process.cwd(), conversation.sessionFile ?? null, now());
	}

	/**
	 * One turn of one conversation, redacted on the way in (src/secrets/redact.ts — Phase 5.5 made that
	 * boundary real, and the plan asks for `tool_calls_json` to be redacted too: the result of a tool call is
	 * where a credential is most likely to appear). `retrieved`/`cited` are
	 * the ids the turn was shown and the ids its reply actually cited — kept apart because retrieval is not
	 * citation, and the gap between them is the metric (see `memoryHitRate`).
	 */
	recordTurn(
		conversationId: string,
		turn: {
			userText: string;
			assistantText?: string;
			toolCalls?: unknown;
			usage?: unknown;
			retrieved?: number[];
			cited?: number[];
		},
	): number {
		const result = this.db
			.prepare(
				`INSERT INTO turns (conversation_id, user_text, assistant_text, tool_calls_json, usage_json, retrieved_json, cited_json, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				conversationId,
				redactSecrets(turn.userText),
				turn.assistantText === undefined ? null : redactSecrets(turn.assistantText),
				turn.toolCalls === undefined ? null : redactSecrets(JSON.stringify(turn.toolCalls)),
				turn.usage === undefined ? null : JSON.stringify(turn.usage),
				turn.retrieved === undefined ? null : JSON.stringify(turn.retrieved),
				turn.cited === undefined ? null : JSON.stringify(turn.cited),
				now(),
			);
		return Number(result.lastInsertRowid);
	}

	/**
	 * Automatic recall, measured: of the turns that were shown memories, how many cited one. A fact that
	 * was injected and never used cost prompt tokens and earned nothing, which is the question the
	 * hit-rate metrics ask (docs/memory.md Phase 4) and the reason both lists are logged separately.
	 */
	memoryHitRate(): {
		turns: number;
		turns_shown_memories: number;
		turns_citing: number;
		memories_retrieved: number;
		memories_cited: number;
		rate: number;
	} {
		const row = this.db
			.prepare(
				`SELECT count(*) AS turns,
				        coalesce(sum(retrieved_json IS NOT NULL AND retrieved_json <> '[]'), 0) AS shown,
				        coalesce(sum(cited_json IS NOT NULL AND cited_json <> '[]'), 0) AS citing,
				        coalesce(sum(json_array_length(retrieved_json)), 0) AS retrieved,
				        coalesce(sum(json_array_length(cited_json)), 0) AS cited
				 FROM turns`,
			)
			.get() as { turns: number; shown: number; citing: number; retrieved: number; cited: number };
		return {
			turns: row.turns,
			turns_shown_memories: row.shown,
			turns_citing: row.citing,
			memories_retrieved: row.retrieved,
			memories_cited: row.cited,
			rate: row.shown === 0 ? 0 : row.citing / row.shown,
		};
	}

	/**
	 * Store a memory — or point at the one already there. The write-time dedup gate (docs/memory.md):
	 * the same body, or a vector this close (`NEAR_DUPLICATE`) to an active one, is the same fact, so a retried
	 * write is safe. A write that *supersedes* is never swallowed: it is deliberately a near copy.
	 *
	 * The vector is written only when the current index identity produced it, so a row can never carry
	 * a vector from a model the search will not filter for. When the embedder refuses an input — it is
	 * longer than the model's window, the audio does not decode — the row is still stored without a
	 * vector and `notIndexed` says why: keyword search reaches it, and nothing is half-read in silence.
	 */
	async addMemory(memory: NewMemory): Promise<{
		id: number;
		duplicateOf: number | null;
		/** Set when this write replaced the active row it contradicts — whether the token frame said so or a judge did. */
		contradicted?: { id: number; body: string };
		notIndexed?: string;
		/** Set when a judge was configured and answered nothing — it threw, timed out, or named no row. */
		notJudged?: string;
	}> {
		const body = redactSecrets(memory.body);
		const exact = this.db.prepare("SELECT id FROM memories WHERE status = 'active' AND body = ?").get(body) as { id: number } | undefined;
		if (exact) return { id: exact.id, duplicateOf: exact.id };

		const embedded: EmbedResult = memory.media
			? await this.embedder.embedMedia(memory.media)
			: await this.embedder.embedDocument(body);
		const vector = embedded.ok ? embedded.vector : null;
		const identity = vector ? this.embedder.identity : null;
		// The near-duplicate gate is text-only: the threshold is tuned on text, and two different files
		// that happen to embed alike are not the same memory. One candidate fetch answers both write-time
		// questions — which of these rows is a copy of this write, and which of them this write corrects.
		// No origin filter here on purpose: a copy is a copy whoever wrote it.
		const candidates =
			vector && memory.supersedes === undefined && !memory.media ? this.vectorSearch(vector, CONTRADICTION_CANDIDATES) : [];
		// A row `valueSwap` matches is never the first: a correction reads as a near-duplicate to the
		// vectors, and refusing it would lose the fact. Bodies are re-read by id (≤ 5, the cap above).
		const conflicts = candidates
			.map((candidate) => ({ id: candidate.id, swap: valueSwap(body, this.memory(candidate.id)?.body ?? "") }))
			.filter((candidate): candidate is { id: number; swap: ValueSwap } => candidate.swap !== undefined);
		const near = candidates.find((hit) => hit.score >= NEAR_DUPLICATE && !conflicts.some((conflict) => conflict.id === hit.id));
		if (near) return { id: near.id, duplicateOf: near.id };
		// The judge is asked even when the token rule already matched: the model reading the pair as the
		// same fact in other words is the one thing that can veto the rule, and at ~6 ms a pair the cost
		// is not the reason to skip it. It sees the same ≤ 5 candidates, once, never recursively.
		const judged = await this.judgeContradiction(body, candidates);
		const verdict = judged.verdict;
		if (verdict?.verdict === "duplicate") {
			return { id: verdict.target, duplicateOf: verdict.target, ...(judged.reason ? { notJudged: judged.reason } : {}) };
		}
		// `extend` is the model saying this is the same fact, told in more words — measured, the class the
		// token rule gets wrong. A deterministic value swap still wins over a model that saw nothing.
		const restatement = verdict?.verdict === "extend";
		const supersedes =
			memory.supersedes ??
			(restatement ? undefined : conflicts[0]?.id) ??
			(verdict?.verdict === "contradict" ? verdict.target : undefined);
		const result = this.db
			.prepare(
				`INSERT INTO memories
					(kind, body, tags, embedding, embed_model, dims, embed_quantized, embedded_at, modality,
					 origin_class, session_kind, strength, supersedes, created_at, session_id, turn_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				memory.kind,
				body,
				JSON.stringify(memory.tags ?? []),
				vector ? Buffer.from(vector.buffer) : null,
				identity?.model ?? null,
				vector?.length ?? null,
				identity ? (identity.quantized ? 1 : 0) : null,
				vector ? now() : null,
				memory.media?.kind ?? "text",
				memory.origin_class,
				memory.session_kind,
				memory.strength ?? 1.0,
				supersedes ?? null,
				now(),
				memory.session_id ?? null,
				memory.turn_id ?? null,
			);
		const id = Number(result.lastInsertRowid);
		if (memory.media) {
			this.db
				.prepare("INSERT INTO media (memory_id, kind, mime, path, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)")
				.run(id, memory.media.kind, memory.media.mime, memory.media.path, Buffer.from(memory.media.bytes), now());
		}
		this.audit(id, "create", memory.actor, {}, memory.reason);
		// A contradiction is recorded on both sides: the new row points at what it replaces, and the old
		// row keeps its pre-image in the audit, so "what did we believe before" stays answerable.
		if (supersedes !== undefined && (conflicts.length || verdict?.verdict === "contradict")) {
			const conflict = conflicts[0];
			this.markSuperseded(
				supersedes,
				id,
				memory.actor,
				memory.reason ??
					(conflict
						? `same fact, new value: ${conflict.swap.was.join(" ")} → ${conflict.swap.now.join(" ")}`
						: "contradiction micro-call"),
			);
			return {
				id,
				duplicateOf: null,
				contradicted: { id: supersedes, body: this.memory(supersedes)?.body ?? "" },
				...(embedded.ok ? {} : { notIndexed: embedded.error }),
				...(judged.reason ? { notJudged: judged.reason } : {}),
			};
		}
		return {
			id,
			duplicateOf: null,
			...(embedded.ok ? {} : { notIndexed: embedded.error }),
			...(judged.reason ? { notJudged: judged.reason } : {}),
		};
	}

	memory(id: number): MemoryRow | undefined {
		const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
		return row ? this.mapRow(row as Record<string, unknown>) : undefined;
	}

	/** Text search (FTS5) fused with the semantic search, in one rank order. */
	async search(options: SearchOptions): Promise<SearchResult> {
		const limit = Math.max(1, Math.min(options.limit ?? 5, 50));
		const candidates = limit * 2;
		const origins = options.injectableOnly ? INJECTABLE_ORIGINS : undefined;
		const lists: number[][] = [this.ftsSearch(options.query, candidates, origins)];

		let partial = this.embedder.identity === null;
		let note = this.embedder.error;
		if (!partial) {
			const query = await this.embedder.embedQuery(options.query);
			if (query.ok) lists.push(this.vectorSearch(query.vector, candidates, origins).map((hit) => hit.id));
			else {
				partial = true;
				note = `the query could not be embedded (${query.error}); results are keyword-only`;
			}
		}

		const ranked = fuseRrf(lists);
		const byId = new Map(ranked.map((hit) => [hit.id, hit.score]));
		const ordered = ranked
			.map((hit) => this.memory(hit.id))
			.filter((row): row is MemoryRow => row !== undefined && row.status === "active" && (!origins || origins.includes(row.origin_class)))
			.map((row) => ({ row, score: (byId.get(row.id) ?? 0) * rankFactors(row, halfLifeDaysFor(row.kind)) }))
			// Same-fact pairs keep their better-ranked half.
			.filter((entry, index, all) => !all.slice(0, index).some((earlier) => sameFact(earlier.row.body, entry.row.body)))
			// RRF ties order by id desc; a tie after the factors is still that tie, so keep the same key.
			.sort((a, b) => b.score - a.score || b.row.id - a.row.id)
			.slice(0, limit);
		const scoreOf = new Map(ordered.map((entry) => [entry.row.id, entry.score]));
		const ftsHits = new Set(lists[0]);
		const vectorHits = new Set(lists.length > 1 ? lists[1] : []);
		const results: ScoredMemory[] = applyTokenBudget(ordered.map((entry) => entry.row), options.maxTokens ?? Infinity).map((row) => ({
			...row,
			score: scoreOf.get(row.id) ?? 0,
			matched_by: ftsHits.has(row.id) && vectorHits.has(row.id) ? "both" : ftsHits.has(row.id) ? "fts" : "vector",
		}));
		if (options.count !== false && results.length > 0) this.bumpUseCount(results.map((row) => row.id));
		return { results, partial, ...(note ? { note } : {}) };
	}

	/**
	 * Keyword half. `status='active'` and the origin filter live in the SQL for both halves, so a row that
	 * is not eligible cannot come back through the door the other half opened — and cannot spend the token
	 * budget, the candidate slots, or a retrieval count that a filtered row never earned.
	 */
	private ftsSearch(query: string, limit: number, origins?: readonly OriginClass[]): number[] {
		const match = ftsQuery(query);
		if (!match) return [];
		const rows = this.db
			.prepare(
				`SELECT memories_fts.rowid AS id
				 FROM memories_fts
				 JOIN memories ON memories.id = memories_fts.rowid
				 WHERE memories_fts MATCH ? AND memories.status = 'active'${originFilter(origins)}
				 ORDER BY bm25(memories_fts) ASC, id DESC
				 LIMIT ?`,
			)
			.all(match, ...(origins ?? []), limit) as { id: number }[];
		return rows.map((row) => row.id);
	}

	/**
	 * Semantic half: one scan of the vectors that belong to *this* index.
	 *
	 * shortcut: full scan + cosine in JS, which is fine up to a few tens of thousands of rows;
	 * when it is not, the `sqlite-vec` path plugs in here (its filters stay the same SQL ones).
	 */
	vectorSearch(queryVector: Float32Array, limit = 20, origins?: readonly OriginClass[]): { id: number; score: number }[] {
		const identity = this.embedder.identity;
		if (!identity) return [];
		const rows = this.db
			.prepare(
				`SELECT id, embedding FROM memories
				 WHERE status = 'active' AND embedding IS NOT NULL
				   AND embed_model = ? AND embed_quantized = ? AND dims = ?${originFilter(origins)}`,
			)
			.all(identity.model, identity.quantized ? 1 : 0, queryVector.length, ...(origins ?? [])) as { id: number; embedding: Uint8Array }[];
		return rows
			.map((row) => ({ id: row.id, score: cosine(queryVector, new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4)) }))
			// A vector at right angles to the query is not a near miss, it is unrelated; returning it
			// would spend the token budget on noise.
			.filter((hit) => hit.score > 0)
			.sort((a, b) => b.score - a.score || b.id - a.id)
			.slice(0, limit);
	}

	/** The bytes of a memory's image or recording, for whoever has to show or play it. */
	mediaBytes(memoryId: number): { kind: MediaKind; mime: string; path: string; bytes: Uint8Array } | undefined {
		return this.db
			.prepare("SELECT kind, mime, path, bytes FROM media WHERE memory_id = ? ORDER BY id DESC")
			.get(memoryId) as { kind: MediaKind; mime: string; path: string; bytes: Uint8Array } | undefined;
	}

	/** The only automatic transition. Both rows stay; the pre-image is written first. */
	markSuperseded(id: number, byId: number, actor: string, reason?: string): void {
		const row = this.memory(id);
		if (!row) throw new Error(`memory ${id} does not exist`);
		if (row.status !== "active") throw new Error(`memory ${id} is ${row.status}, only an active memory can be superseded`);
		this.db
			.prepare("UPDATE memories SET status = 'superseded', superseded_by = ? WHERE id = ?")
			.run(byId, id);
		this.db.prepare("UPDATE memories SET supersedes = ? WHERE id = ?").run(id, byId);
		this.audit(id, "supersede", actor, row, reason);
	}

	/** Reachable only from an explicit call (the browser, or `memory_forget` when the user asked). */
	forget(id: number, actor: string, reason?: string): void {
		// The one `if` that carries the whole unattended-writer story (docs/memory.md Phase 6): a background
		// pass may add and supersede, and may not make a row disappear. The MCP background mount already
		// refuses the *tool* (src/memory/mcp.ts); this is the same rule at the store, which is where a sweep,
		// a job handler or a script arrives with an actor name of its own instead of a tool call.
		if (UNATTENDED_ACTORS.includes(actor)) {
			throw new Error(`memory ${id} cannot be forgotten by ${actor}: an unattended pass may supersede a row, never delete one`);
		}
		const row = this.memory(id);
		if (!row) throw new Error(`memory ${id} does not exist`);
		if (row.status === "deleted") return;
		this.db.prepare("UPDATE memories SET status = 'deleted' WHERE id = ?").run(id);
		this.audit(id, "forget", actor, row, reason);
	}

	/** `cited_count` moves only when the model actually cited `#id` — retrieval is not citation. */
	/** Returns whether a row was actually bumped — an id that does not exist is not a citation. */
	markCited(id: number): boolean {
		return this.db.prepare("UPDATE memories SET cited_count = cited_count + 1, last_verified_at = ? WHERE id = ?").run(now(), id).changes > 0;
	}

	private bumpUseCount(ids: number[]): void {
		const statement = this.db.prepare("UPDATE memories SET use_count = use_count + 1 WHERE id = ?");
		for (const id of ids) statement.run(id);
	}

	/**
	 * Does the stored index match the embeddings we can produce now? A mismatch is reported and
	 * queued, never papered over by searching two vector spaces together (risk 7).
	 *
	 * Only active rows count as the index: `vectorSearch` reads nothing else, so a stale vector on a
	 * superseded or deleted row is not something anyone can get a wrong answer from, and counting it
	 * would keep a re-embed job open forever.
	 */
	indexIdentity(): { expected: EmbedIdentity | null; rows: number; stale: number; reembedQueued: boolean } {
		const { expected, rows, stale } = this.indexSummary();
		return {
			expected,
			rows,
			stale,
			reembedQueued: stale > 0 && this.queueReembed(`${stale} of ${rows} vectors are from another model or quantization`).length > 0,
		};
	}

	/**
	 * The same reading without the queue: opening the Memory tab must not put a job in the daemon's queue,
	 * and a process holding the store read-only could not write one. `indexIdentity` is this plus the queue.
	 */
	indexSummary(): { expected: EmbedIdentity | null; rows: number; stale: number } {
		const expected = this.embedder.identity;
		const all = this.db
			.prepare("SELECT embed_model AS model, embed_quantized AS quantized, count(*) AS n FROM memories WHERE embedding IS NOT NULL AND status = 'active' GROUP BY embed_model, embed_quantized")
			.all() as { model: string; quantized: number; n: number }[];
		const rows = all.reduce((total, group) => total + group.n, 0);
		const stale = all
			.filter((group) => group.model !== expected?.model || Boolean(group.quantized) !== expected?.quantized)
			.reduce((total, group) => total + group.n, 0);
		return { expected, rows, stale };
	}

	/** Queue `memory.reembed`. An already-open job is not queued twice, but it is made due again. */
	queueReembed(reason: string): number[] {
		return this.queueJob("memory.reembed", { payload: { reason } });
	}

	/**
	 * Re-embed what the current index cannot represent — which is exactly what switching embedding models
	 * leaves behind (every bge-small vector, and anything written before embeddings were on). Media is
	 * re-embedded from the bytes in the database, so a file that has since moved does not lose its memory.
	 *
	 * The report is the point: “semantic search now covers 8 of your 21 memories” has to be sayable before
	 * the switch rather than discovered a week later. Rows the model refuses stay unindexed and say why.
	 * Only `active` rows are touched — the same set `vectorSearch` reads, which is what lets the report
	 * above reach zero.
	 */
	async reembed(actor = "reembed"): Promise<{ embedded: number[]; skipped: { id: number; why: string }[] }> {
		const identity = this.embedder.identity;
		if (!identity) return { embedded: [], skipped: [{ id: 0, why: this.embedder.error ?? "embeddings are off" }] };
		const stale = this.db
			.prepare(
				`SELECT id, body, modality FROM memories
				 WHERE status = 'active' AND (embedding IS NULL OR embed_model IS NOT ? OR embed_quantized IS NOT ?)
				 ORDER BY id`,
			)
			.all(identity.model, identity.quantized ? 1 : 0) as { id: number; body: string; modality: string }[];
		const embedded: number[] = [];
		const skipped: { id: number; why: string }[] = [];
		for (const row of stale) {
			let result: EmbedResult;
			if (row.modality === "text") {
				result = await this.embedder.embedDocument(row.body);
			} else {
				const media = this.mediaBytes(row.id);
				if (!media) {
					skipped.push({ id: row.id, why: "no media row is attached to it" });
					continue;
				}
				try {
					result = await this.embedder.embedMedia(media);
				} catch (error) {
					skipped.push({ id: row.id, why: `its stored bytes could not be decoded: ${(error as Error).message}` });
					continue;
				}
			}
			if (!result.ok) {
				skipped.push({ id: row.id, why: result.error });
				continue;
			}
			this.audit(row.id, "reembed", actor, this.memory(row.id), `re-embedded with ${identity.model}`);
			this.db
				.prepare("UPDATE memories SET embedding = ?, embed_model = ?, embed_quantized = ?, dims = ?, embedded_at = ? WHERE id = ?")
				.run(Buffer.from(result.vector.buffer), identity.model, identity.quantized ? 1 : 0, result.vector.length, now(), row.id);
			embedded.push(row.id);
		}
		// The job closes when nothing is left for it to fix — not merely because this pass wrote something.
		// A row the model refuses has no vector and is not a stale index (the write path reports it), so it
		// does not hold the job open.
		const left = this.db
			.prepare("SELECT count(*) AS n FROM memories WHERE status = 'active' AND embedding IS NOT NULL AND (embed_model IS NOT ? OR embed_quantized IS NOT ?)")
			.get(identity.model, identity.quantized ? 1 : 0) as { n: number };
		if (left.n === 0) this.db.prepare("DELETE FROM jobs WHERE kind = 'memory.reembed' AND locked_by IS NULL").run();
		return { embedded, skipped };
	}

	/**
	 * Every active row, oldest first — what a consolidation pass clusters over. It reads every status the
	 * search filters out of, because the sweep's whole job is the rows nobody queries.
	 */
	activeMemories(): MemoryRow[] {
		return (this.db.prepare("SELECT * FROM memories WHERE status = 'active' ORDER BY id").all() as unknown as Record<string, unknown>[]).map((row) =>
			this.mapRow(row),
		);
	}

	/**
	 * The vectors of the active rows in the **current** index, keyed by id — what the sweep clusters with.
	 * A row with no vector, or one from another model or quantization, is absent rather than guessed at: a
	 * vector is only comparable inside one index (risk 7), and those rows are what `memory.reembed` fixes.
	 * shortcut: one scan holding every vector, like `vectorSearch`'s full scan; the same place `sqlite-vec`
	 * would plug in when the store outgrows it.
	 */
	activeVectors(): Map<number, Float32Array> {
		const identity = this.embedder.identity;
		if (!identity) return new Map();
		const rows = this.db
			.prepare(
				`SELECT id, embedding FROM memories
				 WHERE status = 'active' AND embedding IS NOT NULL AND embed_model = ? AND embed_quantized = ?`,
			)
			.all(identity.model, identity.quantized ? 1 : 0) as { id: number; embedding: Uint8Array }[];
		return new Map(
			rows.map((row) => [row.id, new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4)]),
		);
	}

	/**
	 * Every turn's question, what it was shown and what it cited — the promotion gates' evidence, straight out
	 * of `turns.retrieved_json`/`cited_json`. Immutable history: a merge follows these citations at read time
	 * (src/memory/consolidate.ts) rather than rewriting what a turn actually wrote.
	 */
	citationEvidence(): { userText: string; retrieved: number[]; cited: number[] }[] {
		return (this.db.prepare("SELECT user_text, retrieved_json, cited_json FROM turns ORDER BY id").all() as unknown as { user_text: string; retrieved_json: string | null; cited_json: string | null }[]).map(
			(turn) => ({
				userText: turn.user_text,
				retrieved: turn.retrieved_json ? (JSON.parse(turn.retrieved_json) as number[]) : [],
				cited: turn.cited_json ? (JSON.parse(turn.cited_json) as number[]) : [],
			}),
		);
	}

	/** How many memory rows exist, in any status. "No automatic process makes a row disappear" reads this. */
	memoryRowCount(): number {
		return Number((this.db.prepare("SELECT count(*) AS n FROM memories").get() as unknown as { n: number }).n);
	}

	/**
	 * What the sweep's trigger reads: rows written since the last sweep that *ran*, and when that was. The
	 * last sweep is the last successful `memory.consolidate` attempt in `job_runs`, so the queue's own record
	 * is the clock and there is no second piece of state to keep in step.
	 */
	sweepState(): { newRows: number; lastSweepAt: string | null } {
		const row = this.db
			.prepare(
				`SELECT (SELECT count(*) FROM memories WHERE created_at > coalesce(
				            (SELECT max(finished_at) FROM job_runs WHERE kind = 'memory.consolidate' AND status = 'ok'), '')) AS new_rows,
				        (SELECT max(finished_at) FROM job_runs WHERE kind = 'memory.consolidate' AND status = 'ok') AS last_sweep`,
			)
			.get() as unknown as { new_rows: number; last_sweep: string | null };
		return { newRows: row.new_rows, lastSweepAt: row.last_sweep };
	}

	/**
	 * The merge, exactly as the plan requires it: N active rows collapse to one survivor, the N go
	 * `superseded` (never deleted, each with its pre-image in `memory_audit`), `merged_from` records them on
	 * the survivor, and their counters move with them — which is what stops two copies of a fact from being
	 * permanently one criterion short of a promotion gate each.
	 */
	applyMerge(merge: { survivor: number; merged: number[] }, actor: string): void {
		const survivor = this.memory(merge.survivor);
		if (!survivor) throw new Error(`memory ${merge.survivor} does not exist`);
		// The pre-image of the row that is about to absorb the others, taken before anything moves.
		this.audit(survivor.id, "edit", actor, survivor, `merged ${merge.merged.map((id) => `#${id}`).join(", ")} into it`);
		let cited = survivor.cited_count;
		let used = survivor.use_count;
		for (const id of merge.merged) {
			const row = this.memory(id);
			if (!row) continue;
			cited += row.cited_count;
			used += row.use_count;
			this.markSuperseded(id, survivor.id, actor, `consolidation: the same fact as #${survivor.id}`);
		}
		this.db
			.prepare("UPDATE memories SET merged_from = ?, cited_count = ?, use_count = ? WHERE id = ?")
			.run(JSON.stringify([...survivor.merged_from, ...merge.merged]), cited, used, survivor.id);
	}

	/**
	 * Promotion is a rank change and nothing else: `strength` up, `last_verified_at` now, and a `verify`
	 * audit row saying the gates it cleared. It never writes a fact and never removes one.
	 */
	applyPromotion(id: number, actor: string): void {
		const row = this.memory(id);
		if (!row) throw new Error(`memory ${id} does not exist`);
		this.audit(id, "verify", actor, row, "promotion gates: cited by three turns across three questions, and used when it was fetched");
		this.db.prepare("UPDATE memories SET strength = ?, last_verified_at = ? WHERE id = ?").run(Math.max(row.strength, PROMOTED_STRENGTH), now(), id);
	}

	/**
	 * The browser's edit of one row's text, kind or tags. Provenance is not editable — `origin_class` and
	 * `session_kind` are code's, never an argument (docs/memory.md Phase 4) — and the body goes through the
	 * same redaction as a write, so editing cannot put a credential into a row a write would have refused.
	 */
	editMemory(id: number, patch: { body?: string; kind?: string; tags?: string[] }, actor: string, reason?: string): MemoryRow {
		const row = this.memory(id);
		if (!row) throw new Error(`memory ${id} does not exist`);
		const body = patch.body === undefined ? row.body : redactSecrets(patch.body);
		const kind = patch.kind ?? row.kind;
		const tags = patch.tags ?? row.tags;
		if (body === row.body && kind === row.kind && tags.join("\u0000") === row.tags.join("\u0000")) return row;
		this.audit(id, "edit", actor, row, reason ?? "edited in the memory browser");
		this.db.prepare("UPDATE memories SET body = ?, kind = ?, tags = ? WHERE id = ?").run(body, kind, JSON.stringify(tags), id);
		return this.memory(id)!;
	}

	/**
	 * Undo one audited change by putting its pre-image back (docs/memory.md Phase 6: "undo for anything a
	 * sweep did — with … undo restores a pre-image and changes nothing else"). Only the columns a pre-image
	 * carries are restored: the vector, the media bytes and the row's provenance did not change, so they stay
	 * exactly as they were. A `create` entry has nothing before it — undoing a write would be deleting a
	 * fact, and that is `forget`'s job, which a human asks for.
	 */
	undo(memoryId: number, auditId: number, actor: string): MemoryRow {
		const entry = this.db.prepare("SELECT id, action, pre_image FROM memory_audit WHERE id = ? AND memory_id = ?").get(auditId, memoryId) as
			| { id: number; action: AuditAction; pre_image: string }
			| undefined;
		if (!entry) throw new Error(`no audit entry #${auditId} on memory #${memoryId}`);
		const before = JSON.parse(entry.pre_image) as Partial<MemoryRow>;
		if (entry.action === "create" || Object.keys(before).length === 0) {
			throw new Error(`audit #${auditId} wrote memory #${memoryId}: undo puts back what was there before a change, it does not un-write a fact`);
		}
		const current = this.memory(memoryId);
		if (!current) throw new Error(`memory ${memoryId} does not exist`);
		// The column list is a fixed whitelist, not text from the pre-image: an audit row is data, and data
		// does not get to name columns.
		const set: string[] = [];
		const values: (string | number | null)[] = [];
		const put = (column: string, value: string | number | null): void => {
			set.push(`${column} = ?`);
			values.push(value);
		};
		if (typeof before.body === "string") put("body", redactSecrets(before.body));
		if (typeof before.kind === "string") put("kind", before.kind);
		if (before.tags) put("tags", JSON.stringify(before.tags));
		if (before.status) put("status", before.status);
		if ("supersedes" in before) put("supersedes", before.supersedes ?? null);
		if ("superseded_by" in before) put("superseded_by", before.superseded_by ?? null);
		if (before.merged_from) put("merged_from", JSON.stringify(before.merged_from));
		if (typeof before.strength === "number") put("strength", before.strength);
		if (typeof before.use_count === "number") put("use_count", before.use_count);
		if (typeof before.cited_count === "number") put("cited_count", before.cited_count);
		if ("last_verified_at" in before) put("last_verified_at", before.last_verified_at ?? null);
		this.audit(memoryId, "edit", actor, current, `undo of ${entry.action} (audit #${entry.id})`);
		this.db.prepare(`UPDATE memories SET ${set.join(", ")} WHERE id = ?`).run(...values, memoryId);
		return this.memory(memoryId)!;
	}

	/**
	 * Queue a job. Jobs are the only path a background writer takes. One row per open kind: asking again
	 * brings the existing row forward rather than adding a second copy of the same work.
	 */
	queueJob(kind: string, { payload = {}, runAt }: { payload?: unknown; runAt?: string } = {}): number[] {
		const at = runAt ?? now();
		const existing = this.db.prepare("SELECT id FROM jobs WHERE kind = ? AND locked_by IS NULL").all(kind) as { id: number }[];
		if (existing.length > 0) {
			// The row is there, but this call has new work for it, so it is due now: a pass that ran left it
			// an hour out (src/daemon/jobs.ts), and a stale index must not wait that long.
			this.db.prepare("UPDATE jobs SET next_run_at = ? WHERE kind = ? AND locked_by IS NULL").run(at, kind);
			return existing.map((row) => row.id);
		}
		const result = this.db.prepare("INSERT INTO jobs (kind, next_run_at, payload) VALUES (?, ?, ?)").run(kind, at, JSON.stringify(payload));
		return [Number(result.lastInsertRowid)];
	}

	audit(memoryId: number, action: AuditAction, actor: string, preImage: unknown, reason?: string): void {
		this.db
			.prepare("INSERT INTO memory_audit (memory_id, action, actor, pre_image, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)")
			.run(memoryId, action, actor, JSON.stringify(preImage ?? {}), reason ?? null, now());
	}

	/** What the audit says a memory went through, oldest first — the browser's "why" view reads this. */
	history(memoryId: number): AuditEntry[] {
		return (this.db.prepare("SELECT id, action, actor, pre_image, reason, created_at FROM memory_audit WHERE memory_id = ? ORDER BY id ASC").all(memoryId) as unknown as Record<string, string>[]).map(
			(row) => ({
				id: Number(row.id),
				action: row.action as AuditEntry["action"],
				actor: row.actor ?? "",
				pre_image: row.pre_image ? JSON.parse(row.pre_image) : null,
				reason: row.reason ?? null,
				created_at: row.created_at ?? "",
			}),
		);
	}

	private mapRow(row: Record<string, unknown>): MemoryRow {
		const { embedding: _embedding, embed_model: model, dims, embed_quantized: quantized, tags, merged_from, ...rest } = row;
		const media = rest.modality === "text" ? undefined : this.mediaBytes(Number(row.id));
		return {
			...rest,
			tags: JSON.parse((tags as string) || "[]"),
			merged_from: JSON.parse((merged_from as string) || "[]") as number[],
			embed: model ? { model: model as string, dims: dims as number, quantized: Boolean(quantized) } : null,
			media: media
				? { id: Number(row.id), kind: media.kind, mime: media.mime, path: media.path, bytes_size: media.bytes.byteLength }
				: null,
		} as MemoryRow;
	}
}
