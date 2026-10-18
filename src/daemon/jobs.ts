/**
 * The daemon's job queue (docs/architecture.md Phase 4.5).
 *
 * One `setTimeout` loop, no queue dependency, and no cron parser: `jobs.next_run_at` is enough. What
 * makes it safe is the claim — a single `UPDATE … WHERE id = ? AND locked_at IS NULL` whose `changes`
 * says who won — so two schedulers on one row cannot both run it, and a crash mid-run cannot lose a
 * fact that was already written (the facts live in `memories`; a job only reorganises them).
 *
 * Every attempt is recorded in `job_runs`: what ran, when, whether it worked, and what it changed. The
 * record is written when the attempt ends and carries the kind itself, because a job row closes when its
 * work is done (`reembed()` deletes it once the index is clean) and the history of what it did is not
 * part of that cleanup.
 */
import type { DatabaseSync } from "node:sqlite";
import { redactSecrets } from "../secrets/redact.ts";
import type { JobRow, JobRunRow, SchedulerSnapshot } from "../server/protocol.ts";

export interface Job {
	id: number;
	kind: string;
	payload: unknown;
}

/** A job returns what it changed, for `job_runs.detail`. Throwing is a `failed` row, not a crash. */
export type JobHandler = (job: Job) => string | void | Promise<string | void>;

/** What one pass did, so a test (or the debug panel) can see it without reading the database. */
export interface JobAttempt {
	id: number;
	kind: string;
	status: "ok" | "failed";
	detail?: string;
}

/** How long a job that ran waits before it is due again. Jobs are periodic maintenance, not a queue. */
const RESCHEDULE_MS = 60 * 60 * 1000;

const now = () => new Date().toISOString();

/** How many jobs one pass takes. A pass is bounded so a huge backlog cannot starve a live turn. */
const DUE_BATCH = 50;

export class JobQueue {
	constructor(
		private readonly db: DatabaseSync,
		private readonly clock: () => string = now,
	) {}

	/**
	 * The jobs that are due and unclaimed, oldest first, as of this call. A pass works through this list
	 * rather than asking again after each job: a failed job stays due, and asking again would put the pass
	 * in a loop that never ends.
	 */
	dueNow(): Job[] {
		const rows = this.db
			.prepare("SELECT id, kind, payload FROM jobs WHERE locked_at IS NULL AND next_run_at <= ? ORDER BY id LIMIT ?")
			.all(this.clock(), DUE_BATCH) as { id: number; kind: string; payload: string }[];
		return rows.map((row) => ({ id: row.id, kind: row.kind, payload: JSON.parse(row.payload) as unknown }));
	}

	/**
	 * The claim, exactly as the plan writes it. `changes` is the whole concurrency story: one caller gets
	 * 1, everyone else gets 0 and moves on. Nothing is read-then-written, so there is no window to race in.
	 */
	claim(id: number, workerId: string): boolean {
		return this.db.prepare("UPDATE jobs SET locked_by = ?, locked_at = ? WHERE id = ? AND locked_at IS NULL").run(workerId, this.clock(), id).changes === 1;
	}

	/** The queue's clock, so an attempt is stamped with the same clock that decided it was due. */
	at(): string {
		return this.clock();
	}

	/** Record one attempt — see the file header for why this happens after the run, not before. */
	record(job: Job, startedAt: string, status: "ok" | "failed", detail?: string): void {
		// A job that finished its work closes its own queue row (`reembed()` does), so the id may be gone by
		// the time the attempt is recorded: link it when it is still there, and let the record stand alone
		// when it is not. The kind is copied, so the history never loses what ran.
		this.db
			.prepare("INSERT INTO job_runs (job_id, kind, started_at, finished_at, status, detail) VALUES ((SELECT id FROM jobs WHERE id = ?), ?, ?, ?, ?, ?)")
			.run(job.id, job.kind, startedAt, this.clock(), status, detail ?? null);
	}

	/**
	 * Release the claim. A job that failed keeps its `next_run_at` (the plan's rule: a failed sweep is
	 * retried on the next tick, not rescheduled into next week); a job that ran waits out `RESCHEDULE_MS`.
	 */
	release(id: number, { failed }: { failed: boolean }): void {
		const at = this.clock();
		this.db
			.prepare("UPDATE jobs SET locked_by = NULL, locked_at = NULL, next_run_at = ? WHERE id = ?")
			.run(failed ? at : new Date(Date.parse(at) + RESCHEDULE_MS).toISOString(), id);
	}

	/** How many jobs are waiting. `flypi status` prints it, and the health page carries it. */
	queued(): number {
		return Number((this.db.prepare("SELECT count(*) AS n FROM jobs").get() as unknown as { n: number }).n);
	}

