/**
 * The SQLite store behind flypi's memory (docs/memory.md Phase 3).
 *
 * One file, one writer (docs/risks.md risk 3): the process holding the memory store owns this file, and
 * anything else that ever opens it (a future `flypi memory …` subcommand, risk 15) opens it read-only with
 * `busy_timeout`. The shared pragmas and migration engine live in `src/shared/sqlite.ts`, because the
 * backend has its own database under the same rules and a second copy of them is how the two would drift.
 *
 * What belongs in this file is what the facts are joined to: `memories`, `media`, `memory_audit`, the
 * `jobs`/`job_runs` queue that every automated memory mutation is audited against (`memory_audit.job_run_id`),
 * and the `conversations`/`turns` record of what retrieval was shown and what a reply cited
 * (`memories.turn_id`). The one table that did not belong here — `runs`, "is a turn in flight right now" —
 * moved to the backend's own store in v5.
 */
import { DatabaseSync } from "node:sqlite";
import { migrate, openFlypiDb, schemaVersion, type Migration } from "../shared/sqlite.ts";

const SCHEMA_V1 = `
CREATE TABLE conversations (
	id TEXT PRIMARY KEY,
	cwd TEXT NOT NULL,
	title TEXT,
	pi_session_file TEXT,
	created_at TEXT NOT NULL
);

CREATE TABLE turns (
	id INTEGER PRIMARY KEY,
	conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
	user_text TEXT NOT NULL,
	assistant_text TEXT,
	tool_calls_json TEXT,
	usage_json TEXT,
	created_at TEXT NOT NULL
);

-- Daemon-restart recovery (Phase 4.5): a row left 'running' by a dead process becomes 'interrupted'.
CREATE TABLE runs (
	conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
	status TEXT NOT NULL CHECK (status IN ('running','idle','aborted','interrupted')),
	last_event_seq INTEGER NOT NULL DEFAULT 0,
	updated_at TEXT NOT NULL
);

CREATE TABLE jobs (
	id INTEGER PRIMARY KEY,
	kind TEXT NOT NULL,
	next_run_at TEXT NOT NULL,
	payload TEXT NOT NULL DEFAULT '{}',
	locked_by TEXT,
	locked_at TEXT
);

CREATE TABLE job_runs (
	id INTEGER PRIMARY KEY,
	job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
	started_at TEXT NOT NULL,
	finished_at TEXT,
	status TEXT NOT NULL CHECK (status IN ('running','ok','failed')),
	detail TEXT
);

-- origin_class/session_kind are authority, and only code sets them (docs/memory.md Phase 4).
CREATE TABLE memories (
	id INTEGER PRIMARY KEY,
	kind TEXT NOT NULL,
	body TEXT NOT NULL,
	tags TEXT NOT NULL DEFAULT '[]',
	embedding BLOB,
	embed_model TEXT,
	dims INTEGER,
	embed_quantized INTEGER,
	embedded_at TEXT,
	origin_class TEXT NOT NULL CHECK (origin_class IN ('owner','agent','untrusted','system')),
	session_kind TEXT NOT NULL CHECK (session_kind IN ('interactive','background','subagent','unknown')),
	status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','deleted')),
	supersedes INTEGER REFERENCES memories(id),
	superseded_by INTEGER REFERENCES memories(id),
	merged_from TEXT NOT NULL DEFAULT '[]',
	strength REAL NOT NULL DEFAULT 1.0,
	use_count INTEGER NOT NULL DEFAULT 0,
	cited_count INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	last_verified_at TEXT,
	session_id TEXT,
	turn_id INTEGER REFERENCES turns(id)
);
CREATE INDEX memories_status ON memories(status);
CREATE INDEX memories_embed_identity ON memories(embed_model, dims, embed_quantized);

-- Trigger-maintained: an app-side dual write is how a search index drifts from its rows.
CREATE VIRTUAL TABLE memories_fts USING fts5(body, tags, content=memories, content_rowid=id);
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
	INSERT INTO memories_fts(rowid, body, tags) VALUES (new.id, new.body, new.tags);
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
	INSERT INTO memories_fts(memories_fts, rowid, body, tags) VALUES ('delete', old.id, old.body, old.tags);
END;
CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
	INSERT INTO memories_fts(memories_fts, rowid, body, tags) VALUES ('delete', old.id, old.body, old.tags);
	INSERT INTO memories_fts(rowid, body, tags) VALUES (new.id, new.body, new.tags);
END;

-- Every automated mutation keeps its pre-image, so anything a sweep did is undoable (risk 9).
CREATE TABLE memory_audit (
	id INTEGER PRIMARY KEY,
	memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
	action TEXT NOT NULL CHECK (action IN ('create','edit','supersede','forget','verify','reembed')),
	actor TEXT NOT NULL,
	pre_image TEXT NOT NULL,
	reason TEXT,
	job_run_id INTEGER REFERENCES job_runs(id),
	created_at TEXT NOT NULL
);
CREATE INDEX memory_audit_memory ON memory_audit(memory_id);
`;

