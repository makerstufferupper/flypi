/**
 * The release rehearsal script (docs/release-checks.md). It has top-level side effects — running it *is* the
 * rehearsal — so nothing here imports it. What is pinned instead is the surface that would otherwise rot: the
 * flags it reads are the flags it documents, and the names it uses keep a serving container out of reach.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const script = "scripts/release-check.mjs";
const source = readFileSync(script, "utf8");
const help = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });

describe("the release rehearsal", () => {
	it("prints its stages instead of running them when asked for help", () => {
		expect(help.status).toBe(0);
		for (const stage of ["gates", "pack", "npm-install", "image", "published"]) expect(help.stdout).toContain(stage);
	});

	it("documents every flag it reads", () => {
		const flags = new Set([...source.matchAll(/(?:has|valueOf)\("(--[a-z-]+)"\)/g)].map((match) => match[1]));
		expect(flags.size).toBeGreaterThan(3);
		for (const flag of flags) expect(help.stdout, `${flag} is read but never documented`).toContain(flag);
	});

	it("only ever names containers and ports of its own", () => {
		// A rehearsal that could stop the serving daemon is a rehearsal nobody runs: flypi-check-* on 8792/8793,
		// never the `flypi` container, never its `flypi-data` volume, never port 8791.
		expect(source).toContain("flypi-check-");
		expect(source).not.toMatch(/"flypi-data"/);
		expect(source).not.toMatch(/127\.0\.0\.1:8791/);
	});
});
