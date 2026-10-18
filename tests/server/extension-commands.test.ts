/**
 * An extension's slash command, used from the chat (docs/protocol.md `extensionUi`).
 *
 * The extension is a real file in `.flypi/agent/extensions/` — the way a user adds one — so this drives
 * pi's own discovery, its own command dispatch from `session.prompt`, and flypi's bridge from `ctx.ui` to
 * the page. Nothing here mocks an extension.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import { startFlypiServer } from "../../src/server/index.ts";
import { checkServerFrame, type ClientCommand, type ServerFrame } from "../../src/server/protocol.ts";
import { harness } from "../helpers/flypi-harness.ts";
import { fauxAssistantMessage, fauxText } from "../helpers/stub-model.ts";

/**
 * One command that exercises everything the bridge carries: notifications with and without a level, the
 * dialogs that wait for the page, the signal pi uses to dismiss one, and the terminal-only half of `ctx.ui`
 * that a browser has nowhere to put.
 */
const EXTENSION = `
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("ping", {
		description: "Say pong and ask what the page can answer",
		handler: async (args, ctx) => {
			ctx.ui.notify("pong " + args, "info");
			ctx.ui.notify("no level asked");
			ctx.ui.setWidget("above", ["ignored"]);
			ctx.ui.setStatus("state", "ignored");
			ctx.ui.setWorkingMessage("ignored");
			ctx.ui.setWorkingVisible(false);
			ctx.ui.setWorkingIndicator({ frames: [] });
			ctx.ui.setHiddenThinkingLabel("ignored");
			ctx.ui.setFooter(undefined);
			ctx.ui.setHeader(undefined);
			ctx.ui.setTitle("ignored");
			ctx.ui.onTerminalInput(() => undefined);
			ctx.ui.pasteToEditor("ignored");
			ctx.ui.setEditorText("ignored");
			ctx.ui.setEditorComponent(undefined);
			ctx.ui.addAutocompleteProvider((provider) => provider);
			ctx.ui.setTheme("nope");
			ctx.ui.setToolsExpanded(true);
			await ctx.ui.custom(() => undefined);
			const early = await ctx.ui.select("already aborted", ["a"], { signal: AbortSignal.abort() });
			const headless = await ctx.ui.editor();
			ctx.ui.notify(
				"editor=" + ctx.ui.getEditorText() + " themes=" + ctx.ui.getAllThemes().length + " expanded=" + ctx.ui.getToolsExpanded() + " early=" + early + " headless=" + headless,
				"info",
			);
			const choice = await ctx.ui.select("Pick one", ["alpha", "beta"]);
			const ok = await ctx.ui.confirm("Sure?", "do it");
			const text = await ctx.ui.input("Type it", "optional");
			const blank = await ctx.ui.input("No placeholder");
			ctx.ui.notify("choice=" + choice + " ok=" + ok + " text=" + text + " blank=[" + blank + "]", "info");
			// A question pi hands a signal for — an aborted turn does — is released when that signal fires,
			// whether or not anybody answers it.
			const later = new AbortController();
			setTimeout(() => later.abort(), 30);
			const dismissed = await ctx.ui.select("dismiss me", ["a"], { signal: later.signal });
			const cancelled = await ctx.ui.input("cancelled", "x", { signal: AbortSignal.abort() });
			ctx.ui.notify("dismissed=" + dismissed + " cancelled=[" + cancelled + "] component=" + ctx.ui.getEditorComponent() + " theme=" + ctx.ui.getTheme(), "info");
		},
	});
	// A command with no description of its own still has to be listable.
	pi.registerCommand("nodesc", {
		handler: async () => {},
	});
}
`;

interface Client {
	send(command: ClientCommand): void;
	next(match: (frame: ServerFrame) => boolean, timeoutMs?: number): Promise<ServerFrame>;
	close(): Promise<void>;
}

function connect(url: string, token: string): Promise<Client> {
	const socket = new WebSocket(`${url}/?token=${encodeURIComponent(token)}`);
	const frames: ServerFrame[] = [];
	let cursor = 0;
	socket.on("message", (raw) => {
		const frame = JSON.parse(String(raw)) as ServerFrame;
		expect(checkServerFrame(frame).ok, `server sent a frame that violates its own schema: ${String(raw)}`).toBe(true);
		frames.push(frame);
	});
	return new Promise((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	}).then(() => ({
		send: (command) => socket.send(JSON.stringify(command)),
		next: (match, timeoutMs = 10_000) =>
			new Promise((resolve, reject) => {
				const deadline = Date.now() + timeoutMs;
				const poll = () => {
					for (let i = cursor; i < frames.length; i++) {
						if (match(frames[i]!)) {
							cursor = i + 1;
							return resolve(frames[i]!);
						}
					}
					if (Date.now() > deadline) return reject(new Error(`timed out; frames=${JSON.stringify(frames.map((f) => f.type))}`));
					setTimeout(poll, 5);
				};
				poll();
			}),
		close: () => new Promise<void>((done) => { socket.once("close", () => done()); socket.close(); }),
	}));
}

