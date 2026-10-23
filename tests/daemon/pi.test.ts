/**
 * Which pi a process reports as running (docs/pi-upgrades.md Phase 8.1). The point of the field is that the
 * loaded version and the declared/pinned one can disagree, so every case here is some way of disagreeing.
 */
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	PI_PIN_FILE,
	bundledPiVersion,
	linkPiScope,
	loadedPi,
	piTreeDir,
	piTrees,
	readPiPin,
	relinkFromPin,
	restoreBundledScope,
	switchPiVersion,
	writePiPin,
	type PiInfo,
	type PiPin,
} from "../../src/daemon/pi.ts";

/** Read the version off disk by a route the implementation does not use, so the comparison is not a tautology. */
const onDisk = JSON.parse(readFileSync(resolve("node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8")) as { version: string };

/** A read-only directory stops a non-root user and means nothing to root, so the two cases below are skipped there. */
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

function rootWithPin(pin: PiPin | null): string {
	const root = mkdtempSync(join(tmpdir(), "flypi-pi-"));
	if (pin) {
		mkdirSync(join(root, ".flypi", "pi"), { recursive: true });
		writeFileSync(join(root, PI_PIN_FILE), JSON.stringify(pin));
	}
	return root;
}

describe("which pi is running", () => {
	it("names the loaded module, not the range flypi declares", () => {
		const root = rootWithPin(null);
		try {
			expect(loadedPi(root)).toEqual({ version: onDisk.version, pinned: false });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("says a pin chose it, and names the version the installed tree holds", () => {
		const root = rootWithPin({ version: onDisk.version, from: "1.0.4", pinnedAt: "2026-10-21T00:00:00.000Z", verified: true });
		try {
			expect(loadedPi(root)).toEqual({ version: onDisk.version, pinned: true, bundled: "1.0.4" });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	// A flypi reinstall can drop the link a pin made. Reporting the pin's version then would claim a switch
	// that is not happening, so the loaded module wins and the pin reads as not in effect.
	it("reports the loaded version when the pin claims another one", () => {
		const root = rootWithPin({ version: "9.9.9", from: onDisk.version, pinnedAt: "2026-10-21T00:00:00.000Z", verified: true });
		try {
			expect(loadedPi(root)).toEqual({ version: onDisk.version, pinned: false });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reads no pin as no pin, and refuses to read a file that is not one", () => {
		const empty = rootWithPin(null);
		const broken = mkdtempSync(join(tmpdir(), "flypi-pi-broken-"));
		mkdirSync(join(broken, ".flypi", "pi"), { recursive: true });
		writeFileSync(join(broken, PI_PIN_FILE), "not json");
		try {
			expect(readPiPin(empty)).toBeNull();
			expect(readPiPin(broken)).toBeNull();
			expect(readPiPin(join(empty, "no-such-dir"))).toBeNull();
		} finally {
			rmSync(empty, { recursive: true, force: true });
			rmSync(broken, { recursive: true, force: true });
		}
	});
});

/** Write a `@earendil-works` directory that looks like a pi tree of one version. */
function scopeAt(dir: string, version: string): string {
	mkdirSync(join(dir, "pi-coding-agent"), { recursive: true });
	writeFileSync(join(dir, "pi-coding-agent", "package.json"), JSON.stringify({ version }));
	return dir;
}

/**
 * A root with a fake package directory in it. The pointer is always passed explicitly, so no test can move
 * the `@earendil-works` this suite is running on.
 */
function fakeFlypi(bundled: string | null, trees: string[] = []): { root: string; scope: string } {
	const root = mkdtempSync(join(tmpdir(), "flypi-pi-root-"));
	const scope = join(root, "package", "node_modules", "@earendil-works");
	if (bundled) scopeAt(scope, bundled);
	for (const version of trees) scopeAt(join(piTreeDir(root, version), "node_modules", "@earendil-works"), version);
	return { root, scope };
}

describe("moving pi", () => {
	it("points the package at a tree, keeping the installed one as the way back", () => {
		const { root, scope } = fakeFlypi("1.3.0", ["1.4.0"]);
		try {
			expect(linkPiScope(root, "1.4.0", scope)).toMatchObject({ ok: true });
			expect(lstatSync(scope).isSymbolicLink()).toBe(true);
			expect(realpathSync(scope)).toBe(realpathSync(join(piTreeDir(root, "1.4.0"), "node_modules", "@earendil-works")));
			expect(bundledPiVersion(root)).toBe("1.3.0");
			expect(restoreBundledScope(root, scope)).toMatchObject({ ok: true });
			expect(lstatSync(scope).isSymbolicLink()).toBe(false);
			expect(bundledPiVersion(root)).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses a version with no tree on disk rather than leaving the package with no pi", () => {
		const { root, scope } = fakeFlypi("1.3.0", []);
		try {
			expect(linkPiScope(root, "9.9.9", scope)).toEqual({ ok: false, message: "there is no pi 9.9.9 tree on disk" });
			expect(lstatSync(scope).isSymbolicLink()).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.skipIf(asRoot)("refuses a package directory it cannot write, and copies nothing on the way to saying so", () => {
		const { root, scope } = fakeFlypi("1.3.0", ["1.4.0"]);
		const pkgModules = join(scope, "..");
		chmodSync(pkgModules, 0o555);
		try {
			const result = linkPiScope(root, "1.4.0", scope);
			expect(result.ok).toBe(false);
			expect(result.message).toContain("is not writable by this user");
			expect(lstatSync(scope).isSymbolicLink()).toBe(false);
			expect(bundledPiVersion(root)).toBeNull();
		} finally {
			chmodSync(pkgModules, 0o755);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("re-applies a pin whose link an upgrade dropped, and says so", () => {
		const { root, scope } = fakeFlypi("1.3.0", ["1.4.0"]);
		try {
			linkPiScope(root, "1.4.0", scope);
			writePiPin(root, { version: "1.4.0", from: "1.3.0", pinnedAt: "2026-10-21T00:00:00.000Z", verified: true });
			// What a flypi upgrade does: the package directory is replaced, and the pointer with it.
			rmSync(scope, { force: true });
			scopeAt(scope, "1.3.0");
			expect(relinkFromPin(root, scope)).toBe("pi re-pointed at the pinned 1.4.0");
			expect(readlinkSync(scope)).toContain(join(".flypi", "pi", "1.4.0"));

			// A pin whose tree is gone is a sentence, not a broken package.
			rmSync(piTreeDir(root, "1.4.0"), { recursive: true, force: true });
			rmSync(scope, { force: true });
			expect(relinkFromPin(root, scope)).toBe("the pin asks for pi 1.4.0, but its tree is not on disk — running the pi flypi was installed with");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	// A version the loaded pi can never be, so "already running" is never the answer under test.
	const switches = (root: string, scope: string, over: Partial<Parameters<typeof switchPiVersion>[1]> = {}) =>
		switchPiVersion("9.9.0", {
			root,
			scope,
			global: () => true,
			install: (where, version) => {
				scopeAt(join(piTreeDir(where, version), "node_modules", "@earendil-works"), version);
				return { ok: true };
			},
			probe: async () => [],
			restart: async () => {},
			pi: async () => ({ version: "9.9.0", pinned: true }) satisfies PiInfo,
			...over,
		});

	it("refuses where there is no pointer to move, and says what to run instead", async () => {
		const { root, scope } = fakeFlypi("1.3.0", []);
		try {
			const result = await switches(root, scope, { global: () => false });
			expect(result.ok).toBe(false);
			expect(result.message).toContain("npm install @earendil-works/pi-coding-agent@X && npm test && npm run smoke");
			expect(result.message).toContain("rebuild the image");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.skipIf(asRoot)("refuses an unwritable package dir before downloading a tree for it", async () => {
		const { root, scope } = fakeFlypi("1.3.0", []);
		const pkgModules = join(scope, "..");
		let installed = 0;
		chmodSync(pkgModules, 0o555);
		try {
			const result = await switches(root, scope, {
				install: (where, version) => {
					installed++;
					scopeAt(join(piTreeDir(where, version), "node_modules", "@earendil-works"), version);
					return { ok: true };
				},
			});
			expect(result.ok).toBe(false);
			expect(result.message).toContain("rebuild the image");
			expect(installed).toBe(0);
			expect(readPiPin(root)).toBeNull();
		} finally {
			chmodSync(pkgModules, 0o755);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not move anything when the probe fails", async () => {
		const { root, scope } = fakeFlypi("1.3.0", []);
		try {
			const result = await switches(root, scope, { probe: async () => ["@earendil-works/pi-coding-agent: SessionManager is undefined, and flypi calls it as a function"] });
			expect(result.ok).toBe(false);
			expect(result.message).toContain("SessionManager is undefined");
			expect(readPiPin(root)).toBeNull();
			expect(lstatSync(scope).isSymbolicLink()).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps the switch when the restarted daemon answers with the candidate, and drops the trees nothing can go back to", async () => {
		const { root, scope } = fakeFlypi("1.3.0", ["9.9.0", "1.2.0"]);
		try {
			const result = await switches(root, scope);
			expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
			expect(readPiPin(root)).toMatchObject({ version: "9.9.0", from: "1.3.0", verified: true });
			// Two trees on disk: the one now running and the one to go back to. The third is dropped.
			expect(piTrees(root)).toEqual(["9.9.0"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	// The failure with no web UI (risk 13): the page is served by the process being replaced, so going back
	// cannot wait for someone to notice.
	it("goes back on its own when the candidate does not come up, and prints what the log said", async () => {
		const { root, scope } = fakeFlypi("1.3.0", ["9.9.0"]);
		let restarts = 0;
		try {
			const result = await switches(root, scope, {
				restart: async () => {
					restarts += 1;
					// The candidate died at import: the daemon that answers is the one on the old pi.
					if (restarts === 1) rmSync(scope, { force: true });
					scopeAt(scope, restarts === 1 ? "1.3.0" : "1.3.0");
				},
				pi: async () => ({ version: "1.3.0", pinned: false }) satisfies PiInfo,
				logTail: () => "Error: cannot find module 'whatever'",
			});
			expect(result.ok).toBe(false);
			expect(result.message).toContain("pi 9.9.0 did not start");
			expect(result.message).toContain("back on pi 1.3.0");
			expect(result.message).toContain("cannot find module");
			expect(restarts).toBe(2);
			// Back where npm put it, with no pin left claiming otherwise.
			expect(lstatSync(scope).isSymbolicLink()).toBe(false);
			expect(readPiPin(root)).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
