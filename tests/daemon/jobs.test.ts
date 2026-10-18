/**
 * The daemon's job queue (docs/architecture.md Phase 4.5): the claim, the record of every attempt, the
 * rules about when a job is due again, and what a crash leaves behind.
 */
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/memory/store.ts";
import { JobQueue, runDueJobs, startJobLoop } from "../../src/daemon/jobs.ts";
import { openTestDb } from "../helpers/memory-db.ts";
import { tempConnectedVault } from "../helpers/secret-vault.ts";

const CLOCK = "2026-10-11T09:00:00.000Z";
const PASSWORD = "router-adm1n-c0rrect";

/** A queue on a clock that does not move, so "is it due" is a fact the test controls. */
function queueOn(db: ReturnType<typeof openTestDb>) {
	return new JobQueue(db, () => CLOCK);
}

describe("the job queue", () => {
	it("runs a due job once, and records what it changed", async () => {
		const db = openTestDb();
		const store = new MemoryStore(db);
		const queue = queueOn(db);
		store.queueJob("memory.reembed", { payload: { reason: "3 rows are from embedding-gemma-1" }, runAt: CLOCK });

		const ran = await runDueJobs(queue, { "memory.reembed": (job) => `re-embedded 3 from ${JSON.stringify((job.payload as { reason: string }).reason)}` });

		expect(ran).toEqual([{ id: expect.any(Number), kind: "memory.reembed", status: "ok", detail: "re-embedded 3 from \"3 rows are from embedding-gemma-1\"" }]);
		const runs = db.prepare("SELECT kind, status, detail, started_at, finished_at FROM job_runs").all() as { kind: string; status: string; detail: string; started_at: string; finished_at: string }[];
		// The payload the job was queued with is what the handler saw, and the record is what the scheduler
		// tab shows: an operator should be able to see that the sweep happened and what it fixed.
		expect(runs).toEqual([{ kind: "memory.reembed", status: "ok", detail: "re-embedded 3 from \"3 rows are from embedding-gemma-1\"", started_at: CLOCK, finished_at: CLOCK }]);
		db.close();
	});

	it("the claim is won by exactly one of two schedulers", async () => {
		const db = openTestDb();
		const store = new MemoryStore(db);
		store.queueJob("memory.consolidate", { runAt: CLOCK });
		const a = queueOn(db);
		const b = queueOn(db);

		// Both see the same due job — the race is real, and the answer is the UPDATE's `changes`.
		const job = a.dueNow()[0];
		expect(job?.kind).toBe("memory.consolidate");
		expect([a.claim(job!.id, "a"), b.claim(job!.id, "b")].filter(Boolean)).toHaveLength(1);
		// Whoever lost does not run it, and cannot lock it either.
		expect(b.claim(job!.id, "b")).toBe(false);
		expect((db.prepare("SELECT locked_by FROM jobs WHERE id = ?").get(job!.id) as { locked_by: string }).locked_by).toBe("a");
		db.close();
	});

	it("a job that throws is a failed row, not a restarted daemon", async () => {
		const db = openTestDb();
		const store = new MemoryStore(db);
		store.queueJob("memory.reembed", { runAt: CLOCK });
		const queue = queueOn(db);

		const ran = await runDueJobs(queue, { "memory.reembed": () => { throw new Error("the model could not be loaded"); } });

		expect(ran[0]).toMatchObject({ kind: "memory.reembed", status: "failed", detail: "the model could not be loaded" });
		expect((db.prepare("SELECT status, detail FROM job_runs").get() as { status: string; detail: string }).status).toBe("failed");
		db.close();
	});

	it("a job that fails on a command with a credential in it records the failure without the credential", async () => {
		// `job_runs.detail` is what an operator reads, and `flypi logs` prints it (docs/secrets.md).
		const held = tempConnectedVault();
		const db = openTestDb();
		const store = new MemoryStore(db);
		store.queueJob("secrets.reencrypt", { runAt: CLOCK });
		const queue = queueOn(db);
		try {
			held.vault.put({ name: "router_admin", value: PASSWORD, kind: "password", actor: "test" });
			const ran = await runDueJobs(queue, {
				"secrets.reencrypt": () => {
					throw new Error(`curl -u admin:${PASSWORD} https://192.168.1.1 exited 7`);
				},
			});
			const said = "curl -u admin:[secret:router_admin] https://192.168.1.1 exited 7";
			expect(ran[0]).toMatchObject({ status: "failed", detail: said });
			expect((db.prepare("SELECT detail FROM job_runs").get() as { detail: string }).detail).toBe(said);
		} finally {
			held.dispose();
			db.close();
		}
	});

	it("a failed job stays due, a job that ran waits an hour", async () => {
		const db = openTestDb();
		const store = new MemoryStore(db);
		store.queueJob("memory.reembed", { runAt: CLOCK });
		const queue = queueOn(db);

		await runDueJobs(queue, { "memory.reembed": () => { throw new Error("nope"); } });
		// The plan's rule: a failed sweep is retried, not rescheduled into next week.
		// The plan's rule: a failed sweep is retried on the next pass, not rescheduled into next week.
		expect(queue.dueNow()[0]?.kind).toBe("memory.reembed");

		await runDueJobs(queue, { "memory.reembed": () => "re-embedded 1" });
		expect(queue.dueNow()).toEqual([]);
		expect((db.prepare("SELECT next_run_at FROM jobs").get() as { next_run_at: string }).next_run_at).toBe("2026-10-11T10:00:00.000Z");
		db.close();
	});

	it("a kind with no handler is a visible failure, not a silently open job", async () => {
		const db = openTestDb();
		const store = new MemoryStore(db);
		// Phase 6 will give this kind a handler; until then the queue must say so rather than pretend.
		store.queueJob("wiki.render", { runAt: CLOCK });

		const ran = await runDueJobs(queueOn(db), {});

		expect(ran[0]).toMatchObject({ kind: "wiki.render", status: "failed", detail: "no handler for wiki.render: that phase has not landed" });
		db.close();
	});

	it("releases the claims a dead process left behind", () => {
		const db = openTestDb();
		const store = new MemoryStore(db);
		store.queueJob("memory.reembed", { runAt: CLOCK });
		const queue = queueOn(db);
		const job = queue.dueNow()[0];
		queue.claim(job!.id, "pid-4242");
		// The previous daemon died holding this claim: no process has it, so the row would sit locked and
		// nothing would ever run it — while the next queueJob would add a duplicate row beside it.
		expect(queue.dueNow()).toEqual([]);
		expect(store.queueJob("memory.reembed")).not.toEqual([job!.id]);

		expect(queue.releaseStaleClaims()).toBe(1);
		expect(queue.dueNow()[0]?.id).toBe(job!.id);
		db.close();
	});

	it("an attempt is still on the record after its queue row closes", async () => {
		const db = openTestDb();
		const store = new MemoryStore(db);
		store.queueJob("memory.reembed", { runAt: CLOCK });
		const queue = queueOn(db);

		// What `reembed()` really does: the index is clean, so the queue row is deleted. The history of the
		// run is not part of that cleanup.
		await runDueJobs(queue, { "memory.reembed": () => { db.prepare("DELETE FROM jobs WHERE id = ?").run(1); return "re-embedded 4"; } });

		expect(queue.snapshot()).toEqual({
			jobs: [],
			jobRuns: [{ kind: "memory.reembed", status: "ok", startedAt: CLOCK, finishedAt: CLOCK, detail: "re-embedded 4" }],
		});
		db.close();
	});

	it("shows what is queued and when it is due", () => {
		const db = openTestDb();
		const store = new MemoryStore(db);
		store.queueJob("memory.consolidate", { runAt: CLOCK });
		const queue = queueOn(db);
		queue.claim(queue.dueNow()[0]!.id, "me");
		// A job that is not due yet still belongs in the panel — that is what "when will it run" means.
		store.queueJob("wiki.render", { runAt: "2026-10-12T00:00:00.000Z" });

		expect(queue.snapshot()).toEqual({
			jobs: [
				{ kind: "memory.consolidate", nextRunAt: CLOCK, running: true },
				{ kind: "wiki.render", nextRunAt: "2026-10-12T00:00:00.000Z", running: false },
			],
			jobRuns: [],
		});
		expect(queue.queued()).toBe(2);
		db.close();
	});

	it("a job with nothing to report is a clean row, and the record it shows is capped", async () => {
		const db = openTestDb();
		const store = new MemoryStore(db);
		const queue = queueOn(db);
		store.queueJob("memory.reembed", { runAt: CLOCK });
		store.queueJob("memory.consolidate", { runAt: CLOCK });
		// A handler that returns nothing is normal — a sweep that found nothing to say. The row must not read
		// as a failure, and the panel must not be handed a detail to invent one from.
		await runDueJobs(queue, { "memory.reembed": () => {}, "memory.consolidate": () => "swept 2" });

		expect(queue.snapshot().jobRuns).toEqual([
			{ kind: "memory.consolidate", status: "ok", startedAt: CLOCK, finishedAt: CLOCK, detail: "swept 2" },
			{ kind: "memory.reembed", status: "ok", startedAt: CLOCK, finishedAt: CLOCK },
		]);
		// Newest first, and only as many as were asked for: a year of sweeps is not the activity panel.
		expect(queue.snapshot(1).jobRuns.map((run) => run.kind)).toEqual(["memory.consolidate"]);
		db.close();
	});

	it("the loop runs a pass with no client attached, and stopping it stops the passes", async () => {
		const db = openTestDb();
		const store = new MemoryStore(db);
		store.queueJob("memory.reembed", { runAt: CLOCK });
		const queue = queueOn(db);
		let passes = 0;
		let claimedBy: string | null = null;
		const stop = startJobLoop(
			queue,
			{
				// The owner on the claim is what makes an abandoned lease mean something, and the loop claims
				// as this process.
				"memory.reembed": (job) => {
					claimedBy = (db.prepare("SELECT locked_by FROM jobs WHERE id = ?").get(job.id) as { locked_by: string | null }).locked_by;
					return "re-embedded 1";
				},
			},
			{ intervalMs: 5, onPass: () => (passes += 1) },
		);

		// A wait with a deadline, never a sleep: the point is that nothing had to ask for it.
		for (let waited = 0; waited < 2000 && passes === 0; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
		expect(passes).toBeGreaterThan(0);
		expect(claimedBy).toBe(process.pid.toString());
		// And the timer must not hold the process open, or `flypi stop` would never finish.
		stop();
		const after = passes;
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(passes).toBe(after);
		db.close();
	});
});
