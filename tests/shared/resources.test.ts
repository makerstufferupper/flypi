/**
 * The resource table (src/shared/resources.ts) pinned to the protocol in both directions: every
 * declared command parses as a real client command and every declared field is on `ResultFrame`,
 * and the `ResultFrame` fields left once the action and conversation ones are subtracted are
 * exactly the table's. Either way a drift — a renamed command, a snapshot field with no resource —
 * fails here instead of at runtime on the settings page.
 */
import { describe, expect, it } from "vitest";
import { parseClientCommand, ResultFrame } from "../../src/server/protocol.ts";
import { COMMAND_TO_RESOURCE, RESOURCES, type ResourceName } from "../../src/shared/resources.ts";

/**
 * The write commands whose schema demands more than `{ type, requestId }`: `saveConfig` and
 * `savePackages` make every edit list optional, but these three carry a required array or version.
 */
const writeExtras: Partial<Record<string, object>> = {
	usePi: { version: "1.4.0" },
	saveSecrets: { secrets: [] },
	saveMemory: { memories: [] },
};

describe("the resource table cannot drift from the protocol", () => {
	it("names a read command, a write command where the resource has one, and a result field", () => {
		for (const name of Object.keys(RESOURCES) as ResourceName[]) {
			const r = RESOURCES[name];
			for (const type of [r.read, r.write]) {
				if (type === undefined) continue;
				const frame = { type, requestId: "r1", ...writeExtras[type] };
				const parsed = parseClientCommand(JSON.stringify(frame));
				expect(parsed.ok, JSON.stringify(frame)).toBe(true);
				expect(COMMAND_TO_RESOURCE.get(type), type).toBe(name);
			}
			expect(r.field in ResultFrame.properties, `${name} -> ${r.field}`).toBe(true);
		}
	});

	it("covers the snapshot half of ResultFrame — the rest names an action or a conversation", () => {
		// This hand list is the "not resources" list from the plan: one honest list, not a fourth synced copy.
		const notResources = ["type", "requestId", "conversationId", "sessionPath", "sessions", "debug", "revealed", "interrupted"];
		const snapshots = Object.keys(ResultFrame.properties).filter((f) => !notResources.includes(f));
		expect(new Set(snapshots)).toEqual(new Set(Object.values(RESOURCES).map((r) => r.field)));
	});
});
