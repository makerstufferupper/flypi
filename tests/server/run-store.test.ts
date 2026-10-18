/**
 * The backend's `runs` table (src/server/run-store.ts, docs/architecture.md Phase 4.5): which conversation
 * was in a turn, and what a restart does when it finds one that was. "State lives in SQLite, not RAM" — a
 * backend that comes back has to be able to say which turn finished nowhere, without anything having
 * remembered it. It is a second database, and the memory store is never opened to answer this.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { flypiPaths } from "../../src/agent/paths.ts";
import { MIGRATIONS, openMemoryDb } from "../../src/memory/db.ts";
import { openRunStore, RUN_MIGRATIONS, RunStore } from "../../src/server/run-store.ts";
import { migrate, openFlypiDb, schemaVersion } from "../../src/shared/sqlite.ts";

const type = "SELECT conversation_id, session_file, status, last_event_seq FROM runs ORDER BY conversation_id";
const rows = (db: DatabaseSync) =>
	db.prepare(type).all() as unknown as { conversation_id: string; session_file: string | null; status: string; last_event_seq: number }[];

/** A run store on a fresh in-memory database, with the handle the assertions read through. */
function newRunStore(): { runs: RunStore; db: DatabaseSync } {
	const db = openFlypiDb(":memory:");
	migrate(db, RUN_MIGRATIONS);
	return { runs: new RunStore(db), db };
}

describe("the run record", () => {
	it("records a turn as running, then as idle, and keeps the session file it names", () => {
		const { runs, db } = newRunStore();
		runs.setRunStatus("c1", "running", { seq: 0, sessionFile: "/tmp/s1.jsonl" });
		expect(rows(db)).toEqual([{ conversation_id: "c1", session_file: "/tmp/s1.jsonl", status: "running", last_event_seq: 0 }]);

		runs.setRunStatus("c1", "idle", { seq: 7, sessionFile: "/tmp/s1.jsonl" });
		expect(rows(db)).toEqual([{ conversation_id: "c1", session_file: "/tmp/s1.jsonl", status: "idle", last_event_seq: 7 }]);
		db.close();
	});

	it("keeps why a turn stopped, even though it settles as idle a moment later", () => {
		const { runs, db } = newRunStore();
		runs.setRunStatus("c1", "running", { seq: 1 });
		runs.setRunStatus("c1", "aborted", { seq: 2 });
		runs.setRunStatus("c1", "idle", { seq: 3 });

		expect(rows(db)).toEqual([{ conversation_id: "c1", session_file: null, status: "aborted", last_event_seq: 3 }]);
		db.close();
	});

	it("does not lose a session file when a later turn does not know it", () => {
		// A turn arriving over the memory MCP surface knows the conversation id but not the session file.
		const { runs, db } = newRunStore();
		runs.setRunStatus("c1", "running", { seq: 0, sessionFile: "/tmp/s1.jsonl" });
		runs.setRunStatus("c1", "idle", { seq: 1 });
		expect(rows(db)[0]!.session_file).toBe("/tmp/s1.jsonl");
		db.close();
	});

	it("turns a run left `running` by a dead process into `interrupted`, once", () => {
		const { runs, db } = newRunStore();
		runs.setRunStatus("c1", "running", { seq: 4, sessionFile: "/tmp/s1.jsonl" });
		runs.setRunStatus("c2", "idle", { seq: 9, sessionFile: "/tmp/s2.jsonl" });
		// A turn that finished normally says nothing about the crash; only the one that was in flight does.
		expect(runs.reconcileInterrupted()).toEqual(["c1"]);
		expect(rows(db)).toEqual([
			{ conversation_id: "c1", session_file: "/tmp/s1.jsonl", status: "interrupted", last_event_seq: 4 },
			{ conversation_id: "c2", session_file: "/tmp/s2.jsonl", status: "idle", last_event_seq: 9 },
		]);
		// And a second backend starting must not report the same interruption twice.
		expect(runs.reconcileInterrupted()).toEqual([]);
		db.close();
	});

	it("answers whether a session's last turn was cut short", () => {
		const { runs, db } = newRunStore();
		runs.setRunStatus("c1", "running", { seq: 4, sessionFile: "/tmp/s1.jsonl" });
		runs.reconcileInterrupted();

		expect(runs.interruptedFor("/tmp/s1.jsonl")).toEqual({ at: expect.any(String) });
		// A chat with nothing to say about it is not shown a notice.
		expect(runs.interruptedFor("/tmp/other.jsonl")).toBeUndefined();

		// A later turn that finished supersedes it: an interruption is not a permanent property of a chat.
		// The timestamp is moved back rather than relying on the wall clock separating two writes a
		// millisecond apart.
		db.prepare("UPDATE runs SET updated_at = '2026-10-11T00:00:00.000Z' WHERE status = 'interrupted'").run();
		runs.setRunStatus("c1", "running", { seq: 5, sessionFile: "/tmp/s1.jsonl" });
		runs.setRunStatus("c1", "idle", { seq: 8, sessionFile: "/tmp/s1.jsonl" });
		expect(runs.interruptedFor("/tmp/s1.jsonl")).toBeUndefined();
		db.close();
	});
});

