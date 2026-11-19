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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Type } from "typebox";
import { startFlypiServer, type FlypiServerHandle } from "../../src/server/index.ts";
import { ClientCommandSchema, SubagentAgentsRow, SubagentAgentsSnapshot } from "../../src/server/protocol.ts";
import type { AgentTypeRow, AgentTypesSnapshot } from "../../src/agent/subagent-agents.ts";
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
		/** The import's report; on a plain read these keys are absent, not empty. */
		copied?: string[];
		skipped?: string[];
		ignored?: string[];
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
					// The write's own report, in the frame that used to be indistinguishable from a read's
					// (T46.3.3 review). `notes.txt` is `ignored`, not a row and not an error.
					copied: [join(agents, "scout.md")],
					skipped: [],
					ignored: ["notes.txt"],
				},
			});
		} finally {
			host.restore();
			await c.close();
		}
	});

	// The answer to the click. `importAgentFiles` reports what it copied and what it refused to overwrite
	// (src/agent/subagent-agents.ts, `AgentImportReport`), and a snapshot that dropped that report replies to Import
	// with the very list a plain read gives — so the panel could not say "kept your `scout.md`, which you had
	// edited", which is the promise the import is built under ("A file already in flypi's dir is never
	// overwritten"). The read that follows carries **none** of the three keys: an empty `skipped` would read back as
	// "there was nothing to keep", which is the opposite of what just happened.
	it("says what the import copied and what it refused to overwrite, and the read after it says neither", async () => {
		const h = await harness(toolTurn());
		withProviderConfig(h.root, { defaultProvider: "lmstudio", defaultModel: "qwen3" }, { lmstudio: { type: "api_key", key: "local" } });
		const agents = agentsDirOf(h.root, { "scout.md": "---\ndescription: MY OWN scout, edited by hand\n---\nmine\n" });
		const host = plantedHome({
			"scout.md": "---\ndescription: the host copy\n---\nbody\n",
			"pilot.md": "---\ndescription: fly it\nmodel: lmstudio/qwen3\n---\nbody\n",
		});
		const c = await connected(h);
		try {
			c.client.send({ type: "importSubagentAgents", requestId: "r7" });
			const written = snapshot(await c.client.for("r7"));
			// `skipped` names the *type*, which is what the panel lists; `copied` the destination it wrote.
			expect(written.skipped).toEqual(["scout"]);
			expect(written.copied).toEqual([join(agents, "pilot.md")]);
			expect(written.ignored).toEqual([]);
			// The list's whole point, checked on the file itself: the hand-edited copy is byte for byte what the
			// operator wrote, while the name that was free arrived.
			expect(readFileSync(join(agents, "scout.md"), "utf8")).toBe("---\ndescription: MY OWN scout, edited by hand\n---\nmine\n");
			expect(written.rows.map((row) => row.description)).toEqual(["fly it", "MY OWN scout, edited by hand"]);

			c.client.send({ type: "subagentAgents", requestId: "r8" });
			expect(Object.keys(snapshot(await c.client.for("r8"))).sort()).toEqual(["errors", "rows", "source"]);
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

/**
 * The module's snapshot pinned to the frame it travels in (T46.3.3 review). Nothing else does this check:
 * `ResourceHandler` answers `unknown` (`src/server/resources-server.ts:35`), the dispatcher sends whatever came back
 * under a cast (`{ [resource.field]: snapshot } as Omit<ResultFrame, "type" | "requestId">`,
 * `src/server/index.ts:290`) and outgoing frames are never validated — `send` only encodes
 * (`src/server/index.ts:201`) and `src/server/index.ts` holds no `Value.*` call at all. So `AgentTypesSnapshot`
 * (src/agent/subagent-agents.ts) and `SubagentAgentsSnapshot` (src/server/protocol.ts) are two hand-maintained
 * definitions of one shape with nothing between them, and one-sided drift is a panel column that reads
 * `undefined` while `tsc` and every test that does not name that key stay green.
 *
 * `packages` has the same exposure, and so has every resource added after it: the cheap fix is this pair of rows,
 * the real fix is a dispatcher that validates what it sends, which is a protocol decision and not this file's.
 */
const MODULE = join(process.cwd(), "src/agent/subagent-agents.ts");

describe("the agent-types snapshot is the shape of the frame it travels in", () => {
	/** Both directions of a key drift, each labelled with the side that moved. */
	function agree(moduleKeys: readonly string[], schema: readonly string[], what: string): void {
		expect(moduleKeys.filter((key) => !schema.includes(key)), `${what}: the module has it, the schema does not`).toEqual([]);
		expect(schema.filter((key) => !moduleKeys.includes(key)), `${what}: the schema has it, the module does not`).toEqual([]);
	}

	/** A snapshot that carries every field, including the three only a write fills. Its type is the module's, so
	 *  `tsc` refuses a fixture that names a field the interface dropped or stops naming one it kept; the row is
	 *  what refuses it at runtime. A `source` that is absent and one that is empty stay pinned by the socket rows
	 *  above, which assert the frames themselves. */
	const row: AgentTypeRow = {
		type: "scout",
		file: "/x/.flypi/agent/agents/scout.md",
		description: "read the repo",
		model: "lmstudio/qwen3",
		thinking: "xhigh",
		invalid: "the name holds a ':', which the extension reserves",
		runsOn: "lmstudio/qwen3",
		resolvable: false,
		thinkingUnsupported: true,
		inherited: true,
	};
	const snapshot: AgentTypesSnapshot = {
		rows: [row],
		source: { path: "/h/.pi/agent/agents", exists: true },
		errors: ["/x/.flypi/agent/models.json defines no model flypi can serve"],
		copied: ["/x/.flypi/agent/agents/pilot.md"],
		skipped: ["scout"],
		ignored: ["notes.txt"],
	};

	it("sends exactly the fields the frame declares, at both levels", () => {
		agree(Object.keys(snapshot), Object.keys(SubagentAgentsSnapshot.properties), "the snapshot");
		agree(Object.keys(row), Object.keys(SubagentAgentsRow.properties), "a row");
	});

	// A fixture's keys are whatever the fixture spelled, and an `interface` is erased — so renaming a field on the
	// module's side alone turns `tsc` red and leaves every `Object.keys` exactly as it was (measured: with
	// `AgentTypesSnapshot.skipped` renamed, the row above stayed green and only this one went red). The declaration
	// is the only runtime-visible record of those names, which is why this row reads them out of the file.
	// Line-based on purpose: both interfaces are one field per line, and a doc-comment line never starts `name:`.
	it("declares those names in the module too, where a rename is otherwise invisible", () => {
		const declared = (interfaceName: string): string[] => {
			const lines = readFileSync(MODULE, "utf8").split("\n");
			const start = lines.findIndex((line) => line.startsWith(`export interface ${interfaceName}`));
			expect(start, `${interfaceName} is no longer declared where the pin reads it`).toBeGreaterThan(-1);
			const fields: string[] = [];
			for (const line of lines.slice(start + 1)) {
				if (line.trim() === "}") break;
				fields.push(.../^\t([A-Za-z]\w*)\??:/.exec(line)?.slice(1) ?? []);
			}
			return fields;
		};
		agree(declared("AgentTypesSnapshot"), Object.keys(SubagentAgentsSnapshot.properties), "AgentTypesSnapshot");
		// `AgentTypeRow` is an empty alias (`extends AgentFileRow, AgentModelAnswer`), so its fields are those two.
		const rowFields = [...new Set([...declared("AgentFileRow"), ...declared("AgentModelAnswer")])];
		agree(rowFields, Object.keys(SubagentAgentsRow.properties), "AgentTypeRow");
	});
});