/** The frame for one extension question, by the title the extension gave it. */
const isDialog = (kind: string, title: string) => (frame: ServerFrame): boolean =>
	frame.type === "extensionUi" && frame.kind === kind && frame.title === title;

const isNotify = (prefix: string) => (frame: ServerFrame): boolean =>
	frame.type === "extensionUi" && frame.kind === "notify" && frame.message.startsWith(prefix);

describe("an extension command, from the chat", () => {
	it("is listed, runs from a prompt, and its ctx.ui reaches the page", async () => {
		const runs: string[] = [];
		const h = await harness(() => [fauxAssistantMessage([fauxText("answered")])], {
			onRunStatus: (_id, status) => runs.push(status),
		});
		mkdirSync(join(h.root, ".flypi", "agent", "extensions"), { recursive: true });
		writeFileSync(join(h.root, ".flypi", "agent", "extensions", "ping.ts"), EXTENSION);
		// A prompt template is the other kind of slash command the chat can offer.
		mkdirSync(join(h.root, ".flypi", "agent", "prompts"), { recursive: true });
		writeFileSync(join(h.root, ".flypi", "agent", "prompts", "notes.md"), "---\ndescription: Summarise the notes\n---\nSummarise {{args}}.\n");
		const server = await startFlypiServer({ registry: h.registry, token: "t" });
		const client = await connect(server.url, "t");
		try {
			client.send({ type: "newSession", requestId: "r1" });
			const bound = await client.next((frame) => frame.type === "result" && frame.requestId === "r1");
			if (bound.type !== "result" || !bound.conversationId) throw new Error("no conversation");
			const conversationId = bound.conversationId;

			// The chat's `/` list comes from the debug snapshot it already asks for.
			client.send({ type: "debug", conversationId, requestId: "r2" });
			const snapshot = await client.next((frame) => frame.type === "result" && frame.requestId === "r2");
			expect(snapshot.type === "result" && snapshot.debug?.commands).toEqual(
				expect.arrayContaining([
					{ name: "ping", description: "Say pong and ask what the page can answer", source: "extension" },
					{ name: "nodesc", description: "", source: "extension" },
					{ name: "notes", description: "Summarise the notes", source: "prompt" },
				]),
			);

			client.send({ type: "prompt", conversationId, text: "/ping hi", mode: "steer" });
			const pong = await client.next(isNotify("pong "));
			if (pong.type !== "extensionUi") throw new Error("not an extension frame");
			expect(pong.message).toBe("pong hi");
			// A notification with no level of its own arrives without one, rather than as an "info".
			const plain = await client.next(isNotify("no level"));
			expect(plain.type === "extensionUi" && plain.level).toBeUndefined();

			// The terminal half of ctx.ui answers like a session with no UI bound, and a question handed an
			// already-aborted signal is never pushed to the page at all.
			const headless = await client.next(isNotify("editor="));
			expect(headless.type === "extensionUi" && headless.message).toBe("editor= themes=0 expanded=false early=undefined headless=undefined");

			// Each dialog waits for the page: the extension's handler is parked until `extensionReply`.
			for (const [kind, title, value] of [
				["select", "Pick one", "beta"],
				["confirm", "Sure?", "yes"],
				["input", "Type it", "typed"],
				["input", "No placeholder", ""],
			] as const) {
				const dialog = await client.next(isDialog(kind, title));
				if (dialog.type !== "extensionUi") throw new Error("not a dialog");
				client.send({ type: "extensionReply", conversationId, dialogId: dialog.dialogId!, value });
			}
			const done = await client.next(isNotify("choice="));
			expect(done.type === "extensionUi" && done.message).toBe("choice=beta ok=true text=typed blank=[]");

			// pi's signal releases a question the page never answers, and one it was never even asked about.
			const released = await client.next(isNotify("dismissed="));
			expect(released.type === "extensionUi" && released.message).toBe("dismissed=undefined cancelled=[undefined] component=undefined theme=undefined");

			// A command that starts no turn leaves no `runs` row saying one is in flight (Phase 4.5).
			expect(runs).toEqual([]);

			// An answer for a dialog nobody is waiting on is refused, so the page stops showing it.
			client.send({ type: "extensionReply", conversationId, dialogId: "gone", value: "x", requestId: "r3" });
			const refused = await client.next((frame) => frame.type === "error" && frame.requestId === "r3");
			expect(refused.type === "error" && refused.message).toContain("gone");

			// A real turn still records its run, so moving `markRun` to pi's `preflightResult` did not cost
			// the daemon the "a turn was in flight" record.
			client.send({ type: "prompt", conversationId, text: "a question", mode: "steer" });
			await client.next((frame) => frame.type === "event" && frame.event.type === "agent_settled");
			expect(runs).toEqual(["running", "idle"]);
		} finally {
			await client.close();
			await server.close();
			h.registry.dispose(); // releases any dialog still waiting, the way an eviction or a shutdown does
			h.cleanup();
			rmSync(join(h.root, ".flypi", "agent", "extensions"), { recursive: true, force: true });
			rmSync(join(h.root, ".flypi", "agent", "prompts"), { recursive: true, force: true });
		}
	});
});
