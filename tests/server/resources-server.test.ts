/**
 * The dispatcher's seam proof (Phase 11.2 T27): a fake resource — `gizmo` — registered from
 * the outside and driven read + write + "unavailable in this process" over a REAL WebSocket, with no
 * change to `src/server/index.ts`. A real resource is `{ field, commands, impl }`; the server needs
 * nothing else. `startFlypiServer` takes the parse union and the impls, merges them over the eight
 * built-ins, and the dispatcher treats `gizmo` exactly like `secrets`.
 *
 * The fake's result frame cannot satisfy `checkServerFrame` — `ResultFrame` stays a closed union, and
 * opening it is a protocol version bump, deliberately out of scope here. This test therefore asserts
 * on the parsed JSON of the frames, not on checked frames.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Type } from "typebox";
import { startFlypiServer, type FlypiServerHandle } from "../../src/server/index.ts";
import { ClientCommandSchema } from "../../src/server/protocol.ts";
import type { ResourceEntry } from "../../src/server/resources-server.ts";
import { harness, toolTurn } from "../helpers/flypi-harness.ts";
import { homeEnv, withProviderConfig } from "../helpers/flypi-root.ts";

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

describe("the resource dispatcher answers a fake resource over a real socket", () => {
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
			const refused = (await client.anyError()) as { message?: string; requestId?: string };
			expect(refused.message).toMatch(/^not a flypi command/);
			expect(refused.requestId).toBeUndefined();
		} finally {
			await client.close();
			await server.close();
			h.cleanup();
		}
	});
});

/**
 * `.flypi/agent/agents` — the agent types flypi's subagent extension can spawn — as the eighth resource, read
 * and written over a real socket against a temp root (this worktree's own `.flypi/` is never opened). Every
 * assertion is on the **frames**, because that is the claim of the resource table: `src/server/index.ts` gained
 * no routing arm and no `deps` field for this resource, and `commandTargets` found both commands in `RESOURCES`.
 */
