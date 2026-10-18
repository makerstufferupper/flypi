import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { flypiPaths, type FlypiPaths } from "../../src/agent/paths.ts";
import { openMemoryDb } from "../../src/memory/db.ts";
import { keyfileProvider } from "../../src/secrets/crypto.ts";
import { openSecretVault, SecretStore } from "../../src/secrets/vault.ts";

/**
 * A vault over its own throwaway checkout: the real migrated database file and the real key file, because
 * the things worth asserting here are the file mode, a second connection to the same file, and a key
 * version that survives a reopen (docs/testing.md).
 */
export function tempVault(): { vault: SecretStore; db: DatabaseSync; paths: FlypiPaths; dispose(): void } {
	const dir = mkdtempSync(join(tmpdir(), "flypi-secrets-"));
	const paths = flypiPaths(dir);
	const db = openMemoryDb(paths.memoryDbPath);
	const vault = new SecretStore(db, keyfileProvider(paths.secretKeyPath));
	return { vault, db, paths, dispose: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/** The audit trail as a test reads it: what happened, and what the row kept about the row it replaced. */
export function auditOf(db: DatabaseSync, name: string): { action: string; preImage: Record<string, unknown> }[] {
	return (
		db.prepare("SELECT a.action AS action, a.pre_image AS pre FROM secret_audit a JOIN secrets s ON s.id = a.secret_id WHERE s.name = ? ORDER BY a.id").all(name) as {
			action: string;
			pre: string;
		}[]
	).map((row) => ({ action: row.action, preImage: JSON.parse(row.pre) as Record<string, unknown> }));
}

/**
 * The same, wired the way a process wires it in production: `openSecretVault` connects the vault to the
 * process-wide redaction boundary. Tests that assert redaction go through this, so the wiring is the thing
 * under test and not a fixture detail.
 */
export function tempConnectedVault(): { vault: SecretStore; db: DatabaseSync; paths: FlypiPaths; dispose(): void } {
	const dir = mkdtempSync(join(tmpdir(), "flypi-secrets-wired-"));
	const paths = flypiPaths(dir);
	const db = openMemoryDb(paths.memoryDbPath);
	const vault = openSecretVault(paths, { db, write: true });
	return {
		vault,
		db,
		paths,
		dispose: () => {
			vault.close();
			db.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
