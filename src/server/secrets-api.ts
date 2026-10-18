/**
 * The Secrets tab's server side (docs/secrets.md Phase 5.5): the vault's rows in the wire's shape, plus the
 * references that say what would break if a name went away.
 *
 * Two things this file is responsible for:
 *
 * - Nothing here copies a secret value into a snapshot. The rows carry `mask` and `fingerprint`; the only
 *   plaintext in this API is a `reveal`, which the caller asked for by name.
 * - `references` comes from the config files, not from the vault: a secret does not know what points at it,
 *   and deleting one whose name is written in mcp.json would break a server the user did not mean to touch.
 */
import type { FlypiPaths } from "../agent/paths.ts";
import { MIN_SECRET_CHARS } from "../secrets/redact.ts";
import type { SecretStore } from "../secrets/vault.ts";
import { secretReferences } from "../secrets/config.ts";
import type { KeyState, RevealedSecret, SecretEdit, SecretsSnapshot } from "./protocol.ts";

export interface SecretsApi {
	/** Never a value: masks, counters, key state and the references. */
	snapshot(): SecretsSnapshot;
	/** Put, rotate, delete or restore. Returns the refreshed snapshot; a refused edit throws, and the panel shows why. */
	apply(edits: SecretEdit[]): SecretsSnapshot;
	/** The one call that returns a plaintext, and the vault records it as `revealed`. */
	reveal(name: string): RevealedSecret | undefined;
}

export function secretsApi(vault: SecretStore, paths: FlypiPaths): SecretsApi {
	const snapshot = (): SecretsSnapshot => {
		const drift = vault.keyDrift();
		const key: KeyState = {
			provider: drift.keyProvider,
			currentVersion: drift.current,
			rows: drift.rows,
			stale: drift.stale,
			reencryptQueued: drift.reencryptQueued,
		};
		return {
			secrets: vault.list("", true).map((row) => ({
				id: row.id,
				name: row.name,
				kind: row.kind,
				mask: row.mask,
				meta: row.meta,
				status: row.status,
				createdAt: row.created_at,
				...(row.updated_at === null ? {} : { updatedAt: row.updated_at }),
				...(row.last_used_at === null ? {} : { lastUsedAt: row.last_used_at }),
				useCount: row.use_count,
				keyVersion: row.key_version,
				fingerprint: row.fingerprint,
			})),
			references: secretReferences(paths),
			key,
			// The gap in the redaction, said out loud: a value this short is not matched in a memory or a
			// transcript, so a user who stored one should know which names are unprotected (src/secrets/redact.ts).
			tooShortToRedact: vault.activeValues().filter((entry) => entry.value.length < MIN_SECRET_CHARS).map((entry) => entry.name),
		};
	};

	return {
		snapshot,
		apply: (edits) => {
			for (const edit of edits) {
				if (edit.remove === true) {
					const gone = vault.remove(edit.name, { actor: "ui" });
					if (gone.status === "not found") throw new Error(`no secret named "${edit.name}"`);
					continue;
				}
				if (edit.restore === true) {
					const back = vault.restore(edit.name, { actor: "ui" });
					if (back.status === "not found") throw new Error(`nothing deleted named "${edit.name}"`);
					continue;
				}
				if (edit.value === undefined) throw new Error(`${edit.name}: nothing to store`);
				const result = vault.row(edit.name)
					? vault.rotate({ name: edit.name, value: edit.value, kind: edit.kind, meta: edit.meta, actor: "ui" })
					: vault.put({ name: edit.name, value: edit.value, kind: edit.kind, meta: edit.meta, actor: "ui" });
				if (result.status === "exists") throw new Error(`that value is already stored as "${result.name}"`);
				if (result.status === "name taken") throw new Error(`"${edit.name}" holds a different value — rotate it or choose another name`);
			}
			return snapshot();
		},
		reveal: (name) => {
			const value = vault.value(name, { actor: "ui", action: "revealed" });
			return value === undefined ? undefined : { name, value };
		},
	};
}
