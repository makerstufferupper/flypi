import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, openMemoryDb } from "../../src/memory/db.ts";
import { migrate, schemaVersion } from "../../src/shared/sqlite.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import { openTempFileDb, openTestDb } from "../helpers/memory-db.ts";

const TABLES = ["conversations", "turns", "jobs", "job_runs", "memories", "memories_fts", "memory_audit", "media"];

describe("memory db: forward-only migrations, WAL, one writer's pragmas", () => {
	it("creates every table the memory subsystem needs, exactly once", () => {
		const db = openTestDb();
		const names = new Set(
			(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as { name: string }[]).map((row) => row.name),
		);
		for (const table of TABLES) expect(names.has(table), `missing table ${table}`).toBe(true);
		expect(schemaVersion(db)).toBe(MIGRATIONS.length);
	});

	it("migrating again changes nothing", () => {
		const db = openTestDb();
		migrate(db, MIGRATIONS);
		migrate(db, MIGRATIONS);
		expect(schemaVersion(db)).toBe(MIGRATIONS.length);
		expect((db.prepare("SELECT count(*) AS n FROM schema_migrations").get() as { n: number }).n).toBe(MIGRATIONS.length);
	});

	it("a real file keeps WAL on and survives being reopened", () => {
		const handle = openTempFileDb();
		try {
			expect((handle.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
			expect((handle.db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
			new MemoryStore(handle.db).createConversation({ id: "c1", cwd: "/tmp" });
			handle.db.close();

			const reopened = openMemoryDb(handle.file);
			expect(schemaVersion(reopened)).toBe(MIGRATIONS.length);
			expect((reopened.prepare("SELECT count(*) AS n FROM conversations").get() as { n: number }).n).toBe(1);
			reopened.close();
		} finally {
			rmSync(join(handle.file, ".."), { recursive: true, force: true });
		}
	});

	it("adds media and modality to a v1 file, and its rows stay text", () => {
		// The shipped database is v1; this is what happens to it the next time it is opened.
		const db = new DatabaseSync(":memory:");
		db.exec(MIGRATIONS[0]!.sql);
		db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
		db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (1, '2026-10-07T00:00:00Z')").run();
		const inserted = db
			.prepare("INSERT INTO memories (kind, body, origin_class, session_kind, created_at) VALUES ('note', 'a fact from v1', 'owner', 'interactive', '2026-10-07T00:00:00Z')")
			.run();

		migrate(db, MIGRATIONS);

		expect(schemaVersion(db)).toBe(MIGRATIONS.length);
		expect((db.prepare("SELECT modality FROM memories WHERE id = ?").get(Number(inserted.lastInsertRowid)) as { modality: string }).modality).toBe("text");
		// A media row's kind is checked by the schema, like every other state flypi reasons about.
		const media = "INSERT INTO media (memory_id, kind, mime, path, bytes, created_at) VALUES (?, ?, 'image/png', 'x.png', X'00', '2026-10-11T00:00:00Z')";
		expect(() => db.prepare(media).run(Number(inserted.lastInsertRowid), "image")).not.toThrow();
		expect(() => db.prepare(media).run(Number(inserted.lastInsertRowid), "video")).toThrow(/CHECK constraint/);
		db.close();
	});

	it("keeps the record of a run after the job that scheduled it closes", () => {
		// A shipped v3 database, which is what a real user's file looks like before this build opens it.
		const db = new DatabaseSync(":memory:");
		// As `openMemoryDb` leaves it: without this the cascade below would not fire and the test would be
		// proving nothing.
		db.exec("PRAGMA foreign_keys = ON");
		for (const migration of MIGRATIONS.filter((entry) => entry.version < 4)) db.exec(migration.sql);
		db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
		for (const version of [1, 2, 3]) db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, '2026-10-11T00:00:00Z')").run(version);

		const job = db.prepare("INSERT INTO jobs (kind, next_run_at, payload) VALUES ('memory.reembed', '2026-10-11T00:00:00Z', '{}')").run();
		db.prepare("INSERT INTO job_runs (job_id, started_at, finished_at, status, detail) VALUES (?, '2026-10-11T00:00:00Z', '2026-10-11T00:00:01Z', 'ok', 're-embedded 4')").run(Number(job.lastInsertRowid));
		db.prepare("DELETE FROM jobs WHERE id = ?").run(Number(job.lastInsertRowid));
		// What v3 did: closing the queue row took the history of the run with it, so the scheduler could not
		// say when the last sweep was or what it changed — and `memory_audit.job_run_id` pointed at nothing.
		expect((db.prepare("SELECT count(*) AS n FROM job_runs").get() as { n: number }).n).toBe(0);

		migrate(db, MIGRATIONS);

		expect(schemaVersion(db)).toBe(MIGRATIONS.length);
		// A migration that deferred foreign keys has to put them back on: this is the choke point where a
		// silent `foreign_keys = OFF` would otherwise last for the life of the connection.
		expect((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
		expect((db.prepare("PRAGMA foreign_key_check").all() as unknown[])).toEqual([]);

		// And the same shape now stands up on its own: `reembed()` closes its job row when the index is clean.
		const second = db.prepare("INSERT INTO jobs (kind, next_run_at, payload) VALUES ('memory.reembed', '2026-10-11T00:00:00Z', '{}')").run();
		db.prepare("INSERT INTO job_runs (job_id, kind, started_at, finished_at, status, detail) VALUES (?, 'memory.reembed', '2026-10-11T00:00:00Z', '2026-10-11T00:00:01Z', 'ok', 're-embedded 4')").run(Number(second.lastInsertRowid));
		db.prepare("DELETE FROM jobs WHERE id = ?").run(Number(second.lastInsertRowid));
		expect(
			(db.prepare("SELECT job_id, kind, detail FROM job_runs WHERE job_id IS NULL").all() as { job_id: number | null; kind: string; detail: string }[]).map((row) => row.kind),
		).toEqual(["memory.reembed"]);
		db.close();
	});

	it("drops the run record, which the backend now keeps in its own database", () => {
		// A shipped v4 file, which is what an existing user's memory database looks like: `runs` was in here
		// until the store split. The rows themselves are copied out first, by `openRunStore`.
		const db = new DatabaseSync(":memory:");
		db.exec("PRAGMA foreign_keys = ON");
		for (const migration of MIGRATIONS.filter((entry) => entry.version < 5)) db.exec(migration.sql);
		db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
		for (const version of [1, 2, 3, 4]) db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, '2026-10-13T00:00:00Z')").run(version);
		db.prepare("INSERT INTO conversations (id, cwd, pi_session_file, created_at) VALUES ('c1', '/tmp', '/tmp/s1.jsonl', '2026-10-12T00:00:00Z')").run();
		db.prepare("INSERT INTO runs (conversation_id, status, last_event_seq, updated_at) VALUES ('c1', 'interrupted', 4, '2026-10-12T00:00:00Z')").run();

		migrate(db, MIGRATIONS);

		expect(schemaVersion(db)).toBe(MIGRATIONS.length);
		expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'runs'").get()).toBeUndefined();
		// What stays is what the facts are joined to: the conversation, and so every memory's provenance.
		expect((db.prepare("SELECT count(*) AS n FROM conversations").get() as { n: number }).n).toBe(1);
		expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
		db.close();
	});

	it("adds a yaml kind to a v6 vault without touching its rows", () => {
		// A shipped v6 file: the secrets table exists with its kind CHECK — and a CHECK is the one constraint
		// SQLite cannot alter, so the migration rebuilds the table. What has to survive is the rows, their ids,
		// and the audit rows that point at them.
		const db = new DatabaseSync(":memory:");
		db.exec("PRAGMA foreign_keys = ON");
		for (const migration of MIGRATIONS.filter((entry) => entry.version < 7)) db.exec(migration.sql);
		db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
		for (const version of [1, 2, 3, 4, 5, 6]) db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, '2026-10-13T00:00:00Z')").run(version);
		const insert =
			"INSERT INTO secrets (name, kind, value_cipher, value_nonce, value_tag, key_version, fingerprint, mask, created_at) VALUES ('kube_config','generic',x'01',x'02',x'03',1,'fp',' kub…43 ','2026-10-12T00:00:00Z')";
		db.prepare(insert).run();
		db.prepare("INSERT INTO secret_audit (secret_id, action, actor, created_at) VALUES (1, 'put', 'test', '2026-10-12T00:00:00Z')").run();
		expect(() => db.prepare("UPDATE secrets SET kind = 'yaml' WHERE name = 'kube_config'").run()).toThrow(/CHECK constraint/);

		migrate(db, MIGRATIONS);

		expect(schemaVersion(db)).toBe(MIGRATIONS.length);
		expect(db.prepare("SELECT id, name, kind, mask FROM secrets").get()).toEqual({ id: 1, name: "kube_config", kind: "generic", mask: " kub…43 " });
		expect((db.prepare("SELECT count(*) AS n FROM secret_audit WHERE secret_id = 1").get() as { n: number }).n).toBe(1);
		// The new kind is allowed, an invented one still is not, and nothing was copied twice.
		db.prepare("UPDATE secrets SET kind = 'yaml' WHERE name = 'kube_config'").run();
		expect(() => db.prepare("UPDATE secrets SET kind = 'shh' WHERE name = 'kube_config'").run()).toThrow(/CHECK constraint/);
		expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
		expect((db.prepare("SELECT count(*) AS n FROM secrets").get() as { n: number }).n).toBe(1);
		db.close();
	});

	it("folds the api_key and token rows of a v7 vault into password", () => {
		// Three kinds described one shape, so the labels go away and the rows have to follow without anything
		// else moving: the ciphertext, the id the audit rows point at, the mask a user already recognised, and
		// the kinds that were never one of the three.
		const db = new DatabaseSync(":memory:");
		db.exec("PRAGMA foreign_keys = ON");
		for (const migration of MIGRATIONS.filter((entry) => entry.version < 8)) db.exec(migration.sql);
		db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
		for (const version of [1, 2, 3, 4, 5, 6, 7]) db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, '2026-10-13T00:00:00Z')").run(version);
		const put = db.prepare(
			"INSERT INTO secrets (name, kind, value_cipher, value_nonce, value_tag, key_version, fingerprint, mask, created_at) VALUES (?, ?, x'01', x'02', x'03', 1, ?, ?, '2026-10-12T00:00:00Z')",
		);
		put.run("openai_key", "api_key", "fp-a", "sk-…7890");
		put.run("github_token", "token", "fp-b", "ghp…1111");
		put.run("mats_key", "ssh_private_key", "fp-c", "SHA256:abc");
		db.prepare("INSERT INTO secret_audit (secret_id, action, actor, created_at) VALUES (1, 'put', 'test', '2026-10-12T00:00:00Z')").run();

		migrate(db, MIGRATIONS);

		expect(schemaVersion(db)).toBe(MIGRATIONS.length);
		expect(db.prepare("SELECT id, name, kind, mask FROM secrets ORDER BY id").all()).toEqual([
			{ id: 1, name: "openai_key", kind: "password", mask: "sk-…7890" },
			{ id: 2, name: "github_token", kind: "password", mask: "ghp…1111" },
			{ id: 3, name: "mats_key", kind: "ssh_private_key", mask: "SHA256:abc" },
		]);
		expect((db.prepare("SELECT count(*) AS n FROM secret_audit WHERE secret_id = 1").get() as { n: number }).n).toBe(1);
		// A label this build does not have is refused; nothing was copied twice.
		expect(() => db.prepare("UPDATE secrets SET kind = 'api_key' WHERE id = 1").run()).toThrow(/CHECK constraint/);
		expect(() => db.prepare("UPDATE secrets SET kind = 'token' WHERE id = 2").run()).toThrow(/CHECK constraint/);
		expect((db.prepare("SELECT count(*) AS n FROM secrets").get() as { n: number }).n).toBe(3);
		expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
		db.close();
	});

		it("refuses a database newer than this build instead of downgrading it", () => {
		const dir = mkdtempSync(join(tmpdir(), "flypi-memory-new-"));
		const file = join(dir, "flypi.db");
		const db = openMemoryDb(file);
		db.exec("INSERT INTO schema_migrations (version, applied_at) VALUES (99, '2099-01-01T00:00:00Z')");
		db.close();

		expect(() => openMemoryDb(file)).toThrow(/newer than this build/);
		rmSync(dir, { recursive: true, force: true });
	});

	it("enforces the CHECK constraints the status rules and provenance depend on", async () => {
		const db = openTestDb();
		const store = new MemoryStore(db);
		const { id } = await store.addMemory({
			kind: "convention",
			body: "a fact",
			origin_class: "owner",
			session_kind: "interactive",
			actor: "test",
		});
		// A status outside the table cannot be written, by schema rather than by convention.
		expect(() => db.prepare("UPDATE memories SET status = 'gone' WHERE id = ?").run(id)).toThrow(/CHECK constraint/);
		expect(() => db.prepare("UPDATE memories SET origin_class = 'self-appointed' WHERE id = ?").run(id)).toThrow(/CHECK constraint/);
	});

	it("keeps memories_fts in step through a raw UPDATE and a raw DELETE", async () => {
		const db = openTestDb();
		const store = new MemoryStore(db);
		const { id } = await store.addMemory({
			kind: "convention",
			body: "we deploy with flypi deploy, never make deploy",
			tags: ["deploy"],
			origin_class: "owner",
			session_kind: "interactive",
			actor: "test",
		});
		const match = (query: string) =>
			(db.prepare("SELECT rowid AS id FROM memories_fts WHERE memories_fts MATCH ?").all(query) as { id: number }[]).map((row) => row.id);

		expect(match("flypi")).toEqual([id]);

		// Written straight at the table, not through MemoryStore: this is what proves the index is
		// trigger-maintained and there is no app-side second write to drift.
		db.prepare("UPDATE memories SET body = 'we deploy with flypi ship', tags = '[\"deploy\",\"ship\"]' WHERE id = ?").run(id);
		expect(match("flypi")).toEqual([id]);
		expect(match("deploy")).toEqual([id]);
		expect(match("make")).toEqual([]);

		db.prepare("DELETE FROM memories WHERE id = ?").run(id);
		expect(match("flypi")).toEqual([]);
	});

	it("cascades a conversation's turns away with it", () => {
		const db = openTestDb();
		const store = new MemoryStore(db);
		store.createConversation({ id: "c1", cwd: "/tmp" });
		const turnId = store.recordTurn("c1", { userText: "hi", assistantText: "hello" });
		expect(turnId).toBeGreaterThan(0);
		db.prepare("DELETE FROM conversations WHERE id = 'c1'").run();
		expect((db.prepare("SELECT count(*) AS n FROM turns").get() as { n: number }).n).toBe(0);
	});

	it("refuses a turn for a conversation that does not exist", () => {
		const db = openTestDb();
		const store = new MemoryStore(db);
		expect(() => store.recordTurn("nope", { userText: "hi" })).toThrow(/FOREIGN KEY/i);
	});
});
