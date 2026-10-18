/**
 * Phase 5.5 in a real session, not a unit (docs/testing.md): a secret reaches a tool result and an answer,
 * and does not reach the session file. The stub model scripts the turns; everything else — the extension, the
 * redaction hooks, pi's transcript, the session file on disk — is the real thing.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EventFrame } from "../../src/server/protocol.ts";
import { harness, settled } from "../helpers/flypi-harness.ts";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall, type FauxResponseStep } from "../helpers/stub-model.ts";

const TOKEN = "ghp_AAAAAAAAAAAAAAAAAA11111111";

/** A checkout whose vault is real: the migrated database, the key file, and the extension wired into the session. */
async function sessionWithVault(turn: () => FauxResponseStep[], settings: Record<string, unknown> = {}) {
	const h = await harness(turn, { tools: ["read", "bash", "secret_get", "secret_list"], withVault: true });
	writeFileSync(join(h.root, ".flypi", "agent", "settings.json"), JSON.stringify({ permissions: { askBeforeUse: [] }, ...settings }));
	const vault = h.vault;
	vault.put({ name: "github_token", value: TOKEN, kind: "password", actor: "test" });
	// The leak this phase is about: a token that arrives from outside — a file, a command, an MCP server.
	writeFileSync(join(h.root, "token.txt"), `Authorization: Bearer ${TOKEN}\n`);
	return {
		h,
		vault,
		run: async (prompt = "go", thinking?: "off" | "minimal" | "low" | "medium" | "high") => {
			const conversation = await h.registry.create();
			// Only this test needs the model to think; the level is the session's, not a settings file (line 207).
			if (thinking) h.registry.setThinkingLevel(conversation.id, thinking);
			void h.registry.prompt(conversation.id, prompt);
			await settled(conversation.id, h.registry);
			return conversation;
		},
		/** What the UI and an HTML export would show: the events the server recorded. */
		events: (id: string) => h.registry.log(id).replayAfter(0).events.map((entry) => entry.event) as EventFrame["event"][],
		/** What survives: pi's own session file. */
		transcript: () => readFileSync(h.sessions[0]!.session.sessionFile!, "utf8"),
		dispose: () => {
			h.registry.dispose();
			h.cleanup();
		},
	};
}

const textOf = (events: EventFrame["event"][]) =>
	events
		.filter((event) => event.type === "message_end" || event.type === "tool_execution_end")
		.map((event) => JSON.stringify(event))
		.join("\n");

describe("a secret in a session", () => {
	it("reaches a tool result and the answer, and neither survives into the session file", async () => {
		const turned = await sessionWithVault(() => [
			fauxAssistantMessage([fauxToolCall("read", { path: "token.txt" }, { id: "call-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText(`the token is ${TOKEN} — keep it safe`)], { stopReason: "stop" }),
		]);
		try {
			const conversation = await turned.run();
			const shown = textOf(turned.events(conversation.id));
			// Both hooks fired, in the places they have to: the tool result the user is shown, and the answer
			// the model wrote.
			expect(shown).toContain("[secret:github_token]");
			expect(shown).not.toContain(TOKEN);
			// The durable artifact. This is the one that decides whether the value is in the context of every
			// later turn, the HTML export, and any memory captured from it.
			const transcript = turned.transcript();
			expect(transcript).not.toContain(TOKEN);
			expect(transcript).toContain("[secret:github_token]");
		} finally {
			turned.dispose();
		}
	});

	it("still redacts on the way to the memory the turn is captured from", async () => {
		const turned = await sessionWithVault(() => [
			fauxAssistantMessage([fauxToolCall("bash", { command: "cat token.txt" }, { id: "call-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")], { stopReason: "stop" }),
		]);
		try {
			await turned.run();
			// The tool's own output went through the shell, not through flypi, and is still caught.
			expect(turned.transcript()).not.toContain(TOKEN);
			// And the vault itself is untouched by any of this: nothing here wrote a secret.
			expect(turned.vault.list().map((row) => row.use_count)).toEqual([0]);
		} finally {
			turned.dispose();
		}
	});

	it("keeps the value out of the frames the UI streams, not only out of the final message", async () => {
		const turned = await sessionWithVault(() => [
			fauxAssistantMessage([fauxToolCall("read", { path: "token.txt" }, { id: "call-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText(`the token is ${TOKEN} — keep it safe`)], { stopReason: "stop" }),
		]);
		try {
			const conversation = await turned.run();
			// The UI renders these, and they arrive *before* `message_end` rewrites the message: the one place
			// a value can be seen before it is redacted (src/server/session-registry.ts).
			const streamed = turned
				.events(conversation.id)
				.filter((event) => event.type === "message_update")
				.map((event) => JSON.stringify(event));
			expect(streamed.length).toBeGreaterThan(0);
			expect(streamed.join("\n")).not.toContain(TOKEN);
			// And it is the same text, not a blanked one: the placeholder is there once the value has arrived.
			expect(streamed.at(-1)).toContain("[secret:github_token]");
		} finally {
			turned.dispose();
		}
	});

	it("keeps it out of the thinking it streams to the activity panel as well", async () => {
		// Thinking is a second copy of the same turn, streamed somewhere else: the activity panel shows it while
		// it is being written, so the filter has to cover `thinking_delta` and not only the answer.
		const turned = await sessionWithVault(() => [
			fauxAssistantMessage([fauxThinking(`the token in the file is ${TOKEN}, so use it as the bearer`), fauxText("done")], { stopReason: "stop" }),
		]);
		try {
			const conversation = await turned.run("go", "medium");
			const streamed = turned
				.events(conversation.id)
				.filter((event) => event.type === "message_update")
				.map((event) => JSON.stringify(event));
			// Not a vacuous pass: the turn really did stream thinking.
			expect(streamed.some((event) => event.includes("thinking_delta"))).toBe(true);
			expect(streamed.join("\n")).not.toContain(TOKEN);
			expect(streamed.at(-1)).toContain("[secret:github_token]");
		} finally {
			turned.dispose();
		}
	});

	it("holds `secret_get` where the user has not said it may run", async () => {
		const turned = await sessionWithVault(() => [
			fauxAssistantMessage([fauxToolCall("secret_get", { name: "github_token" }, { id: "call-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("I could not read it")], { stopReason: "stop" }),
		]);
		try {
			const conversation = await turned.run();
			const shown = textOf(turned.events(conversation.id));
			expect(shown).toContain("flypi did not run");
			expect(shown).toContain("askBeforeUse");
			expect(turned.vault.row("github_token")!.use_count).toBe(0);
		} finally {
			turned.dispose();
		}
	});

	it("lets it through when the setting says so, and the value is still not kept afterwards", async () => {
		const turned = await sessionWithVault(
			() => [
				fauxAssistantMessage([fauxToolCall("secret_get", { name: "github_token" }, { id: "call-1" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxText(`understood, ${TOKEN}`)], { stopReason: "stop" }),
			],
			{ secrets: { askBeforeUse: false } },
		);
		try {
			const conversation = await turned.run();
			const shown = textOf(turned.events(conversation.id));
			// The one deliberate plaintext: the tool result of the call that asked for it.
			expect(shown).toContain(TOKEN);
			expect(turned.vault.row("github_token")!.use_count).toBe(1);
			// Everything after it is redacted, including the model repeating it back.
			expect(turned.transcript()).not.toContain(`understood, ${TOKEN}`);
			expect(turned.transcript()).toContain("understood, [secret:github_token]");
		} finally {
			turned.dispose();
		}
	});
});
