/**
 * The health/MCP URLs spelled *outside* `src/agent/paths.ts` (plan `.scratch/plans/t32-plan.md` §T32.4).
 * Those copies cannot import it: `scripts/*.mjs` run under bare node (`start.mjs` runs before
 * `npm install`), and a `Dockerfile` imports nothing — so the shape is pinned from the source instead,
 * the way `tests/daemon/daemon-file.test.ts` pins the CLI's copy of the daemon file. The scripts are
 * read, never run: running `dev-container.mjs` or `release-check.mjs` *is* the deploy
 * (`dev-container.test.ts`, `release-check.test.ts` do the same for their surfaces).
 *
 * Deliberately absent: `ui/App.svelte`'s **relative** `/healthz`, which is what makes the page work over
 * the LAN and through the Vite proxy (plan risk R8), and `src/memory/mcp.ts`, which reports the host it
 * actually bound rather than the loopback default (R9).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureConfig } from "../../scripts/start.mjs";
import { healthUrl, memoryMcpUrl } from "../../src/agent/paths.ts";

/** One loopback probe of a known port, whatever the port is written as: a `${…}` in a script, the
 *  literal `8791` in the image's own HEALTHCHECK (which the plan doc's grep could never reach).
 *  shortcut: the `8791` is the image's port spelled a second time, here — move it in `Dockerfile` and move it here too. */
const SPELLING = /http:\/\/([0-9A-Za-z.-]+):(?:\$\{[^}]*\}|8791)\/healthz/g;

/** Every copy that exists, with its count. The count is what keeps this from being decoration: a spelling
 *  that changes shape stops matching, and a file whose spellings were deleted scores 0 against a non-zero
 *  expected number rather than passing vacuously over an empty match list. */
const SITES = [
	["scripts/flypi.mjs", 1],
	["scripts/dev-container.mjs", 3],
	["scripts/release-check.mjs", 1],
	["Dockerfile", 1],
] as const;

/** The surface a runnable copy could be spelled in: every script, the CLI entry point and the top-level
 *  configs (`Dockerfile`, `vite.config.ts`, `package.json`, `start.sh`, …). `*.md` is prose that documents
 *  the URL, not a copy that runs. */
const SWEPT = [
	...readdirSync(".", { withFileTypes: true }).filter((e) => e.isFile() && !e.name.endsWith(".md")).map((e) => e.name),
	...["bin", "scripts"].flatMap((dir) => readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(dir, e.name))),
];

/** Every copy of the shared shape in a file, with the line above it. Continuations are joined first, so the
 *  Dockerfile's HEALTHCHECK spells its URL on the instruction's own line and its `#` comment sits above it. */
function copies(file: string, spelling: RegExp) {
	const lines = readFileSync(file, "utf8").replace(/\\\n[ \t]*/g, " ").split("\n");
	return lines.flatMap((line, i) => (line.match(spelling) ?? []).map(() => ({ line, above: lines[i - 1] ?? "" })));
}

describe("the health URL the .mjs scripts and the image spell for themselves", () => {
	it("is the loopback shape paths.ts owns, in every copy", () => {
		const health = new URL(healthUrl(4321));
		expect(health.pathname).toBe("/healthz");
		for (const [file, expected] of SITES) {
			const found = [...readFileSync(file, "utf8").matchAll(SPELLING)];
			expect(found.length, `${file}: expected ${expected} spelling(s) of the health URL`).toBe(expected);
			for (const match of found) expect(match[1], `${file} host`).toBe(health.hostname);
		}
	});

	it("leaves the TS scripts importing paths.ts instead of re-spelling", () => {
		for (const file of ["scripts/pi.ts", "scripts/serve-daemon.ts"]) {
			expect(readFileSync(file, "utf8"), `${file} must import the layout, not inline it`).toContain('from "../src/agent/paths.ts"');
		}
	});

	// SITES is a closed list, so it cannot catch a *new* copy: everything else runnable is swept for the
	// spelling instead. A new probe must either be declared in SITES or import paths.ts. `scripts/start.mjs`
	// is swept and matches nothing — its unreachable copy is the /mcp URL, covered by the ensureConfig test.
	it("leaves no copy of the health URL outside the declared sites", () => {
		for (const file of SWEPT) {
			if (SITES.some(([site]) => site === file)) continue;
			expect([...readFileSync(file, "utf8").matchAll(SPELLING)], `${file} spells the health URL — declare it in SITES or import paths.ts`).toHaveLength(0);
		}
	});

	// The `shortcut:` comments, pinned the way tests/daemon/daemon-file.test.ts:108-113 pins the CLI's: the
	// line above every copy must say why that copy cannot import paths.ts. Deleting one is red here.
	it("carries a shortcut comment at every copy", () => {
		for (const [file, expected] of SITES) {
			const found = copies(file, SPELLING);
			expect(found, `${file}: expected ${expected} commented copy(ies)`).toHaveLength(expected);
			for (const copy of found) expect(copy.above, copy.line.trim()).toContain("shortcut:");
		}
		// start.mjs spells no /healthz; the copy it carries is the /mcp URL this file pins behaviourally.
		const mcp = copies("scripts/start.mjs", /:\$\{[^}]*\}\/mcp/g);
		expect(mcp, "scripts/start.mjs: expected 1 commented copy").toHaveLength(1);
		for (const copy of mcp) expect(copy.above, copy.line.trim()).toContain("shortcut:");
	});

	// The one /mcp copy that matters at bootstrap: it runs before npm install, so it cannot import, and a
	// host here that is not the one `memoryMcpUrl` answers is a memory entry the agent cannot reach.
	it("writes the bootstrap mcp.json entry at the URL paths.ts names", () => {
		const root = mkdtempSync(join(tmpdir(), "flypi-health-url-"));
		try {
			const { port } = ensureConfig(root, {});
			const entry = JSON.parse(readFileSync(join(root, ".flypi", "agent", "mcp.json"), "utf8")).mcpServers["flypi-memory"];
			// One compare over the whole string pins scheme, host and path (and that the entry's port is
			// the port the script reported). Renaming the host to `localhost` here is enough to go red.
			expect(entry.url).toBe(memoryMcpUrl(port));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
