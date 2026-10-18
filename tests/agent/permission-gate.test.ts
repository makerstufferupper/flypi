/**
 * The permission gate (docs/architecture.md Phase 5): a tool named in `permissions.askBeforeUse` in
 * `.flypi/agent/settings.json` does not run until the user puts it there. Proven through a real session,
 * because the gate is an extension handler and only a session hands it a tool call — and with the real
 * `bash` tool, so "did not run" means a file that was never created.
 */
import { describe, expect, it } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { askBeforeUseOf, needsApproval } from "../../src/agent/permission-gate.ts";
import { createFlypiSession } from "../../src/agent/runtime.ts";
import { createTempFlypiRoot } from "../helpers/flypi-root.ts";
import { createStubModel, fauxAssistantMessage, fauxText, fauxToolCall } from "../helpers/stub-model.ts";

function writeSettings(root: string, settings: unknown): void {
	writeFileSync(join(root, ".flypi", "agent", "settings.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
}

/** A turn that tries to touch one file, then answers. The file is the evidence of what ran. */
const touching = (marker: string) => [
	fauxAssistantMessage([fauxToolCall("bash", { command: `touch ${marker}` }, { id: "call-1" })], { stopReason: "toolUse", timestamp: 0 }),
	fauxAssistantMessage([fauxText("held off")], { timestamp: 0 }),
];

async function sessionAsking(root: string, responses: ReturnType<typeof touching>) {
	const stub = await createStubModel({ responses });
	const { session } = await createFlypiSession({ root, modelRuntime: stub.modelRuntime, model: stub.model });
	return { session, stub };
}

describe("asking before a tool runs", () => {
	it("does not run a listed tool, and tells the model why so it can ask", async () => {
		const root = createTempFlypiRoot();
		const marker = join(root, "touched-by-accident.txt");
		writeSettings(root, { permissions: { askBeforeUse: ["bash"] } });
		const { session, stub } = await sessionAsking(root, touching(marker));
		try {
			await session.prompt("tidy this up");
			// The command never reached a shell.
			expect(existsSync(marker)).toBe(false);
			// The turn still finished, and what the model was shown is an instruction it can act on: ask the
			// user, and where to say yes.
			expect(stub.requests).toHaveLength(2);
			const shown = JSON.stringify(stub.requests.at(-1)!.messages);
			expect(shown).toContain("needs your approval first");
			expect(shown).toContain("permissions.askBeforeUse");
			expect(shown).toContain('"bash"');
		} finally {
			session.dispose();
		}
	});

	it("runs it once the user has said yes, in the same session", async () => {
		// The list is read when the call is made, not when the session starts: the loop closes by editing a
		// file, without restarting anything.
		const root = createTempFlypiRoot();
		const marker = join(root, "approved-now.txt");
		writeSettings(root, { permissions: { askBeforeUse: ["bash"] } });
		const { session, stub } = await sessionAsking(root, [...touching(marker), ...touching(marker)]);
		try {
			await session.prompt("tidy this up");
			expect(existsSync(marker)).toBe(false);

			writeSettings(root, { permissions: { askBeforeUse: [] } });
			await session.prompt("go ahead");
			expect(existsSync(marker)).toBe(true);
		} finally {
			session.dispose();
		}
	});

	it("stays out of the way when nothing is listed", async () => {
		const root = createTempFlypiRoot();
		const marker = join(root, "never-asked-about.txt");
		const { session } = await sessionAsking(root, touching(marker));
		try {
			await session.prompt("tidy this up");
			expect(existsSync(marker)).toBe(true);
		} finally {
			session.dispose();
		}
	});

	it("blocks nothing when settings.json will not parse, rather than blocking everything", async () => {
		// pi would have refused to start this conversation over that file; a gate that guessed at a name
		// would silently hold back tools nobody asked about.
		const root = createTempFlypiRoot();
		const marker = join(root, "broken-settings.txt");
		writeSettings(root, "{ not json");
		const { session } = await sessionAsking(root, touching(marker));
		try {
			await session.prompt("tidy this up");
			expect(existsSync(marker)).toBe(true);
		} finally {
			session.dispose();
		}
	});
});

describe("the list itself", () => {
	it("takes the names out of settings.json and ignores anything that is not a name", () => {
		expect(askBeforeUseOf({ permissions: { askBeforeUse: ["bash", " mcp__fs__write_file ", "", 3, null] } })).toEqual(["bash", "mcp__fs__write_file"]);
		expect(askBeforeUseOf({})).toEqual([]);
		expect(askBeforeUseOf({ permissions: { askBeforeUse: "bash" } })).toEqual([]);
		expect(askBeforeUseOf(null)).toEqual([]);
	});

	it("matches a tool exactly, or a whole server by prefix", () => {
		expect(needsApproval(["bash"], "bash")).toBe(true);
		expect(needsApproval(["bash"], "read")).toBe(false);
		// A prefix is what lets a user gate an MCP server they have not enumerated tool by tool — the names
		// come from the status panel (src/agent/mcp-status.ts), which is the only place they are visible.
		expect(needsApproval(["mcp__filesystem__*"], "mcp__filesystem__write_file")).toBe(true);
		expect(needsApproval(["mcp__filesystem__*"], "mcp__other__write_file")).toBe(false);
		expect(needsApproval(["mcp__filesystem__write_file"], "mcp__filesystem__write_files")).toBe(false);
	});
});
