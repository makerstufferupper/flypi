import { describe, expect, it } from "vitest";
import { flypiPaths } from "../../src/agent/paths.ts";
import { EMBED_MODEL, JUDGE_MODEL, memoryConfig, parseMemoryConfig } from "../../src/memory/config.ts";
import { cosine, createEmbedder, EMBED_WINDOW_TOKENS, noneEmbedder, overWindow, type EmbedResult } from "../../src/memory/embed.ts";
import { createTempFlypiRoot, withProviderConfig } from "../helpers/flypi-root.ts";
import { pcmWav, sine } from "../helpers/wav.ts";

describe("memory config", () => {
	const paths = flypiPaths("/repo");

	it("defaults to the chosen model, quantized, cached under .flypi", () => {
		expect(memoryConfig(paths).embeddings).toEqual({
			provider: "transformers",
			model: EMBED_MODEL,
			quantized: true,
			cacheDir: "/repo/.flypi/models",
		});
	});

	it("a settings file can choose FTS-only, which is a decision rather than a failure", () => {
		expect(parseMemoryConfig({ memory: { embeddings: { provider: "none" } } }, paths).embeddings.provider).toBe("none");
	});

	it("the index identity parts are read, because a different model is a different vector space", () => {
		const config = parseMemoryConfig(
			{ memory: { embeddings: { model: "Xenova/multilingual-e5-small", quantized: false, cacheDir: "/models" } } },
			paths,
		);
		expect(config.embeddings).toMatchObject({ model: "Xenova/multilingual-e5-small", quantized: false, cacheDir: "/models" });
	});

	it("the review fork counts ten delivered answers by default, and 0 switches it off", () => {
		// A config key with an off switch, like the judge: a fork is a whole model run with no human in the loop.
		expect(memoryConfig(paths).review).toEqual({ interval: 10 });
		expect(parseMemoryConfig({ memory: { reviewInterval: 3 } }, paths).review).toEqual({ interval: 3 });
		expect(parseMemoryConfig({ memory: { reviewInterval: 0 } }, paths).review).toEqual({ interval: 0 });
		// Junk stays at the default rather than becoming "fork on every turn".
		for (const junk of [true, "10", -1, 2.5, null]) {
			expect(parseMemoryConfig({ memory: { reviewInterval: junk } }, paths).review.interval, String(junk)).toBe(10);
		}
	});

	it("a half-written block cannot produce a half-known index identity", () => {
		// An empty model string would otherwise let a row be stored with no model name on it.
		expect(parseMemoryConfig({ memory: { embeddings: { model: "" } } }, paths).embeddings.model).toBe(EMBED_MODEL);
	});

	it("the contradiction judge defaults to the measured checkpoint, in the same cache", () => {
		// A second resident model is a decision the store makes, not one the settings file gets to omit.
		expect(memoryConfig(paths).judge).toEqual({
			provider: "transformers",
			model: JUDGE_MODEL,
			quantized: true,
			cacheDir: "/repo/.flypi/models",
		});
	});

	it("the judge can be turned off on its own, without touching the embeddings", () => {
		// The judge is ~400 MB of RSS on top of the embedder, so "no" has to be expressible per model.
		const config = parseMemoryConfig({ memory: { judge: { provider: "none" } } }, paths);
		expect(config.judge.provider).toBe("none");
		expect(config.embeddings.provider).toBe("transformers");
	});

	it("reads the real settings file", () => {
		const root = createTempFlypiRoot();
		withProviderConfig(root, { memory: { embeddings: { provider: "none" } } });
		expect(memoryConfig(flypiPaths(root)).embeddings.provider).toBe("none");
	});
});

