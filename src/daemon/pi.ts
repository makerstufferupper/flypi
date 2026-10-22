/**
 * Which pi this process is running (docs/pi-upgrades.md Phase 8.1).
 *
 * The version is read off the module that was **loaded**, never off flypi's own `package.json`: the whole
 * point of the field is that those two can disagree. A checkout resolves pi from its lockfile, an installed
 * flypi resolves it from its own `node_modules`, and from Phase 8.3 on a pin can choose a third tree that is
 * neither. `getPackageDir()` is pi's own answer for where it lives, and it is the only way in — pi's
 * `exports` map does not publish `package.json`, so `import.meta.resolve("…/package.json")` throws
 * (docs/pi-upgrades.md C1).
 *
 * Nothing here reaches the network, and nothing here moves a version: the pin is read-only state, and the
 * machinery that writes it is Phase 8.3.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";

/** The chosen pi, next to the trees it points at (`.flypi/pi/<version>/`). Written by `flypi pi use`. */
export const PI_PIN_FILE = join(".flypi", "pi", "pin.json");

/** What `.flypi/pi/pin.json` holds. `.flypi/` is state, so a flypi upgrade never touches it. */
export interface PiPin {
	/** The pi version the pin asks for. */
	version: string;
	/** The version the tree flypi shipped with held before the pin moved it — the way back. */
	from: string | null;
	pinnedAt: string;
	/** The candidate answered `/healthz` reporting this version, so the switch committed. */
	verified: boolean;
}

/** What `/healthz`, `hello` and `flypi status` say about pi. */
export interface PiInfo {
	/** The version of the pi module this process actually loaded. */
	version: string;
	/** A pin chose it, rather than the tree flypi was installed with. */
	pinned: boolean;
	/** What the tree flypi shipped with holds — present only when that is not what is running. */
	bundled?: string;
}

/** The pin, or null when there is none — which is every machine that has never run `flypi pi use`. */
export function readPiPin(root: string): PiPin | null {
	try {
		const pin = JSON.parse(readFileSync(join(root, PI_PIN_FILE), "utf8")) as PiPin;
		return typeof pin.version === "string" ? pin : null;
	} catch {
		return null;
	}
}

/**
 * The loaded pi, and what chose it. A pin that names a version other than the one loaded is not a pin that
 * took effect — a flypi reinstall can drop the link it made — so it reports `pinned: false` rather than
 * claiming a switch that is not happening.
 */
export function loadedPi(root: string): PiInfo {
	const version = (JSON.parse(readFileSync(join(getPackageDir(), "package.json"), "utf8")) as { version: string }).version;
	const pin = readPiPin(root);
	const pinned = pin?.version === version;
	return { version, pinned, ...(pinned && pin?.from && pin.from !== version ? { bundled: pin.from } : {}) };
}
