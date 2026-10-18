/**
 * The recall quality gate (docs/memory.md Phase 4): 20 questions against 20 stored facts, hit@5 at or
 * above 90%, and nothing near the 1.5k injected-token budget. It runs here, on the corpus fixture, with
 * embeddings off — because that is what CI has, and a gate nobody can run is not a gate.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { noneEmbedder } from "../../src/memory/embed.ts";
import { estimateTokens, MemoryStore } from "../../src/memory/store.ts";
import { openTestDb } from "../helpers/memory-db.ts";

interface Corpus {
	facts: { body: string; kind: string; tags: string[] }[];
	questions: { ask: string; expect: number[] }[];
}

const corpus = JSON.parse(
	readFileSync(fileURLToPath(new URL("../fixtures/recall-corpus/corpus.json", import.meta.url)), "utf8"),
) as Corpus;

describe("recall corpus, FTS-only as CI runs it", () => {
	it("finds the fact behind every question in five rows and well under the token budget", async () => {
		const store = new MemoryStore(openTestDb(), noneEmbedder());
		const ids: number[] = [];
		for (const fact of corpus.facts) {
			ids.push((await store.addMemory({ ...fact, origin_class: "owner", session_kind: "interactive", actor: "test" })).id);
		}
		expect(corpus.facts).toHaveLength(20);
		expect(corpus.questions).toHaveLength(20);

		const misses: string[] = [];
		let worstTokens = 0;
		for (const question of corpus.questions) {
			// The same bounds the recall extension uses: five rows, 1200 injected tokens.
			const results = await store.search({ query: question.ask, limit: 5, count: false, maxTokens: 1200 });
			worstTokens = Math.max(worstTokens, results.results.reduce((sum, row) => sum + estimateTokens(row.body), 0));
			const found = new Set(results.results.map((row) => row.id));
			if (!question.expect.some((index) => found.has(ids[index]!))) misses.push(question.ask);
		}

		const hits = corpus.questions.length - misses.length;
		// The documented bar is 90%, and one question is deliberately lexical-disjoint from its fact
		// ("saving the same fact twice" vs "the write gate rejects a duplicate") because keyword search
		// cannot be expected to win a paraphrase. The misses are named so a ranking change that breaks
		// this is debuggable from the failure, not by re-running the corpus by hand.
		expect({ hitAt5: `${hits}/${corpus.questions.length}`, misses: misses.slice(0, 2) }).toEqual(
			expect.objectContaining({ hitAt5: expect.stringMatching(/^(1[89]|20)\/20$/) }),
		);
		expect(hits).toBeGreaterThanOrEqual(Math.ceil(corpus.questions.length * 0.9));
		expect(worstTokens).toBeLessThan(1500);
	});
});
