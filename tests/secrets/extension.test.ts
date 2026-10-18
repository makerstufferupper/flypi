/**
 * The vault's agent surface (docs/secrets.md Phase 5.5): the `secret_*` tools and the two redaction hooks.
 * The extension is driven through the same registration API pi gives an extension — registered tools called
 * directly, event handlers called with the events pi would send — because the claim here is about what the
 * extension does with those events, and the transcript-level claim is covered in scripts/smoke-secrets.mjs
 * against a real session.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSecretsExtension } from "../../src/secrets/extension.ts";
import { tempConnectedVault } from "../helpers/secret-vault.ts";

const TOKEN = "ghp_AAAAAAAAAAAAAA11111111";
const KEY = "sk-proj-BBBBBBBBBBBBBB22222222";

type AnyTool = { execute: (id: string, args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[]; details?: unknown; isError?: boolean }> };

/** Registers the extension the way pi does and hands the test the tools and the event handlers it registered. */
function extension() {
	const held = tempConnectedVault();
	const tools = new Map<string, AnyTool>();
	const handlers = new Map<string, ((event: never) => unknown)[]>();
	held.vault.put({ name: "github_token", value: TOKEN, kind: "password", actor: "test" });
	held.vault.put({ name: "openai_key", value: KEY, kind: "password", actor: "test" });
	createSecretsExtension(held.vault, { paths: held.paths })({
		on: (event: string, handler: (e: never) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool: (tool: { name: string } & AnyTool) => {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI);
	const text = async (name: string, args: Record<string, unknown> = {}) => {
		const result = await tools.get(name)!.execute("call-1", args);
		return { text: result.content.map((block) => block.text).join(""), isError: result.isError === true };
	};
	/** What the extension would have changed about an event pi sent it — `undefined` means it left it alone. */
	const emit = (event: string, payload: unknown) => handlers.get(event)!.map((handler) => handler(payload as never)).find((result) => result !== undefined);
	return { held, tools, text, emit };
}

describe("the tools", () => {
	it("are all registered, under the names the permission gate and the docs use", () => {
		const { held, tools } = extension();
		try {
			expect([...tools.keys()].sort()).toEqual([
				"secret_delete",
				"secret_env",
				"secret_file",
				"secret_get",
				"secret_list",
				"secret_put",
				"secret_rotate",
			]);
		} finally {
			held.dispose();
		}
	});

	it("list names and masks, never a value", async () => {
		const { held, text } = extension();
		try {
			const listed = await text("secret_list");
			expect(listed.text).toContain("github_token");
			expect(listed.text).toContain("ghp…1111");
			expect(listed.text).not.toContain(TOKEN);
			expect(listed.text).not.toContain(KEY);
		} finally {
			held.dispose();
		}
	});

	it("hand a value to a command, and never to the model", async () => {
		const { held, text, emit } = extension();
		try {
			// The command sees the real value; what comes back has it replaced. This is the shape every other
			// CLI is meant to be used through, and the reason no vault value goes in the environment.
			const ran = await text("secret_env", { name: "github_token", command: 'printf "%s %s" "$FLYPI_SECRET" "$FLYPI_SECRET_GITHUB_TOKEN"' });
			expect(ran.isError).toBe(false);
			expect(ran.text).toBe("[secret:github_token] [secret:github_token]");
			expect(held.vault.row("github_token")!.use_count).toBe(1);
			// A command that prints a *different* secret is redacted too, by length and all.
			const other = await text("secret_env", { name: "github_token", command: `printf %s ${KEY}` });
			expect(other.text).toBe("[secret:openai_key]");
			expect((await text("secret_env", { name: "nope", command: "true" })).text).toContain('no secret named "nope"');
			// A command that failed is an error the model can read, and its output is still redacted — a stack
			// trace quotes the header it was trying to send.
			const broken = await text("secret_env", { name: "github_token", command: `printf '%s\n' ${TOKEN}; exit 3` });
			expect(broken.isError).toBe(true);
			expect(broken.text).toContain("exited with 3");
			expect(broken.text).toContain("[secret:github_token]");
			expect(broken.text).not.toContain(TOKEN);
		} finally {
			held.dispose();
		}
	});

	it("short values are still replaced when they come from the vault", async () => {
		const { held, text } = extension();
		try {
			// Too short to match as text anywhere (that rule is deliberate, see redact.ts), but a command that
			// echoes the value it was given is not "text anywhere".
			held.vault.put({ name: "pin", value: "1234", kind: "password", actor: "test" });
			expect((await text("secret_env", { name: "pin", command: 'printf %s "$FLYPI_SECRET"' })).text).toBe("[secret:pin]");
		} finally {
			held.dispose();
		}
	});

	it("write a file for the tools that only take a path", async () => {
		const { held, text } = extension();
		try {
			const written = await text("secret_file", { name: "openai_key" });
			const file = JSON.parse(written.text).path as string;
			expect(readFileSync(file, "utf8")).toBe(KEY);
			// 0400, because the file holds the plaintext: `mode` on write only applies when the file is new.
			expect(statSync(file).mode & 0o777).toBe(0o400);
			expect(written.text).toContain("0400");
		} finally {
			held.dispose();
		}
	});

	it("store, replace and delete, and say what each did", async () => {
		const { held, text } = extension();
		try {
			expect(JSON.parse((await text("secret_put", { name: "new_key", value: "cccccc-333333", kind: "password" })).text).status).toBe("stored");
			expect(JSON.parse((await text("secret_rotate", { name: "new_key", value: "dddddd-444444" })).text).status).toBe("rotated");
			expect(JSON.parse((await text("secret_delete", { name: "new_key" })).text).status).toBe("deleted");
			expect(JSON.parse((await text("secret_list")).text)).toEqual(expect.any(Array));
			expect(JSON.parse((await text("secret_list")).text).map((row: { name: string }) => row.name)).toContain("github_token");
		} finally {
			held.dispose();
		}
	});
});

describe("the redaction hooks", () => {
	it("redact a tool result, including the structured part", () => {
		const { held, emit } = extension();
		try {
			const result = emit("tool_result", {
				toolName: "mcp__github__whoami",
				content: [{ type: "text", text: `token is ${TOKEN}` }],
				// An MCP server echoing the token in structuredContent is the common case, and a handler that
				// replaced only `content` would drop this silently.
				structuredContent: { token: TOKEN, nested: { token: TOKEN }, count: 1 },
			}) as { content: { text: string }[]; structuredContent: Record<string, unknown> };
			expect(result.content[0]!.text).toBe("token is [secret:github_token]");
			expect(result.structuredContent.token).toBe("[secret:github_token]");
			expect((result.structuredContent.nested as { token: string }).token).toBe("[secret:github_token]");
			expect(result.structuredContent.count).toBe(1);
		} finally {
			held.dispose();
		}
	});

	it("redact a result that is an error, because a failed call leaks the token just the same", () => {
		const { held, emit } = extension();
		try {
			const result = emit("tool_result", {
				toolName: "bash",
				content: [{ type: "text", text: `401 with ${KEY}` }],
				isError: true,
			}) as { isError?: boolean };
			expect(result.isError).toBe(true);
		} finally {
			held.dispose();
		}
	});

	it("leave a result with nothing to redact alone", () => {
		const { held, emit } = extension();
		try {
			expect(emit("tool_result", { toolName: "read", content: [{ type: "text", text: "a file, no secrets" }] })).toBeUndefined();
		} finally {
			held.dispose();
		}
	});

	it("do not redact the one tool whose result is meant to be the value", async () => {
		const { held, emit, text } = extension();
		try {
			// The exception holds only because the tool_call gate held it first; the value is in context for
			// that turn and redacted everywhere after it.
			expect((await text("secret_get", { name: "github_token" })).text).toBe(TOKEN);
			expect(emit("tool_result", { toolName: "secret_get", content: [{ type: "text", text: TOKEN }] })).toBeUndefined();
			expect(emit("tool_result", { toolName: "secret_list", content: [{ type: "text", text: TOKEN }] })).toBeDefined();
		} finally {
			held.dispose();
		}
	});

	it("redact the assistant's own words before they become the transcript", () => {
		const { held, emit } = extension();
		try {
			const changed = emit("message_end", {
				message: { role: "assistant", content: [{ type: "text", text: `the token is ${TOKEN}, and the key is ${KEY}` }] },
			}) as { message: { content: { text: string }[] } };
			expect(changed.message.content[0]!.text).toBe("the token is [secret:github_token], and the key is [secret:openai_key]");
			// A user's own message is theirs; and an assistant message with nothing to redact is left alone,
			// so pi keeps its original object.
			expect(emit("message_end", { message: { role: "user", content: [{ type: "text", text: TOKEN }] } })).toBeUndefined();
			expect(emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "nothing here" }] } })).toBeUndefined();
		} finally {
			held.dispose();
		}
	});
});

describe("the gate on reading a value back", () => {
	it("holds `secret_get` until the user has said this may run", () => {
		const { held, emit } = extension();
		try {
			const blocked = emit("tool_call", { toolName: "secret_get", input: { name: "github_token" } }) as { block: boolean; reason: string };
			expect(blocked.block).toBe(true);
			// The reason has to say what to do about it, because it is what the model reads.
			expect(blocked.reason).toContain("askBeforeUse");
			expect(blocked.reason).toContain("secret_env");
			// Every other tool here runs: only the plaintext read is the user's decision.
			expect(emit("tool_call", { toolName: "secret_list", input: {} })).toBeUndefined();
		} finally {
			held.dispose();
		}
	});

	it("and stops holding it when the user sets the setting that says so", () => {
		const started = extension();
		try {
			const { held, emit } = started;
			mkdirSync(held.paths.agentDir, { recursive: true });
			writeFileSync(held.paths.settingsPath, JSON.stringify({ secrets: { askBeforeUse: false } }));
			// Read on every call, so the next call is allowed — not the next restart.
			expect(emit("tool_call", { toolName: "secret_get", input: { name: "github_token" } })).toBeUndefined();
		} finally {
			started.held.dispose();
		}
	});
});
