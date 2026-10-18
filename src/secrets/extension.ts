/**
 * The vault's agent surface (docs/secrets.md Phase 5.5): the `secret_*` tools and the two redaction hooks,
 * registered as one extension like the memory one is.
 *
 * Two rules shape this file:
 *
 * - A tool result is where a credential is most likely to appear, so every result passes through the
 *   redactor — the model sees `[secret:github_token]` instead of the token — except `secret_get`, which is
 *   the one call whose whole point is to hand the plaintext over, and which the permission gate holds until
 *   the user agrees.
 * - The value must not become a durable artifact. So the assistant message is redacted at `message_end`,
 *   before it is written to the session file: the value is in the model's context for the turn that asked
 *   for it, and nothing after that keeps it.
 *
 * The vault itself is opened by the process that owns the memory database (the daemon, `npm run memory`, the
 * CLI). A process with no vault registers nothing, which is how `npm run serve` stays out of it.
 */
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { FlypiPaths } from "../agent/paths.ts";
import { blockedToolCall } from "../agent/permission-gate.ts";
import { secretFilePath, secretsConfig } from "./config.ts";
import { placeholder, redactSecrets } from "./redact.ts";
import { SECRET_KINDS, type SecretKind, type SecretStore } from "./vault.ts";

/** The one tool whose result is plaintext, and the name the permission gate holds by default. */
export const SECRET_GET = "secret_get";

/** A command may print a lot; a credential does not need the last megabyte of it. */
const COMMAND_BYTES = 64_000;
const COMMAND_MS = 30_000;

const NameParam = Type.String({ description: "The secret's name, as it appears in the vault" });
const ValueParam = Type.String({ description: "The secret's value. It is encrypted before it is stored." });
const KindParam = Type.Optional(
	Type.String({
		description: `What kind of secret: ${SECRET_KINDS.join(", ")}. "password" is any credential a service hands you — an api key, a token or a password, stored the same way; "yaml" is parsed before it is stored.`,
	}),
);

export interface SecretsExtensionOptions {
	/** Whose doing every audit row records. */
	actor?: string;
	paths: FlypiPaths;
}

