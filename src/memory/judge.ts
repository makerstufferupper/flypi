/**
 * The contradiction judge (docs/memory.md Phase 4): a small local NLI cross-encoder over the rows a
 * write is already near, so "same fact, new value" and "same fact, new words" stop being a cosine
 * question. Measured (`scripts/benchmark-nli.ts`, 2026-10-11): no similarity threshold separates them —
 * the four real corrections sat at 0.95–0.98 while reworded copies sat at 0.96–0.97, and the
 * paraphrased corrections reached only 0.83–0.91.
 *
 * It is deliberately not a chat model. It takes no prompt, produces no prose, needs no credential,
 * cannot spend a turn's token budget, and answers in one batched pass: 87 MB of q8 weights, ~6 ms per
 * pair. The reasoning for that choice, and what the model gets wrong, is in docs/decisions.md.
 */
import type { JudgeConfig } from "./config.ts";
import type { ModelProgress } from "./progress.ts";
import { NEAR_DUPLICATE } from "./store.ts";
import type { ContradictionCandidate, ContradictionClassifier, ContradictionVerdict } from "./store.ts";

/** The model has 512 positions; 256 is far inside it and inside any memory body. A pair that still
 * reaches the window gets no opinion — a judgment made over a truncated sentence is not a judgment. */
const MAX_PAIR_TOKENS = 256;

/**
 * The judge's own blind side, measured: it answers `contradiction` at 0.92–1.00 for rows that are simply
 * about different things ("the deploy port is 8080" against "the deploy host is 10.0.0.5", cosine 0.8990;
 * two unrelated rows at 0.7434). NLI asks whether one sentence follows from another; "these are different
 * facts" is not that question, and the token frame in store.ts is what answers it.
 *
 * So two guards, and the floor only sits where it does because of the second one. Measured over the same
 * 21 pairs at each floor (false supersede / missed correction) — `scripts/benchmark-nli.ts --sweep`:
 * 0.95 → 0/5, 0.90 → 0/4, **0.85 → 0/3**, 0.80 → 0/2, 0.70 → 1/2, where the 0.70 miss is an unrelated
 * pair at 0.7434 that no guard can save because two sentences about different subjects share no frame.
 * Without the frame guard, 0.85 measures 1/1: the different-key pair at 0.8990 gets retired. 0.85 is the
 * lowest floor that keeps the different-key and unrelated pairs out on this set. Where it sits is a
 * property of the corpus, not of the model — the paraphrase corrections this is meant to catch measure
 * 0.8312–0.9114, so the band between 0.80 and 0.85 is the argument, and `--floor`/`--sweep` re-answer it
 * against whatever the corpus has become rather than against this comment.
 */
export const CONTRADICTION_SIMILARITY = 0.85;

/** Below this the model is not trusted to retire a fact. A missed contradiction is recoverable — the old
 * row stays active and recall de-dupes at read time — while a false one silently rewrites history. */
export const CONTRADICTION_CONFIDENCE = 0.8;

export type NliLabel = "contradiction" | "entailment" | "neutral";

/** Checkpoints disagree about which index is which label, so the name is the only safe key. */
export function labelFor(id2label: Record<string, string> | undefined, index: number): NliLabel | undefined {
	const name = id2label?.[String(index)];
	if (!name) return undefined;
	const lower = name.toLowerCase();
	if (lower.includes("contra")) return "contradiction";
	if (lower.includes("entail")) return "entailment";
	if (lower.includes("neutral")) return "neutral";
	return undefined;
}

export function softmax(logits: number[]): number[] {
	const max = Math.max(...logits);
	const weights = logits.map((value) => Math.exp(value - max));
	const total = weights.reduce((sum, value) => sum + value, 0);
	return weights.map((value) => value / total);
}

/**
 * NLI labels to the store's own vocabulary — no new verdicts, because the write gate already speaks it.
 * `extend` is not decoration here: it is the model saying "this is the same fact, said in more words",
 * which is what vetoes the token rule for a reworded copy (the one class the rule got wrong).
 */
export function verdictFor(
	label: NliLabel,
	confidence: number,
	similarity: number,
	floor: number = CONTRADICTION_SIMILARITY,
): ContradictionVerdict {
	const near = similarity >= NEAR_DUPLICATE;
	if (label === "contradiction" && similarity >= floor && confidence >= CONTRADICTION_CONFIDENCE) {
		return "contradict";
	}
	if (label === "entailment") return near ? "duplicate" : "extend";
	return near ? "extend" : "new";
}

