/**
 * Which pi a process reports as running (docs/pi-upgrades.md Phase 8.1). The point of the field is that the
 * loaded version and the declared/pinned one can disagree, so every case here is some way of disagreeing.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PI_PIN_FILE, loadedPi, readPiPin, type PiPin } from "../../src/daemon/pi.ts";

/** Read the version off disk by a route the implementation does not use, so the comparison is not a tautology. */
const onDisk = JSON.parse(readFileSync(resolve("node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8")) as { version: string };

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