export function createSecretsExtension(vault: SecretStore, options: SecretsExtensionOptions): ExtensionFactory {
	const actor = options.actor ?? "agent";
	return (pi) => {
		/**
		 * The gate Phase 5 built, applied to the one tool here whose result is a credential. Read from the
		 * settings on every call like `createPermissionGateExtension` does, so the user turning it off takes
		 * effect on the next call and not at the next restart. Being asked is the default: a model that wants a
		 * value has to ask a person for it.
		 */
		pi.on("tool_call", (event) => {
			if (event.toolName !== SECRET_GET) return;
			if (!secretsConfig(options.paths).askBeforeUse) return;
			return blockedToolCall(
				`flypi did not run "${SECRET_GET}": reading a secret back as plaintext is the user's decision. ` +
					`Ask them whether this call may run; to stop being asked, they set "secrets": { "askBeforeUse": false } ` +
					`in .flypi/agent/settings.json. Until then use secret_env or secret_file, which hand the value to a command instead of to you.`,
			);
		});

		pi.registerTool({
			name: "secret_list",
			label: "List secrets",
			description: "List the flypi secret vault: names, kinds, masks and metadata. Never the values.",
			parameters: Type.Object({ query: Type.Optional(Type.String({ description: "Filter by name or metadata" })) }),
			execute: async (_id, { query }) => json(vault.list(typeof query === "string" ? query : "")),
		});

		pi.registerTool({
			name: "secret_env",
			label: "Run a command with a secret",
			description:
				"Run a shell command with the secret in FLYPI_SECRET and FLYPI_SECRET_<NAME>, and return its output with the secret replaced. Use this rather than putting the value in the command: it never reaches the transcript, the session file or the model's arguments.",
			parameters: Type.Object({ name: NameParam, command: Type.String({ description: "The command to run" }) }),
			execute: async (_id, { name, command }) => {
				const value = vault.value(name, { actor, action: "used" });
				if (value === undefined) return error(`no secret named "${name}" in the vault`);
				const ran = await run(command, { FLYPI_SECRET: value, [`FLYPI_SECRET_${name.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`]: value });
				// Both guards: `redactSecrets` for any *other* secret the command printed, and this one for the
				// value just handed over, which is redacted whatever its length. A failed command's output is
				// redacted on the way out too — a stack trace quotes the header it was trying to send.
				const text = redactSecrets(ran.text).replaceAll(value, placeholder(name));
				if (!ran.ok) return error(text);
				return ran.text.trim() === "" ? json({ ran: true, output: "", note: "the command printed nothing" }) : { content: [{ type: "text" as const, text }], details: { name, ran: true } };
			},
		});

		pi.registerTool({
			name: "secret_file",
			label: "Write a secret to a file",
			description:
				"Write the secret to a mode-0400 file under .flypi/secrets/ and return its path. For the commands that only take a path — ssh, gpg. It is not the agent's environment, so the value is not inherited by every child process.",
			parameters: Type.Object({ name: NameParam }),
			execute: async (_id, { name }) => {
				const value = vault.value(name, { actor, action: "used" });
				if (value === undefined) return error(`no secret named "${name}" in the vault`);
				mkdirSync(options.paths.secretsDir, { recursive: true });
				// `secret_file_path` refuses a name that would not be a safe file name.
				const file = secretFilePath(options.paths, name);
				writeFileSync(file, value, { mode: 0o400 });
				// `mode` only applies on create; ask for it, so re-writing a secret never leaves it world-readable.
				chmodSync(file, 0o400);
				return json({ path: file, mode: "0400", note: "the file holds the plaintext — delete it when the command is done" });
			},
		});

		pi.registerTool({
			name: SECRET_GET,
			label: "Read a secret's value",
			description:
				"The plaintext value of one secret. It is held until the user approves each call: this is the one tool whose result is a credential, and the value will not be kept in the conversation afterwards.",
			parameters: Type.Object({ name: NameParam }),
			execute: async (_id, { name }) => {
				const value = vault.value(name, { actor, action: "revealed" });
				// No redaction on this result — that is the whole exception. If the value turns up again in a
				// later tool result or in the answer, it is redacted there.
				return value === undefined ? error(`no secret named "${name}" in the vault`) : { content: [{ type: "text" as const, text: value }], details: { name } };
			},
		});

		pi.registerTool({
			name: "secret_put",
			label: "Store a secret",
			description: "Store a value in the vault. Give it a name and a kind; the value is encrypted and only a mask is ever listed back.",
			parameters: Type.Object({ name: NameParam, value: ValueParam, kind: KindParam, meta: Type.Optional(Type.Record(Type.String(), Type.String())) }),
			execute: async (_id, params) => json(vault.put({ name: params.name, value: params.value, kind: params.kind as SecretKind, meta: params.meta, actor })),
		});

		pi.registerTool({
			name: "secret_rotate",
			label: "Replace a secret's value",
			description: "Replace the value of an existing secret. The value it replaced is kept as a mask in the audit history; nothing auto-expires a secret.",
			parameters: Type.Object({ name: NameParam, value: ValueParam, kind: KindParam }),
			execute: async (_id, params) => json(vault.rotate({ name: params.name, value: params.value, kind: params.kind as SecretKind, actor })),
		});

		pi.registerTool({
			name: "secret_delete",
			label: "Delete a secret",
			description: "Delete a secret from the vault. It leaves a tombstone and its history, like a forgotten memory.",
			parameters: Type.Object({ name: NameParam }),
			execute: async (_id, { name }) => json(vault.remove(name, { actor })),
		});

		/**
		 * Every tool result, redacted — including `structuredContent`, which a handler that replaces only
		 * `content` silently drops (docs/extensions.md). An MCP server's structured result is exactly where a
		 * token tends to be echoed back.
		 */
		pi.on("tool_result", (event) => {
			if (event.toolName === SECRET_GET) return;
			let changed = false;
			const content = event.content.map((block) => {
				if (block.type !== "text") return block;
				const text = redactSecrets(block.text);
				if (text === block.text) return block;
				changed = true;
				return { ...block, text };
			}) as typeof event.content;
			const structured = event.structuredContent === undefined ? undefined : redactValue(event.structuredContent as Json);
			if (!changed && structured === undefined) return;
			return {
				content,
				...(structured === undefined ? {} : { structuredContent: structured }),
				...(event.isError ? { isError: true } : {}),
			};
		});

		/**
		 * The assistant's own words, on the way into the session file. A model that repeats a token it was
		 * shown writes it into the transcript, the context of every later turn, the HTML export and any memory
		 * captured from it — this is the seam that stops that.
		 */
		pi.on("message_end", (event) => {
			const message = event.message as { role?: string; content?: unknown };
			if (message.role !== "assistant" || !Array.isArray(message.content)) return;
			let changed = false;
			const content = message.content.map((block) => {
				if (typeof block !== "object" || block === null) return block;
				const part = block as { type?: string; text?: string };
				if (part.type !== "text" || typeof part.text !== "string") return block;
				const text = redactSecrets(part.text);
				if (text === part.text) return block;
				changed = true;
				return { ...part, text };
			});
			if (!changed) return;
			return { message: { ...(event.message as object), content } as never };
		});
	};
}

function json(value: unknown): { content: { type: "text"; text: string }[]; details: unknown } {
	const text = JSON.stringify(value, null, 2);
	return { content: [{ type: "text", text }], details: value };
}

function error(text: string): { content: { type: "text"; text: string }[]; details: unknown; isError: true } {
	return { content: [{ type: "text", text }], details: { error: text }, isError: true };
}

/**
 * Recursive, because `structuredContent` is JSON: a token can be nested in it. Declared here rather than
 * imported — pi's own `JsonValue` lives in `@earendil-works/pi-ai`, which is a dev dependency here.
 */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function redactValue(value: Json): Json {
	if (typeof value === "string") return redactSecrets(value);
	if (Array.isArray(value)) return value.map((item) => redactValue(item));
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item)]));
	}
	return value;
}

/**
 * The command's own environment plus the secret — never the other way round, so nothing can name a variable
 * over an existing one. Output is capped and the command is killed if it hangs; a command that fails is
 * reported with its output, because "ssh refused it" is the answer the model needs.
 */
/** `{ ok: false }` covers both a non-zero exit and a command that never started; the text says which. */
function run(command: string, env: Record<string, string>): Promise<{ text: string; ok: boolean }> {
	return new Promise((resolve) => {
		const child = spawn(command, { shell: true, env: { ...process.env, ...env } });
		const chunks: Buffer[] = [];
		let bytes = 0;
		const collect = (buffer: Buffer) => {
			if (bytes >= COMMAND_BYTES) return;
			bytes += buffer.length;
			chunks.push(buffer);
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		const timer = setTimeout(() => child.kill("SIGKILL"), COMMAND_MS);
		child.on("close", (code) => {
			clearTimeout(timer);
			const output = Buffer.concat(chunks).toString("utf8");
			resolve(code === 0 ? { text: output, ok: true } : { text: `the command exited with ${code}\n${output}`, ok: false });
		});
		child.on("error", (cause) => {
			clearTimeout(timer);
			resolve({ text: `the command could not run: ${(cause as Error).message}`, ok: false });
		});
	});
}