/** One answer for the whole write: a real contradiction outranks a restatement, which outranks a detail. */
export function chooseVerdict(
	scored: { id: number; verdict: ContradictionVerdict }[],
): { verdict: ContradictionVerdict; target?: number } {
	const rank: Record<ContradictionVerdict, number> = { new: 0, extend: 1, duplicate: 2, contradict: 3 };
	let best: { id: number; verdict: ContradictionVerdict } | undefined;
	for (const row of scored) if (!best || rank[row.verdict] > rank[best.verdict]) best = row;
	return best ? { verdict: best.verdict, target: best.id } : { verdict: "new" };
}

/**
 * Load the judge, or say why there isn't one — the same shape as `createEmbedder`, because a store with
 * no judge is a supported state and not a failure (risk 8). Nothing about it is optional at the call
 * site: the row is written whatever the judge does.
 */
export async function createJudge(config: JudgeConfig, onProgress?: (progress: ModelProgress) => void): Promise<{ classify?: ContradictionClassifier; error?: string }> {
	if (config.provider === "none") return {};
	try {
		// Lazy, like the embedder: this is ~300 MB of runtime, not something a keyword-only store needs.
		const { AutoModelForSequenceClassification, AutoTokenizer } = await import("@huggingface/transformers");
		const tokenizer = await AutoTokenizer.from_pretrained(config.model, { cache_dir: config.cacheDir, ...(onProgress ? { progress_callback: onProgress } : {}) });
		// q8, measured: fp16 loads for this checkpoint (finite logits) but is 60% larger and twice the
		// latency, so there is no reason to ask for it.
		const model = await AutoModelForSequenceClassification.from_pretrained(config.model, {
			cache_dir: config.cacheDir,
			dtype: config.quantized ? "q8" : "fp32",
			...(onProgress ? { progress_callback: onProgress } : {}),
		});
		const labels = (model.config as { id2label?: Record<string, string> } | undefined)?.id2label;
		if (!labels) return { error: `${config.model} declares no labels — no contradiction judgment` };
		const classify = await nliClassifier(tokenizer, model, labels);
		return { classify };
	} catch (error) {
		return { error: `no contradiction judgment: ${(error as Error).message}` };
	}
}

/** The adapter boundary. transformers.js v4 hands back a `BatchEncoding`, whose shape is its own; only
 * the two fields this code reads are named, and everything else is passed through untouched. */
interface Encoding {
	attention_mask?: { tolist(): unknown };
	[key: string]: unknown;
}
type Tokenizer = (
	texts: string[],
	options: { text_pair: string[]; padding: boolean; truncation: boolean; max_length: number; return_token_type_ids?: boolean },
) => Encoding | Promise<Encoding>;
type Classifier = (inputs: Encoding) => Promise<{ logits: { tolist(): unknown } }>;

/** Exported for the test: this is the part that talks to a model, and it is testable without one. */
export async function nliClassifier(
	tokenizer: Tokenizer,
	model: Classifier,
	labels: Record<string, string>,
): Promise<ContradictionClassifier> {
	return async (body: string, candidates: ContradictionCandidate[]) => {
		// The stored row is the premise: the question is whether the new sentence contradicts what is
		// already true, not the other way round. One batched pass, one pass per write (never recursive).
		const premises = candidates.map((candidate) => candidate.body);
		const inputs = await tokenizer(premises, {
			text_pair: candidates.map(() => body),
			padding: true,
			truncation: true,
			max_length: MAX_PAIR_TOKENS,
			return_token_type_ids: true,
		});
		const masks = (inputs.attention_mask?.tolist() ?? []) as unknown[][];
		// int64 tensors come back as BigInt in onnxruntime-web, and `0 + 1n` throws — which would look
		// exactly like a judge that never answered.
		const truncated = masks.map((row) => row.reduce<number>((sum, value) => sum + Number(value), 0) >= MAX_PAIR_TOKENS);
		const output = await model(inputs);
		const logits = (output.logits.tolist() as unknown[][]).map((row) => row.map(Number));
		const scored: { id: number; verdict: ContradictionVerdict }[] = [];
		logits.forEach((row, index) => {
			const candidate = candidates[index];
			if (!candidate || truncated[index]) return; // no opinion about a pair we could not read whole
			const probabilities = softmax(row);
			if (probabilities.some((value) => !Number.isFinite(value))) return; // a dtype that returns NaN is not an answer
			const top = probabilities.indexOf(Math.max(...probabilities));
			const label = labelFor(labels, top);
			if (!label) return;
			scored.push({ id: candidate.id, verdict: verdictFor(label, probabilities[top] ?? 0, candidate.score) });
		});
		return chooseVerdict(scored);
	};
}
