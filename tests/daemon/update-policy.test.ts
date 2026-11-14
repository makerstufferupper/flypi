/**
 * What one pass of the update rule decides (`src/daemon/update-policy.ts`, docs/architecture.md Phase 7 and
 * docs/pi-upgrades.md Phase 8.4), as data: the pass goes in, the list of actions comes out. Nothing in this
 * file starts a daemon, opens a socket, touches the filesystem or reaches the network — the rule is called
 * with the stamps a pass would have read, which is the whole reason it stopped being a callback over
 * `readUpdateCheck` and `spawn`: the daemon's tests run in a checkout, where the install band cannot be
 * reached from inside the daemon at all.
 *
 * The rows are the cases the rule is trusted with. It will not restart the process while a page is attached
 * or a turn is in flight, and it waits a full stretch of idle (`IDLE_BEFORE_INSTALL_MS`) even when nobody is
 * using it. It installs the one published release it downloaded, never the newest. A failed registry check
 * leaves it silent. pi is only ever shown, pinned or not. Extension packages install unattended only when
 * `updates.autoExtensions` says so, and before flypi rather than after.
 */
import { describe, expect, it } from "vitest";
import { PACKAGE_CHECK_INTERVAL_MS, type PackageCheck } from "../../src/agent/packages.ts";
import { CHECK_INTERVAL_MS, IDLE_BEFORE_INSTALL_MS, type UpdateCheck } from "../../src/daemon/update.ts";
import { updatePolicy, type UpdatePass } from "../../src/daemon/update-policy.ts";

// A fixed clock: the pass is handed `now` rather than reading one, so the boundary arithmetic below is exact.
const now = 1_777_000_000_000;
const iso = (at: number) => new Date(at).toISOString();
/** A flypi stamp answered a minute ago, with the step above the running version downloaded. */
const flypiStamp = (over: Partial<UpdateCheck> = {}): UpdateCheck => ({
	checkedAt: iso(now - 60_000),
	current: "0.1.0",
	latest: "0.3.0",
	next: "0.2.0",
	download: { version: "0.2.0", file: "/root/.flypi/updates/flypi-0.2.0.tgz", at: iso(now - 60_000) },
	...over,
});
/** The extension stamp answered a minute ago; `updates` is the list of sources pending a reload. */
const packageStamp = (over: Partial<PackageCheck> = {}): PackageCheck => ({ checkedAt: iso(now - 60_000), updates: [], ...over });
/** A pass idle at the end of its idle stretch, with a flypi package staged and no extension pending. */
const pass = (over: Partial<UpdatePass> = {}): UpdatePass => ({
	version: "0.1.0",
	checkout: false,
	autoExtensions: true,
	first: false,
	stamp: flypiStamp(),
	packages: packageStamp(),
	pi: { check: { checkedAt: iso(now - 60_000), latest: "0.3.0", next: "0.2.0" }, pinned: false },
	idle: { clients: 0, runningTurns: 0 },
	idleSince: now - IDLE_BEFORE_INSTALL_MS,
	now,
	...over,
});
/** What the fixture above has waiting: the tarball for 0.2.0, with this process on 0.1.0. */
const install = { kind: "installFlypi", version: "0.2.0", file: "/root/.flypi/updates/flypi-0.2.0.tgz" };

