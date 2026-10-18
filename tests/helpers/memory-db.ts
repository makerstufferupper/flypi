import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Embedder, EmbedIdentity } from "../../src/memory/embed.ts";
import type { MemoryMedia } from "../../src/memory/media.ts";
import { openMemoryDb } from "../../src/memory/db.ts";

/**
 * Every memory test owns its database (docs/testing.md): `:memory:` normally, a temp file when the
 * test is about WAL or a schema file surviving a reopen.
 */
export function openTestDb(): DatabaseSync {
	return openMemoryDb(":memory:");
}

export function openTempFileDb(): { db: DatabaseSync; file: string; dispose(): void } {
	const dir = mkdtempSync(join(tmpdir(), "flypi-memory-"));
	const file = join(dir, "flypi.db");
	const db = openMemoryDb(file);
	return { db, file, dispose: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/**
 * A deterministic stand-in for the embedding model: a unit vector per known word, with an explicit
 * alias table so a test can ask in different words and still land on the same fact. That proves the
 * retrieval *mechanism* (fusion, filters, budgets) without a 900 MB model; semantic quality itself is
 * only asserted against the real model, under FLYPI_EMBED_TESTS=1.
 *
 * The alias table covers media too, keyed by the file's path: a test can say what the fake model
 * “sees” in `office-cat.png` and check that a typed query reaches it.
 */
export function wordEmbedder(
	identity: EmbedIdentity = { model: "test-embed-v1", quantized: true },
	aliases: Record<string, string> = {},
): Embedder {
	// Fixed width, so every text in a test has the same `dims` and the identity filter cannot hide
	// a row for the wrong reason.
	const dims = 512;
	const vectorFor = (text: string): Float32Array => {
		const words: string[] = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
		for (const [from, to] of Object.entries(aliases)) {
			if (words.join(" ").includes(from.toLowerCase())) words.push(...to.toLowerCase().split(" "));		}
		const vector = new Float32Array(dims);
		for (const word of words) vector[hash(word) % dims] = 1;
		return vector;
	};
	const embed = async (text: string) => ({ ok: true as const, vector: normalise(vectorFor(text)) });
	return { identity, embedQuery: embed, embedDocument: embed, embedMedia: async (media: MemoryMedia) => embed(media.path) };
}

/**
 * An embedder with an identity that refuses every input — what “too long for the window” looks like to
 * the store: the row is still written, without a vector, and the reason travels with it.
 */
export function refusingEmbedder(
	error: string,
	identity: EmbedIdentity = { model: "test-refusing", quantized: true },
): Embedder {
	const refuse = async () => ({ ok: false as const, error });
	return { identity, embedQuery: refuse, embedDocument: refuse, embedMedia: refuse };
}

const hash = (word: string): number => [...word].reduce((total, char) => (total * 31 + char.charCodeAt(0)) | 0, 7) >>> 0;

function normalise(vector: Float32Array): Float32Array {
	let sum = 0;
	for (const value of vector) sum += value * value;
	const length = Math.sqrt(sum);
	if (length === 0) return vector;
	return Float32Array.from(vector, (value) => value / length);
}
