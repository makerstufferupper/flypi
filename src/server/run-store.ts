/**
 * The backend's own database (docs/decisions.md: one datastore per component). It answers exactly one
 * question that a restarted process cannot answer from RAM: was a turn in flight when it went away
 * (docs/architecture.md Phase 4.5).
 *
 * It is a second file, next to the memory store, on purpose. The memory database keeps `jobs`/`job_runs`
 * and `conversations`/`turns` because `memory_audit.job_run_id` and `memories.turn_id` are real foreign
 * keys inside it; a run row belongs to whoever runs pi sessions, so it lives here and names the session
 * file directly rather than joining through the memory store for it. Neither file is opened by the other
 * component's code path.
 */
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { FlypiPaths } from "../agent/paths.ts";
import { migrate, openFlypiDb, type Migration } from "../shared/sqlite.ts";

export const RUN_MIGRATIONS: Migration[] = [
	{
		version: 1,
		sql: `
CREATE TABLE runs (
	conversation_id TEXT PRIMARY KEY,
	session_file TEXT,
	status TEXT NOT NULL CHECK (status IN ('running','idle','aborted','interrupted')),
	last_event_seq INTEGER NOT NULL DEFAULT 0,
	updated_at TEXT NOT NULL
);
CREATE INDEX runs_session ON runs(session_file);
`,
	},
];

const now = () => new Date().toISOString();

export class RunStore {
	constructor(private readonly db: DatabaseSync) {}

	/**
	 * Which conversation is running a turn right now. `aborted` sticks: a stopped turn settles as `idle` a
	 * moment later, and why it stopped is the part worth keeping.
	 *
	 * shortcut: `last_event_seq` is the conversation's in-memory event counter as it stood at that write. The
	 * `running` write holds what the log already had — 0 for a brand-new chat, the seeded history for one that
	 * was reopened — and never how far the turn got; the settling write holds the whole turn. A row turned
	 * `interrupted` keeps the `running` number, because the process that knew the rest is gone. The counter
	 * restarts with the process and when a chat moves to another session file, so this is a record, not a
	 * resume cursor: nothing reads it, and a client that ever needs to resume mid-turn needs it advanced per
	 * event instead.
	 */
	setRunStatus(conversationId: string, status: "running" | "idle" | "aborted", { seq, sessionFile }: { seq: number; sessionFile?: string }): void {
		this.db
			.prepare(
				`INSERT INTO runs (conversation_id, session_file, status, last_event_seq, updated_at) VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(conversation_id) DO UPDATE SET
				     session_file = COALESCE(excluded.session_file, runs.session_file),
				     status = CASE WHEN runs.status = 'aborted' AND excluded.status = 'idle' THEN 'aborted' ELSE excluded.status END,
				     last_event_seq = excluded.last_event_seq,
				     updated_at = excluded.updated_at`,
			)
			.run(conversationId, sessionFile ?? null, status, seq, now());
	}

	/**
	 * The start-up reconciliation: every row still `running` belongs to a process that is gone — this process
	 * has started no turns yet and is the only writer (risk 3). They become `interrupted`, and the chat says
	 * so when it is opened. Nothing here re-runs a half-finished turn: the tools may already have written to
	 * the world.
	 */
	reconcileInterrupted(): string[] {
		const stale = this.db.prepare("SELECT conversation_id FROM runs WHERE status = 'running'").all() as unknown as { conversation_id: string }[];
		if (stale.length === 0) return [];
		this.db.prepare("UPDATE runs SET status = 'interrupted', updated_at = ? WHERE status = 'running'").run(now());
		return stale.map((row) => row.conversation_id);
	}

	/**
	 * The most recent turn a restart cut short in one session file. A newer turn that finished supersedes it
	 * — an interruption is not a permanent property of a chat, and re-showing it would be.
	 */
	interruptedFor(sessionFile: string): { at: string } | undefined {
		const row = this.db
			.prepare("SELECT updated_at FROM runs WHERE session_file = ? AND status = 'interrupted' ORDER BY updated_at DESC LIMIT 1")
			.get(sessionFile) as unknown as { updated_at: string } | undefined;
		if (!row) return undefined;
		const newer = this.db
			.prepare("SELECT count(*) AS n FROM runs WHERE session_file = ? AND status IN ('idle','running') AND updated_at > ?")
			.get(sessionFile, row.updated_at) as unknown as { n: number };
		return newer.n > 0 ? undefined : { at: row.updated_at };
	}

	/**
	 * Is a turn in flight in this process right now? The daemon's sweep trigger asks, because a sweep
	 * reorganises the store a live conversation is being answered from (docs/memory.md Phase 6).
	 */
	runningTurns(): number {
		return Number((this.db.prepare("SELECT count(*) AS n FROM runs WHERE status = 'running'").get() as unknown as { n: number }).n);
	}

	close(): void {
		this.db.close();
	}
}

/**
 * Bring the pre-split memory database's `runs` rows across, before memory migration v5 drops that table.
 * One-time by construction: the copy is keyed on the legacy table still being there, and `OR IGNORE` makes
 * it harmless if some path already copied them.
 */
function importLegacyRuns(memoryFile: string, db: DatabaseSync): void {
	if (!existsSync(memoryFile)) return;
	const legacy = new DatabaseSync(memoryFile, { readOnly: true });
	try {
		if (!legacy.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runs'").get()) return;
		// The old table had no session file of its own; it joined through the memory store's `conversations`.
		const rows = legacy
			.prepare(
				`SELECT runs.conversation_id, conversations.pi_session_file, runs.status, runs.last_event_seq, runs.updated_at
				 FROM runs LEFT JOIN conversations ON conversations.id = runs.conversation_id`,
			)
			.all() as unknown as { conversation_id: string; pi_session_file: string | null; status: string; last_event_seq: number; updated_at: string }[];
		for (const row of rows) {
			db.prepare("INSERT OR IGNORE INTO runs (conversation_id, session_file, status, last_event_seq, updated_at) VALUES (?, ?, ?, ?, ?)")
				.run(row.conversation_id, row.pi_session_file, row.status, row.last_event_seq, row.updated_at);
		}
	} finally {
		legacy.close();
	}
}

/** Open (creating if needed) the backend's run database, copying any rows the old combined file holds. */
export function openRunStore(paths: FlypiPaths): RunStore {
	const db = openFlypiDb(paths.runDbPath);
	migrate(db, RUN_MIGRATIONS);
	importLegacyRuns(paths.memoryDbPath, db);
	return new RunStore(db);
}
