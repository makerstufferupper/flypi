/**
 * The update check and the download (`src/daemon/update.ts`, docs/architecture.md Phase 7): the version
 * ladder (one published release at a time — the reason it exists is that flypi's databases migrate when the
 * version that needs the migration starts), the registry answer and the package fetch over a stubbed fetch (a
 * test never reaches the network), the checksum a download is verified against, the stamp on disk, and what
 * installing would run. `flypi update` itself is `scripts/update.ts`, and its checkout refusal — the only
 * branch a test can take from inside a checkout — is asserted in `tests/daemon/cli.test.ts`.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	UPDATE_CHECK_FILE,
	checkForUpdate,
	clearUpdateCheck,
	downloadUpdate,
	dueForCheck,
	installArgs,
	isGlobalInstall,
	isNewer,
	keepDownload,
	nextVersion,
	packageInfo,
	published,
	readUpdateCheck,
	stagedUpdate,
	updateAvailable,
	writeUpdateCheck,
} from "../../src/daemon/update.ts";

const response = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body }) as unknown as Response;
const stub = (body: unknown, ok = true, status = 200) => ({ fetchImpl: async () => response(body, ok, status) as never });
const temp = (prefix: string) => {
	const root = mkdtempSync(join(tmpdir(), prefix));
	return { root, done: () => rmSync(root, { recursive: true, force: true }) };
};

describe("which version is newer", () => {
	it("reads the parts as numbers, not text", () => {
		expect(isNewer("0.1.0", "0.1.1")).toBe(true);
		expect(isNewer("0.9.0", "0.10.0")).toBe(true);
		expect(isNewer("1.9.9", "2.0.0")).toBe(true);
	});

	it("says no for the same version and for an older one", () => {
		expect(isNewer("0.1.0", "0.1.0")).toBe(false);
		expect(isNewer("0.2.0", "0.1.9")).toBe(false);
		expect(isNewer("2.0.0", "1.9.9")).toBe(false);
	});

	it("fills a missing part with zero, so 1.2 is 1.2.0", () => {
		expect(isNewer("1.2", "1.2.1")).toBe(true);
		expect(isNewer("1.2.1", "1.2")).toBe(false);
	});
});

describe("one step at a time", () => {
	// The rule and its reason: 0.1.0 → 0.3.0 would run 0.3.0's schema migration against 0.1.0's schema and
	// skip whatever 0.2.0 would have done to it, so an update moves to the next published release.
	const ladder = { "0.1.0": {}, "0.1.2": {}, "0.10.0": {}, "0.2.0": {}, "0.1.1": {}, "0.3.0-next.0": {} };

	it("orders the published releases by number, and ignores prereleases", () => {
		expect(published(ladder)).toEqual(["0.1.0", "0.1.1", "0.1.2", "0.2.0", "0.10.0"]);
	});

	it("refuses to skip a published release", () => {
		expect(nextVersion(ladder, "0.1.0")).toBe("0.1.1");
		expect(nextVersion(ladder, "0.1.1")).toBe("0.1.2");
		expect(nextVersion(ladder, "0.2.0")).toBe("0.10.0");
	});

	it("walks past a prerelease without stepping on it", () => {
		expect(nextVersion({ "0.2.0-next.0": {}, "0.2.0": {} }, "0.1.0")).toBe("0.2.0");
	});

	it("says there is nowhere to go when this is the newest, and takes no step it cannot list", () => {
		expect(nextVersion(ladder, "0.10.0")).toBeNull();
		// A registry that named no versions is not a licence to jump to whatever `latest` says.
		expect(nextVersion({}, "0.1.0")).toBeNull();
	});

	it("names the stamp's step only while it is still ahead of what is running", () => {
		const stamp = { checkedAt: "2026-10-17T00:00:00.000Z", current: "0.1.0", latest: "0.3.0", next: "0.1.1" };
		expect(updateAvailable(stamp, "0.1.0")).toBe("0.1.1");
		// The step has been taken since the stamp was written; the next one comes from a fresh look.
		expect(updateAvailable(stamp, "0.1.1")).toBeNull();
		expect(updateAvailable(stamp, "0.4.0")).toBeNull();
		expect(updateAvailable(null, "0.1.0")).toBeNull();
		expect(updateAvailable({ checkedAt: "x", current: "0.1.0", latest: null, next: null, error: "offline" }, "0.1.0")).toBeNull();
	});
});

describe("asking the registry", () => {
	it("asks for the package document, which is where the ladder lives", async () => {
		let url = "";
		const answer = await checkForUpdate({
			current: "0.1.0",
			name: "@makerstufferupper/flypi",
			fetchImpl: async (input) => {
				url = String(input);
				return response({ "dist-tags": { latest: "0.3.0" }, versions: { "0.1.0": {}, "0.1.1": {}, "0.3.0": {} } });
			},
		});
		expect(url).toBe("https://registry.npmjs.org/%40makerstufferupper%2Fflypi");
		expect(answer.latest).toBe("0.3.0");
		// The step, not the top of the ladder: this is what gets downloaded and installed.
		expect(answer.next).toBe("0.1.1");
		expect(answer.error).toBeUndefined();
		expect(Date.parse(answer.checkedAt)).not.toBeNaN();
	});

	it("reports a package the registry has never heard of, rather than throwing", async () => {
		const answer = await checkForUpdate({ current: "0.1.0", name: "@makerstufferupper/flypi", ...stub({}, false, 404) });
		expect(answer.latest).toBeNull();
		expect(answer.next).toBeNull();
		expect(answer.error).toContain("404");
	});

	it("reports a registry it cannot reach, rather than throwing", async () => {
		const answer = await checkForUpdate({
			current: "0.1.0",
			name: "flypi",
			fetchImpl: async () => {
				throw new Error("offline");
			},
		});
		expect(answer.latest).toBeNull();
		expect(answer.error).toContain("offline");
	});

	it("refuses a document that names no published versions to step through", async () => {
		const answer = await checkForUpdate({ current: "0.1.0", name: "flypi", ...stub({ "dist-tags": { latest: "0.2.0" } }) });
		expect(answer.next).toBeNull();
		expect(answer.error).toContain("no published versions");
	});

	it("keeps the step's own checksums, which is what a download is verified against", async () => {
		const answer = await checkForUpdate({
			current: "0.1.0",
			name: "flypi",
			fetchImpl: async () =>
				response({
					"dist-tags": { latest: "0.3.0" },
					versions: { "0.1.0": {}, "0.2.0": { dist: { tarball: "https://registry.npmjs.org/flypi/-/flypi-0.2.0.tgz", shasum: "ab12", integrity: "sha512-xyz" } }, "0.3.0": {} },
				}),
		});
		expect(answer.next).toBe("0.2.0");
		expect(answer.dist?.tarball).toContain("flypi-0.2.0.tgz");
		expect(answer.dist?.integrity).toBe("sha512-xyz");
	});
});

describe("downloading the package", () => {
	const bytes = Buffer.from("a tarball, in memory");
	const dist = { tarball: "https://registry.npmjs.org/flypi/-/flypi-0.2.0.tgz", integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`, shasum: createHash("sha1").update(bytes).digest("hex") };
	const sent = (body: Buffer) => ({ fetchImpl: async () => ({ ok: true, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) }) as unknown as Response });

	it("verifies the bytes against the registry's sha512 and keeps them", async () => {
		const { root, done } = temp("flypi-dl-");
		try {
			const out = await downloadUpdate({ root, version: "0.2.0", dist, ...sent(bytes) });
			expect(out.error).toBeUndefined();
			expect(readFileSync(out.file as string)).toEqual(bytes);
		} finally {
			done();
		}
	});

	it("deletes what does not match, rather than staging code the registry never published", async () => {
		const { root, done } = temp("flypi-dl-");
		try {
			const out = await downloadUpdate({ root, version: "0.2.0", dist, ...sent(Buffer.from("someone else's tarball")) });
			expect(out.file).toBeUndefined();
			expect(out.error).toContain("sha512");
			expect(existsSync(join(root, ".flypi", "updates"))).toBe(false);
		} finally {
			done();
		}
	});

	it("refuses a manifest that published no checksum to verify against", async () => {
		const { root, done } = temp("flypi-dl-");
		try {
			const out = await downloadUpdate({ root, version: "0.2.0", dist: { tarball: "https://registry.npmjs.org/flypi/-/flypi-0.2.0.tgz" }, ...sent(bytes) });
			expect(out.error).toContain("no checksum");
		} finally {
			done();
		}
	});

	it("falls back to the older sha1 when that is all the manifest carries", async () => {
		const { root, done } = temp("flypi-dl-");
		try {
			const out = await downloadUpdate({ root, version: "0.2.0", dist: { tarball: dist.tarball, shasum: dist.shasum }, ...sent(bytes) });
			expect(out.file).toBeTruthy();
		} finally {
			done();
		}
	});

	it("keeps one version waiting, not every version it has ever downloaded", async () => {
		const { root, done } = temp("flypi-dl-");
		try {
			await downloadUpdate({ root, version: "0.2.0", dist, ...sent(bytes) });
			await downloadUpdate({ root, version: "0.3.0", dist: { ...dist, tarball: "https://registry.npmjs.org/flypi/-/flypi-0.3.0.tgz" }, ...sent(bytes) });
			expect(readdirSync(join(root, ".flypi", "updates"))).toEqual(["flypi-0.3.0.tgz"]);
		} finally {
			done();
		}
	});
});

describe("what is ready to install", () => {
	const stamp = { checkedAt: "2026-10-17T00:00:00.000Z", current: "0.1.0", latest: "0.3.0", next: "0.2.0", download: { version: "0.2.0", file: "/tmp/flypi-0.2.0.tgz", at: "2026-10-17T00:00:00.000Z" } };

	it("names the download only when it is newer than what is running", () => {
		expect(stagedUpdate(stamp, "0.1.0")).toBe("0.2.0");
		// A stamp left by the install that already happened: the tarball is not a pending restart.
		expect(stagedUpdate(stamp, "0.2.0")).toBeNull();
		expect(stagedUpdate({ ...stamp, download: undefined }, "0.1.0")).toBeNull();
		expect(stagedUpdate(null, "0.1.0")).toBeNull();
	});

	it("keeps a download only while it is still the step to take", () => {
		expect(keepDownload({ checkedAt: "x", current: "0.1.0", latest: "0.3.0", next: "0.2.0" }, stamp)?.file).toBe("/tmp/flypi-0.2.0.tgz");
		// The step has been taken, so the package on disk is code that is already running.
		expect(keepDownload({ checkedAt: "x", current: "0.2.0", latest: "0.3.0", next: "0.3.0" }, stamp)).toBeUndefined();
		expect(keepDownload({ checkedAt: "x", current: "0.1.0", latest: null, next: null }, null)).toBeUndefined();
	});

	it("will not install over a flypi that is not the npm global package", () => {
		// The checkout the tests run from: `npm install -g` would land somewhere else, and the restart would
		// come back on the same code while the log claimed it had updated.
		expect(isGlobalInstall(resolve(import.meta.dirname, "..", ".."))).toBe(false);
	});

	it("installs the file it just verified, not a version string it re-resolves", () => {
		expect(installArgs("/root/.flypi/updates/flypi-0.2.0.tgz")).toEqual(["install", "-g", "--no-audit", "--no-fund", "/root/.flypi/updates/flypi-0.2.0.tgz"]);
	});
});

describe("the stamp on disk", () => {
	it("is absent until something asks, and reads back what was written", () => {
		const { root, done } = temp("flypi-update-");
		try {
			expect(readUpdateCheck(root)).toBeNull();
			writeUpdateCheck(root, { checkedAt: "2026-10-17T00:00:00.000Z", current: "0.1.0", latest: "0.3.0", next: "0.2.0" });
			expect(readUpdateCheck(root)?.next).toBe("0.2.0");
			expect(JSON.parse(readFileSync(join(root, UPDATE_CHECK_FILE), "utf8")).current).toBe("0.1.0");
		} finally {
			done();
		}
	});

	it("is written on a root that has no .flypi/ yet", () => {
		// `flypi update --check` on a machine that has never run a daemon.
		const { root, done } = temp("flypi-update-");
		try {
			writeUpdateCheck(root, { checkedAt: "2026-10-17T00:00:00.000Z", current: "0.1.0", latest: null, next: null, error: "offline" });
			expect(readUpdateCheck(root)?.error).toBe("offline");
		} finally {
			done();
		}
	});

	it("is cleared after a step, so the next one is taken from a fresh look", () => {
		const { root, done } = temp("flypi-update-");
		try {
			writeUpdateCheck(root, { checkedAt: "2026-10-17T00:00:00.000Z", current: "0.1.0", latest: "0.3.0", next: "0.2.0" });
			clearUpdateCheck(root);
			expect(readUpdateCheck(root)).toBeNull();
			// Clearing an absent stamp is not an error: it is the normal state before the first check.
			clearUpdateCheck(root);
		} finally {
			done();
		}
	});

	it("is due when there is none, and again a day after the last one", () => {
		expect(dueForCheck(null)).toBe(true);
		const now = Date.parse("2026-10-17T12:00:00.000Z");
		expect(dueForCheck({ checkedAt: "2026-10-17T11:00:00.000Z", current: "0.1.0", latest: "0.1.0", next: null }, now)).toBe(false);
		expect(dueForCheck({ checkedAt: "2026-10-16T11:00:00.000Z", current: "0.1.0", latest: "0.1.0", next: null }, now)).toBe(true);
		// A stamp written by another install, or junk, is due rather than trusted.
		expect(dueForCheck({ checkedAt: "not a date", current: "0.1.0", latest: "9.9.9", next: "9.9.9" }, now)).toBe(true);
	});
});

describe("what this install is", () => {
	it("knows the checkout it is running from, which is why it does not ask the registry", () => {
		const pkg = packageInfo();
		expect(pkg.name).toBe("@makerstufferupper/flypi");
		expect(pkg.checkout).toBe(true);
		expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
	});
});