describe("the store split", () => {
	it("copies the run record out of a pre-split memory database before that table is dropped", () => {
		const root = mkdtempSync(join(tmpdir(), "flypi-store-split-"));
		try {
			const paths = flypiPaths(root);
			// The memory file exactly as an older build left it: schema v4, `runs` inside it, and the only
			// session file it knew sitting on the conversation row.
			const legacy = openFlypiDb(paths.memoryDbPath);
			migrate(legacy, MIGRATIONS.filter((entry) => entry.version < 5));
			legacy.prepare("INSERT INTO conversations (id, cwd, pi_session_file, created_at) VALUES ('c1', '/tmp', '/tmp/s1.jsonl', '2026-10-12T00:00:00Z')").run();
			legacy.prepare("INSERT INTO runs (conversation_id, status, last_event_seq, updated_at) VALUES ('c1', 'interrupted', 4, '2026-10-12T00:00:00Z')").run();
			legacy.close();

			const runs = openRunStore(paths);
			// The record, and the session file it needs to answer `interruptedFor` without the memory store.
			expect(runs.interruptedFor("/tmp/s1.jsonl")).toEqual({ at: "2026-10-12T00:00:00Z" });
			runs.close();

			// Opening the memory store again is what drops its copy of the table — the rows are not in two
			// places, which is the whole point of the split.
			const memory = openMemoryDb(paths.memoryDbPath);
			expect(schemaVersion(memory)).toBe(MIGRATIONS.length);
			expect(memory.prepare("SELECT name FROM sqlite_master WHERE name = 'runs'").get()).toBeUndefined();
			// The conversation and its provenance stay: `memories.turn_id` points at `turns`, which points at it.
			expect((memory.prepare("SELECT count(*) AS n FROM conversations").get() as { n: number }).n).toBe(1);
			expect(memory.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
			memory.close();

			// A second backend does not duplicate what the first already copied.
			const again = openRunStore(paths);
			again.close();
			const check = openFlypiDb(paths.runDbPath);
			expect((check.prepare("SELECT count(*) AS n FROM runs").get() as { n: number }).n).toBe(1);
			check.close();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses a run database newer than this build instead of downgrading it", () => {
		const root = mkdtempSync(join(tmpdir(), "flypi-run-new-"));
		try {
			const paths = flypiPaths(root);
			const runs = openRunStore(paths);
			runs.close();
			const db = openFlypiDb(paths.runDbPath);
			db.exec("INSERT INTO schema_migrations (version, applied_at) VALUES (99, '2099-01-01T00:00:00Z')");
			db.close();

			expect(() => openRunStore(paths)).toThrow(/newer than this build/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
