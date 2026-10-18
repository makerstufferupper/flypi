/**
 * Embeddings (docs/memory.md Phase 3, docs/risks.md risk 7/8/11).
 *
 * One model, three inputs: EmbeddingGemma 2 maps text, images and audio into the same 768-dimensional
 * space, which is what lets a typed query reach a voice recording (docs/decisions.md, "Multimodal
 * memory"). The model loads once per process and is reused; `identity` is what a stored vector's
 * `embed_model`/`embed_quantized` columns must match for the two to be comparable at all. A missing or
 * under-downloaded model is not an error: it returns the FTS-only embedder *with the reason kept*, so
 * recall can say it degraded instead of pretending it did not (risk 8).
 *
 * Nothing here truncates. The tokenizer's `model_max_length` is effectively unlimited, so an input
 * longer than the model's 8,192-token window is counted and refused — a silently half-read memory is
 * the failure this replaced (a 512-token model used to index the first third of a memory and report
 * success).
 */
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbeddingsConfig } from "./config.ts";
import type { ModelProgress } from "./progress.ts";
import { decodeWav, type MemoryMedia } from "./media.ts";

export interface EmbedIdentity {
	model: string;
	quantized: boolean;
}

/** A vector, or the reason there isn't one — never a silent "close enough". */
export type EmbedResult = { ok: true; vector: Float32Array } | { ok: false; error: string };

export interface Embedder {
	/** `null` means no vectors: search is FTS-only and must report it. */
	identity: EmbedIdentity | null;
	/** Why there are no vectors, when there are none — shown to the caller, never swallowed. */
	error?: string;
	/** Asymmetric retrieval: EG2 was trained with a query prefix and a document prefix. */
	embedQuery(text: string): Promise<EmbedResult>;
	embedDocument(text: string): Promise<EmbedResult>;
	embedMedia(media: MemoryMedia): Promise<EmbedResult>;
}

/** EmbeddingGemma 2's context, shared by every modality (model card: 8,192 tokens). */
export const EMBED_WINDOW_TOKENS = 8192;

/** The window check, apart from the model so it can be tested without downloading one. */
export function overWindow(tokens: number, window = EMBED_WINDOW_TOKENS): string | undefined {
	if (tokens <= window) return undefined;
	return `input is ${tokens} tokens, over the ${window}-token window — split it into two memories, or shorten it`;
}

export function noneEmbedder(error?: string): Embedder {
	const unavailable = async () => ({ ok: false as const, error: "embeddings are not configured" });
	return {
		identity: null,
		...(error ? { error } : {}),
		embedQuery: unavailable,
		embedDocument: unavailable,
		embedMedia: unavailable,
	};
}

export async function createEmbedder(config: EmbeddingsConfig, onProgress?: (progress: ModelProgress) => void): Promise<Embedder> {
	if (config.provider === "none") return noneEmbedder();
	try {
		return await transformersEmbedder(config, onProgress);
	} catch (error) {
		return noneEmbedder(`embeddings unavailable: ${(error as Error).message}`);
	}
}

/**
 * The configured model's **identity** without loading the model. A second process that reads the memory
 * database (`npm run serve`, the dev server) has to know which vector space the stored rows are in —
 * otherwise it reports every vector as "from another model" — and it must not produce one: every embed
 * refuses, which is also what stops a read-only process quietly adding a vector it cannot reproduce.
 * No download, no ~100 MB runtime.
 */
export async function configuredIdentity(config: EmbeddingsConfig): Promise<Embedder> {
	if (config.provider === "none") return noneEmbedder();
	const unavailable = async () => ({ ok: false as const, error: "this process does not load the embedding model — `flypi start` is the one that writes vectors" });
	return {
		identity: { model: config.model, quantized: config.quantized },
		embedQuery: unavailable,
		embedDocument: unavailable,
		embedMedia: unavailable,
	};
}

const queryInstruction = (text: string) => `task: search result | query: ${text}`;
const documentInstruction = (text: string) => `title: none | text: ${text}`;

async function transformersEmbedder(config: EmbeddingsConfig, onProgress?: (progress: ModelProgress) => void): Promise<Embedder> {
	// Imported lazily: it is ~100 MB of runtime and only needed when vectors were asked for.
	const { AutoModel, AutoProcessor, RawImage } = await import("@huggingface/transformers");
	const processor = await AutoProcessor.from_pretrained(config.model, { cache_dir: config.cacheDir, ...(onProgress ? { progress_callback: onProgress } : {}) });
	// v4 picks the weights by dtype per component. Never fp16: this model's activation range exceeds
	// float16's and returns NaN or quietly degraded vectors.
	const dtype = config.quantized ? "q8" : "fp32";
	const model = await AutoModel.from_pretrained(config.model, {
		cache_dir: config.cacheDir,
		dtype: { model: dtype, vision_encoder: dtype, audio_encoder: dtype },
		...(onProgress ? { progress_callback: onProgress } : {}),
	});
	const identity = { model: config.model, quantized: config.quantized };

	const encode = async (...inputs: Parameters<typeof processor>): Promise<EmbedResult> => {
		const prepared = await processor(...inputs);
		const tooLong = overWindow(prepared.input_ids?.dims?.[1] ?? 0);
		if (tooLong) return { ok: false, error: tooLong };
		const output = await model(prepared);
		const [vector] = (output.sentence_embedding ?? output.last_hidden_state).tolist() as number[][];
		if (!vector) return { ok: false, error: "the model returned no embedding" };
		return { ok: true, vector: Float32Array.from(vector) };
	};

	return {
		identity,
		embedQuery: (text) => encode(queryInstruction(text)),
		embedDocument: (text) => encode(documentInstruction(text)),
		// Prefixes apply to text only (model card), so media goes in bare. Audio is decoded from the bytes
		// we hold. An image has to pass through a file — RawImage takes a path or a URL, and Node has no
		// createImageBitmap — so it goes through a temp file holding those same bytes: the stored bytes stay
		// authoritative and `media.path` stays provenance, which is what lets an old media row re-embed after
		// its original file moved.
		embedMedia: (media) =>
			media.kind === "image" ? withImageFile(media, (image) => encode(null, image)) : encode(null, null, decodeWav(media.bytes).samples),
	};

	async function withImageFile<T>(media: MemoryMedia, then: (image: InstanceType<typeof RawImage>) => Promise<T>): Promise<T> {
		const file = join(tmpdir(), `flypi-memory-${randomUUID()}.${media.mime.split("/")[1] ?? "img"}`);
		writeFileSync(file, media.bytes);
		try {
			return await then(await RawImage.read(file));
		} finally {
			rmSync(file, { force: true });
		}
	}
}

/** Cosine, computed from the norms rather than trusting the writer to have normalised. */
export function cosine(a: Float32Array, b: Float32Array): number {
	if (a.length !== b.length) return 0;
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i += 1) {
		dot += a[i]! * b[i]!;
		normA += a[i]! * a[i]!;
		normB += b[i]! * b[i]!;
	}
	if (normA === 0 || normB === 0) return 0;
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
