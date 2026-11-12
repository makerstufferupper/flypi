/**
 * The server half of the resource plane (Phase 11.2 T27): one implementation per resource, and one
 * lookup that turns a resource command into guard → call → `reply(requestId, { [field]: snapshot })`.
 * `src/server/index.ts` keeps every command that is not a read/write snapshot exactly as it was; the
 * seven resource arms are what this replaces.
 *
 * The refusal sentences live here and stay verbatim: the panels' tests assert them
 * (`tests/server/server.test.ts`, `tests/server/secrets-server.test.ts`, `tests/server/memory-server.test.ts`).
 * `pi` has two because reading the versions and moving pi refuse with different words, which is why a
 * guard answers per direction rather than per resource.
 */
import { readConfig, applyConfigEdits } from "../agent/config-files.ts";
import { applyPackageEdits, readPackages } from "../agent/packages.ts";
import { mcpStatus } from "../agent/mcp-status.ts";
import type { FlypiPaths } from "../agent/paths.ts";
import { COMMAND_TO_RESOURCE, RESOURCES, type ResourceName } from "../shared/resources.ts";
import type { ClientCommand, PiVersions, SchedulerSnapshot } from "./protocol.ts";
import type { MemoryApi } from "./memory-api.ts";
import type { SecretsApi } from "./secrets-api.ts";

/** The three ways a command speaks to a resource: read it, write it, or re-check it (`piCheck`). */
export type ResourceDirection = "read" | "check" | "write";

/** What the dispatcher hands a handler. The fake resources of the seam test are not `ClientCommand`s. */
export type ResourceCommand = { type: string; requestId?: string };

/**
 * A handler answers with the snapshot to reply on the resource's field, with `null` for a bare ack
 * (moving pi acks before the restart, and there is no snapshot left to show), or with a sentence for
 * a refused action — which is the shape `usePi` and `installUpdate` already had.
 */
export type ResourceHandler = (command: ResourceCommand) => unknown | Promise<unknown>;

/**
 * The guard and its verbatim refusal sentences per direction (`pi` is the resource whose two differ)
 * arrive as one pair or not at all: an `available` without `unavailable` would answer a refusal with a
 * TypeError instead of a sentence, so `refusal` never has to assert. The agent-dir resources (config,
 * packages, mcp) take the second branch — their process always can serve every direction.
 */
type ResourceGuards =
	| { available: (direction: ResourceDirection) => boolean; unavailable: { read: string; write: string } }
	| { available?: undefined; unavailable?: undefined };

export type ResourceImpl = {
	read?: ResourceHandler;
	/** "Check now": refreshes and replies on the same field as a read (pi's `piCheck`). */
	check?: ResourceHandler;
	apply?: ResourceHandler;
} & ResourceGuards;

/** One row of the dispatcher: what a command type resolves to. */
export interface ResourceEntry {
	/** The `ResultFrame` field carrying the snapshot. A fake resource names its own, outside the closed union. */
	field: string;
	/**
	 * Commands beyond the ones the shared table already names for this resource: `pi` adds its second
	 * write (`rollbackPi`) and its check (`piCheck`) here, because `RESOURCES` names one write per
	 * resource and no check at all. A fake resource declares all of its commands on these lists, which
	 * is why the strings are only loose here — `BuiltInResourceEntry` pins the built-ins to the protocol.
	 */
	reads?: readonly string[];
	checks?: readonly string[];
	writes?: readonly string[];
	impl: ResourceImpl;
}

/**
 * A built-in's extra commands are protocol names, so renaming one in `protocol.ts` fails to compile
 * here rather than leaving the command unmatched by both the dispatcher and the `switch` in index.ts.
 */
export interface BuiltInResourceEntry extends ResourceEntry {
	reads?: readonly ClientCommand["type"][];
	checks?: readonly ClientCommand["type"][];
	writes?: readonly ClientCommand["type"][];
}

/** The process the impls run in: the agent dir's paths and the optional capability callbacks. */
export interface ResourceDeps {
	paths: FlypiPaths;
	/** A package write reloads the *idle* conversations: a turn in flight keeps the extensions it started with (src/server/session-registry.ts `reloadExtensions`). */
	reloadExtensions: () => Promise<void>;
	piVersions?: () => PiVersions;
	piCheck?: () => Promise<PiVersions>;
	usePi?: (version: string) => Promise<string | null>;
	scheduler?: () => SchedulerSnapshot;
	secrets?: SecretsApi;
	memory?: MemoryApi;
}

/** The command a resource answers for, resolved to its handler, guard and result field. */
export interface ResourceTarget {
	field: string;
	direction: ResourceDirection;
	impl: ResourceImpl;
	run: ResourceHandler;
}

/** The refusal sentence for a direction this process cannot serve; null when it can. */
export function refusal(impl: ResourceImpl, direction: ResourceDirection): string | null {
	if (!impl.available || impl.available(direction)) return null;
	return direction === "write" ? impl.unavailable.write : impl.unavailable.read;
}