export const MIGRATIONS: Migration[] = [
	{ version: 1, sql: SCHEMA_V1 },
	{
		// Multimodal memory (docs/decisions.md): the bytes are the memory, so they live here and not
		// in a directory that can drift away from the row. `modality` is what the embedder was shown.
		version: 2,
		sql: `
ALTER TABLE memories ADD COLUMN modality TEXT NOT NULL DEFAULT 'text' CHECK (modality IN ('text','image','audio'));

CREATE TABLE media (
	id INTEGER PRIMARY KEY,
	memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
	kind TEXT NOT NULL CHECK (kind IN ('image','audio')),
	mime TEXT NOT NULL,
	path TEXT NOT NULL,
	bytes BLOB NOT NULL,
	created_at TEXT NOT NULL
);
CREATE INDEX media_memory ON media(memory_id);
`,
	},
	{
		// What a turn was shown and what it cited (docs/memory.md Phase 4). `memories.cited_count` says a
		// fact was useful; only a per-turn record says how often retrieval paid off, which is what the
		// dreaming promotion gates will read. The memory server stays the only writer, so a turn arrives
		// through the MCP surface rather than from the agent process.
		version: 3,
		sql: `
ALTER TABLE turns ADD COLUMN retrieved_json TEXT;
ALTER TABLE turns ADD COLUMN cited_json TEXT;
`,
	},
	{
		// A recorded attempt outlives the queue entry that scheduled it (docs/architecture.md Phase 4.5).
		// `reembed()` closes its job row once the index is clean, and `ON DELETE CASCADE` was taking the
		// history of every attempt with it — so the scheduler could not say when the last run was or what it
		// changed, and `memory_audit.job_run_id` would have pointed at a row that no longer exists.
		version: 4,
		deferForeignKeys: true,
		sql: `
CREATE TABLE job_runs_v4 (
	id INTEGER PRIMARY KEY,
	job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
	kind TEXT NOT NULL DEFAULT '',
	started_at TEXT NOT NULL,
	finished_at TEXT,
	status TEXT NOT NULL CHECK (status IN ('running','ok','failed')),
	detail TEXT
);
INSERT INTO job_runs_v4 (id, job_id, started_at, finished_at, status, detail) SELECT id, job_id, started_at, finished_at, status, detail FROM job_runs;
DROP TABLE job_runs;
ALTER TABLE job_runs_v4 RENAME TO job_runs;
CREATE INDEX job_runs_job ON job_runs(job_id);
`,
	},
	{
		// The store split (docs/decisions.md: one database per component). `runs` recorded which conversation
		// had a turn in flight — a fact about the process running pi sessions, not about a memory, and the
		// backend was the only thing that ever wrote it. It now lives in the backend's own database, which
		// copies the rows out of this file before migrating it (`openRunStore`), so no record is lost.
		// `conversations` stays: it is the row `turns`, and so every memory's provenance, points at.
		version: 5,
		sql: `
DROP TABLE IF EXISTS runs;
`,
	},
	{
		// The secrets vault (docs/secrets.md Phase 5.5) lives in this file on purpose: one store, one writer, one
		// backup, and the redaction boundary that keeps a credential out of `turns` and `memories` is the one
		// thing both halves need. Ciphertext only — value_cipher/value_nonce/value_tag are an AES-256-GCM seal,
		// so a tampered row fails loudly instead of decrypting to garbage — and mask/fingerprint are what every
		// read path returns instead of the value.
		//
		// `name` is unique only among active rows: deleting is a tombstone, so a name has to be usable again
		// without losing the row that used to hold it. Same rule as memories.
		version: 6,
		sql: `
CREATE TABLE secrets (
	id INTEGER PRIMARY KEY,
	name TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('api_key','token','password','ssh_private_key','ssh_public_key','generic')),
	value_cipher BLOB NOT NULL,
	value_nonce BLOB NOT NULL,
	value_tag BLOB NOT NULL,
	key_version INTEGER NOT NULL,
	fingerprint TEXT NOT NULL,
	mask TEXT NOT NULL,
	meta TEXT NOT NULL DEFAULT '{}',
	status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted')),
	created_at TEXT NOT NULL,
	updated_at TEXT,
	last_used_at TEXT,
	use_count INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX secrets_name_active ON secrets(name) WHERE status = 'active';
CREATE INDEX secrets_status ON secrets(status);
CREATE INDEX secrets_key_version ON secrets(key_version);

-- Every use and every change is recorded, with the pre-image a rotation leaves behind. "reencrypt" is not in
-- the doc's list of actions: Phase 5.5 asks for a pre-image after a key rotation, and re-sealing every row
-- under a new key is exactly what an audit row is for.
CREATE TABLE secret_audit (
	id INTEGER PRIMARY KEY,
	secret_id INTEGER NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
	action TEXT NOT NULL CHECK (action IN ('put','rotated','deleted','restored','used','revealed','reencrypt')),
	actor TEXT NOT NULL,
	pre_image TEXT,
	reason TEXT,
	created_at TEXT NOT NULL
);
CREATE INDEX secret_audit_secret ON secret_audit(secret_id);
`,
	},
	{
		// A `yaml` kind: a kubeconfig or an MCP config blob stored whole so `secret_file` can hand it to a
		// command, with its syntax checked on the way in (src/secrets/crypto.ts `validate`). SQLite cannot alter
		// a CHECK, so `secrets` is rebuilt — same rows, same ids, so the audit rows still point at them.
		// `secret_audit` is rebuilt too rather than left alone: renaming a table rewrites the foreign keys that
		// refer to it, so its constraint would otherwise end up naming the dropped copy.
		version: 7,
		deferForeignKeys: true,
		sql: `
ALTER TABLE secrets RENAME TO secrets_v6;
-- The rename left these indexes behind on the old table, and the new one needs their names back.
DROP INDEX secrets_name_active;
DROP INDEX secrets_status;
DROP INDEX secrets_key_version;
CREATE TABLE secrets (
	id INTEGER PRIMARY KEY,
	name TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('api_key','token','password','ssh_private_key','ssh_public_key','yaml','generic')),
	value_cipher BLOB NOT NULL,
	value_nonce BLOB NOT NULL,
	value_tag BLOB NOT NULL,
	key_version INTEGER NOT NULL,
	fingerprint TEXT NOT NULL,
	mask TEXT NOT NULL,
	meta TEXT NOT NULL DEFAULT '{}',
	status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted')),
	created_at TEXT NOT NULL,
	updated_at TEXT,
	last_used_at TEXT,
	use_count INTEGER NOT NULL DEFAULT 0
);
INSERT INTO secrets SELECT * FROM secrets_v6;
CREATE UNIQUE INDEX secrets_name_active ON secrets(name) WHERE status = 'active';
CREATE INDEX secrets_status ON secrets(status);
CREATE INDEX secrets_key_version ON secrets(key_version);
ALTER TABLE secret_audit RENAME TO secret_audit_v6;
DROP INDEX secret_audit_secret;
CREATE TABLE secret_audit (
	id INTEGER PRIMARY KEY,
	secret_id INTEGER NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
	action TEXT NOT NULL CHECK (action IN ('put','rotated','deleted','restored','used','revealed','reencrypt')),
	actor TEXT NOT NULL,
	pre_image TEXT,
	reason TEXT,
	created_at TEXT NOT NULL
);
INSERT INTO secret_audit SELECT * FROM secret_audit_v6;
CREATE INDEX secret_audit_secret ON secret_audit(secret_id);
DROP TABLE secret_audit_v6;
DROP TABLE secrets_v6;
`,
	},
	{
		// One `password` kind where there were three: `api_key`, `token` and `password` are the same shape — one line
		// of characters injected as-is — and the only thing the extra labels did was make the dropdown a guess
		// (src/secrets/crypto.ts). The CHECK is rebuilt around the smaller list, mapping the labels that go away onto
		// the one that stays. `secret_audit` moves with it for the reason v7 learned: renaming a table rewrites the
		// foreign keys that refer to it, and leaving it behind would point them at the copy being dropped.
		version: 8,
		deferForeignKeys: true,
		sql: `
ALTER TABLE secrets RENAME TO secrets_v7;
DROP INDEX secrets_name_active;
DROP INDEX secrets_status;
DROP INDEX secrets_key_version;
CREATE TABLE secrets (
	id INTEGER PRIMARY KEY,
	name TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('password','ssh_private_key','ssh_public_key','yaml','generic')),
	value_cipher BLOB NOT NULL,
	value_nonce BLOB NOT NULL,
	value_tag BLOB NOT NULL,
	key_version INTEGER NOT NULL,
	fingerprint TEXT NOT NULL,
	mask TEXT NOT NULL,
	meta TEXT NOT NULL DEFAULT '{}',
	status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted')),
	created_at TEXT NOT NULL,
	updated_at TEXT,
	last_used_at TEXT,
	use_count INTEGER NOT NULL DEFAULT 0
);
INSERT INTO secrets (id, name, kind, value_cipher, value_nonce, value_tag, key_version, fingerprint, mask, meta, status, created_at, updated_at, last_used_at, use_count)
	SELECT id, name, CASE WHEN kind IN ('api_key','token') THEN 'password' ELSE kind END, value_cipher, value_nonce, value_tag, key_version, fingerprint, mask, meta, status, created_at, updated_at, last_used_at, use_count
	FROM secrets_v7;
CREATE UNIQUE INDEX secrets_name_active ON secrets(name) WHERE status = 'active';
CREATE INDEX secrets_status ON secrets(status);
CREATE INDEX secrets_key_version ON secrets(key_version);
ALTER TABLE secret_audit RENAME TO secret_audit_v7;
DROP INDEX secret_audit_secret;
CREATE TABLE secret_audit (
	id INTEGER PRIMARY KEY,
	secret_id INTEGER NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
	action TEXT NOT NULL CHECK (action IN ('put','rotated','deleted','restored','used','revealed','reencrypt')),
	actor TEXT NOT NULL,
	pre_image TEXT,
	reason TEXT,
	created_at TEXT NOT NULL
);
INSERT INTO secret_audit SELECT * FROM secret_audit_v7;
CREATE INDEX secret_audit_secret ON secret_audit(secret_id);
DROP TABLE secret_audit_v7;
DROP TABLE secrets_v7;
`,
	},
	{
		// The wiki (docs/memory.md Phase 6): a render-only projection of the `active` rows, so it is a table of
		// derived text and not a second copy of the facts. Nothing reads it back as a memory — recall keeps
		// reading `memories` — which is why it can be dropped and rebuilt from scratch at any time (wiki.ts).
		// `claim_ids` is the provenance spine: the rows that back a page or a section, written by code, never
		// chosen by a model. `model` is null while the prose is the template's rather than a model's.
		version: 9,
		sql: `
CREATE TABLE wiki_pages (
	slug TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	topic_key TEXT NOT NULL,
	body TEXT NOT NULL,
	claim_ids TEXT NOT NULL DEFAULT '[]',
	model TEXT,
	generated_at TEXT NOT NULL
);

CREATE TABLE wiki_sections (
	id INTEGER PRIMARY KEY,
	slug TEXT NOT NULL REFERENCES wiki_pages(slug) ON DELETE CASCADE,
	heading TEXT NOT NULL,
	body TEXT NOT NULL,
	claim_ids TEXT NOT NULL DEFAULT '[]',
	generated_at TEXT NOT NULL
);
CREATE INDEX wiki_sections_slug ON wiki_sections(slug);
`,
	},
];

/**
 * Open (creating if needed) the memory database and bring it up to date. Migrations run in
 * version order inside a transaction each, and a file newer than this build is an error rather
 * than a silent downgrade.
 */
export function openMemoryDb(file: string): DatabaseSync {
	const db = openFlypiDb(file);
	migrate(db, MIGRATIONS);
	return db;
}

/**
 * The same file without owning it: read-only, so a second process (`flypi secret print`, risk 15) can answer
 * from it while the daemon holds the write lock — WAL readers do not wait for the writer, and `busy_timeout`
 * covers the rest. No migrations run here, because a read-only connection cannot run them, so a file older
 * than this build says so instead of reporting a table that is not there.
 */
export function openMemoryDbReadOnly(file: string): DatabaseSync {
	const db = new DatabaseSync(file, { readOnly: true });
	db.exec("PRAGMA busy_timeout = 5000");
	const version = schemaVersion(db);
	if (version < MIGRATIONS.length) {
		db.close();
		throw new Error(`${file} is at schema v${version}, and this build needs v${MIGRATIONS.length}: start flypi once to migrate it`);
	}
	return db;
}
