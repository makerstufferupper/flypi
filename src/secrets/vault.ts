/**
 * The secrets vault (docs/secrets.md Phase 5.5).
 *
 * Same shape as `MemoryStore`, same rules: nothing here ever hands back a plaintext unless the call asks for
 * one by name (`value`, `activeValues`), every read path returns the mask, deleting is a tombstone, and every
 * change and use leaves an audit row with the pre-image it replaced. The ciphertext lives in the memory
 * database, so there is one store, one writer and one backup.
 *
 * The values are decrypted in this process and never serialised on the way out: a list, a debug frame or a
 * memory row can only carry what this file chooses to put in it.
 */
import type { DatabaseSync } from "node:sqlite";
import type { FlypiPaths } from "../agent/paths.ts";
import { openMemoryDb, openMemoryDbReadOnly } from "../memory/db.ts";
import { keyProviderFor, secretsConfig, type SecretsConfig } from "./config.ts";
import { fingerprint, mask, open as unseal, seal, validate, type KeyProvider, type SecretKind } from "./crypto.ts";
import { SECRET_NAME } from "./config.ts";
import { closeSecretSource, invalidateSecrets, setSecretSource } from "./redact.ts";

export type { SecretKind } from "./crypto.ts";
export { SECRET_KINDS } from "./crypto.ts";

export interface SecretRow {
	id: number;
	name: string;
	kind: SecretKind;
	/** What a list or the UI shows. Never the value. */
	mask: string;
	meta: Record<string, string>;
	status: "active" | "deleted";
	created_at: string;
	updated_at: string | null;
	last_used_at: string | null;
	use_count: number;
	key_version: number;
	fingerprint: string;
}

export interface SecretUse {
	action: string;
	actor: string;
	reason: string | null;
	created_at: string;
}

export interface SecretInput {
	name: string;
	value: string;
	kind?: SecretKind;
	meta?: Record<string, string>;
	actor: string;
	reason?: string;
}

export const REENCRYPT_JOB = "secrets.reencrypt";

export class SecretStore {
	/**
	 * `readOnly` is not a hint: it is the state of the handle. A second process (`flypi secret print` from a
	 * config file, `npm run serve`) reads the vault through a read-only connection so it never competes with
	 * the writer, and that means its reads cannot record a use. Those reads still answer — the alternative is
	 * that a config file cannot resolve its own API key while the daemon is running — they just leave no
	 * audit row, which is why the flag is explicit rather than something each write discovers by failing.
	 */
	constructor(
		readonly db: DatabaseSync,
		readonly keys: KeyProvider,
		readonly readOnly: boolean = false,
	) {}

	/** A change cannot be made here. Said plainly, rather than as SQLite's "attempt to write a readonly database". */
	private writable(): void {
		if (this.readOnly) throw new Error("this vault is open read-only — a change has to go through the process that owns the database, such as `flypi secret …` or the web UI");
	}

	/**
	 * This process just changed the set of secrets, so the redaction boundary must ask again rather than answer
	 * from what it read a moment ago. Redaction itself is a pull (src/secrets/redact.ts): a process that only
	 * reads the vault is covered by the cache's short lifetime, and one that writes invalidates it here.
	 */
	private changed(): void {
		invalidateSecrets();
	}

	/** Active rows, optionally with the tombstones. No plaintext in any of them. */
	list(query = "", includeDeleted = false): SecretRow[] {
		return this.rows(query, includeDeleted);
	}

	row(name: string): SecretRow | undefined {
		const found = this.db.prepare("SELECT id, name, kind, mask, meta, status, created_at, updated_at, last_used_at, use_count, key_version, fingerprint FROM secrets WHERE name = ?").get(name);
		return found === undefined ? undefined : decodeRow(found as unknown as StoredRow);
	}

	/** The one call that returns a plaintext, and the reason it is in the audit trail. */
	value(name: string, { actor, action = "used" }: { actor: string; action?: "used" | "revealed" }): string | undefined {
		const row = this.stored(name);
		if (!row) return undefined;
		const key = this.keys.key(row.key_version);
		if (key === undefined) {
			// Loud, not a wrong plaintext: the row was sealed under a key this provider no longer holds.
			throw new Error(`the vault has no key v${row.key_version} for "${name}" — rotate it to a new value, or restore that key`);
		}
		const plaintext = unseal({ valueCipher: row.value_cipher, valueNonce: row.value_nonce, valueTag: row.value_tag }, key);
		if (this.readOnly) return plaintext;
		this.db
			.prepare("UPDATE secrets SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?")
			.run(now(), row.id);
		// A use is not a change, so there is no pre-image: the audit row names the row and nothing more.
		this.audit({ id: row.id, name: row.name }, action, actor, undefined, undefined);
		return plaintext;
	}

