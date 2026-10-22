/**
 * What makes a daemon a daemon (docs/architecture.md Phase 4.5): it says it is alive on plain HTTP, it
 * remembers its own port and token between runs, it reconciles what the last process left half-done, and
 * it runs maintenance while nobody is watching. The pieces are tested where they live (the claim in
 * jobs.test.ts, the run record in tests/server/run-store.test.ts); this file tests that they are wired to
 * each other — including that the run record is written to the backend's own database, not the memory one.
 */
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flypiPaths, type FlypiPaths } from "../../src/agent/paths.ts";
import { memoryEndpoint, readConfig } from "../../src/agent/config-files.ts";
import { readPackageCheck, readPackages } from "../../src/agent/packages.ts";
import { builtUi, readDaemonInfo, startFlypiDaemon, DAEMON_FILE, type DaemonHandle } from "../../src/daemon/index.ts";
import { startMemoryServer } from "../../src/memory/mcp.ts";
import { openRunStore, type RunStore } from "../../src/server/run-store.ts";
import type { ClientCommand, ServerFrame } from "../../src/server/protocol.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import { openTempFileDb, refusingEmbedder, wordEmbedder } from "../helpers/memory-db.ts";
import { stubCreateSession, toolTurn } from "../helpers/flypi-harness.ts";
import { createTempFlypiRoot } from "../helpers/flypi-root.ts";