describe("what one update pass decides", () => {
	it("refuses to install while a page is attached", () => {
		// A restart would cut off the person reading an answer, which is the one thing this rule must not do.
		expect(updatePolicy(pass({ idle: { clients: 1, runningTurns: 0 } }))).toEqual([{ kind: "endIdle" }]);
	});

	it("refuses to install while a turn runs", () => {
		// The other half of idleness, and the half a rule that only counted sockets would miss: the answer is
		// the same list, because today the two are one boolean computed in one line.
		expect(updatePolicy(pass({ idle: { clients: 0, runningTurns: 1 } }))).toEqual([{ kind: "endIdle" }]);
	});

	it("waits for a stretch of idle before it installs", () => {
		// The stretch began this pass, so this pass is never the one that installs; a lull shorter than
		// IDLE_BEFORE_INSTALL_MS is a brief gap rather than a restart, and the exact boundary is the install.
		expect(updatePolicy(pass({ idleSince: 0 }))).toEqual([{ kind: "beginIdle" }]);
		expect(updatePolicy(pass({ idleSince: now - IDLE_BEFORE_INSTALL_MS + 1 }))).toEqual([]);
		expect(updatePolicy(pass({ idleSince: now - IDLE_BEFORE_INSTALL_MS }))).toEqual([install, { kind: "endIdle" }]);
	});

	it("refuses to install a staged package that is no longer newer", () => {
		// The tarball is the version already running: the install happened, and `next` above it is not a
		// reason to restart. The sibling is the ladder — `next` 0.3.0 and `latest` 0.4.0 are both above the
		// download, and what installs is the one rung that is on disk (docs/architecture.md: one schema
		// upgrade per start, against the schema that upgrade expects).
		const already = flypiStamp({ download: { version: "0.1.0", file: "/root/.flypi/updates/flypi-0.1.0.tgz", at: iso(now) } });
		expect(updatePolicy(pass({ stamp: already }))).toEqual([{ kind: "endIdle" }]);
		expect(updatePolicy(pass({ stamp: flypiStamp({ next: "0.3.0", latest: "0.4.0" }) }))).toEqual([install, { kind: "endIdle" }]);
	});

	it("says nothing and installs nothing when the registry check failed", () => {
		// A failed check is a stamp shape, not an event: `latest` and `next` are null, so the only thing that
		// could install is the tarball on disk — and that is the version running now, which `stagedUpdate`
		// refuses. The answer is a quiet re-arm, and the day arrives for the same failed stamp.
		const failed: UpdateCheck = { checkedAt: iso(now), current: "0.2.0", latest: null, next: null, error: "the registry could not be reached: connect ECONNREFUSED 127.0.0.1:443", download: { version: "0.2.0", file: "/root/.flypi/updates/flypi-0.2.0.tgz", at: iso(now) } };
		expect(updatePolicy(pass({ version: "0.2.0", stamp: failed }))).toEqual([{ kind: "endIdle" }]);
		expect(updatePolicy(pass({ version: "0.2.0", stamp: { ...failed, checkedAt: iso(now - CHECK_INTERVAL_MS) } }))).toEqual([{ kind: "checkRegistry" }, { kind: "endIdle" }]);
	});

	it("treats a pinned pi pointer the same as an unpinned one", () => {
		// pi is only ever shown: moving it restarts the process, so nothing moves by itself
		// (docs/pi-upgrades.md:91 — "Auto-switching pi on idle is off by default and stays off in this
		// phase"). The action list has no kind that names a pi switch, and `pinned` changes nothing in it.
		const stale = { check: { checkedAt: iso(now - CHECK_INTERVAL_MS), latest: "0.4.0", next: "0.4.0" }, pinned: true };
		const pinned = updatePolicy(pass({ pi: stale }));
		expect(pinned).toEqual(updatePolicy(pass({ pi: { check: stale.check, pinned: false } })));
		expect(pinned).toEqual([{ kind: "checkPi" }, install, { kind: "endIdle" }]);
	});

	it("asks once at startup, whatever the stamps say", () => {
		// The one moment the two daily gates are skipped: a daemon that has just started asks rather than
		// waiting out the day it may have missed. It never installs and never touches the idle clock, and the
		// extension check keeps its own gate here, as it has today.
		expect(updatePolicy(pass({ first: true }))).toEqual([{ kind: "checkRegistry" }, { kind: "checkPi" }]);
		expect(updatePolicy(pass({ first: true, packages: null }))).toEqual([{ kind: "checkRegistry" }, { kind: "checkPi" }, { kind: "stagePackages" }]);
	});

	it("leaves the flypi ladder alone in a checkout but still checks the extensions", () => {
		// A checkout updates with git, and the registry has never heard of it; the extension sources it loads
		// are ordinary packages, so their check — and their install — run exactly as they do in an installed
		// package. `staged` is forced null here, so the flypi tarball on disk stays on disk.
		const pending = packageStamp({ checkedAt: iso(now - PACKAGE_CHECK_INTERVAL_MS), updates: ["pi-mcp"] });
		expect(updatePolicy(pass({ checkout: true, packages: pending }))).toEqual([
			{ kind: "stagePackages" },
			{ kind: "reloadExtensions", sources: ["pi-mcp"] },
			{ kind: "endIdle" },
		]);
	});

	it("installs the extensions before flypi, and only when the user allowed it", () => {
		// The order is the reason: the flypi install may take this process away mid-pass, and an extension
		// needs no restart. `updates.autoExtensions` (src/agent/packages.ts:111-116) is the user's choice, and
		// refusing it costs the flypi install nothing.
		const pending = packageStamp({ updates: ["pi-mcp"] });
		expect(updatePolicy(pass({ packages: pending }))).toEqual([{ kind: "reloadExtensions", sources: ["pi-mcp"] }, install, { kind: "endIdle" }]);
		expect(updatePolicy(pass({ packages: pending, autoExtensions: false }))).toEqual([install, { kind: "endIdle" }]);
	});

	it("re-arms the clock after a pass that installed nothing", () => {
		// Nothing staged and nothing pending spends the stretch rather than holding it: a package found later
		// waits for a whole new idle stretch instead of the tail of this one. The stamp has no download at all,
		// which is what a daemon that never found an update keeps.
		expect(updatePolicy(pass({ stamp: flypiStamp({ next: null, latest: null, download: undefined }) }))).toEqual([{ kind: "endIdle" }]);
		// The same for a daemon that has never had an answer at all: it asks, it waits, it installs nothing.
		expect(updatePolicy(pass({ stamp: null, packages: null }))).toEqual([{ kind: "checkRegistry" }, { kind: "stagePackages" }, { kind: "endIdle" }]);
	});
});