	/**
	 * Store a value. The fingerprint is checked first, so the same credential written twice comes back as
	 * `already stored as "name"` instead of a second row or a second name — the case where a user pastes the
	 * same API key under two handles and later cannot tell which is which.
	 */
	put(input: SecretInput): { status: "stored"; id: number } | { status: "exists"; name: string; id: number } | { status: "name taken"; name: string; id: number } {
		this.writable();
		if (!SECRET_NAME.test(input.name)) throw new Error(`"${input.name}" is not a usable secret name: letters, digits, dot, dash and underscore`);
		const kind = input.kind ?? "generic";
		// The value is checked against the kind before anything is written, so a CLI, a tool call and the web UI
		// cannot each decide what a `yaml` secret means (src/secrets/crypto.ts `validate`).
		const problem = validate(input.value, kind);
		if (problem) throw new Error(`"${input.name}" ${problem}`);
		const print = fingerprint(input.value);
		const same = this.db.prepare("SELECT name, id FROM secrets WHERE status = 'active' AND fingerprint = ?").get(print) as { name: string; id: number } | undefined;
		if (same) return { status: "exists", ...same };
		const taken = this.db.prepare("SELECT id FROM secrets WHERE status = 'active' AND name = ?").get(input.name) as { id: number } | undefined;
		if (taken) return { status: "name taken", name: input.name, id: taken.id };

		const version = this.keys.currentVersion();
		const key = this.keys.key(version);
		if (key === undefined) throw new Error(`the ${this.keys.name} key provider reports v${version} as current but does not hold it`);
		const sealed = seal(input.value, key);
		const result = this.db
			.prepare(
				`INSERT INTO secrets (name, kind, value_cipher, value_nonce, value_tag, key_version, fingerprint, mask, meta, status, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
			)
			.run(
				input.name,
				kind,
				Buffer.from(sealed.valueCipher),
				Buffer.from(sealed.valueNonce),
				Buffer.from(sealed.valueTag),
				version,
				print,
				mask(input.value, kind),
				JSON.stringify(input.meta ?? {}),
				now(),
			);
		this.audit({ id: Number(result.lastInsertRowid), name: input.name, key_version: version }, "put", input.actor, undefined, input.reason);
		this.changed();
		return { status: "stored", id: Number(result.lastInsertRowid) };
	}

	/** A new value for an existing name. The old row is what the audit row keeps (masked, never plaintext). */
	rotate(input: SecretInput): { status: "rotated"; id: number } | { status: "not found"; name: string } {
		this.writable();
		const row = this.stored(input.name);
		if (!row) return { status: "not found", name: input.name };
		const kind = (input.kind ?? row.kind) as SecretKind;
		const problem = validate(input.value, kind);
		if (problem) throw new Error(`"${input.name}" ${problem}`);
		const version = this.keys.currentVersion();
		const key = this.keys.key(version);
		if (key === undefined) throw new Error(`the ${this.keys.name} key provider reports v${version} as current but does not hold it`);
		const sealed = seal(input.value, key);
		this.db
			.prepare(
				"UPDATE secrets SET kind = ?, value_cipher = ?, value_nonce = ?, value_tag = ?, key_version = ?, fingerprint = ?, mask = ?, meta = ?, updated_at = ? WHERE id = ?",
			)
			.run(
				kind,
				Buffer.from(sealed.valueCipher),
				Buffer.from(sealed.valueNonce),
				Buffer.from(sealed.valueTag),
				version,
				fingerprint(input.value),
				mask(input.value, kind),
				JSON.stringify(input.meta ?? JSON.parse(String(row.meta))),
				now(),
				row.id,
			);
		this.audit(row, "rotated", input.actor, preImage(row), input.reason);
		this.changed();
		return { status: "rotated", id: row.id };
	}

	/** A tombstone, never an erasure: history is not the vault's to delete (same rule as memories). */
	remove(name: string, { actor, reason }: { actor: string; reason?: string }): { status: "deleted"; id: number } | { status: "not found"; name: string } {
		this.writable();
		const row = this.stored(name);
		if (!row) return { status: "not found", name };
		this.db.prepare("UPDATE secrets SET status = 'deleted', updated_at = ? WHERE id = ?").run(now(), row.id);
		this.audit(row, "deleted", actor, preImage(row), reason);
		this.changed();
		return { status: "deleted", id: row.id };
	}

	/** Undo, which a tombstone makes possible without ever having held the plaintext client-side. */
	restore(name: string, { actor, reason }: { actor: string; reason?: string }): { status: "restored"; id: number } | { status: "not found"; name: string } {
		this.writable();
		const row = this.db.prepare("SELECT * FROM secrets WHERE name = ? AND status = 'deleted'").get(name) as unknown as StoredRow | undefined;
		if (!row) return { status: "not found", name };
		this.db.prepare("UPDATE secrets SET status = 'active', updated_at = ? WHERE id = ?").run(now(), row.id);
		this.audit(row, "restored", actor, preImage(row), reason);
		this.changed();
		return { status: "restored", id: row.id };
	}

	uses(name: string, limit = 20): SecretUse[] {
		const row = this.row(name);
		if (!row) return [];
		return this.db
			.prepare("SELECT action, actor, reason, created_at FROM secret_audit WHERE secret_id = ? ORDER BY id DESC LIMIT ?")
			.all(row.id, limit) as unknown as SecretUse[];
	}

	/**
	 * Key drift, reported the way the embedding drift is: the vault answers, the status panel shows it, a job
	 * does the work. Nothing rotates a key on a timer — a credential outliving its usefulness is a human
	 * judgement (risk 9).
	 */
	keyDrift(): { keyProvider: string; current: number; rows: number; stale: number; reencryptQueued: boolean } {
		const current = this.keys.currentVersion();
		const rows = (this.db.prepare("SELECT count(*) AS n FROM secrets WHERE status = 'active'").get() as { n: number }).n;
		const stale = (this.db.prepare("SELECT count(*) AS n FROM secrets WHERE status = 'active' AND key_version <> ?").get(current) as { n: number }).n;
		const queued = this.db.prepare("SELECT id FROM jobs WHERE kind = ? AND locked_by IS NULL").get(REENCRYPT_JOB) !== undefined;
		return { keyProvider: this.keys.name, current, rows, stale, reencryptQueued: queued };
	}

	/** Ask for a new key. The rows are re-sealed by the job, not here: on a large vault that is background work. */
	rotateKey(actor: string, reason?: string): { version: number; reencryptQueued: number[] } {
		this.writable();
		const version = this.keys.rotate();
		return { version, reencryptQueued: this.queueReencrypt(reason ?? `key rotated to v${version} by ${actor}`) };
	}

	queueReencrypt(reason: string): number[] {
		this.writable();
		const at = now();
		const existing = this.db.prepare("SELECT id FROM jobs WHERE kind = ? AND locked_by IS NULL").all(REENCRYPT_JOB) as { id: number }[];
		if (existing.length > 0) {
			this.db.prepare("UPDATE jobs SET next_run_at = ?, payload = ? WHERE kind = ? AND locked_by IS NULL").run(at, JSON.stringify({ reason }), REENCRYPT_JOB);
			return existing.map((row) => row.id);
		}
		const result = this.db.prepare("INSERT INTO jobs (kind, next_run_at, payload) VALUES (?, ?, ?)").run(REENCRYPT_JOB, at, JSON.stringify({ reason }));
		return [Number(result.lastInsertRowid)];
	}

	/**
	 * Re-seal every row under the current key, then let the provider forget the ones no row needs. Each row
	 * keeps an audit row with its pre-image, which is what "rotate, then re-encrypt, then forget the old key"
	 * means when someone later asks what a row used to be.
	 */
	reencrypt(): { rows: number; keyVersion: number } {
		this.writable();
		const version = this.keys.currentVersion();
		const stale = this.db.prepare("SELECT * FROM secrets WHERE status = 'active' AND key_version <> ?").all(version) as unknown as StoredRow[];
		const key = this.keys.key(version);
		if (key === undefined) throw new Error(`the ${this.keys.name} key provider reports v${version} as current but does not hold it`);
		for (const row of stale) {
			// Read with the old key first: a row that cannot be opened must stop the pass, not be skipped, or a
			// vault would quietly lose a secret while looking healthy.
			const old = this.keys.key(row.key_version);
			if (old === undefined) throw new Error(`the vault has no key v${row.key_version} for "${row.name}" — restore that key before re-encrypting`);
			const plaintext = unseal({ valueCipher: row.value_cipher, valueNonce: row.value_nonce, valueTag: row.value_tag }, old);
			const sealed = seal(plaintext, key);
			this.db
				.prepare("UPDATE secrets SET value_cipher = ?, value_nonce = ?, value_tag = ?, key_version = ? WHERE id = ?")
				.run(Buffer.from(sealed.valueCipher), Buffer.from(sealed.valueNonce), Buffer.from(sealed.valueTag), version, row.id);
			this.audit(row, "reencrypt", "job", preImage(row), `re-sealed under v${version}`);
		}
		this.keys.retain([version]);
		return { rows: stale.length, keyVersion: version };
	}

	/**
	 * This process is done with the vault. Redaction stops reading it, rather than being left pointing at a
	 * closed database — one vault per process, so dropping the source is the whole of it.
	 */
	close(): void {
		closeSecretSource();
	}

	/** Every active name with its plaintext — the redaction boundary's input, and nothing else uses it. */
	activeValues(): { name: string; value: string }[] {
		const out: { name: string; value: string }[] = [];
		for (const row of this.db.prepare("SELECT * FROM secrets WHERE status = 'active'").all() as unknown as StoredRow[]) {
			const key = this.keys.key(row.key_version);
			if (key === undefined) continue;
			try {
				out.push({ name: row.name, value: unseal({ valueCipher: row.value_cipher, valueNonce: row.value_nonce, valueTag: row.value_tag }, key) });
			} catch {
				// A row this process cannot open is reported by `value()` when someone asks for it; the other
				// secrets still get redacted.
			}
		}
		return out;
	}

	private rows(query = "", includeDeleted = false): SecretRow[] {
		return (this.db
			.prepare(
				`SELECT id, name, kind, mask, meta, status, created_at, updated_at, last_used_at, use_count, key_version, fingerprint
				 FROM secrets WHERE (? = '' OR name LIKE ? OR meta LIKE ?) AND (? = 1 OR status <> 'deleted') ORDER BY name`,
			)
			.all(query, `%${query}%`, `%${query}%`, includeDeleted ? 1 : 0) as unknown as StoredRow[]).map(decodeRow);
	}

	private stored(name: string): StoredRow | undefined {
		return this.db.prepare("SELECT * FROM secrets WHERE name = ? AND status = 'active'").get(name) as unknown as StoredRow | undefined;
	}

	private audit(row: { id: number; name: string; key_version?: number }, action: string, actor: string, preImage: unknown, reason?: string): void {
		this.db
			.prepare("INSERT INTO secret_audit (secret_id, action, actor, pre_image, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)")
			.run(row.id, action, actor, JSON.stringify(preImage ?? { name: row.name, key_version: row.key_version ?? null }), reason ?? null, now());
	}
}

interface StoredRow {
	id: number;
	name: string;
	kind: string;
	value_cipher: Uint8Array;
	value_nonce: Uint8Array;
	value_tag: Uint8Array;
	key_version: number;
	fingerprint: string;
	mask: string;
	meta: string;
	status: "active" | "deleted";
	created_at: string;
	updated_at: string | null;
	last_used_at: string | null;
	use_count: number;
}

function decodeRow(row: StoredRow): SecretRow {
	let meta: Record<string, string> = {};
	try {
		meta = JSON.parse(String(row.meta)) as Record<string, string>;
	} catch {
		// A meta column that is not JSON is a broken annotation, not a broken secret: the row still lists.
	}
	return {
		id: row.id,
		name: row.name,
		kind: row.kind as SecretKind,
		mask: row.mask,
		meta,
		status: row.status,
		created_at: row.created_at,
		updated_at: row.updated_at,
		last_used_at: row.last_used_at,
		use_count: row.use_count,
		key_version: row.key_version,
		fingerprint: row.fingerprint,
	};
}

/** What an audit row keeps about the row it replaced — identity and key version, never the value. */
function preImage(row: StoredRow): Record<string, unknown> {
	return { name: row.name, kind: row.kind, mask: row.mask, fingerprint: row.fingerprint, key_version: row.key_version };
}

const now = () => new Date().toISOString();

/**
 * Open the vault for this process (docs/secrets.md Phase 5.5). This is the one call that connects the vault
 * to redaction: whatever process opens a vault also becomes a process that redacts, because that is the only
 * way a secret stored by one process is protected by another. A process that already holds the memory
 * database passes its own handle — the daemon does, and a second connection to the same file in one process
 * buys nothing.
 *
 * `write: false` (the default) opens the file read-only, which is right for a process that does not own it:
 * `npm run serve` without a daemon, or a `flypi secret list` run while the daemon is up. Such a process can
 * read and redact; a mutation it attempts fails with SQLite's own "attempt to write a readonly database",
 * which names the real problem — that this process is not the vault's owner.
 */
export function openSecretVault(
	paths: FlypiPaths,
	options: { db?: DatabaseSync; write?: boolean; config?: SecretsConfig } = {},
): SecretStore {
	const config = options.config ?? secretsConfig(paths);
	const db = options.db ?? (options.write === true ? openMemoryDb(paths.memoryDbPath) : openMemoryDbReadOnly(paths.memoryDbPath));
	// A process that does not own the writer opens the vault read-only, so it can answer `print NAME` while the
	// daemon is running, and it is told which of the two it has (see SecretStore.readOnly).
	const vault = new SecretStore(db, keyProviderFor(config), options.write !== true);
	setSecretSource(() => vault.activeValues());
	return vault;
}
