/**
 * The vault's crypto and its key seam (docs/secrets.md Phase 5.5).
 *
 * AES-256-GCM through `node:crypto` — no native module, so `npm install` still works everywhere flypi
 * runs. Every row gets a fresh 96-bit nonce and its own auth tag, which is what makes a tampered or
 * swapped row fail loudly instead of decrypting to garbage. That is the whole reason this file is a choke
 * point: a seal that silently returns the wrong plaintext would put a wrong secret into a config file, and
 * nothing downstream could tell.
 *
 * The key is behind `KeyProvider` so a macOS Keychain or a pinentry prompt can appear later without
 * touching the table. The default reads a key file — see `keyfileProvider`.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse } from "yaml";

export const KEY_BYTES = 32;
export const NONCE_BYTES = 12;

/**
 * A secret kind is a label with consequences: it decides what a list line may show (see `mask`) and what a
 * value has to be before it is stored (see `validate`).
 *
 * One `password` kind covers an api key, a token and a password: they are the same shape to the code — one line
 * of characters, injected as-is — and which of the three it was was never information the vault could use. A
 * person reading the list learns it from the name and the notes, and the agent from those and from whether the
 * config wants `secret_env` or `secret_file`. (They used to be three kinds. Nothing read the difference, and the
 * dropdown made people choose wrong.) v8 collapses any stored `api_key`/`token` row to `password`.
 */
export const SECRET_KINDS = ["password", "ssh_private_key", "ssh_public_key", "yaml", "generic"] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];

/** One sealed row: the three pieces GCM produces, kept apart because SQLite stores each as its own BLOB. */
export interface Sealed {
	valueCipher: Uint8Array;
	valueNonce: Uint8Array;
	valueTag: Uint8Array;
}

/** The key is 32 bytes and the plaintext is UTF-8; nothing else is encoded, so a row round-trips exactly. */
export function seal(plaintext: string, key: Uint8Array): Sealed {
	const nonce = randomBytes(NONCE_BYTES);
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	const valueCipher = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	return { valueCipher, valueNonce: nonce, valueTag: cipher.getAuthTag() };
}

/**
 * Throws when the key is not the one that sealed the row, or when any byte of the row moved. The caller
 * adds the name — that is the only way a user finds out which secret a key rotation left behind.
 */
export function open(sealed: Sealed, key: Uint8Array): string {
	const decipher = createDecipheriv("aes-256-gcm", key, asBuffer(sealed.valueNonce));
	decipher.setAuthTag(asBuffer(sealed.valueTag));
	try {
		return Buffer.concat([decipher.update(asBuffer(sealed.valueCipher)), decipher.final()]).toString("utf8");
	} catch {
		throw new Error("the vault could not open this row: the key version is gone, or the ciphertext changed");
	}
}

/** sha256 hex. `put` checks this before storing anything, so a repeat write does not need to decrypt. */
export function fingerprint(plaintext: string): string {
	return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

/**
 * What a list, a tool result or the UI shows instead of the value.
 *
 * A key's last four characters are how a user recognises which one they mean — the reason the plan keeps a
 * little of it — and a fingerprint is how two SSH keys are told apart (what `ssh-keygen -lf` prints, so it
 * reads the same). A short value gets no characters at all: showing four of a six-character password would
 * show most of it. Note this fingerprints the bytes stored, not the public half of a private key, which is
 * enough to tell two stored keys apart and is not the string to compare against `ssh-keygen`.
 */
export function mask(value: string, kind: SecretKind): string {
	if (kind === "ssh_private_key" || kind === "ssh_public_key") {
		return `SHA256:${createHash("sha256").update(value, "utf8").digest("base64").replace(/=+$/, "")}`;
	}
	// A mask is one line in a list, whatever was stored — a yaml blob or a key pasted with a trailing newline.
	const flat = value.replace(/\s+/g, " ").trim();
	if (flat.length <= 8) return "•••••";
	return `${flat.slice(0, 3)}…${flat.slice(-4)}`;
}

/**
 * Does this value match the kind it is being stored as? Answers with the sentence to show, or null.
 *
 * Only `yaml` has anything to say. A kubeconfig or an MCP config blob that does not parse is worthless the
 * moment `secret_file` hands it to a command, and the vault is the last place that can name the line that
 * broke. Any other kind is a string: rejecting a typo in a password would be a guess about what the user
 * meant, which is not this function's call to make.
 */
export function validate(value: string, kind: SecretKind): string | null {
	if (kind !== "yaml") return null;
	try {
		parse(value);
	} catch (cause) {
		// A YAMLParseError's first line names the line and column; the rest is a code frame the panel has no room for.
		return `is not valid YAML: ${(cause as Error).message.split("\n")[0]}`;
	}
	return null;
}

/**
 * A key provider holds versioned keys. `currentVersion` seals new rows; `key(version)` returns an older key
 * while rows still need it and `undefined` once it is gone, which is how "rotate, then re-encrypt, then
 * forget the old key" reaches a real error rather than a wrong plaintext.
 */
export interface KeyProvider {
	readonly name: string;
	currentVersion(): number;
	key(version: number): Uint8Array | undefined;
	/** Generate a new key, make it current, and return its version. */
	rotate(): number;
	/** Drop the versions no row needs any more. */
	retain(versions: readonly number[]): void;
}

/**
 * The default provider: a key file, mode 0600, created on first use. It is a JSON map of versions because
 * rotation must keep the old key readable until every row has been re-sealed under the new one.
 *
 * Written by hand rather than with a temp file and a rename: the file already exists by then (created 0600
 * on first use), and the only thing that can happen mid-write is a crash with an unreadable vault, which
 * every other flypi JSON file behaves the same way about.
 */
export function keyfileProvider(file: string): KeyProvider {
	const read = (): { current: number; keys: Record<string, string> } => {
		if (!existsSync(file)) return write({ current: 1, keys: { 1: randomBytes(KEY_BYTES).toString("base64") } });
		try {
			const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
			if (isObject(raw) && typeof raw.current === "number" && isObject(raw.keys)) return raw as { current: number; keys: Record<string, string> };
		} catch {
			// Fall through: a vault that cannot be read must not be replaced by a fresh key, because that
			// would strand every row in the database. Say so instead.
		}
		throw new Error(`${file} is not a key file flypi can read (it holds the keys every encrypted row needs)`);
	};
	const write = (state: { current: number; keys: Record<string, string> }) => {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${JSON.stringify(state, null, "\t")}\n`, { mode: 0o600 });
		// `mode` only applies when the file is created; a umask, or a file that already existed, can leave it
		// wider than that. Ask for it explicitly.
		chmodSync(file, 0o600);
		return state;
	};

	return {
		name: "keyfile",
		currentVersion: () => read().current,
		key: (version) => {
			const encoded = read().keys[String(version)];
			return encoded === undefined ? undefined : Buffer.from(encoded, "base64");
	 },
		rotate: () => {
			const state = read();
			const current = state.current + 1;
			write({ current, keys: { ...state.keys, [current]: randomBytes(KEY_BYTES).toString("base64") } });
			return current;
		},
		retain: (versions) => {
			const state = read();
			const keep = new Set([state.current, ...versions]);
			const keys: Record<string, string> = {};
			for (const [version, encoded] of Object.entries(state.keys)) if (keep.has(Number(version))) keys[version] = encoded;
			write({ current: state.current, keys });
		},
	};
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asBuffer(value: Uint8Array): Buffer {
	// node:sqlite hands back a plain Uint8Array for a BLOB; the crypto API wants a Buffer.
	return Buffer.from(value);
}
