/**
 * The Memory tab's wire (docs/memory.md Phase 6, docs/protocol.md), driven by a scripted WS client against a
 * real store. What the page depends on is a property of the frames: the snapshot lists every row in every
 * status (so a superseded chain and a tombstone are both visible and undoable), an edit comes back with the
 * audit row it wrote, undo puts a pre-image back and moves nothing else, and a process that has no memory
 * database says so instead of answering with an empty store.
 */
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { flypiPaths } from "../../src/agent/paths.ts";
import { openMemoryDb } from "../../src/memory/db.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import { renderWiki } from "../../src/memory/wiki.ts";
import { memoryApi } from "../../src/server/memory-api.ts";
import { startFlypiServer, type FlypiServerHandle } from "../../src/server/index.ts";
import { checkServerFrame, type ClientCommand, type MemorySnapshot, type ServerFrame } from "../../src/server/protocol.ts";
import { harness, toolTurn } from "../helpers/flypi-harness.ts";
import { wordEmbedder } from "../helpers/memory-db.ts";

function connect(url: string, token: string) {
	const socket = new WebSocket(`${url}/?token=${encodeURIComponent(token)}`);
	const frames: ServerFrame[] = [];
	let cursor = 0;
	socket.on("message", (raw) => {
		const frame = JSON.parse(String(raw)) as ServerFrame;
		// Every frame has to satisfy its own schema — the page renders straight from these.
		expect(checkServerFrame(frame).ok, `server sent a frame that violates its own schema: ${String(raw)}`).toBe(true);
		frames.push(frame);
	});
	const opened = new Promise<void>((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
	return opened.then(() => ({
		send: (command: ClientCommand) => socket.send(JSON.stringify(command)),
		for: (requestId: string) =>
			new Promise<ServerFrame>((resolve, reject) => {
				const deadline = Date.now() + 5_000;
				const poll = () => {
					for (let index = cursor; index < frames.length; index += 1) {
						const frame = frames[index]!;
						if (("requestId" in frame ? frame.requestId : undefined) === requestId) {
							cursor = index + 1;
							return resolve(frame);
						}
					}
					if (Date.now() > deadline) return reject(new Error(`no reply to ${requestId}; got ${frames.map((frame) => frame.type).join(",")}`));
					setTimeout(poll, 5);
				};
				poll();
			}),
		close: () =>
			new Promise<void>((resolve) => {
				socket.once("close", () => resolve());
				socket.close();
			}),
	}));
}

async function startMemoryServer(options: { withStore?: boolean } = {}) {
	const checkout = await harness(toolTurn());
	const paths = flypiPaths(checkout.root);
	const db = openMemoryDb(paths.memoryDbPath);
	const store = new MemoryStore(db, wordEmbedder());
	const server: FlypiServerHandle = await startFlypiServer({
		registry: checkout.registry,
		...(options.withStore === false ? {} : { memory: memoryApi(store, db) }),
	});
	return {
		server,
		store,
		db,
		client: () => connect(server.url, server.token),
		dispose: async () => {
			await server.close();
			db.close();
			checkout.cleanup();
		},
	};
}

const remember = async (store: MemoryStore, body: string, kind = "note") =>
	(await store.addMemory({ kind, body, tags: ["deploy"], origin_class: "owner", session_kind: "interactive", actor: "user" })).id;

type Client = Awaited<ReturnType<typeof connect>>;
const ask = async (client: Client, type: ClientCommand["type"]) => {
	const requestId = `r-${type}-${Math.random().toString(36).slice(2, 8)}`;
	client.send({ type, requestId } as ClientCommand);
	return client.for(requestId);
};

describe("the memory browser over the wire", () => {
	it("answers with the rows, the turn log, the wiki and the numbers", async () => {
		const h = await startMemoryServer();
		try {
			const kept = await remember(h.store, "the deploy host is the small box");
			const retired = await remember(h.store, "we deploy with docker");
			h.store.forget(retired, "ui", "wrong");
			// A turn that was shown one row and cited it: the pair the hit-rate numbers and the per-turn cost
			// are computed from.
			h.store.ensureConversation({ id: "conv-1", cwd: h.server.url });
			const turn = h.store.recordTurn("conv-1", { userText: "where do we deploy", retrieved: [kept], cited: [kept] });
			renderWiki(h.store, h.db);

			const frame = await ask(await h.client(), "memory");
			expect(frame.type).toBe("result");
			const snapshot = (frame as { memory?: MemorySnapshot }).memory!;
			// Every status is listed: the browser is where a superseded chain and a tombstone are found.
			expect(snapshot.memories.map((row) => [row.id, row.status])).toEqual([
				[retired, "deleted"],
				[kept, "active"],
			]);
			expect(snapshot.memories[1]).toMatchObject({
				body: "the deploy host is the small box",
				kind: "note",
				tags: ["deploy"],
				originClass: "owner",
				history: [{ action: "create", actor: "user" }],
			});
			expect(snapshot.turns).toEqual([
				{
					id: turn,
					conversationId: "conv-1",
					createdAt: expect.any(String),
					userText: "where do we deploy",
					retrieved: [kept],
					cited: [kept],
					// The rows shown to that turn, estimated the way the injection budget estimates them.
					injectedTokens: Math.ceil("the deploy host is the small box".length / 4),
				},
			]);
			expect(snapshot.wiki.map((page) => page.slug)).toEqual(["note"]);
			expect(snapshot.wiki[0]!.body).toContain(`[#${kept}]`);
			expect(snapshot.stats).toMatchObject({ turns: 1, turnsShownMemories: 1, turnsCiting: 1, memoriesRetrieved: 1, memoriesCited: 1, rate: 1, indexRows: 1 }); // only the active row has a vector the index counts
		} finally {
			await h.dispose();
		}
	});

	it("edits a row, and the ack carries the audit chain the edit wrote", async () => {
		const h = await startMemoryServer();
		try {
			const id = await remember(h.store, "the deploy host is the small box");
			const client = await h.client();
			const requestId = "edit-1";
			client.send({ type: "saveMemory", memories: [{ id, body: "the deploy host is the tiny box", tags: ["deploy", "home-lab"] }], requestId });
			const snapshot = ((await client.for(requestId)) as { memory: MemorySnapshot }).memory;
			expect(snapshot.memories[0]).toMatchObject({
				id,
				body: "the deploy host is the tiny box",
				tags: ["deploy", "home-lab"],
				history: [
					{ action: "create", actor: "user" },
					// The pre-image is what the row looked like before, so the page can offer an undo without
					// ever having held the old value itself.
					{ action: "edit", actor: "ui", preImage: expect.stringContaining("the small box") },
				],
			});
			expect(h.store.memory(id)!.body).toBe("the deploy host is the tiny box");
		} finally {
			await h.dispose();
		}
	});

	it("deletes into a tombstone and puts it back by undoing that delete", async () => {
		const h = await startMemoryServer();
		try {
			const id = await remember(h.store, "the deploy host is the small box");
			const client = await h.client();
			client.send({ type: "saveMemory", memories: [{ id, remove: true }], requestId: "del-1" });
			const after = ((await client.for("del-1")) as { memory: MemorySnapshot }).memory;
			expect(after.memories[0]!.status).toBe("deleted");
			// The row is still listed — `select count(*)` did not go down, which is what makes the undo possible.
			expect(after.memories).toHaveLength(1);

			const forgetEntry = after.memories[0]!.history.find((entry) => entry.action === "forget")!;
			client.send({ type: "saveMemory", memories: [{ id, undoAudit: forgetEntry.id }], requestId: "undo-1" });
			const back = ((await client.for("undo-1")) as { memory: MemorySnapshot }).memory;
			expect(back.memories[0]!.status).toBe("active");
			expect(h.store.memory(id)!.status).toBe("active");
		} finally {
			await h.dispose();
		}
	});

	it("undoes one audited change and changes nothing else", async () => {
		const h = await startMemoryServer();
		try {
			const survivor = await remember(h.store, "we use pnpm, never npm", "convention");
			const merged = await remember(h.store, "the deploy host is the small box", "convention");
			h.store.markSuperseded(merged, survivor, "sweep", "consolidation: the same fact as #1");
			const other = await remember(h.store, "the build cache lives on the nvme disk");

			const client = await h.client();
			const supersede = ((await ask(client, "memory")) as { memory: MemorySnapshot }).memory.memories
				.find((row) => row.id === merged)!
				.history.find((entry) => entry.action === "supersede")!;
			client.send({ type: "saveMemory", memories: [{ id: merged, undoAudit: supersede.id }], requestId: "undo-2" });
			const restored = ((await client.for("undo-2")) as { memory: MemorySnapshot }).memory;
			expect(restored.memories.find((row) => row.id === merged)!.status).toBe("active");
			// Nothing else moved: the survivor is still active, the third row is untouched, and the undo is
			// itself audited rather than erasing history.
			expect(restored.memories.find((row) => row.id === survivor)!.status).toBe("active");
			expect(restored.memories.find((row) => row.id === other)!.status).toBe("active");
			expect(restored.memories.find((row) => row.id === merged)!.history.map((entry) => entry.action)).toEqual([
				"create",
				"supersede",
				"edit",
			]);
		} finally {
			await h.dispose();
		}
	});

	it("refuses an edit with nothing to change, and refuses to undo a write", async () => {
		const h = await startMemoryServer();
		try {
			const id = await remember(h.store, "the deploy host is the small box");
			const client = await h.client();
			client.send({ type: "saveMemory", memories: [{ id }], requestId: "noop" });
			expect(((await client.for("noop")) as { message?: string }).message).toContain("nothing to change");

			const created = ((await ask(client, "memory")) as { memory: MemorySnapshot }).memory.memories[0]!.history[0]!;
			client.send({ type: "saveMemory", memories: [{ id, undoAudit: created.id }], requestId: "undo-create" });
			expect(((await client.for("undo-create")) as { message?: string }).message).toMatch(/does not un-write a fact/);
			expect(h.store.memory(id)!.status).toBe("active");
		} finally {
			await h.dispose();
		}
	});

	it("a process with no memory store says so, rather than showing an empty one", async () => {
		const h = await startMemoryServer({ withStore: false });
		try {
			const frame = await ask(await h.client(), "memory");
			expect((frame as { message?: string }).message).toMatch(/no memory store open/);
		} finally {
			await h.dispose();
		}
	});
});
