/**
 * The dispatcher's seam proof (Phase 11.2 T27): an eighth, fake resource — `gizmo` — registered from
 * the outside and driven read + write + "unavailable in this process" over a REAL WebSocket, with no
 * change to `src/server/index.ts`. A real resource is `{ field, commands, impl }`; the server needs
 * nothing else. `startFlypiServer` takes the parse union and the impls, merges them over the seven
 * built-ins, and the dispatcher treats `gizmo` exactly like `secrets`.
 *
 * The fake's result frame cannot satisfy `checkServerFrame` — `ResultFrame` stays a closed union, and
 * opening it is a protocol version bump, deliberately out of scope here. This test therefore asserts
 * on the parsed JSON of the frames, not on checked frames.
 */
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Type } from "typebox";
import { startFlypiServer, type FlypiServerHandle } from "../../src/server/index.ts";
import { ClientCommandSchema } from "../../src/server/protocol.ts";
import type { ResourceEntry } from "../../src/server/resources-server.ts";
import { harness, toolTurn } from "../helpers/flypi-harness.ts";

const GizmoGet = Type.Object({ type: Type.Literal("gizmoGet"), requestId: Type.Optional(Type.String({ minLength: 1 })) });
const GizmoPut = Type.Object({
	type: Type.Literal("gizmoPut"),
	value: Type.String({ minLength: 1 }),
	requestId: Type.Optional(Type.String({ minLength: 1 })),
});

function connect(url: string, token: string) {
	const socket = new WebSocket(`${url}/?token=${encodeURIComponent(token)}`);
	const frames: Record<string, unknown>[] = [];
	let cursor = 0;
	socket.on("message", (raw) => frames.push(JSON.parse(String(raw)) as Record<string, unknown>));
	const opened = new Promise<void>((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
	return opened.then(() => ({
		send: (command: object) => socket.send(JSON.stringify(command)),
		/** The next error frame, wherever its requestId is — a frame the schema refuses never gets one. */
		anyError: () =>
			new Promise<Record<string, unknown>>((resolve, reject) => {
				const deadline = Date.now() + 5_000;
				const poll = () => {
					const frame = frames.find((candidate) => candidate.type === "error");
					if (frame) return resolve(frame);
					if (Date.now() > deadline) return reject(new Error(`no error frame; got ${JSON.stringify(frames)}`));
					setTimeout(poll, 5);
				};
				poll();
			}),
		for: (requestId: string) =>
			new Promise<Record<string, unknown>>((resolve, reject) => {
				const deadline = Date.now() + 5_000;
				const poll = () => {
					for (let index = cursor; index < frames.length; index += 1) {
						if (frames[index]!.requestId === requestId) {
							cursor = index + 1;
							return resolve(frames[index]!);
						}
					}
					if (Date.now() > deadline) return reject(new Error(`no reply to ${requestId}; got ${JSON.stringify(frames)}`));
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

describe("the resource dispatcher answers a fake eighth resource over a real socket", () => {
	it("reads, writes and refuses `gizmo` without index.ts knowing the name", async () => {
		const h = await harness(toolTurn());
		// The fake's whole state: an availability the test flips, and a value the write refreshes.
		let open = true;
		let stored = "widget";
		const gizmo: ResourceEntry = {
			field: "gizmo",
			reads: ["gizmoGet"],
			writes: ["gizmoPut"],
			impl: {
				available: () => open,
				// Different sentences per direction, so the refusals below prove which guard spoke.
				unavailable: { read: "this test process has no gizmo to read", write: "this test process has no gizmo to write" },
				read: () => ({ stored }),
				apply: (command) => {
					// A dispatcher hands the command it parsed; this fake knows its own shape.
					const value = (command as unknown as { value: string }).value;
					// A string is the refused-action contract `usePi` already has.
					if (value === "refuse") return "the gizmo refused";
					stored = value;
					return { stored };
				},
			},
		};
		const server: FlypiServerHandle = await startFlypiServer({
			registry: h.registry,
			clientCommandSchema: Type.Union([ClientCommandSchema, GizmoGet, GizmoPut]),
			resources: { gizmo },
		});
		const client = await connect(server.url, server.token);
		try {
			client.send({ type: "gizmoGet", requestId: "g1" });
			expect(await client.for("g1")).toEqual({ type: "result", requestId: "g1", gizmo: { stored: "widget" } });

			// The write replies with the refreshed snapshot on the same field, as saveConfig does.
			client.send({ type: "gizmoPut", value: "sprocket", requestId: "g2" });
			expect(await client.for("g2")).toEqual({ type: "result", requestId: "g2", gizmo: { stored: "sprocket" } });

			// A refused action answers with the string, on the requestId, like any refusal.
			client.send({ type: "gizmoPut", value: "refuse", requestId: "g3" });
			expect(await client.for("g3")).toEqual({ type: "error", message: "the gizmo refused", requestId: "g3" });

			// "Unavailable in this process": the guard's sentence, per direction, never the handler.
			open = false;
			client.send({ type: "gizmoGet", requestId: "g4" });
			expect(await client.for("g4")).toEqual({ type: "error", message: "this test process has no gizmo to read", requestId: "g4" });
			client.send({ type: "gizmoPut", value: "sprocket", requestId: "g5" });
			expect(await client.for("g5")).toEqual({ type: "error", message: "this test process has no gizmo to write", requestId: "g5" });

			// The union is additive: a real command still round-trips on the same socket.
			client.send({ type: "listSessions", requestId: "g6" });
			expect((await client.for("g6")).type).toBe("result");
		} finally {
			await client.close();
			await server.close();
			h.cleanup();
		}
	});

	it("a server without the seam refuses the fake command at the schema, as before", async () => {
		const h = await harness(toolTurn());
		const server = await startFlypiServer({ registry: h.registry });
		const client = await connect(server.url, server.token);
		try {
			client.send({ type: "gizmoGet", requestId: "g1" });
			// No resource lookup happens for a frame the protocol refuses: the message is the parse's own,
			// and the frame carries no requestId because nothing parsed.
			expect(((await client.anyError()) as { message?: string }).message).toMatch(/^not a flypi command/);
		} finally {
			await client.close();
			await server.close();
			h.cleanup();
		}
	});
});
