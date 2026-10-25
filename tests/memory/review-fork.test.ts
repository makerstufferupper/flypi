/**
 * Phase 4.8 — the review fork (docs/memory.md). Every `memory.reviewInterval` delivered answers, flypi forks a
 * detached agent over a snapshot of the conversation and asks it what is worth saving. What the phase owes
 * (docs/testing.md, row 4.8) is proved here against real sessions: a real pi session file, a real MCP memory
 * server over HTTP, a real store, the stub model for the answers.
 *
 * The two claims that matter most are the safety one and the cost one, and both are asserted on the real
 * artifacts rather than on a unit stand-in:
 *
 * - **nothing a fork said reaches a conversation a human reads** — the fork's words are absent from the session
 *   file, from the projection the next turn replays, and from the transcript the UI is fed;
 * - **the fork extends the parent's cached prefix** — its request carries the same system prompt and the same
 *   advertised tools, and its messages begin byte-for-byte with the parent's last request.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import type { LoadedMcpConfig } from "@earendil-works/pi-coding-agent";
import { startMemoryServer } from "../../src/memory/mcp.ts";
import { backgroundMount, reviewPrompt } from "../../src/memory/review.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import { activeToolNames, firstEvent, harness } from "../helpers/flypi-harness.ts";
import { openTestDb, wordEmbedder } from "../helpers/memory-db.ts";
import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "../helpers/stub-model.ts";

const TOKEN = "review-fork-token";
const WRITE = "mcp__flypi_memory__memory_write";
const SUPERSEDE = "mcp__flypi_memory__memory_supersede";
const FORGET = "mcp__flypi_memory__memory_forget";
const CAPTURE = "mcp__flypi_memory__memory_capture";
/** The first line of the fork's prompt (src/memory/review.ts) — how a test tells a fork's model call from a
 *  turn of the conversation. It is only ever sent to a fork, so finding it means a fork ran. */
const ASK = "Review the conversation above.";
/** What the fork says when it saves nothing, and what it says when it saves something. */
const NOTHING = "Nothing to save";

let store: MemoryStore;
let db: DatabaseSync;
let server: Awaited<ReturnType<typeof startMemoryServer>>;

beforeAll(async () => {
	db = openTestDb();
	store = new MemoryStore(db, wordEmbedder());
	server = await startMemoryServer({ store, token: TOKEN });
});

afterAll(async () => {
	await server.close();
	db.close();
});

/** `memory.reviewInterval` in the checkout's settings.json — the config key with the off switch. */
function setReviewInterval(root: string, interval: number): void {
	writeFileSync(join(root, ".flypi", "agent", "settings.json"), JSON.stringify({ memory: { reviewInterval: interval } }));
}

const answer = (text: string): FauxResponseStep => fauxAssistantMessage([fauxText(text)], { timestamp: 0 });

/** One model request as the stub recorded it: the payload pi handed the provider after every handler ran. */
type Request = { messages: unknown[]; systemPrompt?: string; tools?: unknown[] };
const requestOf = (recorded: unknown): Request => recorded as Request;

/** The model calls that were a fork rather than a turn: the review question is the last message of one. */
function forks(stub: { requests: unknown[] }): Request[] {
	return stub.requests.map(requestOf).filter((request) => JSON.stringify(request.messages.at(-1) ?? "").includes(ASK));
}

/**
 * Waiting on the fact rather than on a sleep (the same argument as the MCP connection wait in
 * tests/memory/cross-session.test.ts): a fork is fired detached, so its model call lands whenever the fork's
 * own session and MCP connection come up.
 */
