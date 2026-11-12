/**
 * The settings plane's resources: the seven snapshots the panels read and, except for `mcp` and
 * `scheduler`, write. One row per resource names the command that reads it, the command that writes
 * it, and the `ResultFrame` field carrying its snapshot — so the server dispatcher
 * (`src/server/index.ts`) and the client demux (`ui/lib/app-state.svelte.ts`) look up one table
 * instead of each keeping its own hand-synced list of names (the way `src/shared/views.ts` keeps
 * the addresses from drifting).
 *
 * A resource is **declared here and typed in `src/server/protocol.ts`**: the typebox schemas stay
 * there, because that file is the protocol's single typed declaration and the trust boundary that
 * validates every frame; this module imports only its types, so neither half of the app pulls the
 * other's runtime through it.
 */
import type { ClientCommand, ResultFrame } from "../server/protocol.ts";

/** A resource's commands must be real client commands and its field a real `ResultFrame` field. */
type ResourceTable = Record<string, { read: ClientCommand["type"]; write: ClientCommand["type"] | undefined; field: keyof ResultFrame }>;

export const RESOURCES = {
	config: { read: "getConfig", write: "saveConfig", field: "config" },
	packages: { read: "packages", write: "savePackages", field: "packages" },
	mcp: { read: "mcpStatus", write: undefined, field: "mcpStatus" },
	pi: { read: "piVersions", write: "usePi", field: "pi" },
	secrets: { read: "secrets", write: "saveSecrets", field: "secrets" },
	memory: { read: "memory", write: "saveMemory", field: "memory" },
	scheduler: { read: "scheduler", write: undefined, field: "scheduler" },
} as const satisfies ResourceTable;

/** The seven resource names — the only list of them (tests/shared/resources.test.ts pins it to the protocol). */
export type ResourceName = keyof typeof RESOURCES;

/** Which resource speaks a command, read or write. Derived from the table, so it cannot lag behind it. */
export const COMMAND_TO_RESOURCE: ReadonlyMap<ClientCommand["type"], ResourceName> = new Map(
	(Object.entries(RESOURCES) as [ResourceName, (typeof RESOURCES)[ResourceName]][]).flatMap(
		([name, r]): [ClientCommand["type"], ResourceName][] =>
			r.write === undefined ? [[r.read, name]] : [[r.read, name], [r.write, name]],
	),
);