describe("embedders", () => {
	it("the FTS-only embedder has no identity and keeps its reason", () => {
		const embedder = noneEmbedder("model not downloaded");
		expect(embedder.identity).toBeNull();
		expect(embedder.error).toBe("model not downloaded");
	});

	it("provider none never loads a model", async () => {
		const embedder = await createEmbedder({ provider: "none", model: EMBED_MODEL, quantized: true, cacheDir: "/tmp" });
		expect(embedder.identity).toBeNull();
		expect(await embedder.embedQuery("anything")).toEqual({ ok: false, error: "embeddings are not configured" });
	});

	it("refuses an input over the model's window instead of reading part of it", () => {
		expect(overWindow(EMBED_WINDOW_TOKENS)).toBeUndefined();
		expect(overWindow(EMBED_WINDOW_TOKENS + 1)).toMatch(/8193 tokens, over the 8192-token window/);
		// The reason says what to do, because the caller has to act on it: split the memory, or shorten it.
		expect(overWindow(9000)).toMatch(/split it into two memories/);
	});

	it("a model that cannot be loaded degrades to keywords with the reason attached", async () => {
		const embedder = await createEmbedder({
			provider: "transformers",
			model: "this/model-does-not-exist",
			quantized: true,
			cacheDir: "/tmp/flypi-missing-model",
		});
		expect(embedder.identity).toBeNull();
		expect(embedder.error).toMatch(/embeddings unavailable/);
	});

	it("cosine is 1 for parallel vectors, 0 for orthogonal, and survives unnormalised input", () => {
		expect(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBe(0);
		expect(cosine(Float32Array.from([3, 4]), Float32Array.from([6, 8]))).toBeCloseTo(1);
		expect(cosine(Float32Array.from([0, 0]), Float32Array.from([1, 1]))).toBe(0);
		expect(cosine(Float32Array.from([1, 1]), Float32Array.from([1, 1, 1]))).toBe(0); // different dims
	});
});

/**
 * The real ~870 MB model, behind a flag: CI stays FTS-only (docs/testing.md). Run with
 * `FLYPI_EMBED_TESTS=1 npm test` once `.flypi/models` is warm.
 */
describe.skipIf(!process.env.FLYPI_EMBED_TESTS)("the chosen embedding model", () => {
	const embedder = () =>
		createEmbedder({ provider: "transformers", model: EMBED_MODEL, quantized: true, cacheDir: flypiPaths(process.cwd()).modelsDir });
	const PNG_1PX =
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
	/** A gated test against a real model should fail with the model's reason, not an assertion diff. */
	const vector = (result: EmbedResult): Float32Array => {
		if (!result.ok) throw new Error(result.error);
		return result.vector;
	};

	it("answers a differently-worded question about the same fact, in 768 dimensions", async () => {
		const model = await embedder();
		expect(model.identity).toMatchObject({ model: EMBED_MODEL });

		const fact = await model.embedDocument("we use pnpm, never npm");
		const asked = await model.embedQuery("which package manager should I use?");
		const unrelated = await model.embedQuery("the deploy target is 10.0.0.7");
		expect(vector(fact).length).toBe(768);
		// Asymmetric retrieval: a query prefix and a document prefix, and the query still lands.
		expect(cosine(vector(asked), vector(fact))).toBeGreaterThan(cosine(vector(unrelated), vector(fact)));
	});

	it("embeds an image and a recording into that same space", async () => {
		const model = await embedder();
		const [image, audio, caption] = await Promise.all([
			model.embedMedia({ kind: "image", path: "pixel.png", mime: "image/png", bytes: Buffer.from(PNG_1PX, "base64") }),
			model.embedMedia({ kind: "audio", path: "voice.wav", mime: "audio/wav", bytes: pcmWav(sine(8000, 220)) }),
			model.embedDocument("a short recording of silence"),
		]);
		// One space, whatever the input: this is what lets a typed query reach a voice note. Whether the
		// *meaning* matches is what the corpus measures, not this — a 1×1 PNG has no meaning.
		for (const result of [image, audio, caption]) expect(vector(result).length).toBe(768);
		expect(Number.isFinite(cosine(vector(audio), vector(caption)))).toBe(true);
	});

	it("refuses a memory longer than the window rather than indexing part of it", async () => {
		const model = await embedder();
		const tooLong = "recorded ".repeat(EMBED_WINDOW_TOKENS);
		const result = await model.embedDocument(tooLong);
		expect(result.ok).toBe(false);
		expect((result as { error: string }).error).toMatch(/over the 8192-token window/);
	});
});
