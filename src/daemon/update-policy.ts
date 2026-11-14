/**
 * When the daemon may update itself, as one pure function (docs/architecture.md Phase 7, docs/pi-upgrades.md
 * Phase 8.4): a pass in — the stamps it read, whether anyone is using the process, the one clock — and the
 * list of actions to take out.
 *
 * The rule is the part worth separating, because it is three rules at once: a ladder (`stagedUpdate` names
 * one published release at a time, never the newest), a day (the three `dueFor*` gates, each on its own
 * stamp), and a stretch of idle held before anything installs — the same idle the memory sweep is triggered
 * on. Every one of those is a case someone has to be able to assert, and none of them could be while they
 * lived in a callback over `readUpdateCheck`, `server.clients()` and `spawn("npm", …)`: the daemon's own tests
 * run in a checkout, where the install band cannot be reached at all. Here the effects are data and the
 * refusal, the wait and the order are named.
 *
 * Nothing here reads a file, opens a socket, starts a process or reaches the network. The staleness rules and
 * the idle constant belong to `update.ts`, `pi.ts` and `packages.ts` and are imported, never re-spelled, so
 * there stays one answer to "is this answer stale". The only state the rule has — when the current idle
 * stretch began — stays with the daemon, which is told to start it and to start again by these actions.
 */
import { dueForPackageCheck, type PackageCheck } from "../agent/packages.ts";
import { dueForPiCheck, type PiCheck } from "./pi.ts";
import { IDLE_BEFORE_INSTALL_MS, dueForCheck, stagedUpdate, type UpdateCheck } from "./update.ts";

/** What one pass of the update rule was asked about. Every field is a read the daemon already does. */
export interface UpdatePass {
	/** The version this process runs — the bottom of the ladder. */
	version: string;
	/** A checkout is not an installed package: it updates with git, and the registry has never heard of it. */
	checkout: boolean;
	/** `updates.autoExtensions` in `.flypi/agent/settings.json` — the user's choice, `packages.ts:111-116`. */
	autoExtensions: boolean;
	/** The first pass after startup asks regardless of how old the answer is, and never installs. */
	first: boolean;
	stamp: UpdateCheck | null;
	packages: PackageCheck | null;
	pi: { check: PiCheck | null; pinned: boolean };
	/** Idleness, as the two counts that define it — see `isIdle`. */
	idle: { clients: number; runningTurns: number };
	/** When the current idle stretch began, or 0 when the daemon has not been idle. */
	idleSince: number;
	/** One clock read for the whole pass. */
	now: number;
}

export type UpdateAction =
	| { kind: "checkRegistry" }
	| { kind: "checkPi" }
	| { kind: "stagePackages" }
	| { kind: "reloadExtensions"; sources: string[] }
	| { kind: "installFlypi"; version: string; file: string }
	| { kind: "notify"; text: string }
	/** Start the idle clock: the stretch has begun. */
	| { kind: "beginIdle" }
	/** Start it again either way — a failed install retries after another stretch, not every pass. */
	| { kind: "endIdle" };

/** No page attached and no turn in flight — the same answer the memory sweep is triggered on. */
export function isIdle(idle: UpdatePass["idle"]): boolean {
	return idle.clients === 0 && idle.runningTurns === 0;
}

/** What the daemon should do about updates this pass, in the order it should do it. */
export function updatePolicy(pass: UpdatePass): UpdateAction[] {
	const actions: UpdateAction[] = [];
	// The daily asks, asked against the pass's own clock — one read of the time for the whole pass rather than
	// one per gate, which is what lets the same pass be answered the same way twice. Startup is the one moment
	// they are not gated on the age of the answer: a daemon that has just started asks rather than waiting out a
	// day it may have missed (`first`).
	if (!pass.checkout && (pass.first || dueForCheck(pass.stamp, pass.now))) actions.push({ kind: "checkRegistry" });
	// pi's published versions are asked about on the same rhythm and are only ever *shown*: moving pi restarts
	// the process, so nothing moves by itself, pinned or not (docs/pi-upgrades.md:91). `pass.pi.pinned` is
	// therefore read by nothing here, and the test says so rather than a branch inventing a rule.
	if (!pass.checkout && (pass.first || dueForPiCheck(pass.pi.check, pass.now))) actions.push({ kind: "checkPi" });
	// Deliberately not gated on `checkout` — the extensions a checkout loads are ordinary packages — and
	// gated on its own day even at startup, unlike the two above.
	if (dueForPackageCheck(pass.packages, pass.now)) actions.push({ kind: "stagePackages" });
	// Startup asks; it never installs. A restart nobody asked for, at the moment someone is starting the app,
	// is the failure this rule exists to avoid, and the idle clock is left untouched.
	if (pass.first) return actions;
	const staged = pass.checkout ? null : stagedUpdate(pass.stamp, pass.version);
	const pending = pass.packages?.updates ?? [];
	// The tarball the stamp names, which is what an install would run. A stamp this process did not write may
	// name a version with no path — `readUpdateCheck` does not validate what it parses (update.ts:200-206) — so
	// the file is checked here as well as in `installStaged`; the guard is today's, so deleting it is a change.
	const file = pass.stamp?.download?.file;
	if ((!staged && pending.length === 0) || !isIdle(pass.idle)) {
		// Nothing waiting, or someone using the process: spend the stretch rather than hold it.
		actions.push({ kind: "endIdle" });
		return actions;
	}
	if (!pass.idleSince) {
		// The stretch has only just begun, so this pass cannot be the one that installs.
		actions.push({ kind: "beginIdle" });
		return actions;
	}
	if (pass.now - pass.idleSince < IDLE_BEFORE_INSTALL_MS) return actions;
	// Packages first: they need no restart, and the flypi install below may take this process away.
	// The choice is the user's (`updates.autoExtensions` in settings.json): an unattended extension
	// update is how an incompatible one arrives.
	if (pending.length && pass.autoExtensions) actions.push({ kind: "reloadExtensions", sources: pending });
	if (staged && file) actions.push({ kind: "installFlypi", version: staged, file });
	// Start the clock again either way: a failed install retries after another idle stretch, not every pass.
	actions.push({ kind: "endIdle" });
	return actions;
}
