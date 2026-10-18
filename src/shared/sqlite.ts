/**
 * The SQLite setup every flypi-owned database shares (docs/decisions.md: one writer per file). WAL,
 * foreign keys, a busy timeout, and forward-only migrations that are never edited or re-run. `node:sqlite`
 * provides none of that by itself, and two copies of it is how two databases drift apart.
 *
 * There are two databases on purpose (the backend's run record and the memory store), and each is opened
 * by exactly one component. Nothing here joins across them — a cross-file join would need an `ATTACH`,
 * which is how a split quietly becomes one database again.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** One statement batch per version. Versions are never reused or edited after release. */
export interface Migration {
	version: number;
	sql: string;
	/**
	 * Run with `foreign_keys` off. Only a migration that rebuilds a table another one references needs it —
	 * `PRAGMA foreign_keys` is a no-op inside a transaction, so it has to be set around the whole batch.
	 * Such a migration checks its own work: see `assertForeignKeys`.
	 */
	deferForeignKeys?: boolean;
}

/** Open (creating the parent directories) a flypi-owned SQLite file with the pragmas every one needs. */
export function openFlypiDb(file: string): DatabaseSync {
	if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
	const db = new DatabaseSync(file);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA foreign_keys = ON");
	// A second connection (risk 15) must wait for the writer, not fail on it.
	db.exec("PRAGMA busy_timeout = 5000");
	return db;
}

/** The current schema version as recorded in the file, or 0 for an empty database. */
export function schemaVersion(db: DatabaseSync): number {
	const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
	if (!row) return 0;
	return (db.prepare("SELECT max(version) AS version FROM schema_migrations").get() as { version: number }).version ?? 0;
}

/** Rows that no longer satisfy their foreign keys — the check a deferred migration owes. */
export function assertForeignKeys(db: DatabaseSync): void {
	const broken = db.prepare("PRAGMA foreign_key_check").all() as unknown[];
	if (broken.length > 0) throw new Error(`foreign keys are broken after migrating: ${JSON.stringify(broken)}`);
}

/** Bring a database up to `migrations`, one version per transaction. A newer file is an error, not a downgrade. */
export function migrate(db: DatabaseSync, migrations: Migration[]): void {
	db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
	const current = schemaVersion(db);
	if (current > migrations.length) {
		throw new Error(`database schema v${current} is newer than this build knows (v${migrations.length})`);
	}
	for (const migration of migrations) {
		if (migration.version <= current) continue;
		if (migration.deferForeignKeys) db.exec("PRAGMA foreign_keys = OFF");
		db.exec("BEGIN");
		try {
			db.exec(migration.sql);
			db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(migration.version, new Date().toISOString());
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
		if (migration.deferForeignKeys) {
			db.exec("PRAGMA foreign_keys = ON");
			assertForeignKeys(db);
		}
	}
}