	/**
	 * On daemon start, any claim still held belongs to a process that is gone: the daemon is the only
	 * writer (risk 3), and a row locked by nobody would never run again — while `queueJob` happily queues a
	 * second row of the same kind beside it, because that one is not locked.
	 */
	releaseStaleClaims(): number {
		return Number(this.db.prepare("UPDATE jobs SET locked_by = NULL, locked_at = NULL WHERE locked_at IS NOT NULL").run().changes);
	}

	/** What the scheduler tab shows: the queue, and the attempts that ran. Newest attempts first. */
	snapshot(limit = 20): SchedulerSnapshot {
		const jobs = this.db.prepare("SELECT kind, next_run_at, locked_by FROM jobs ORDER BY next_run_at, id").all() as unknown as { kind: string; next_run_at: string; locked_by: string | null }[];
		// `job_runs.kind` is the record's own copy, so an attempt keeps its name after its queue row closes.
		const runs = this.db
			.prepare("SELECT job_runs.kind AS recorded, jobs.kind AS queued, job_runs.status, job_runs.started_at, job_runs.finished_at, job_runs.detail FROM job_runs LEFT JOIN jobs ON jobs.id = job_runs.job_id ORDER BY job_runs.id DESC LIMIT ?")
			.all(limit) as unknown as { recorded: string; queued: string; status: string; started_at: string; finished_at: string | null; detail: string | null }[];
		return {
			jobs: jobs.map((job) => ({ kind: job.kind, nextRunAt: job.next_run_at, running: job.locked_by !== null } satisfies JobRow)),
			jobRuns: runs.map((run) => ({
				kind: run.recorded || run.queued,
				status: run.status as JobRunRow["status"],
				startedAt: run.started_at,
				...(run.finished_at ? { finishedAt: run.finished_at } : {}),
				...(run.detail ? { detail: run.detail } : {}),
			})),
		};
	}
}

/**
 * One pass: claim and run every job that is due, and record each attempt.
 *
 * A kind with no handler here is a `failed` row saying so: the queue is not the place that knows which
 * phases have landed, and a job nobody runs should be visible in the scheduler tab rather than silently
 * open. `memory.consolidate` and `wiki.render` get their handlers in Phase 6, `secrets.reencrypt` in
 * Phase 5.5 — registering one is one line in that phase's `handlers` map.
 */
export async function runDueJobs(queue: JobQueue, handlers: Record<string, JobHandler>): Promise<JobAttempt[]> {
	// The worker is this process: that is what makes a claim left behind recognisably one that a dead
	// process abandoned.
	const workerId = process.pid.toString();
	const ran: JobAttempt[] = [];
	for (const job of queue.dueNow()) {
		// Someone else claimed it first: whoever won will run it. Not our job — literally.
		if (!queue.claim(job.id, workerId)) continue;
		const startedAt = queue.at();
		let status: "ok" | "failed" = "ok";
		let detail: string | undefined;
		try {
			const handler = handlers[job.kind];
			if (!handler) throw new Error(`no handler for ${job.kind}: that phase has not landed`);
			detail = (await handler(job)) ?? undefined;
		} catch (error) {
			status = "failed";
			detail = (error as Error).message;
		}
		// A failed job's message quotes the command it failed, and that command may have had a credential in
		// it. `job_runs.detail` is what an operator reads, so it is redacted on the way in (docs/secrets.md).
		if (detail !== undefined) detail = redactSecrets(detail);
		queue.record(job, startedAt, status, detail);
		queue.release(job.id, { failed: status === "failed" });
		ran.push({ id: job.id, kind: job.kind, status, ...(detail ? { detail } : {}) });
	}
	return ran;
}

/**
 * The loop: one `setTimeout`, never `setInterval` — a pass that outlives its interval cannot overlap
 * itself, and an unref'd timer never holds the process open on its own.
 */
export function startJobLoop(
	queue: JobQueue,
	handlers: Record<string, JobHandler>,
	options: { intervalMs?: number; onPass?: (ran: JobAttempt[]) => void; beforePass?: () => void } = {},
): () => void {
	const intervalMs = options.intervalMs ?? 60_000;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;
	const tick = () => {
		// The pass can be told what to queue on its way in: the daemon asks "is a sweep due?" here, so the
		// idle check happens at the moment the queue is about to run rather than on another timer that could
		// decide while a turn was in flight.
		try {
			options.beforePass?.();
		} catch (error) {
			console.error(`flypi jobs: ${(error as Error).message}`);
		}
		void runDueJobs(queue, handlers)
			.then((ran) => options.onPass?.(ran))
			.catch((error) => console.error(`flypi jobs: ${(error as Error).message}`))
			.finally(() => {
				if (stopped) return;
				timer = setTimeout(tick, intervalMs);
				timer.unref();
			});
	};
	timer = setTimeout(tick, 0);
	timer.unref();
	return () => {
		stopped = true;
		if (timer) clearTimeout(timer);
	};
}
