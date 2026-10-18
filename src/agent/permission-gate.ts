/**
 * The permission gate (docs/architecture.md Phase 5): a tool on flypi's ask-before-use list does not run
 * until the user has put it there. `permissions.askBeforeUse` in `.flypi/agent/settings.json`, next to the
 * `memory` block src/memory/config.ts reads — one place for what flypi asks pi to do.
 *
 * The plan said "using tool annotations". It cannot: pi hands a `tool_call` handler a tool *name* and its
 * arguments, and the MCP annotations a server announces (`destructiveHint`, `openWorldHint`) stay inside
 * pi's MCP extension, which exposes none of its connection state to the host (docs/pi-api.md). So the list
 * is of tool names, and the status panel (src/agent/mcp-status.ts) is where the annotations surface — a
 * user reads "this tool says it is destructive" there and writes its name here.
 *
 * The list is re-read on every call rather than captured at session start, so the loop closes without a
 * restart: the model is told the call was gated, the user adds the name in the file, and the next call runs.
 */
import { readFileSync } from "node:fs";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { FlypiPaths } from "./paths.ts";

/** pi's own result shape for a blocked call (`ToolCallEventResult`). */
export const blockedToolCall = (reason: string) => ({ block: true, reason });

const BLOCKED = (toolName: string) =>
	blockedToolCall(
		`flypi did not run "${toolName}": it needs your approval first (it is on permissions.askBeforeUse in ` +
		`.flypi/agent/settings.json). Ask the user whether this call may run; if they agree, they add "${toolName}" to that list and you can call it again.`,
	);

/**
 * `permissions.askBeforeUse` out of a parsed settings.json. Anything that is not a non-empty string is
 * dropped: this file is also pi's, and a stray key there must not become a gate that matches nothing.
 */
export function askBeforeUseOf(settings: unknown): string[] {
	const permissions = (settings as { permissions?: { askBeforeUse?: unknown } } | null)?.permissions;
	const list = Array.isArray(permissions?.askBeforeUse) ? permissions.askBeforeUse : [];
	return list.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "").map((entry) => entry.trim());
}

/**
 * Whether a tool is on the list. A name matches exactly; a name ending in `*` matches that prefix, which is
 * how a whole server is gated (`mcp__filesystem__*`) without listing every tool it may grow.
 */
export function needsApproval(list: readonly string[], toolName: string): boolean {
	return list.some((entry) => (entry.endsWith("*") ? toolName.startsWith(entry.slice(0, -1)) : entry === toolName));
}

/**
 * The extension that enforces it. Registered by `createFlypiSession` like the other flypi extensions, so
 * every session — the daemon's, `npm run serve`'s, a test's — is gated the same way.
 */
export function createPermissionGateExtension(paths: FlypiPaths): ExtensionFactory {
	return (pi) => {
		pi.on("tool_call", (event) => {
			if (!needsApproval(readList(paths.settingsPath), event.toolName)) return;
			return BLOCKED(event.toolName);
		});
	};
}

/**
 * Read the list now, so an edit takes effect on the next call. A settings.json that will not parse asks for
 * nothing: pi itself would have refused to start the conversation over that file, and a gate that guessed at
 * a name would block tools nobody asked to gate.
 */
function readList(settingsPath: string): string[] {
	try {
		return askBeforeUseOf(JSON.parse(readFileSync(settingsPath, "utf8")));
	} catch {
		return [];
	}
}