/** A WS client small enough to read: connect, send a command, wait for the frame that answers it. */
async function connect(url: string, token: string) {
	const socket = new WebSocket(`${url}/?token=${encodeURIComponent(token)}`);
	const frames: ServerFrame[] = [];
	socket.on("message", (raw) => frames.push(JSON.parse(String(raw)) as ServerFrame));
	await new Promise<void>((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
	return {
		send: (command: ClientCommand) => socket.send(JSON.stringify(command)),
		next: (match: (frame: ServerFrame) => boolean, timeoutMs = 15_000) =>
			new Promise<ServerFrame>((resolve, reject) => {
				const until = Date.now() + timeoutMs;
				const poll = () => {
					const found = frames.find(match);
					if (found) return resolve(found);
					if (Date.now() > until) return reject(new Error(`no frame matched; saw ${JSON.stringify(frames.map((frame) => frame.type))}`));
					setTimeout(poll, 20);
				};
				poll();
			}),
		close: () => new Promise<void>((resolve) => { socket.once("close", () => resolve()); socket.close(); }),
	};
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A seeded or live `message_end` of the given role, for asking what a reopened chat can show. */
const messageEnd = (role: string) => (frame: ServerFrame) =>
	frame.type === "event" && frame.event.type === "message_end" && (frame.event as { message?: { role?: string } }).message?.role === role;

/** A store of the kind a daemon holds: a real file, a real schema, a deterministic embedder. */
function memory() {
	const db = openTempFileDb();
	return { db, store: new MemoryStore(db.db, wordEmbedder()) };
}

/** Every run store this file opens. `startFlypiDaemon` does not close what it was handed, any more than it
 * closes the memory store it is given, so the file that opens them closes them. */
const openedRuns: RunStore[] = [];
afterEach(() => {
	for (const runs of openedRuns.splice(0)) runs.close();
});

/** One daemon on one root and one store, minus the models: `startFlypiDaemon` with a stub session. */
async function startOn(
	root: string,
	store: ReturnType<typeof memory>,
	options: { log?: (line: string) => void; script?: ReturnType<typeof toolTurn>; tokensPerSecond?: number; token?: string } = {},
): Promise<DaemonHandle & { runs: RunStore }> {
	// The backend's own database, opened from the same paths an entrypoint would use. It is a separate file
	// from `store`, which is the point: nothing here can join the two by accident.
	const runs = openRunStore(flypiPaths(root));
	openedRuns.push(runs);
	const started = await startFlypiDaemon({
		paths: flypiPaths(root),
		db: store.db.db,
		store: store.store,
		runs,
		jobIntervalMs: 5,
		log: options.log ?? (() => {}),
		...(options.token ? { token: options.token } : {}),
		createSession: stubCreateSession(root, options.script ?? toolTurn(), {
			...(options.tokensPerSecond ? { tokensPerSecond: options.tokensPerSecond } : {}),
			authPath: join(root, ".flypi", "agent", "auth.json"),
		}),
	});
	return { ...started, runs };
}

/**
 * The status of the one run row, read through a second connection to the backend's file: the writer holds it
 * open, and reading it anyway is what `sqlite3` and `flypi status` depend on.
 */
const runStatus = (root: string) => {
	const db = new DatabaseSync(flypiPaths(root).runDbPath, { readOnly: true });
	try {
		return (db.prepare("SELECT status FROM runs").get() as { status: string } | undefined)?.status;
	} finally {
		db.close();
	}
};

async function daemon(options: { log?: (line: string) => void } = {}) {
	const root = createTempFlypiRoot();
	const store = memory();
	const started = await startOn(root, store, options);
	return {
		root,
		...store,
		...started,
		dispose: async () => {
			await started.close();
			store.db.dispose();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

const healthAt = async (port: number) => (await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as Record<string, unknown>;

describe("the daemon", () => {
	it("reads the memory endpoint out of the same mcp.json the agent reads", () => {
		const root = createTempFlypiRoot();
		const paths: FlypiPaths = flypiPaths(root);
		try {
			// Nothing to read yet, which is its own answer: the agent would have no memory tools.
			expect(memoryEndpoint(paths).note).toMatch(/no flypi-memory entry/);

			writeFileSync(
				join(root, ".flypi", "agent", "mcp.json"),
				JSON.stringify({ mcpServers: { "flypi-memory": { url: "http://127.0.0.1:8791/mcp", headers: { Authorization: "Bearer fixed-token" } } } }),
			);
			// The daemon cannot listen on one port while `recall()` connects to another: the file the agent
			// reads is the answer.
			expect(memoryEndpoint(paths)).toEqual({ port: 8791, token: "fixed-token" });

			// A placeholder token means the environment holds it; say so rather than start a server nothing
			// can authenticate to.
			writeFileSync(
				join(root, ".flypi", "agent", "mcp.json"),
				JSON.stringify({ mcpServers: { "flypi-memory": { url: "http://127.0.0.1:8790/mcp", headers: { Authorization: "Bearer ${FLYPI_MEMORY_TOKEN}" } } } }),
			);
			delete process.env.FLYPI_MEMORY_TOKEN;
			expect(memoryEndpoint(paths)).toEqual({ port: 8790, note: "mcp.json asks for ${FLYPI_MEMORY_TOKEN}, which is not set — its requests will be refused" });
			process.env.FLYPI_MEMORY_TOKEN = "from-the-env";
			expect(memoryEndpoint(paths)).toEqual({ port: 8790, token: "from-the-env" });
			delete process.env.FLYPI_MEMORY_TOKEN;
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("writes the flypi-memory entry into a root that had no agent config", async () => {
		const logged: string[] = [];
		const d = await daemon({ log: (line) => logged.push(line) });
		try {
			const paths = flypiPaths(d.root);
			// The daemon picked its own memory port and minted its own token. The agent reaches them only
			// through the file, so a root that never had an agent dir now names this server.
			expect(memoryEndpoint(paths)).toEqual({ port: d.memoryPort, token: expect.any(String) });
			expect(logged.join("\n")).toMatch(/wrote the flypi-memory entry/);
			expect(logged.join("\n")).not.toMatch(/no flypi-memory entry/);

			// The empty `settings.json`/`models.json` pair comes with it: the settings panel has an empty list
			// to add to rather than a file it could not read, and a new conversation names the half that is
			// missing ("set defaultProvider and defaultModel") rather than reporting a broken install.
			expect(readConfig(paths).errors).toEqual([]);
			expect(readConfig(paths).endpoints).toEqual([]);
			expect(logged.join("\n")).toMatch(/no model is configured yet/);

			// The bearer the file now holds is the one the running server accepts — and a wrong one is refused,
			// so the first assertion is not passing on a server that stopped checking.
			const written = JSON.parse(readFileSync(paths.mcpPath, "utf8")) as { mcpServers: Record<string, { headers: { Authorization: string } }> };
			const authorization = written.mcpServers["flypi-memory"]!.headers.Authorization;
			const post = (auth: string) =>
				fetch(`http://127.0.0.1:${d.memoryPort}/mcp`, { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: "{}" });
			expect((await post(authorization)).status).not.toBe(401);
			expect((await post("Bearer not-the-token")).status).toBe(401);
		} finally {
			await d.dispose();
		}
	});

	it("moves the memory server off a port the file named that someone else took", async () => {
		const root = createTempFlypiRoot();
		const store = memory();
		// The state a recorded port falls into: the number is taken by the time the next start reads the file.
		const squatter = await startMemoryServer({ store: store.store });
		const taken = squatter.port;
		writeFileSync(
			flypiPaths(root).mcpPath,
			JSON.stringify({
				mcpServers: {
					"flypi-memory": { url: `http://127.0.0.1:${taken}/mcp`, headers: { Authorization: "Bearer fixed-token" }, exposure: "direct", toolExposure: { memory_cite: "hidden" } },
				},
			}),
		);
		const log: string[] = [];
		let d: Awaited<ReturnType<typeof startOn>> | undefined;
		try {
			d = await startOn(root, store, { log: (line) => log.push(line) });
			expect(d.memoryPort).not.toBe(taken);
			expect(log.join("\n")).toMatch(/something else already holds/);
			// The file now names the server that is actually running — and keeps what the operator wrote: the
			// token, which the running server accepts, and the exposure and per-tool exceptions this path
			// never touches. Losing `exposure` here would put the server back at pi's `codemode` default, and
			// the model would stop being offered the memory tools with nothing to show it.
			expect(memoryEndpoint(flypiPaths(root))).toEqual({ port: d.memoryPort, token: "fixed-token" });
			const entry = (JSON.parse(readFileSync(flypiPaths(root).mcpPath, "utf8")) as { mcpServers: Record<string, Record<string, unknown>> }).mcpServers["flypi-memory"]!;
			expect(entry.exposure).toBe("direct");
			expect(entry.toolExposure).toEqual({ memory_cite: "hidden" });
			const answer = await fetch(`http://127.0.0.1:${d.memoryPort}/mcp`, {
				method: "POST",
				headers: { authorization: "Bearer fixed-token", "content-type": "application/json" },
				body: "{}",
			});
			expect(answer.status).not.toBe(401);
		} finally {
			await d?.close();
			await squatter.close();
			store.db.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports itself on /healthz and in a pid file, then removes the file on the way out", async () => {
		const d = await daemon();
		try {
			// Unauthenticated: this is what `flypi status` and a service manager ask.
			expect(await healthAt(d.port)).toMatchObject({
				ok: true,
				pid: process.pid,
				memoryPort: d.memoryPort,
				version: "dev",
				// Which pi answers (docs/pi-upgrades.md Phase 8.1): the loaded module's version, read here by a
				// route the server does not use, and unpinned because nothing pinned it.
				pi: { version: (JSON.parse(readFileSync(resolve("node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8")) as { version: string }).version, pinned: false },
			});

			const info = readDaemonInfo(d.root);
			expect(info).toMatchObject({ pid: process.pid, port: d.port, token: d.token, memoryPort: d.memoryPort, version: "dev" });
			// It carries the token that guards the agent server, so it is not world-readable.
			expect(statSync(join(d.root, DAEMON_FILE)).mode & 0o777).toBe(0o600);
			// A root that never had a daemon has no file to read.
			expect(readDaemonInfo(join(d.root, "no-such-dir"))).toBeNull();
		} finally {
			await d.dispose();
		}
		// Nothing is left to mistake for a running daemon.
		expect(readDaemonInfo(d.root)).toBeNull();
	});

	it("the vault its web UI writes is the vault it owns", async () => {
		const d = await daemon();
		const client = await connect(d.url, d.token);
		try {
			// The daemon holds the memory database, so it is the one process a write from the page can go
			// through. Open it read-only here and this fails with "this vault is open read-only" — the Secrets
			// tab would list and redact and never be able to store anything (docs/secrets.md Phase 5.5).
			client.send({
				type: "saveSecrets",
				requestId: "w",
				secrets: [{ name: "router_admin", value: "a-password-nobody-typed", kind: "password", meta: { host: "192.168.1.1" } }],
			});
			const saved = await client.next((frame) => frame.type === "result" && frame.requestId === "w");
			expect(saved.type === "result" && saved.secrets?.secrets).toHaveLength(1);

			// Asked again as a fresh read, not as the echo of the write: the row is in the database the daemon
			// owns, and what comes back is a mask, a note and no value.
			client.send({ type: "secrets", requestId: "r" });
			const view = await client.next((frame) => frame.type === "result" && frame.requestId === "r");
			if (view.type !== "result" || !view.secrets) throw new Error("no vault");
			const row = view.secrets.secrets.find((secret) => secret.name === "router_admin");
			expect(row).toMatchObject({ kind: "password", meta: { host: "192.168.1.1" }, keyVersion: 1 });
			expect(row && "value" in row).toBe(false);
			expect(JSON.stringify(view)).not.toContain("a-password-nobody-typed");
		} finally {
			await client.close();
			await d.dispose();
		}
	});

	it("says which turn the last process left half-done, and the chat is told when it opens it", async () => {
		const root = createTempFlypiRoot();
		const store = memory();
		// A turn slow enough to still be going when the process goes away.
		const slow = { script: toolTurn("a considered answer that goes on for a while, one token at a time"), tokensPerSecond: 8 };
		const first = await startOn(root, store, slow);
		const client = await connect(first.url, first.token);
		let sessionPath = "";
		try {
			client.send({ type: "newSession", requestId: "r1" });
			const created = await client.next((frame) => frame.type === "result" && frame.requestId === "r1");
			if (created.type !== "result" || !created.conversationId || !created.sessionPath) throw new Error("no conversation");
			sessionPath = created.sessionPath;
			client.send({ type: "prompt", conversationId: created.conversationId, text: "go" });
			// Wait for the turn to be genuinely in flight: the record is the evidence, not an event we hope to see.
			for (let waited = 0; waited < 3000 && runStatus(root) !== "running"; waited += 20) await sleep(20);
			expect(runStatus(root)).toBe("running");
		} finally {
			await client.close();
			// Take the process away without letting the turn finish — the state a crash leaves. The turn is
			// not resumed and not thrown away; what survives on disk is what pi had finished writing, which for
			// a message still streaming is nothing (see the `message_end` note in docs/pi-api.md).
			await first.close();
		}
		expect(runStatus(root)).toBe("running");

		// The same store, a new process: what starting again after a crash does.
		const log: string[] = [];
		const second = await startOn(root, store, { log: (line) => log.push(line) });
		const client2 = await connect(second.url, second.token);
		try {
			expect(log.join("\n")).toMatch(/1 turn\(s\) were interrupted by the previous shutdown/);
			expect(runStatus(root)).toBe("interrupted");

			client2.send({ type: "newSession", requestId: "r1" });
			const fresh = await client2.next((frame) => frame.type === "result" && frame.requestId === "r1");
			if (fresh.type !== "result" || !fresh.conversationId) throw new Error("no conversation");
			client2.send({ type: "switchSession", conversationId: fresh.conversationId, sessionPath, requestId: "r2" });
			const openedChat = await client2.next((frame) => frame.type === "result" && frame.requestId === "r2");
			// The half-finished answer arrives with the reason it is half-finished.
			expect(openedChat.type === "result" && openedChat.interrupted).toEqual({ at: expect.any(String) });

			// What that chat can actually show, read the way the page reads it: the prompt is there, and the
			// answer that was streaming when the process died is not. The notice is what makes the gap
			// explainable — this is the assertion that stops the design docs promising a half answer.
			client2.send({ type: "resume", conversationId: fresh.conversationId, afterSeq: 0 });
			expect(await client2.next(messageEnd("user"), 5_000)).toBeTruthy();
			await expect(client2.next(messageEnd("assistant"), 1_000)).rejects.toThrow(/no frame matched/);

			// Asked again while that turn is still the last thing that happened to the chat, it is said again:
			// the notice belongs to the chat until a later turn supersedes it (see run-store.test.ts).
			client2.send({ type: "switchSession", conversationId: fresh.conversationId, sessionPath, requestId: "r3" });
			const reopened = await client2.next((frame) => frame.type === "result" && frame.requestId === "r3");
			expect(reopened.type === "result" && reopened.interrupted).toEqual({ at: expect.any(String) });
		} finally {
			await client2.close();
			await second.close();
			store.db.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("runs the job it was asked to run, with no client attached", async () => {
		const d = await daemon();
		try {
			// Queued through the store, which is how the write path queues it too: a stale index queues itself.
			d.store.queueJob("memory.reembed");
			expect(d.jobs.snapshot().jobs.map((job) => job.kind)).toEqual(["memory.reembed"]);
			expect(d.jobs.snapshot().jobRuns).toEqual([]);

			// A wait with a deadline: nothing asked for this pass, and no socket was open when it ran. The
			// re-embed queues the merge pass (a new vector space is a different set of near pairs), and a sweep
			// queues the wiki render — so the Phase 6 chain runs end to end with nobody connected.
			for (let waited = 0; waited < 5000 && d.jobs.snapshot().jobRuns.length < 3; waited += 20) await sleep(20);
			const runs = d.jobs.snapshot().jobRuns;
			expect(runs.map((run) => run.kind)).toEqual(["wiki.render", "memory.consolidate", "memory.reembed"]);
			expect(runs[2]).toMatchObject({ kind: "memory.reembed", status: "ok", detail: "re-embedded 0, skipped 0" });
			expect(runs[1]).toMatchObject({ kind: "memory.consolidate", status: "ok", detail: expect.stringContaining("rows 0 → 0") });
			expect(runs[0]).toMatchObject({ kind: "wiki.render", status: "ok", detail: "rendered 0 page(s), 0 section(s)" });
			// A job that ran waits rather than spinning, and new work makes it due again (store.queueJob).
			expect(d.jobs.snapshot().jobs.map((job) => job.kind).sort()).toEqual(["memory.consolidate", "memory.reembed", "wiki.render"]);
			expect(d.jobs.queued()).toBe(3);
			expect((await healthAt(d.port)).jobs).toBe(3);
		} finally {
			await d.dispose();
		}
	});

	it("sweeps and renders the wiki once the store has grown, with nobody connected", async () => {
		const d = await daemon();
		try {
			// Enough new rows to clear the trigger (`MIN_NEW_ROWS` in src/memory/consolidate.ts), and a pair of
			// them that the sweep should collapse into one.
			for (let index = 0; index < 25; index += 1) {
				await d.store.addMemory({ kind: "note", body: `note ${index} about the deploy host`, tags: [], origin_class: "agent", session_kind: "interactive", actor: "test" });
			}
			await d.store.addMemory({ kind: "note", body: "the deploy host is 10.0.0.5", tags: [], origin_class: "owner", session_kind: "interactive", actor: "user" });
			await d.store.addMemory({ kind: "note", body: "the deploy host is 10.0.0.5, the small box", tags: [], origin_class: "owner", session_kind: "interactive", actor: "user" });
			const before = d.store.memoryRowCount();

			// Nothing asked for this: the daemon noticed the rows and queued the sweep itself, then the render.
			for (let waited = 0; waited < 5000 && !d.jobs.snapshot().jobRuns.some((run) => run.kind === "wiki.render"); waited += 20) await sleep(20);
			const runs = d.jobs.snapshot().jobRuns;
			expect(runs.find((run) => run.kind === "memory.consolidate")).toMatchObject({ status: "ok", detail: expect.stringContaining("merged 1 cluster") });
			expect(runs.find((run) => run.kind === "wiki.render")).toMatchObject({ status: "ok", detail: expect.stringContaining("page(s)") });
			// Nothing disappeared: the merged copy is superseded, not gone (risk 9), and the wiki is a table of
			// pages a human can read.
			expect(d.store.memoryRowCount(), "a sweep made a row disappear").toBe(before);
			expect((d.db.db.prepare("SELECT count(*) AS n FROM wiki_pages").get() as unknown as { n: number }).n).toBeGreaterThan(0);
		} finally {
			await d.dispose();
		}
	});

	it("waits for the quiet: no sweep while a page is attached, and one the moment it lets go", async () => {
		const d = await daemon();
		const client = await connect(d.url, d.token);
		try {
			for (let index = 0; index < 30; index += 1) {
				await d.store.addMemory({ kind: "note", body: `note ${index} about the build cache`, tags: [], origin_class: "agent", session_kind: "interactive", actor: "test" });
			}
			// Many passes of the loop, and not one sweep: the store is being looked at.
			await sleep(300);
			expect(d.jobs.snapshot().jobRuns.some((run) => run.kind === "memory.consolidate"), "it swept with a page attached").toBe(false);

			// The gate is the attachment, not the clock: the same store, the same rows, one socket fewer.
			await client.close();
			for (let waited = 0; waited < 5000 && !d.jobs.snapshot().jobRuns.some((run) => run.kind === "memory.consolidate"); waited += 20) await sleep(20);
			expect(d.jobs.snapshot().jobRuns.find((run) => run.kind === "memory.consolidate")).toMatchObject({ status: "ok" });
		} finally {
			await d.dispose();
		}
	});

	it("repairs an index another model built, with nobody connected", async () => {
		const root = createTempFlypiRoot();
		const db = openTempFileDb();
		// Vectors written by a model this daemon does not use — what an upgrade leaves behind, and the reason
		// `indexIdentity()` queues the repair rather than refusing to compare them forever.
		const old = new MemoryStore(db.db, wordEmbedder({ model: "embeddinggemma-1", quantized: true }));
		await old.addMemory({ kind: "convention", body: "the deploy host is 10.0.0.5", tags: [], origin_class: "owner", session_kind: "interactive", actor: "user" });
		const store = { db, store: new MemoryStore(db.db, wordEmbedder()) };
		const lines: string[] = [];
		const d = await startOn(root, store, { log: (line) => lines.push(line) });
		try {
			// Asking what the index is queues the job that fixes it. Nothing in the path needs a client.
			expect(lines.join("\n")).toMatch(/stored vectors are not from test-embed-v1 — memory\.reembed is queued/);
			for (let waited = 0; waited < 5000 && d.jobs.snapshot().jobRuns.length === 0; waited += 20) await sleep(20);
			// By kind, not by position: the re-embed queues the merge pass, so the chain has already moved on.
			expect(d.jobs.snapshot().jobRuns.find((run) => run.kind === "memory.reembed")).toMatchObject({ status: "ok", detail: "re-embedded 1, skipped 0" });
			// Repaired: the vectors are now the daemon's own, and there is nothing left to queue.
			expect(store.store.indexIdentity()).toMatchObject({ rows: 1, stale: 0 });
		} finally {
			await d.close();
			db.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("says in the record what a sweep could not do", async () => {
		const root = createTempFlypiRoot();
		const db = openTempFileDb();
		const written = new MemoryStore(db.db, wordEmbedder());
		const id = (await written.addMemory({ kind: "convention", body: "the deploy host is 10.0.0.5", tags: [], origin_class: "owner", session_kind: "interactive", actor: "user" })).id;
		// The daemon comes up on a model that refuses this input. A sweep that did nothing is not a clean
		// run: the reason has to be in the record, or the row looks handled when it is not.
		const store = { db, store: new MemoryStore(db.db, refusingEmbedder("the input is longer than the model's window")) };
		store.store.queueJob("memory.reembed", { runAt: "2000-01-01T00:00:00.000Z" });
		const d = await startOn(root, store);
		try {
			for (let waited = 0; waited < 5000 && d.jobs.snapshot().jobRuns.length === 0; waited += 20) await sleep(20);
			expect(d.jobs.snapshot().jobRuns.find((run) => run.kind === "memory.reembed")).toMatchObject({
				status: "ok",
				detail: `re-embedded 0, skipped 1: #${id} the input is longer than the model's window`,
			});
		} finally {
			await d.close();
			db.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("releases the claim a dead process left, and says when a job has no handler yet", async () => {
		const root = createTempFlypiRoot();
		const store = memory();
		// A claim held by a process that is gone. It would stay locked forever: the row is open, so
		// `queueJob` will not queue a second copy of the kind, and nothing will ever run it. The kind is one
		// this build has no handler for, which is the other half of what the test is for.
		const jobId = store.store.queueJob("memory.reflect", { runAt: "2000-01-01T00:00:00.000Z" })[0]!;
		store.db.db.prepare("UPDATE jobs SET locked_by = 'dead-process', locked_at = '2026-10-11T09:00:00.000Z' WHERE id = ?").run(jobId);
		const lines: string[] = [];
		const d = await startOn(root, store, { log: (line) => lines.push(line) });
		try {
			expect(lines.join("\n")).toMatch(/released 1 job claim\(s\) left by a dead process/);
			// Unlocked, still due, so the next pass takes it.
			expect(d.jobs.snapshot().jobs).toEqual([{ kind: "memory.reflect", nextRunAt: "2000-01-01T00:00:00.000Z", running: false }]);
			for (let waited = 0; waited < 5000 && d.jobs.snapshot().jobRuns.length === 0; waited += 20) await sleep(20);
			// A job nobody implements is a record saying so, not a row that stays open and says nothing —
			// which is what the scheduler tab is for.
			expect(d.jobs.snapshot().jobRuns[0]).toMatchObject({
				kind: "memory.reflect",
				status: "failed",
				detail: "no handler for memory.reflect: that phase has not landed",
			});
		} finally {
			await d.close();
			store.db.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("records the token it was handed, which is what `flypi status` prints", async () => {
		const root = createTempFlypiRoot();
		const store = memory();
		// `FLYPI_TOKEN` / `--token`: the token may come from outside, and the pid file is how the CLI can
		// tell you the URL and token of a process it did not start.
		const d = await startOn(root, store, { token: "a-token-from-the-env" });
		try {
			expect(d.token).toBe("a-token-from-the-env");
			expect(readDaemonInfo(root)).toMatchObject({ token: "a-token-from-the-env", port: d.port });
			// The health page is still open to a poller that has no token at all.
			expect(await healthAt(d.port)).toMatchObject({ ok: true });
		} finally {
			await d.close();
			store.db.dispose();
			rmSync(root, { recursive: true, force: true });
		}
		expect(readDaemonInfo(root)).toBeNull();
	});

	it("comes up from what the launcher actually passes: no port, no token, no paths to override", async () => {
		const root = createTempFlypiRoot();
		const store = memory();
		// The default log is the console; this test is not here to print. `scripts/serve-daemon.ts` passes
		// exactly these options when nothing on the command line was overridden — the daemon picks its own
		// port, mints its own token and knows where its own pid file goes.
		const logged = vi.spyOn(console, "log").mockImplementation(() => {});
		let d: DaemonHandle | undefined;
		const runs = openRunStore(flypiPaths(root));
		openedRuns.push(runs);
		try {
			d = await startFlypiDaemon({ paths: flypiPaths(root), db: store.db.db, store: store.store, runs });
			expect(d.port).toBeGreaterThan(0);
			expect(d.token.length).toBeGreaterThan(0);
			expect(d.memoryPort).toBeGreaterThan(0);
			// The file lands where the docs say it does, and holds what `flypi status` needs to find this
			// process again — including the token it minted, which is why the file is 0600.
			expect(readDaemonInfo(root)).toMatchObject({ pid: process.pid, port: d.port, token: d.token, memoryPort: d.memoryPort });
			expect(statSync(join(root, DAEMON_FILE)).mode & 0o777).toBe(0o600);
			expect(await healthAt(d.port)).toMatchObject({ ok: true, version: "dev", jobs: 0 });
			// Counted on the health page. Queued in the future, not due: the loop takes its first pass as soon
			// as it starts (`setTimeout(tick, 0)`), so a due job here would be run — and a re-embed queues the
			// merge pass — somewhere in the window this fetch opens, which is what made this assertion flaky.
			store.store.queueJob("memory.reembed", { runAt: "2999-01-01T00:00:00.000Z" });
			expect((await healthAt(d.port)).jobs).toBe(1);
		} finally {
			await d?.close();
			store.db.dispose();
			rmSync(root, { recursive: true, force: true });
			logged.mockRestore();
		}
		expect(readDaemonInfo(root)).toBeNull();
	});

	it("has no UI to serve until the UI is built", () => {
		const root = createTempFlypiRoot();
		try {
			expect(builtUi(root)).toBeUndefined();
			mkdirSync(join(root, "dist", "ui"), { recursive: true });
			expect(builtUi(root)).toBe(join(root, "dist", "ui"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	// The settings view reports what the daemon last found for the extensions it loads (docs/protocol.md
	// `packages`): the network question is the daemon's, so opening the panel never asks a registry, and a
	// process that has never checked says so instead of showing an empty list.
	it("writes the extension-package check the settings view reads", async () => {
		const root = createTempFlypiRoot();
		const paths = flypiPaths(root);
		// A local package: there is no registry newer than a path, so the answer is "nothing waiting" — what is
		// under test is that the daemon wrote an answer at all, offline, and that the panel reads it.
		const dir = join(root, "my-pkg");
		mkdirSync(join(dir, "extensions"), { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "my-pkg", version: "1.0.0", pi: { extensions: ["extensions/tool.ts"] } }));
		writeFileSync(join(dir, "extensions", "tool.ts"), "export default function () {}\n");
		writeFileSync(paths.settingsPath, JSON.stringify({ packages: [dir] }, null, 2));
		const store = memory();
		const d = await startOn(root, store);
		try {
			for (let waited = 0; waited < 5000 && readPackageCheck(root) === null; waited += 20) await sleep(20);
			expect(readPackageCheck(root)).toMatchObject({ updates: [] });
			// The list the panel renders: the entry as the file holds it, its code on disk, and no `update` —
			// nothing is newer than a path, and a badge is only ever the stamp's answer.
			const listed = readPackages(paths);
			expect(listed.packages).toEqual([{ source: dir, scope: "user", installed: true, path: dir, version: "1.0.0" }]);
			expect(listed.errors).toEqual([]);
			expect(Date.parse(listed.checkedAt ?? "")).not.toBeNaN();
		} finally {
			await d.close();
			store.db.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
