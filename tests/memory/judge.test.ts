import { describe, expect, it } from "vitest";
import {
	CONTRADICTION_CONFIDENCE,
	CONTRADICTION_SIMILARITY,
	chooseVerdict,
	createJudge,
	labelFor,
	nliClassifier,
	softmax,
	verdictFor,
} from "../../src/memory/judge.ts";
import type { ContradictionCandidate } from "../../src/memory/store.ts";

const candidate = (id: number, body: string, score: number): ContradictionCandidate => ({ id, body, score });

/** A model whose logits are supplied by hand: label order, truncation and NaN are all decisions about
 * what the model gave us, and none of them need a 300 MB download to prove. */
function fakeModel(logits: number[][], masks?: unknown[][]) {
	return {
		tokenizer: async () => ({ attention_mask: { tolist: () => masks ?? logits.map(() => [1, 1, 1]) } }),
		model: async () => ({ logits: { tolist: () => logits } }),
	};
}

describe("the contradiction judge: NLI labels to store verdicts", () => {
	it("maps labels by name, because checkpoints disagree about which index is which", () => {
		const ours = { 0: "contradiction", 1: "entailment", 2: "neutral" };
		const theirs = { 0: "ENTAILMENT", 1: "NEUTRAL", 2: "contradiction" };
		expect(labelFor(ours, 0)).toBe("contradiction");
		expect(labelFor(theirs, 2)).toBe("contradiction");
		expect(labelFor(theirs, 0)).toBe("entailment");
		expect(labelFor(theirs, 1)).toBe("neutral");
		expect(labelFor(undefined, 0)).toBeUndefined();
		expect(labelFor({ 0: "happy" }, 0)).toBeUndefined();
	});

	it("reads probabilities off the logits", () => {
		const probabilities = softmax([2, 0, 0]);
		expect(probabilities.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
		expect(probabilities[0]!).toBeGreaterThan(probabilities[1]!);
	});

	it("refuses to call a distant pair a contradiction, however sure the model is", () => {
		// Measured: the judge answers `contradiction` at 0.92–1.00 for rows that are simply about
		// different things, so the floor is what keeps a distant pair out of the supersede path.
		expect(verdictFor("contradiction", 1, 0.8499)).toBe("new");
		expect(verdictFor("contradiction", 1, 0.7434)).toBe("new");
		expect(verdictFor("contradiction", CONTRADICTION_CONFIDENCE, CONTRADICTION_SIMILARITY)).toBe("contradict");
		// Sure of the label is not the same as the pair being close: both floors have to hold.
		expect(verdictFor("contradiction", 0.79, 0.97)).not.toBe("contradict");
		// 0.8990 does clear the floor — "the deploy port is 8080" against "the deploy host is 10.0.0.5"
		// does, at confidence 1.00. The token frame in store.ts is what stops that one, and
		// tests/memory/store.test.ts asserts it there, where both signals are in the room.
		expect(verdictFor("contradiction", 1, 0.899)).toBe("contradict");
	});

	it("separates a restatement from a detail by how close the vectors already are", () => {
		expect(verdictFor("entailment", 0.98, 0.9677)).toBe("duplicate");
		expect(verdictFor("entailment", 0.98, 0.9403)).toBe("extend"); // same fact, and not near enough to refuse
		expect(verdictFor("neutral", 1, 0.9501)).toBe("extend"); // near, and nothing follows either way
		expect(verdictFor("neutral", 1, 0.9234)).toBe("new");
		expect(verdictFor("neutral", 1, 0.8)).toBe("new");
	});

	it("answers once for the write, with the strongest signal of the candidates shown", () => {
		expect(chooseVerdict([])).toEqual({ verdict: "new" });
		expect(
			chooseVerdict([
				{ id: 1, verdict: "duplicate" },
				{ id: 2, verdict: "contradict" },
				{ id: 3, verdict: "extend" },
			]),
		).toEqual({ verdict: "contradict", target: 2 });
		expect(
			chooseVerdict([
				{ id: 1, verdict: "extend" },
				{ id: 4, verdict: "duplicate" },
			]),
		).toEqual({ verdict: "duplicate", target: 4 });
	});

	it("says there is no judge when none was asked for", async () => {
		const judge = await createJudge({ provider: "none", model: "x", quantized: true, cacheDir: "/tmp" });
		expect(judge.classify).toBeUndefined();
		expect(judge.error).toBeUndefined();
	});
});

describe("the model adapter", () => {
	const labels = { 0: "contradiction", 1: "entailment", 2: "neutral" };

	it("reads the pair it was shown and answers for the row it came from", async () => {
		const { tokenizer, model } = fakeModel([[6, 0, 0], [0, 6, 0]]);
		const classify = await nliClassifier(tokenizer as never, model as never, labels);
		const verdict = await classify("the deploy port is 9090", [
			candidate(11, "the deploy port is 8080", 0.96),
			candidate(12, "the deploy host is 10.0.0.5", 0.96),
		]);
		expect(verdict).toEqual({ verdict: "contradict", target: 11 });
	});

	it("has no opinion about a pair it could not read whole", async () => {
		// 256 is the judge's window; a pair that fills it was truncated, and a truncated judgment is
		// not a judgment.
		const { tokenizer, model } = fakeModel([[6, 0, 0]], [Array.from({ length: 256 }, () => 1)]);
		const classify = await nliClassifier(tokenizer as never, model as never, labels);
		expect(await classify("the deploy port is 9090", [candidate(11, "the deploy port is 8080", 0.96)])).toEqual({ verdict: "new" });
	});

	it("has no opinion about a model that returned NaN", async () => {
		// The EmbeddingGemma lesson: a wrong dtype can return NaN and still look like an answer.
		const { tokenizer, model } = fakeModel([[Number.NaN, Number.NaN, Number.NaN]]);
		const classify = await nliClassifier(tokenizer as never, model as never, labels);
		expect(await classify("the deploy port is 9090", [candidate(11, "the deploy port is 8080", 0.96)])).toEqual({ verdict: "new" });
	});

	it("counts an int64 mask, which comes back as BigInt", async () => {
		// The real crash this prevented: `0 + 1n` throws, and a throwing judge reads as "no contradiction".
		const { tokenizer, model } = fakeModel([[6, 0, 0]], [[1n, 1n, 1n]]);
		const classify = await nliClassifier(tokenizer as never, model as never, labels);
		expect(await classify("the deploy port is 9090", [candidate(11, "the deploy port is 8080", 0.96)])).toEqual({ verdict: "contradict", target: 11 });
	});

	it("has no opinion about a checkpoint whose labels it cannot read", async () => {
		const { tokenizer, model } = fakeModel([[6, 0, 0]]);
		const classify = await nliClassifier(tokenizer as never, model as never, { 0: "positive", 1: "negative" });
		expect(await classify("the deploy port is 9090", [candidate(11, "the deploy port is 8080", 0.96)])).toEqual({ verdict: "new" });
	});
});