async function until(want: () => boolean, why: string, deadline = 10_000): Promise<void> {
	const end = Date.now() + deadline;
	while (!want()) {
		if (Date.now() > end) throw new Error(`never happened: ${why}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/** Long enough that a fork which was going to fire has fired. Used only to prove a fork did *not* run. */
const grace = () => new Promise((resolve) => setTimeout(resolve, 400));

const textOf = (value: unknown): string => JSON.stringify(value);

describe("what the fork is asked, and how its session is wired", () => {
	// Cache parity rests on this: the fork's memory server moves to the background mount, and nothing else about
	// the config does — same name (which is what the tool names are built from), same exposure, same headers.
	it("moves only the memory server to the background mount", () => {
		const config: LoadedMcpConfig = {
			servers: [
				{
					name: "flypi-memory",
					config: { url: "http://127.0.0.1:8790/mcp", headers: { Authorization: "Bearer t" }, exposure: "direct", toolExposure: { memory_turn: "hidden" } },
					source: "mcp.json",
					scope: "global",
				},
				{ name: "filesystem", config: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] }, source: "mcp.json", scope: "global" },
				{ name: "other-http", config: { url: "http://127.0.0.1:9000/sse" }, source: "mcp.json", scope: "global" },
			],
			errors: [],
		};
		const moved = backgroundMount(config, "flypi-memory");
		expect(moved.servers[0]!.config).toEqual({
			url: "http://127.0.0.1:8790/mcp/background",
			headers: { Authorization: "Bearer t" },
			exposure: "direct",
			toolExposure: { memory_turn: "hidden" },
		});
		// A stdio server and a server on another path are left exactly as they were.
		expect(moved.servers[1]!.config).toEqual(config.servers[1]!.config);
		expect(moved.servers[2]!.config).toEqual(config.servers[2]!.config);
		expect(moved.servers.map((entry) => entry.name)).toEqual(config.servers.map((entry) => entry.name));
		expect(moved.errors).toEqual([]);
		// A stdio memory server has no URL to move, so it is left exactly as it is — and its writes land
		// `interactive`, which is the limitation the shortcut comment in src/memory/review.ts names.
		const stdioConfig: LoadedMcpConfig = {
			servers: [{ name: "flypi-memory", config: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] }, source: "mcp.json", scope: "global" }],
			errors: [],
		};
		const stdio = backgroundMount(stdioConfig, "flypi-memory");
		expect(stdio.servers[0]!.config).toEqual(stdioConfig.servers[0]!.config);
		// A memory server on a path that is not `/mcp` is left alone as well — there is no second mount under
		// that path to move it to, and inventing one would 404.
		const oddPath: LoadedMcpConfig = {
			servers: [{ name: "flypi-memory", config: { url: "http://127.0.0.1:8790/memories" }, source: "mcp.json", scope: "global" }],
			errors: [],
		};
		expect(backgroundMount(oddPath, "flypi-memory").servers[0]!.config).toEqual(oddPath.servers[0]!.config);
	});

	// The three things the prompt has to carry, each of which fails open if it is trimmed away.
	it("asks for one fact per row, names what must not be saved, and lets it say so and stop", () => {
		const prompt = reviewPrompt("flypi-memory");
		expect(prompt).toContain("mcp__flypi_memory__memory_write");
		expect(prompt).toContain("One fact per call");
		for (const forbidden of ["failure that only happens in this environment", "tool does not work", "already resolved", "never worked"]) {
			expect(prompt, `the do-not-capture list lost ${forbidden}`).toContain(forbidden);
		}
		expect(prompt).toContain('"Nothing to save"');
		expect(prompt).toContain("You may not replace, delete");
	});
});

describe("the review fork (Phase 4.8)", () => {
	// The counter: one fork per interval, none below it, and none for the turn after it.
	it("spawns exactly one fork per interval and none for the turns between", async () => {
		const h = await harness(() => [], { memoryMcp: { url: server.url, token: TOKEN } });
		setReviewInterval(h.root, 2);
		const conversation = await h.registry.create();
		const stub = h.sessions[0]!.stub;
		await activeToolNames(h.registry.get(conversation.id).session, [WRITE]);
		try {
			stub.append([answer("first answer")]);
			await h.registry.prompt(conversation.id, "first question"); // delivered 1 of 2
			expect(forks(stub), "a fork ran before the interval was reached").toHaveLength(0);

			// The fork's own reply is queued before the turn that triggers it, so the fork's model call gets a
			// scripted answer instead of an empty queue.
			stub.append([answer("second answer"), answer(NOTHING)]);
			await h.registry.prompt(conversation.id, "second question"); // delivered 2 of 2 → fork
			await until(() => forks(stub).length === 1, "the interval-th delivered answer did not spawn a fork");

			stub.append([answer("third answer")]);
			await h.registry.prompt(conversation.id, "third question"); // delivered 3 → no fork
			await grace();
			expect(forks(stub), "a second fork ran one turn past the interval").toHaveLength(1);
		} finally {
			h.registry.dispose();
			h.cleanup();
		}
	}, 30_000);

	// The clock belongs to the conversation, not to the process that ran it.
	it("hydrates the counter from the session file, so a reopen does not restart the clock", async () => {
		const h = await harness(() => [], { memoryMcp: { url: server.url, token: TOKEN } });
		setReviewInterval(h.root, 3);
		const conversation = await h.registry.create();
		const first = h.sessions[0]!.stub;
		await activeToolNames(h.registry.get(conversation.id).session, [WRITE]);
		try {
			// Two delivered answers, one short of the interval: nothing has forked, and the file knows.
			first.append([answer("one"), answer("two")]);
			await h.registry.prompt(conversation.id, "question one");
			await h.registry.prompt(conversation.id, "question two");
			expect(forks(first), "a fork ran two turns into an interval of three").toHaveLength(0);

			// Reopen the same session file — what restarting the daemon does to a conversation. The process
			// that ran those turns is gone (dispose), and the file is opened as a conversation of its own.
			// The counter has to come back at 2, not at 0.
			const sessionFile = h.registry.get(conversation.id).session.sessionFile;
			expect(sessionFile, "the conversation never wrote a session file").toBeTruthy();
			h.registry.dispose();
			const reopenedConversation = await h.registry.switchSession(sessionFile!);
			const reopened = h.sessions[1]!.stub;
			await activeToolNames(h.registry.get(reopenedConversation.id).session, [WRITE]);

			reopened.append([answer("three"), answer(NOTHING)]);
			await h.registry.prompt(reopenedConversation.id, "question three");
			await until(() => forks(reopened).length === 1, "the reopened conversation did not continue the count to the interval");
		} finally {
			h.registry.dispose();
			h.cleanup();
		}
	}, 30_000);

	// What the fork is allowed to do: add a fact, and nothing else.
	it("a fork's write lands as background, and it cannot supersede, forget or capture", async () => {
		const kept = await store.addMemory({
			kind: "convention",
			body: "the deploy target is the mac mini",
			origin_class: "owner",
			session_kind: "interactive",
			actor: "test",
		});
		const h = await harness(() => [], { memoryMcp: { url: server.url, token: TOKEN } });
		setReviewInterval(h.root, 1);
		const conversation = await h.registry.create();
		const stub = h.sessions[0]!.stub;
		await activeToolNames(h.registry.get(conversation.id).session, [WRITE, SUPERSEDE, FORGET]);
		try {
			// The fork's one turn: a write that is allowed, then each of the three that are not, then its reply.
			stub.append([
				answer("the answer"),
				fauxAssistantMessage([fauxToolCall(WRITE, { kind: "convention", body: "deploys run scripts/deploy.sh" }, { id: "fork-write" })], { stopReason: "toolUse", timestamp: 0 }),
				fauxAssistantMessage([fauxToolCall(SUPERSEDE, { id: kept.id, kind: "convention", body: "the deploy target moved to the studio box" }, { id: "fork-supersede" })], { stopReason: "toolUse", timestamp: 0 }),
				fauxAssistantMessage([fauxToolCall(FORGET, { id: kept.id }, { id: "fork-forget" })], { stopReason: "toolUse", timestamp: 0 }),
				answer("saved one, reported two"),
			]);
			await h.registry.prompt(conversation.id, "how do we deploy?");

			// Provenance the fork could not have asked for: the mount it reached set it (src/memory/mcp.ts).
			await until(() => storeRow("deploys run scripts/deploy.sh") !== undefined, "the fork's memory_write never reached the store");
			const row = store.memory(storeRow("deploys run scripts/deploy.sh")!.id)!;
			expect(row.session_kind, "a fork's write landed as an interactive one").toBe("background");
			expect(row.origin_class, "a fork claimed the user's own authority").toBe("agent");
			// The audit row names who wrote it: "who wrote this fact" is the question an audit row is for.
			expect(store.history(row.id).map((entry) => entry.actor), "the audit row does not say a fork wrote it").toContain("fork");

			// The three refusals, read off the store rather than off a mock: nothing was retired, deleted or
			// replaced, and the row the fork tried to destroy is still the active one.
			expect(store.memory(kept.id)!.status, "a background writer superseded a row").toBe("active");
			expect(store.history(kept.id).map((entry) => entry.action).filter((action) => action !== "create"), "a background writer touched a row it may not touch").toEqual([]);
		} finally {
			h.registry.dispose();
			h.cleanup();
		}
	}, 30_000);

	// The gate itself, at the wire: the same store, the same token, and the mount deciding what the caller is.
	it("the background mount refuses supersede, forget and capture while the ordinary one allows them", async () => {
		for (const [label, url, allowed] of [
			["/mcp", server.url, true],
			["/mcp/background", `${server.url}/background`, false],
		] as const) {
			// Its own row per mount: one mount's allowed delete must not make the other mount's refusal pass for
			// the wrong reason — superseding an already-deleted row is an error too.
			const row = await store.addMemory({ kind: "convention", body: `a row for the ${label} mount test`, origin_class: "owner", session_kind: "interactive", actor: "test" });
			const client = await connect(url);
			const write = await call(client, "memory_write", { kind: "note", body: `a write through ${label}` });
			expect(write.isError, `${label}: memory_write was refused`).toBe(false);
			const written = store.memory(Number((write.value as { id: number }).id))!;
			expect(written.session_kind, `${label}: the mount did not set the session kind`).toBe(allowed ? "interactive" : "background");

			for (const [tool, args] of [
				["memory_supersede", { id: row.id, kind: "note", body: "replaced" }],
				["memory_forget", { id: row.id }],
				["memory_capture", { kind: "note", body: "the user's own words, claimed by a fork" }],
			] as const) {
				const result = await call(client, tool, args);
				expect(result.isError, `${label}: ${tool} was ${allowed ? "refused" : "allowed"}`).toBe(!allowed);
				if (!allowed) expect(textOf(result.value), `${tool}: the refusal did not say what to do instead`).toContain("memory_write");
			}
			await client.close();
			if (!allowed) {
				// The row is exactly where the user left it: nothing retired, nothing deleted, nothing audited.
				expect(store.memory(row.id)!.status, "a background writer changed a row's status").toBe("active");
				expect(store.history(row.id).filter((entry) => entry.action !== "create"), "a background writer audited a change to a row").toEqual([]);
			}
		}
	});

	// The safety claim, on a real session: the fork's words are nowhere a human reads them.
	it("nothing the fork said reaches the session file, the projection or the transcript", async () => {
		const FORK_BODY = "the staging box is named harbor";
		const FORK_WORDS = "noted, saved the staging box";
		const h = await harness(() => [], { memoryMcp: { url: server.url, token: TOKEN } });
		setReviewInterval(h.root, 1);
		const conversation = await h.registry.create();
		const stub = h.sessions[0]!.stub;
		await activeToolNames(h.registry.get(conversation.id).session, [WRITE]);
		try {
			stub.append([
				answer("the conversation's answer"),
				fauxAssistantMessage([fauxToolCall(WRITE, { kind: "note", body: FORK_BODY }, { id: "fork-write" })], { stopReason: "toolUse", timestamp: 0 }),
				answer(FORK_WORDS),
			]);
			await h.registry.prompt(conversation.id, "where do we stage?");
			await until(() => storeRow(FORK_BODY) !== undefined, "the fork's write never reached the store");
			await until(() => h.registry.get(conversation.id).session.isIdle, "the fork never finished");

			const session = h.registry.get(conversation.id).session;
			// Not vacuous: the fork really ran, was asked with the review question, and really wrote a fact.
			const forkRequest = forks(stub).at(-1);
			expect(forkRequest, "no fork ran, so this would pass on nothing").toBeTruthy();
			expect(storeRow(FORK_BODY), "the fork wrote nothing, so the absence below proves nothing").toBeTruthy();

			const file = readFileSync(session.sessionFile!, "utf8");
			expect(file, "the fork's prompt reached the session file").not.toContain(ASK);
			expect(file, "the fork's answer reached the session file").not.toContain(FORK_WORDS);
			expect(file, "the fork's write reached the session file").not.toContain(FORK_BODY);
			expect(textOf(session.sessionManager.buildSessionProjection()), "the fork reached the projection").not.toContain(ASK);
			expect(textOf(session.sessionManager.getEntries()), "the fork reached the session entries").not.toContain(ASK);
			// The transcript the UI is fed, from the same session the panel reads.
			expect(textOf([...h.registry.get(conversation.id).messages.values()]), "the fork reached the transcript").not.toContain(ASK);
			// And the next turn of the conversation is not reading a fork's harness turn as an instruction.
			stub.append([answer("the next answer")]);
			await h.registry.prompt(conversation.id, "and what about staging?");
			const last = requestOf(stub.requests.filter((recorded) => !textOf(recorded).includes(ASK)).at(-1)!);
			expect(textOf(last.messages), "the fork's prompt was replayed to the model").not.toContain(ASK);
			expect(textOf(last.messages), "the fork's write was replayed to the model as a standing instruction").not.toContain(FORK_WORDS);
		} finally {
			h.registry.dispose();
			h.cleanup();
		}
	}, 30_000);

	// An interrupted answer is not a turn to learn from — and the count does not move for it.
	it("an aborted turn spawns no fork and does not advance the count", async () => {
		const h = await harness(() => [], { memoryMcp: { url: server.url, token: TOKEN }, tokensPerSecond: 30 });
		setReviewInterval(h.root, 1);
		const conversation = await h.registry.create();
		const stub = h.sessions[0]!.stub;
		await activeToolNames(h.registry.get(conversation.id).session, [WRITE]);
		try {
			// With an interval of 1, a fork would fire on the first delivered answer. Aborting it must not count
			// as one, so the single delivered answer below is the only fork there is.
			stub.append([answer("this answer is cut off before it finishes streaming")]);
			const running = h.registry.prompt(conversation.id, "a long question");
			await firstEvent(conversation.id, h.registry);
			await h.registry.abort(conversation.id);
			await running;
			await grace();
			expect(forks(stub), "an aborted turn spawned a fork").toHaveLength(0);

			// Non-vacuous: the turn really was aborted, and it really left an answer-shaped message behind.
			const aborted = h.registry
				.get(conversation.id)
				.session.sessionManager.getEntries()
				.filter((entry) => entry.type === "message" && entry.message.role === "assistant");
			expect(aborted.length, "the aborted turn left nothing behind, so the count was never at risk").toBeGreaterThan(0);
			const stopReason = (aborted.at(-1) as { message: { stopReason?: string } }).message.stopReason;
			expect(stopReason, "the last assistant message was not the interrupted one").not.toBe("stop");

			stub.append([answer("a finished answer")]);
			await h.registry.prompt(conversation.id, "asked again");
			await until(() => forks(stub).length === 1, "the first delivered answer did not spawn a fork");
			await grace();
			expect(forks(stub), "the aborted turn counted towards an interval of one").toHaveLength(1);
		} finally {
			h.registry.abort(conversation.id).catch(() => undefined);
			h.registry.dispose();
			h.cleanup();
		}
	}, 30_000);

	// The cost claim: the fork's request extends the parent's, so the route serves it from cache.
	it("the fork's request carries the parent's system prompt, tools and messages byte for byte", async () => {
		const h = await harness(() => [], { memoryMcp: { url: server.url, token: TOKEN } });
		setReviewInterval(h.root, 1);
		const conversation = await h.registry.create();
		const stub = h.sessions[0]!.stub;
		await activeToolNames(h.registry.get(conversation.id).session, [WRITE]);
		try {
			stub.append([answer("the answer"), answer(NOTHING)]);
			await h.registry.prompt(conversation.id, "what do we use for packages?");
			await until(() => forks(stub).length === 1, "no fork ran");

			const fork = forks(stub)[0]!;
			// The parent's last request is the one the fork must extend: the calls that were not a fork.
			const parent = requestOf(stub.requests.filter((recorded) => !textOf(recorded).includes(ASK)).at(-1)!);
			// pi hands a provider a *transcript* context: the system prompt and the tool declarations ride in its
			// system messages, so comparing the messages compares the prompt and the advertised tools — which is
			// exactly what a prefix cache keys on. Not vacuous: the system message really names the tools.
			const system = textOf(fork.messages[0]);
			expect(system, "the fork's request carries no system message").toContain("memory_write");
			expect(system, "the fork's request carries no flypi prompt").toContain("Answer in markdown");
			expect(textOf(parent.messages[0]), "the parent's system message differs, so the comparison is meaningless").toContain("Answer in markdown");

			let at = 0;
			while (
				at < parent.messages.length &&
				at < fork.messages.length &&
				JSON.stringify(parent.messages[at]) === JSON.stringify(fork.messages[at])
			) {
				at++;
			}
			expect(at, `the fork's request diverges at message ${at} of the parent's ${parent.messages.length}`).toBe(parent.messages.length);
			expect(fork.messages.length, "the fork appended nothing to the parent's request").toBeGreaterThan(parent.messages.length);
			// The one thing appended: the review question, and nothing of the parent's own last answer rewritten.
			expect(textOf(fork.messages.at(-1)), "the fork's request does not end with the review question").toContain(ASK);
		} finally {
			h.registry.dispose();
			h.cleanup();
		}
	}, 30_000);

	// The switch: `memory.reviewInterval: 0` means no fork, whatever the conversation does.
	it("an interval of zero switches forks off", async () => {
		const h = await harness(() => [], { memoryMcp: { url: server.url, token: TOKEN } });
		setReviewInterval(h.root, 0);
		const conversation = await h.registry.create();
		const stub = h.sessions[0]!.stub;
		await activeToolNames(h.registry.get(conversation.id).session, [WRITE]);
		try {
			stub.append([answer("one"), answer("two"), answer("three"), answer("four")]);
			for (const question of ["a", "b", "c", "d"]) await h.registry.prompt(conversation.id, question);
			await grace();
			expect(forks(stub), "a fork ran with memory.reviewInterval set to 0").toHaveLength(0);
		} finally {
			h.registry.dispose();
			h.cleanup();
		}
	}, 30_000);
});

/** The one row whose body matches exactly, or undefined. A test lookup, so the store's own search is not in the way. */
function storeRow(body: string): { id: number; body: string } | undefined {
	return (db.prepare("select id, body from memories").all() as { id: number; body: string }[]).find((row) => row.body === body);
}

async function connect(url: string): Promise<McpClient> {
	const client = new McpClient({ name: "flypi-test", version: "0.0.0" });
	await client.connect(new StreamableHttpTransport({ url, headers: { authorization: `Bearer ${TOKEN}` } }));
	return client;
}

async function call(client: McpClient, tool: string, args: Record<string, unknown>) {
	const result = await client.callTool(tool, args);
	const text = (result.content as { type: string; text: string }[]).map((block) => block.text).join("");
	try {
		return { isError: result.isError === true, value: JSON.parse(text) as unknown };
	} catch {
		return { isError: result.isError === true, value: { text } };
	}
}