describe("the subagent agent types are a resource the browser reads and writes", () => {
	/** Flypi's own agents dir, seeded. */
	function agentsDirOf(root: string, files: Record<string, string>): string {
		const dir = join(root, ".flypi", "agent", "agents");
		mkdirSync(dir, { recursive: true });
		for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
		return dir;
	}

	/**
	 * A host home that is not the operator's, whose `~/.pi/agent/agents` either holds these files or is not there
	 * at all — the two states the panel's import button distinguishes. `os.homedir()` takes `$HOME` at call time,
	 * which is how `hostAgentsDir()` is aimed at a temp dir (as in tests/agent/subagent-agents.test.ts).
	 */
	function plantedHome(files?: Record<string, string>): { agentsDir: string; restore(): void } {
		const home = mkdtempSync(join(tmpdir(), "flypi-hostagents-"));
		const agentsDir = join(home, ".pi", "agent", "agents");
		if (files) {
			mkdirSync(agentsDir, { recursive: true });
			for (const [name, text] of Object.entries(files)) writeFileSync(join(agentsDir, name), text);
		}
		const env = homeEnv(home);
		return {
			agentsDir,
			restore: () => {
				env.restore();
				rmSync(home, { recursive: true, force: true });
			},
		};
	}

	/** One row's world: the harness's throwaway root, a real server on it, and a socket on that server. */
	async function connected(h: Awaited<ReturnType<typeof harness>>) {
		const server = await startFlypiServer({ registry: h.registry });
		const client = await connect(server.url, server.token);
		return {
			client,
			close: async () => {
				await client.close();
				await server.close();
				h.cleanup();
			},
		};
	}

	/** The shape the resource answers with, as it arrived on the wire. */
	interface AgentsSnapshot {
		rows: Record<string, unknown>[];
		source: { path: string; exists: boolean };
		errors: string[];
	}

	/** The `subagentAgents` half of a reply. */
	function snapshot(frame: Record<string, unknown>): AgentsSnapshot {
		return frame.subagentAgents as AgentsSnapshot;
	}

	// The rows are the answers tests/agent/subagent-agents.test.ts pins for this root shape: the ask the local
	// credential serves is resolvable, the ask nobody serves still names the model the run lands on, and neither row
	// carries the available set the answer was computed over — two credentialed providers measured 402 entries.
	it("reads the agent files and the import source", async () => {
		const h = await harness(toolTurn());
		withProviderConfig(h.root, { defaultProvider: "lmstudio", defaultModel: "qwen3" }, { lmstudio: { type: "api_key", key: "local" } });
		const agents = agentsDirOf(h.root, {
			"scout.md": "---\ndescription: read the repo\nmodel: lmstudio/qwen3\n---\nbody\n",
			"pilot.md": "---\ndescription: fly it\nmodel: playred-lms/spark-x2.6-4b\n---\nbody\n",
		});
		const host = plantedHome({ "researcher.md": "---\ndescription: read it once\n---\nbody\n" });
		const c = await connected(h);
		try {
			c.client.send({ type: "subagentAgents", requestId: "r1" });
			expect(await c.client.for("r1")).toEqual({
				type: "result",
				requestId: "r1",
				subagentAgents: {
					rows: [
						{ type: "pilot", file: join(agents, "pilot.md"), description: "fly it", model: "playred-lms/spark-x2.6-4b", runsOn: "lmstudio/qwen3", resolvable: false },
						{ type: "scout", file: join(agents, "scout.md"), description: "read the repo", model: "lmstudio/qwen3", runsOn: "lmstudio/qwen3", resolvable: true },
					],
					source: { path: host.agentsDir, exists: true },
					errors: [],
				},
			});
		} finally {
			host.restore();
			await c.close();
		}
	});

	// A root with no `.flypi/agent/agents` at all — flypi never creates it (plan decision 13) — answers with an
	// empty list, and `source.exists: false` is the other half of the panel's sentence: "nothing here yet" and
	// "there is nowhere to import from" are different states, and the dev container is permanently the second one.
	it("reads an empty list, and says so about both directories, on a root with no agents dir", async () => {
		const h = await harness(toolTurn());
		const host = plantedHome();
		const c = await connected(h);
		try {
			c.client.send({ type: "subagentAgents", requestId: "r1" });
			const frame = await c.client.for("r1");
			expect(frame.type).toBe("result");
			expect(snapshot(frame)).toEqual({ rows: [], source: { path: host.agentsDir, exists: false }, errors: [] });
			expect(existsSync(join(h.root, ".flypi", "agent", "agents"))).toBe(false); // the read still created nothing
		} finally {
			host.restore();
			await c.close();
		}
	});

	// The write replies the **refreshed** list rather than an ack: the panel needs the rows the copy produced,
	// including that `notes.txt` never became a type. `source` is the directory the import actually read.
	it("imports the host's `*.md` and replies the refreshed list", async () => {
		const h = await harness(toolTurn());
		withProviderConfig(h.root, { defaultProvider: "lmstudio", defaultModel: "qwen3" }, { lmstudio: { type: "api_key", key: "local" } });
		const agents = join(h.root, ".flypi", "agent", "agents");
		const host = plantedHome({
			"scout.md": "---\ndescription: read the repo\nmodel: lmstudio/qwen3\n---\nbody\n",
			"notes.txt": "not a type\n",
		});
		const c = await connected(h);
		try {
			c.client.send({ type: "importSubagentAgents", requestId: "r2" });
			expect(await c.client.for("r2")).toEqual({
				type: "result",
				requestId: "r2",
				subagentAgents: {
					rows: [{ type: "scout", file: join(agents, "scout.md"), description: "read the repo", model: "lmstudio/qwen3", runsOn: "lmstudio/qwen3", resolvable: true }],
					source: { path: host.agentsDir, exists: true },
					errors: [],
				},
			});
		} finally {
			host.restore();
			await c.close();
		}
	});

	// The container has no `~/.pi/agent/agents`, and the panel's disabled button is a courtesy rather than a
	// guard: a write that arrives anyway answers with the path it looked in, on an error frame, instead of
	// replying a list that changed for no reason. Verbatim, because the panel shows this sentence.
	it("refuses an import with a sentence when there is nowhere to import from", async () => {
		const h = await harness(toolTurn());
		const host = plantedHome();
		const c = await connected(h);
		try {
			c.client.send({ type: "importSubagentAgents", requestId: "r3" });
			expect(await c.client.for("r3")).toEqual({
				type: "error",
				message: `${host.agentsDir} does not exist — there is nothing to import from it`,
				requestId: "r3",
			});
		} finally {
			host.restore();
			await c.close();
		}
	});

	// The other refusal, and the module's own words for it: an operator who moved the directory and left a link
	// in its place (the dotfiles-manager shape T46.3.1 reviewed) has made flypi's dir *be* the host dir. Running
	// that import would report every file as "already there" and call it a success.
	it("refuses the import whose source is flypi's own agents directory", async () => {
		const h = await harness(toolTurn());
		const host = plantedHome({ "scout.md": "---\ndescription: read the repo\n---\nbody\n" });
		mkdirSync(join(h.root, ".flypi", "agent"), { recursive: true });
		symlinkSync(host.agentsDir, join(h.root, ".flypi", "agent", "agents"));
		const c = await connected(h);
		try {
			c.client.send({ type: "importSubagentAgents", requestId: "r4" });
			expect(await c.client.for("r4")).toEqual({
				type: "error",
				message: `${host.agentsDir} is flypi's own agents directory — there is nothing to import from here`,
				requestId: "r4",
			});
		} finally {
			host.restore();
			await c.close();
		}
	});

	// `readAgentTypes` reads the root's default model out of `settings.json` through `readForWrite`, which throws
	// on a file that will not parse. That must not blank the list — the panel would say "no agent types" about
	// files that are plainly on disk — so the rows come back with **no model claims** and the file's own sentence
	// in `errors`, the way `readConfig` reports the same file (src/agent/config-files.ts).
	it("keeps the rows and drops the claims when `settings.json` will not parse", async () => {
		const h = await harness(toolTurn());
		const agents = agentsDirOf(h.root, { "scout.md": "---\ndescription: read the repo\nmodel: lmstudio/qwen3\n---\nbody\n" });
		const settings = join(h.root, ".flypi", "agent", "settings.json");
		writeFileSync(settings, "{ this is not json\n");
		const host = plantedHome();
		const c = await connected(h);
		try {
			c.client.send({ type: "subagentAgents", requestId: "r5" });
			const frame = await c.client.for("r5");
			expect(frame.type, JSON.stringify(frame)).toBe("result");
			expect(snapshot(frame).rows).toEqual([{ type: "scout", file: join(agents, "scout.md"), description: "read the repo", model: "lmstudio/qwen3" }]);
			expect(snapshot(frame).errors).toEqual([expect.stringContaining(settings)]);
			expect(snapshot(frame).source).toEqual({ path: host.agentsDir, exists: false });
		} finally {
			host.restore();
			await c.close();
		}
	});

	// What the row above deliberately does **not** catch: a failure that is not a config file the operator can
	// fix is a flypi bug, and a bug answers with an error frame rather than a half-truth in `errors`.
	it("answers a failure that is not the config file's with an error frame", async () => {
		const h = await harness(toolTurn());
		agentsDirOf(h.root, { "scout.md": "---\ndescription: read the repo\n---\nbody\n" });
		const settings = join(h.root, ".flypi", "agent", "settings.json");
		rmSync(settings);
		mkdirSync(settings); // unreadable as a file, and no `FlypiConfigError` explains it
		const host = plantedHome();
		const c = await connected(h);
		try {
			c.client.send({ type: "subagentAgents", requestId: "r6" });
			const frame = await c.client.for("r6");
			// Swallowing every throw would answer this with a `result` whose rows silently lost their model answers;
			// the message is the OS's own sentence (`EISDIR` here, `EPERM` on Windows), so the frame's *kind* is the
			// assertion, not its words.
			expect(frame.type).toBe("error");
			expect(frame.subagentAgents).toBeUndefined();
		} finally {
			host.restore();
			await c.close();
		}
	});
});
