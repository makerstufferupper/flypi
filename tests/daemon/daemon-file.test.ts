/**
 * The `.flypi/daemon.json` contract between the daemon and the CLI (docs: `.scratch/plans/t32-plan.md`
 * §T32.3). `scripts/flypi.mjs` is plain .mjs and cannot import `src/agent/paths.ts`, and the file's field
 * set is declared by `DaemonInfo` in `src/daemon/index.ts` — nothing may import across that boundary, so
 * this file owns the rule: the path, the fields and the `shortcut:` comments that document the exception.
 * No daemon is spawned here — `status` only reads the file and probes a dead port, which keeps this fast;
 * the slow live-CLI cases are `tests/daemon/cli.test.ts`.
 */
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DAEMON_FILE, memoryMcpUrl } from "../../src/agent/paths.ts";

const repo = resolve(import.meta.dirname, "../..");
const cli = join(repo, "scripts", "flypi.mjs");

/** A pid no process can have: `kill(pid, 0)` says it is gone, which is what a dead daemon looks like. */
const DEAD_PID = 2_147_483_647;

/** A port nothing holds at that moment — `status` probes the recorded port, so a sample must not name one
 *  something else answers on (plan risk R5: a dev container on 8791 would make the output environment-dependent). */
async function freePort(): Promise<number> {
	const probe = createServer();
	probe.listen(0, "127.0.0.1");
	await once(probe, "listening");
	const port = (probe.address() as { port: number }).port;
	probe.close();
	return port;
}

/** The fields `DaemonInfo` declares, read out of the daemon's source — the CLI cannot import the type. */
function declaredFields(): string[] {
	const source = readFileSync(join(repo, "src", "daemon", "index.ts"), "utf8");
	const body = /export interface DaemonInfo \{([\s\S]*?)\n\}/.exec(source)?.[1];
	return [...(body?.matchAll(/^\t(\w+):/gm) ?? [])].map((m) => m[1]!);
}

/**
 * One sample per declared field: what the CLI must render. `pid` and `port` are replaced per case — only a
 * live pid makes `status` reach its URL lines, and `port` must be one nothing answers on.
 */
const SAMPLE = {
	pid: DEAD_PID,
	/** What the live container records; the printed agent URL must show the recorded bind, not a loopback guess. */
	host: "0.0.0.0",
	port: 0,
	token: "sample-token",
	/** Printed, never probed, so any unused number is an honest sample here. */
	memoryPort: 45039,
	startedAt: "2026-10-12T09:00:00.000Z",
	version: "0.0.0-contract",
};

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "flypi-daemon-file-"));
	mkdirSync(join(root, ".flypi"), { recursive: true });
	return root;
}

/** The real CLI under bare node — it runs a command at import, so it is spawned, never imported. */
function status(root: string) {
	const result = spawnSync(process.execPath, [cli, "--root", root, "status"], { cwd: repo, encoding: "utf8", timeout: 30_000 });
	return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

describe("the CLI/daemon contract on .flypi/daemon.json", () => {
	it("the CLI reads the file at the path paths.ts names", () => {
		// Runtime agreement, both directions: if DAEMON_FILE or the CLI's own spelling moves, `status`
		// answers "no …daemon.json… never started" instead of the pid from the file and this goes red —
		// whichever side drifted, and it stays green if both change together.
		const root = tempRoot();
		writeFileSync(join(root, DAEMON_FILE), JSON.stringify({ ...SAMPLE, pid: DEAD_PID }));
		try {
			const result = status(root);
			expect(result.out, result.out).toContain("pid 2147483647");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("every DaemonInfo field has a sample, and the CLI prints its two URLs from them", async () => {
		const declared = declaredFields();
		// A new or renamed daemon field lands here first: the sample table has to be updated with it.
		expect(Object.keys(SAMPLE).sort()).toEqual(declared.sort());
		const root = tempRoot();
		const port = await freePort();
		// `status` only prints the URLs when `alive(info.pid)` says yes; the test process is the cheapest live pid.
		writeFileSync(join(root, DAEMON_FILE), JSON.stringify({ ...SAMPLE, pid: process.pid, port }));
		try {
			const result = status(root);
			expect(result.code, result.out).toBe(0);
			// Renaming `memoryPort` or `host`/`port` on either side prints `undefined` here → red. The
			// `started …` line is health-driven, so it is deliberately not asserted (R5).
			expect(result.out, result.out).toContain(memoryMcpUrl(SAMPLE.memoryPort));
			expect(result.out, result.out).toContain(`http://${SAMPLE.host}:${port}`);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("each spelling of the shared shape in the CLI carries its shortcut comment", () => {
		const lines = readFileSync(cli, "utf8").split("\n");
		const sites = lines.flatMap((line, i) => (/\.flypi", "daemon\.json"/.test(line) || /\/mcp/.test(line) ? [{ line, i }] : []));
		// The two sites, and a silent zero is a vacuous pass.
		expect(sites.map((s) => s.i), JSON.stringify(sites.map((s) => s.line))).toHaveLength(2);
		for (const site of sites) expect(lines[site.i - 1], site.line.trim()).toContain("shortcut:");
	});
});