/** The seven built-in resources, from the shared table's command names and this process's `deps`. */
export function resourceEntries(deps: ResourceDeps): Record<ResourceName, BuiltInResourceEntry> {
	// The commands and fields come from RESOURCES (src/shared/resources.ts), so the dispatcher and the
	// protocol cannot drift; only the two commands the table cannot name (rollbackPi, piCheck) are added below.
	return {
		config: {
			field: RESOURCES.config.field,
			impl: {
				read: () => readConfig(deps.paths),
				apply: (command) => {
					// No reload on purpose: a conversation already holds the model runtime it started with,
					// and a new one reads the new files.
					applyConfigEdits(deps.paths, command as CommandOf<"saveConfig">);
					return readConfig(deps.paths);
				},
			},
		},
		packages: {
			field: RESOURCES.packages.field,
			impl: {
				// The packages the agent loads, from the agent dir; no network (src/agent/packages.ts).
				read: () => readPackages(deps.paths),
				// npm or git does the work, so this is the slow one; the conversation on screen gets the
				// change, which is why the reload is part of the write and not the caller's business.
				apply: async (command) => {
					const snapshot = await applyPackageEdits(deps.paths, command as CommandOf<"savePackages">);
					await deps.reloadExtensions();
					return snapshot;
				},
			},
		},
		mcp: {
			field: RESOURCES.mcp.field,
			impl: {
				// The servers themselves are asked. Slow by nature (a stdio server has to start), which is
				// why the panel asks once rather than polling (src/agent/mcp-status.ts).
				read: () => mcpStatus(deps.paths),
			},
		},
		pi: {
			field: RESOURCES.pi.field,
			checks: ["piCheck"],
			writes: ["rollbackPi"],
			impl: {
				available: (direction) =>
					direction === "write" ? deps.usePi !== undefined : direction === "check" ? deps.piCheck !== undefined : deps.piVersions !== undefined,
				unavailable: {
					read: "this flypi process does not manage pi versions — it is a checkout or a headless server",
					write:
						"this flypi process does not manage pi versions — in a checkout, `npm install @earendil-works/pi-coding-agent@X && npm test && npm run smoke`",
				},
				// Which pi answers, and what could be moved to. The daemon's daily stamp, never a live
				// check — the same rule `packages` follows.
				read: () => deps.piVersions!(),
				// The registry asked now; the fresh answer arrives as the same `pi` frame.
				check: () => deps.piCheck!(),
				// The pointer moves and the daemon restarts through the CLI, so the ack has to go out
				// first: this socket is the one being replaced. A refusal is the sentence, not a snapshot.
				apply: (command) => deps.usePi!((command as CommandOf<"usePi">).version),
			},
		},
		secrets: {
			field: RESOURCES.secrets.field,
			impl: {
				available: () => deps.secrets !== undefined,
				unavailable: { read: "this flypi process has no vault open", write: "this flypi process has no vault open" },
				// A snapshot never carries a value — only masks, counters and key state (docs/secrets.md).
				read: () => deps.secrets!.snapshot(),
				// The refreshed list comes back with the ack: the page shows what the vault holds now,
				// including the mask it chose for a value it never sends back.
				apply: (command) => deps.secrets!.apply((command as CommandOf<"saveSecrets">).secrets),
			},
		},
		memory: {
			field: RESOURCES.memory.field,
			impl: {
				available: () => deps.memory !== undefined,
				unavailable: {
					read: "this flypi process has no memory store open — `flypi start` runs the one that owns it",
					write: "this flypi process has no memory store open — `flypi start` runs the one that owns it",
				},
				read: () => deps.memory!.snapshot(),
				// The refreshed store comes back with the ack: the panel shows what the write produced,
				// including the audit row it just wrote.
				apply: (command) => deps.memory!.apply((command as CommandOf<"saveMemory">).memories),
			},
		},
		scheduler: {
			field: RESOURCES.scheduler.field,
			impl: {
				available: () => deps.scheduler !== undefined,
				// The queue belongs to the daemon, not to a conversation, so a process without one says so
				// in an error frame the panel can show rather than rendering an empty table.
				unavailable: { read: "this flypi process has no scheduler — `flypi start` runs one", write: "this flypi process has no scheduler — `flypi start` runs one" },
				read: () => deps.scheduler!(),
			},
		},
	};
}

/**
 * One lookup for every resource command: the shared table's read/write commands plus whatever a
 * resource declares beyond them. Later entries win, so `startFlypiServer` merges the built-ins under
 * the `resources` option and a test can register an eighth resource without touching `index.ts`.
 */
export function commandTargets(resources: Record<string, ResourceEntry>): Map<string, ResourceTarget> {
	const target = (entry: ResourceEntry, direction: ResourceDirection): ResourceTarget => ({
		field: entry.field,
		direction,
		impl: entry.impl,
		run: (direction === "write" ? entry.impl.apply : direction === "check" ? entry.impl.check : entry.impl.read)!,
	});
	const targets = new Map<string, ResourceTarget>();
	for (const [command, name] of COMMAND_TO_RESOURCE) {
		// The merge only ever replaces or extends a built-in, so every table name has an entry here.
		const entry = resources[name]!;
		targets.set(command, target(entry, RESOURCES[name].write === command ? "write" : "read"));
	}
	for (const entry of Object.values(resources)) {
		for (const command of entry.reads ?? []) targets.set(command, target(entry, "read"));
		for (const command of entry.checks ?? []) targets.set(command, target(entry, "check"));
		for (const command of entry.writes ?? []) targets.set(command, target(entry, "write"));
	}
	return targets;
}

/** Narrow a dispatched command to the shape its type's schema guarantees. */
export type CommandOf<T extends ClientCommand["type"]> = Extract<ClientCommand, { type: T }>;
