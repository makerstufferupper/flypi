import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionRegistry } from "../../src/server/session-registry.ts";
import { startMemoryServer } from "../../src/memory/mcp.ts";
import { setDigest } from "../../src/memory/recall.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import { createTempFlypiRoot, sessionFiles, withProviderConfig } from "../helpers/flypi-root.ts";
import { firstEvent, harness, settled, toolTurn } from "../helpers/flypi-harness.ts";
import { openTestDb, wordEmbedder } from "../helpers/memory-db.ts";
import { fauxAssistantMessage, fauxText } from "../helpers/stub-model.ts";

describe("session registry", () => {
	it("creates conversations with ids and session files inside .flypi/sessions (risk 1)", async () => {
		const h = await harness(toolTurn());
		try {
			const a = await h.registry.create();
			const b = await h.registry.create();
			expect(a.id).not.toBe(b.id);
			expect(h.registry.size).toBe(2);
			for (const conversation of [a, b]) {
				expect(conversation.session.sessionFile!.startsWith(join(h.root, ".flypi", "sessions", "/"))).toBe(true);
			}

			// pi writes the file on the first flush, so check it on disk only after a turn.
			void h.registry.prompt(a.id, "go");
			await settled(a.id, h.registry);
			expect(sessionFiles(h.root)).toEqual([a.session.sessionFile!.split("/").pop()!]);

			h.registry.dispose();
			expect(h.disposeCount()).toBe(2);
		} finally {
			h.cleanup();
		}
	});

	it("records every event in the log and fans it out to attached listeners", async () => {
		const h = await harness(toolTurn());
		try {
			const conversation = await h.registry.create();
			const live: { seq: number; type: string }[] = [];
			h.registry.attach(conversation.id, (seq, event) => live.push({ seq, type: event.type }));

			void h.registry.prompt(conversation.id, "go");
			await settled(conversation.id, h.registry);

			const recorded = h.registry.log(conversation.id).replayAfter(0).events.map((entry) => ({ seq: entry.seq, type: (entry.event as { type: string }).type }));
			expect(live.length).toBe(recorded.length);
			// Seqs are assigned once, in order, with no holes — that is what makes resume correct.
			expect(recorded.map((entry) => entry.seq)).toEqual(recorded.map((_entry, index) => index + 1));
			expect(recorded.map((entry) => entry.type)).toContain("tool_execution_end");
			expect(recorded.map((entry) => entry.type)).toContain("agent_settled");
		} finally {
			h.registry.dispose();
			h.cleanup();
		}
	});

	it("never evicts a conversation whose turn is still running, and disposes an idle one exactly once", async () => {
		const clock = { now: 0 };
		const h = await harness(toolTurn(), { idleTtlMs: 1000, now: () => clock.now });
		try {
			const conversation = await h.registry.create();
			clock.now = 10_000; // long past the TTL: only "is it running?" can save it now
			const running = h.registry.prompt(conversation.id, "go");
			await firstEvent(conversation.id, h.registry);

			expect(h.sessions[0]!.session.isStreaming).toBe(true);
			expect(h.registry.evictIdle()).toEqual([]);
			expect(h.registry.size).toBe(1);

			await running;
			clock.now = 20_000; // the idle clock restarts at agent_settled, so this is genuinely stale now
			expect(h.registry.evictIdle()).toEqual([conversation.id]);
			expect(h.registry.size).toBe(0);
			expect(h.disposeCount()).toBe(1);

			// Nothing left to dispose, and a second dispose() must not double-fire.
			expect(h.registry.evictIdle()).toEqual([]);
			h.registry.dispose();
			h.registry.dispose();
			expect(h.disposeCount()).toBe(1);
		} finally {
			h.cleanup();
		}
	});

	it("keeps a running session alive with zero clients attached, and evicts only after it settles", async () => {
		const clock = { now: 0 };
		const h = await harness(toolTurn(), { idleTtlMs: 0, now: () => clock.now });
		try {
			const conversation = await h.registry.create();
			// Do not await: this is the "close the tab, the work continues" case.
			const running = h.registry.prompt(conversation.id, "go");
			await new Promise((resolve) => setTimeout(resolve, 5));

			expect(h.sessions[0]!.session.isStreaming).toBe(true);
			expect(h.registry.evictIdle()).toEqual([]);
			expect(h.registry.size).toBe(1);

			await running;
			expect(h.registry.evictIdle()).toEqual([conversation.id]);
			expect(h.disposeCount()).toBe(1);
		} finally {
			h.cleanup();
		}
	});

	it("records that a turn is in flight, and how it ended, for the daemon's run table", async () => {
		const seen: { status: string; seq: number; sessionFile: boolean }[] = [];
		const h = await harness(toolTurn(), {
			onRunStatus: (_id, status, info) => seen.push({ status, seq: info.seq, sessionFile: info.sessionFile !== undefined }),
		});
		try {
			const conversation = await h.registry.create();
			const running = h.registry.prompt(conversation.id, "go");
			await new Promise((resolve) => setTimeout(resolve, 5));
			// Before any of it could reach a client, the record says a turn is in flight: that row is what a
			// process that dies here will come back as `interrupted`.
			expect(seen.map((entry) => entry.status)).toEqual(["running"]);

			await running;
			expect(seen.map((entry) => entry.status)).toEqual(["running", "idle"]);
			// The settling write carries the conversation's own numbering, turn events included — a record of how
			// the turn ended, not a cursor to resume from (see the note in src/server/run-store.ts); and the
			// session file is what maps the record back to a chat the UI can open.
			expect(seen[1]!.seq).toBeGreaterThan(0);
			expect(seen.every((entry) => entry.sessionFile)).toBe(true);
		} finally {
			h.cleanup();
		}
	});

	it("records an abort as the reason a turn stopped", async () => {
		const seen: string[] = [];
		// Slow enough that the abort lands mid-turn rather than after it.
		const h = await harness(toolTurn("this took a while"), { tokensPerSecond: 40, onRunStatus: (_id, status) => seen.push(status) });
		try {
			const conversation = await h.registry.create();
			const running = h.registry.prompt(conversation.id, "go");
			await new Promise((resolve) => setTimeout(resolve, 30));
			await h.registry.abort(conversation.id);
			await running;

			// `aborted` first, and it is the part that survives the settle: the store keeps the reason the turn
			// stopped rather than the blank `idle` that follows it (tests/daemon/runs.test.ts).
			expect(seen).toEqual(["running", "aborted", "idle"]);
		} finally {
			h.cleanup();
		}
	});

	it("queues a follow-up instead of interrupting the running turn", async () => {
		// Two long answers: the first is still streaming when the follow-up arrives.
		const h = await harness(
			() => [
				fauxAssistantMessage([fauxText("the first answer streams on for a while")], { timestamp: 0 }),
				fauxAssistantMessage([fauxText("and then the follow-up answer")], { timestamp: 0 }),
			],
			{ tokensPerSecond: 40 },
		);
		try {
			const conversation = await h.registry.create();
			const running = h.registry.prompt(conversation.id, "first");
			await firstEvent(conversation.id, h.registry);

			// No interruption: this resolves once the queued message has been answered.
			await h.registry.prompt(conversation.id, "and then", "followUp");
			await running;

			const text = h.sessions[0]!.session
				.messages.filter((message) => message.role === "assistant")
				.map((message) => (message as { content: { type: string; text?: string }[] }).content.filter((block) => block.type === "text").map((block) => block.text).join(""))
				.join("\n");
			expect(text).toContain("the first answer streams on for a while");
			expect(text).toContain("and then the follow-up answer");
		} finally {
			h.registry.dispose();
			h.cleanup();
		}
	});

	it("takes a pasted image to the model and puts a pasted file where the agent can read it", async () => {
		const h = await harness(() => [fauxAssistantMessage([fauxText("seen")], { timestamp: 0 })]);
		try {
			const conversation = await h.registry.create();
			await h.registry.prompt(conversation.id, "what is in these?", "steer", [
				// pi normalizes pasted images (it reads them), so the fixture is a real 1x1 PNG.
				{ name: "shot.png", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" },
				// A pasted file's name is the user's, slashes and all — it must not choose the directory.
				{ name: "../notes.txt", mimeType: "text/plain", data: Buffer.from("the report").toString("base64") },
			]);

			const user = h.sessions[0]!.session.messages.find((message) => message.role === "user") as {
				content: { type: string; text?: string; mimeType?: string }[];
			};
			// Images are the model's input, so they arrive as pi image content next to the text.
			expect(user.content.some((block) => block.type === "image" && block.mimeType === "image/png")).toBe(true);

			// Everything else is written to .flypi/uploads and named by path, so the agent opens it itself.
			const uploads = readdirSync(join(h.root, ".flypi", "uploads"));
			expect(uploads).toHaveLength(1);
			expect(uploads[0]!.endsWith("_notes.txt")).toBe(true);
			const saved = join(h.root, ".flypi", "uploads", uploads[0]!);
			expect(readFileSync(saved, "utf8")).toBe("the report");
			const text = user.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
			expect(text).toContain("what is in these?");
			expect(text).toContain(`[attached file: ${saved}]`);
		} finally {
			h.registry.dispose();
			h.cleanup();
		}
	});

	it("refuses a prompt with neither text nor an attachment", async () => {
		const h = await harness(toolTurn());
		try {
			const conversation = await h.registry.create();
			expect(() => h.registry.prompt(conversation.id, "   ")).toThrow(/needs text or an attachment/);
		} finally {
			h.registry.dispose();
			h.cleanup();
		}
	});

	it("does not evict a session that has only just settled", async () => {
		const clock = { now: 1_000 };
		const h = await harness(toolTurn(), { idleTtlMs: 5_000, now: () => clock.now });
		try {
			const conversation = await h.registry.create();
			void h.registry.prompt(conversation.id, "go");
			await settled(conversation.id, h.registry);
			expect(h.registry.evictIdle()).toEqual([]); // settled moments ago: still warm
			expect(h.registry.size).toBe(1);

			clock.now = 6_000;
			expect(h.registry.evictIdle()).toEqual([conversation.id]);
		} finally {
			h.cleanup();
		}
	});

	it("does not evict a conversation that still has a client attached", async () => {
		const h = await harness(toolTurn(), { idleTtlMs: 0, now: () => 1_000_000 });
		try {
			const conversation = await h.registry.create();
			const detach = h.registry.attach(conversation.id, () => {});
			expect(h.registry.evictIdle()).toEqual([]);
			detach();
			expect(h.registry.evictIdle()).toEqual([conversation.id]);
		} finally {
			h.registry.dispose();
			h.cleanup();
		}
	});
});

describe("session registry: sessions, switching and forks", () => {
	it("switchSession rebinds the same conversation id to another session file", async () => {
		const h = await harness(toolTurn());
		try {
			const first = await h.registry.create();
			const target = first.session.sessionFile!;
			const second = await h.registry.create();
			const switched = await h.registry.switchSession(second.id, target);

			expect(switched.id).toBe(second.id);
			expect(switched.session.sessionFile).toBe(target);
			expect(h.disposeCount()).toBe(1); // the replaced session was disposed once
		} finally {
			h.registry.dispose();
			h.cleanup();
		}
	});

	// The address bar names a session by its file name alone (`/sessions/<id>`, ui/lib/route.ts), so the
	// registry resolves a bare name inside its own dir — and `..` in one still stops at the same wall.
	it("opens a session named by file name alone, and refuses one that climbs out of the sessions dir", async () => {
		const h = await harness(toolTurn());
		try {
			const conversation = await h.registry.create();
			const file = conversation.session.sessionFile!;
			expect((await h.registry.switchSession(conversation.id, file.split("/").pop()!)).session.sessionFile).toBe(file);
			await expect(h.registry.switchSession(conversation.id, "../elsewhere.jsonl")).rejects.toThrow(/not inside/);
		} finally {
			h.registry.dispose();
			h.cleanup();
		}
	});

	it("refuses a session path outside .flypi/sessions", async () => {
		const h = await harness(toolTurn());
		try {
			const conversation = await h.registry.create();
			await expect(h.registry.switchSession(conversation.id, join(h.root, "elsewhere.jsonl"))).rejects.toThrow(/not inside/);
			await expect(h.registry.deleteSession(join(h.root, "elsewhere.jsonl"))).rejects.toThrow(/not inside/);
		} finally {
			h.registry.dispose();
			h.cleanup();
		}
	});

	it("deletes a session file, forgets only the conversation that was showing it, and leaves the others running", async () => {
		const h = await harness(toolTurn());
		try {
			const target = await h.registry.create();
			const other = await h.registry.create();
			const path = target.session.sessionFile!;
			void h.registry.prompt(target.id, "go");
			await settled(target.id, h.registry);
			// pi writes on the first flush, so the file only exists after a turn — that is the one being deleted.
			expect(existsSync(path)).toBe(true);

			await h.registry.deleteSession(path);
			expect(existsSync(path)).toBe(false);
			expect(h.registry.size).toBe(1);
			expect(h.disposeCount()).toBe(1); // exactly once, and only for the conversation that held it
			expect(() => h.registry.get(target.id)).toThrow(/unknown conversation/);
			expect(h.registry.get(other.id)).toBeTruthy();
		} finally {
			h.registry.dispose();
			h.cleanup();
		}
	});

	it("refuses to delete a session whose turn is still running, rather than losing the work", async () => {
		const h = await harness(toolTurn());
		try {
			const conversation = await h.registry.create();
			const path = conversation.session.sessionFile!;
			const running = h.registry.prompt(conversation.id, "go");
			await firstEvent(conversation.id, h.registry);

			await expect(h.registry.deleteSession(path)).rejects.toThrow(/mid-turn/);
			await running;
			expect(existsSync(path)).toBe(true);
			expect(h.registry.get(conversation.id)).toBeTruthy();
			// Once the turn is over, the same call works.
			await h.registry.deleteSession(path);
			expect(existsSync(path)).toBe(false);
			expect(h.disposeCount()).toBe(1);
		} finally {
			h.registry.dispose();
			h.cleanup();
		}
	});

	it("a session file that is already gone is an error, not a silent success", async () => {
		const h = await harness(toolTurn());
		try {
			await expect(h.registry.deleteSession(join(h.root, ".flypi", "sessions", "gone.jsonl"))).rejects.toThrow(/ENOENT/);
		} finally {
			h.registry.dispose();
			h.cleanup();
		}
	});

	it("a chat enters the list when its first message is sent, not before", async () => {
		const h = await harness(toolTurn());
		try {
			const conversation = await h.registry.create();
			const path = conversation.session.sessionFile!;
			// pi writes a session on its first entry: a chat you have only started has nothing to list.
			expect(await h.registry.listSessions()).toEqual([]);
			// The first message is what the client uses as its cue to ask again, so by the time that event
			// reaches a listener the file has to be there.
			const firstUserMessage = new Promise<void>((resolve) => {
				const detach = h.registry.attach(conversation.id, (_seq, event) => {
					if (event.type === "message_end" && event.message.role === "user") {
						detach();
						resolve();
					}
				});
			});
			void h.registry.prompt(conversation.id, "go");
			await firstUserMessage;
			const listed = await h.registry.listSessions();
			expect(listed.map((session) => session.path)).toEqual([path]);
			const row = listed.find((session) => session.path === path)!;
			expect(row.firstMessage).toBe("go");
			expect(row.messageCount).toBeGreaterThan(0);
			await settled(conversation.id, h.registry);
		} finally {
			h.registry.dispose();
			h.cleanup();
		}
	});

	it("forks a conversation at one of its answers, and carries nothing after it", async () => {
		const h = await harness(toolTurn("first answer"));
		try {
			const source = await h.registry.create();
			// What the UI holds for each answer: the seq its message_end arrived on. That is the only
			// handle it has, and fork() has to resolve it back to the right message.
			const answers = new Map<string, number>();
			h.registry.attach(source.id, (seq, event) => {
				if (event.type !== "message_end" || event.message.role !== "assistant") return;
				const [text] = spokenText([event.message]);
				if (text) answers.set(text, seq);
			});

			void h.registry.prompt(source.id, "first");
			await settled(source.id, h.registry);
			h.sessions[0]!.stub.append(toolTurn("second answer")());
			void h.registry.prompt(source.id, "second");
			await settled(source.id, h.registry);
			const firstAnswer = answers.get("first answer");
			expect(firstAnswer, "the first answer never reached a listener").toBeTruthy();

			const forked = await h.registry.fork(source.id, firstAnswer!);
			expect(forked.id).not.toBe(source.id);
			expect(forked.session.sessionFile).not.toBe(source.session.sessionFile);
			// The fork ends at the answer it was forked from; the second prompt never happened in it.
			expect(spokenText(forked.session.messages)).toEqual(["first", "first answer"]);
			// …and the source is untouched: still its own file, still its whole transcript.
			expect(spokenText(h.registry.get(source.id).session.messages)).toEqual(["first", "first answer", "second", "second answer"]);
			expect(h.registry.get(source.id).session.sessionFile).toBe(source.session.sessionFile);
		} finally {
			h.registry.dispose();
			h.cleanup();
		}
	});

	it("refuses to fork from a prompt, or from a seq that carried no message", async () => {
		const h = await harness(toolTurn());
		try {
			const source = await h.registry.create();
			let promptSeq = 0;
			h.registry.attach(source.id, (seq, event) => {
				if (event.type === "message_end" && event.message.role === "user") promptSeq = seq;
			});
			void h.registry.prompt(source.id, "go");
			await settled(source.id, h.registry);

			await expect(h.registry.fork(source.id, promptSeq)).rejects.toThrow(/starts from an answer/);
			await expect(h.registry.fork(source.id, 999)).rejects.toThrow(/no message at seq 999/);
			expect(h.registry.size).toBe(1); // neither attempt opened a conversation
		} finally {
			h.registry.dispose();
			h.cleanup();
		}
	});

	/** user + assistant text in transcript order — what a fork is expected to carry. */
	function spokenText(messages: readonly unknown[]): string[] {
		return (messages as { role?: string; content?: unknown }[])
			.filter((message) => message.role === "user" || message.role === "assistant")
			.map((message) =>
				(Array.isArray(message.content) ? message.content : [])
					.filter((part: { type?: string }) => part?.type === "text")
					.map((part: { text?: string }) => part.text ?? "")
					.join(""),
			)
			.filter(Boolean);
	}

	it("without an injected model it uses .flypi/agent config and the real pi runtime", async () => {
		// The production wiring: credential from the isolated auth.json, model from models.json.
		const root = withProviderConfig(createTempFlypiRoot(), undefined, { lmstudio: { type: "api_key", key: "local" } });
		const registry = new SessionRegistry({ root });
		try {
			const conversation = await registry.create();
			expect(conversation.session.model).toMatchObject({ provider: "lmstudio", id: "qwen3" });
		} finally {
			registry.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});

	// The sidebar's model selector asks for this, so it decides whether the UI offers 1 model or 1.5k.
	it("lists only the models whose provider has a credential", async () => {
		const root = createTempFlypiRoot();
		writeFileSync(join(root, ".flypi", "agent", "settings.json"), JSON.stringify({ defaultProvider: "configured", defaultModel: "has-a-key" }));
		writeFileSync(
			join(root, ".flypi", "agent", "models.json"),
			JSON.stringify({
				providers: {
					configured: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "sk-local", models: [{ id: "has-a-key", input: ["text", "image"] }] },
					"no-credential": { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", models: [{ id: "needs-a-key" }] },
				},
			}),
		);
		const registry = new SessionRegistry({ root });
		try {
			const conversation = await registry.create();
			const debug = await registry.debugInfo(conversation.id);
			// `input` rides through unchanged: it is the field pi-ai itself uses to decide whether an image
			// reaches the provider, and the chat needs it to warn about a paste the model will never see.
			expect(debug.models).toEqual(expect.arrayContaining([{ provider: "configured", modelId: "has-a-key", input: ["text", "image"] }]));
			expect(debug.models.some((model) => model.provider === "no-credential")).toBe(false);
			// The current model is reported whether or not its provider is available, so the selector can
			// still show what the session is actually running.
			expect(debug.model).toEqual({ provider: "configured", modelId: "has-a-key", input: ["text", "image"] });
		} finally {
			registry.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});

	// The Phase 4 gate asks for the injected block to be visible in the debug panel (docs/memory.md).
	// Everything here is real: a live memory server, flypi's own recall extension, the registry's debug
	// snapshot. Since C2 the block is a session entry of its own, so the panel is not the only place it can
	// appear — but it is the only place the *visible* conversation can show what was recalled at all.
	it("shows the memory block the turn actually injected", async () => {
		const store = new MemoryStore(openTestDb(), wordEmbedder());
		await store.addMemory({ kind: "preference", body: "the package manager is pnpm, never npm", origin_class: "owner", session_kind: "interactive", actor: "test" });
		const memory = await startMemoryServer({ store, token: "registry-debug-token" });
		const h = await harness(() => [fauxAssistantMessage([fauxText("pnpm")], { timestamp: 0 })], {
			memoryMcp: { url: memory.url, token: "registry-debug-token" },
		});
		try {
			const conversation = await h.registry.create();
			expect((await h.registry.debugInfo(conversation.id)).memoryBlock).toBeNull();

			void h.registry.prompt(conversation.id, "which package manager do we use?");
			await settled(conversation.id, h.registry);
			const block = (await h.registry.debugInfo(conversation.id)).memoryBlock;
			expect(block).toContain("<relevant_memories>");
			expect(block).toContain("#1 (preference): the package manager is pnpm, never npm");

			// C2 (docs/prompt-cache.md Phase 4.7): the block is in the session file now — that is what lets a
			// later turn replay its bytes instead of re-paying them at the turn boundary. It is an entry of its
			// own, tagged and `display: false`, so it is findable as what it is and never mistaken for speech.
			const file = readFileSync(conversation.session.sessionFile!, "utf8");
			const entry = JSON.parse(file.split("\n").find((line) => line.includes("flypi-memory-block"))!);
			// `details.digest` is in the file too, and the reopen gate reads it: a reopened session that lost its
			// details would re-inject a set this conversation already paid for, quietly. Pinned to the digest of
			// the one row that turn retrieved, so a pi change that stops persisting `details` fails here.
			expect(entry).toMatchObject({
				type: "custom_message",
				customType: "flypi-memory-block",
				display: false,
				details: { digest: setDigest([1]) },
			});

			// Opening another session is a different conversation: no leftover block from the one before.
			const other = await h.registry.create();
			void h.registry.prompt(other.id, "which package manager do we use?");
			await settled(other.id, h.registry);
			await h.registry.switchSession(conversation.id, other.session.sessionFile!);
			expect((await h.registry.debugInfo(conversation.id)).memoryBlock).toBeNull();

			// Rebinding the session must not quietly disarm recall: the new session's extension reports
			// again, and the panel fills up with the block this turn really injected.
			void h.registry.prompt(conversation.id, "which package manager do we use?");
			await settled(conversation.id, h.registry);
			expect((await h.registry.debugInfo(conversation.id)).memoryBlock).toContain("<relevant_memories>");
		} finally {
			h.registry.dispose();
			h.cleanup();
			await memory.close();
		}
	});

	it("an unknown conversation id is an error, not a silent no-op", () => {
		const registry = new SessionRegistry({ root: createTempFlypiRoot() });
		expect(() => registry.get("nope")).toThrow(/unknown conversation/);
		expect(() => registry.setThinkingLevel("nope", "low")).toThrow(/unknown conversation/);
	});

	it("setModel and setThinkingLevel apply to the conversation's session", async () => {
		const h = await harness(toolTurn());
		try {
			const conversation = await h.registry.create();
			await h.registry.setModel(conversation.id, "flypi-stub", "stub");
			expect(conversation.session.model?.id).toBe("stub");
			await expect(h.registry.setModel(conversation.id, "flypi-stub", "nope")).rejects.toThrow(/is not available/);
			h.registry.setThinkingLevel(conversation.id, "low");
			expect(conversation.session.thinkingLevel).toBe("low");
		} finally {
			h.registry.dispose();
			h.cleanup();
		}
	});
});
