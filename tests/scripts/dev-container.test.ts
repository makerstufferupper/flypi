/**
 * The dev container script. Like the release rehearsal it has top-level side effects — running it *is* the
 * rebuild, and it needs docker — so nothing here runs it. What is pinned is the surface that would rot
 * quietly: that the script is reachable from npm, that its help names what it touches, and that the one
 * destructive thing it must never do is absent from its source.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const script = "scripts/dev-container.mjs";
const source = readFileSync(script, "utf8");
const help = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });

describe("the dev container script", () => {
	it("is reachable from npm, and exists", () => {
		const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
		expect(scripts["dev:container"]).toBe(`node ${script}`);
		expect(existsSync(script)).toBe(true);
	});

	it("prints what it does and what it touches, without running anything", () => {
		expect(help.status).toBe(0);
		// The stages, so the help cannot drift from the steps.
		for (const stage of ["build", "pack", "image", "replace", "serve", "prune"]) expect(help.stdout).toContain(stage);
		// The names it acts on, and the volume it must leave alone.
		expect(help.stdout).toContain("flypi:local-");
		expect(help.stdout).toContain("flypi-data");
		expect(help.stdout).toContain("8791");
	});

	// The models in that volume are ~933 MB and re-download on the next start (docs/release.md), so the
	// rebuild keeping it is not a convenience, it is the difference between seconds and an hour.
	it("never removes the state volume, and never touches a published image", () => {
		expect(source).not.toMatch(/"volume"/);
		expect(source).not.toMatch(/makerstufferupper\/flypi:(latest|\d)/);
		expect(source).not.toContain("flypi-check");
		// The image is named by commit sha, because the package version inside it collides with the published one.
		expect(source).toContain("rev-parse");
		expect(source).toContain("flypi:local-");
	});

	// The repo's .dockerignore excludes `*.tgz`, so the build context has to be the pack dir, and the
	// Dockerfile has to be the local one — the repo Dockerfile installs the *published* package (#48).
	it("builds the local Dockerfile from the pack dir, not the repo", () => {
		const at = source.indexOf("--build-arg");
		expect(source.slice(at, at + 120)).toContain("FLYPI_TGZ=${tgz}");
		expect(source.slice(at, at + 160)).toContain("packDir");
		expect(source).toContain("docker/Dockerfile.local");
		expect(source).toMatch(/"pack",\s*"--pack-destination",\s*packDir/);
	});
});
