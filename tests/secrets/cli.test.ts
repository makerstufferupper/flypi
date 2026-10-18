/**
 * `flypi secret …` (docs/secrets.md Phase 5.5) — the command a config file runs. Everything here is driven
 * through the real entrypoint against a real database file, with another connection held open the way the
 * daemon would hold one: the point of the read paths is that they answer while the writer is busy, and the
 * point of `print` is that its stdout *is* the value.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { flypiPaths } from "../../src/agent/paths.ts";
import { runSecretCli } from "../../src/secrets/cli.ts";
import { openMemoryDb } from "../../src/memory/db.ts";

const VALUE = "sk-proj-aaaaaaaaaaaaaaaa1111";

/** A checkout with a memory database in it, plus the connection the daemon would be holding. */
function checkout() {
	const dir = mkdtempSync(join(tmpdir(), "flypi-secret-cli-"));
	const paths = flypiPaths(dir);
	const held = openMemoryDb(paths.memoryDbPath);
	const out: string[] = [];
	const err: string[] = [];
	const run = (argv: string[], stdin?: string) => ({ code: runSecretCli(argv, { root: dir, out: (line) => out.push(line), err: (line) => err.push(line), stdin }), out: out.splice(0), err: err.splice(0) });
	return { paths, run, dispose: () => { held.close(); rmSync(dir, { recursive: true, force: true }); } };
}

describe("reading", () => {
	it("prints the value and nothing else, because that stdout is a config file's API key", () => {
		const { run, dispose } = checkout();
		try {
			expect(run(["put", "openai_key", VALUE]).code).toBe(0);
			const printed = run(["print", "openai_key"]);
			expect(printed.code).toBe(0);
			expect(printed.out).toEqual([VALUE]);
		} finally {
			dispose();
		}
	});

	it("answers a read while another process holds the database open", () => {
		const { run, dispose } = checkout();
		try {
			run(["put", "openai_key", VALUE]);
			// The daemon's write lock is held by `held` above; a second process must still be able to answer.
			expect(run(["print", "openai_key"]).out).toEqual([VALUE]);
			expect(run(["list"]).out[1]).toContain("sk-…1111");
		} finally {
			dispose();
		}
	});

	it("lists names and masks, never the value", () => {
		const { run, dispose } = checkout();
		try {
			run(["put", "openai_key", VALUE, "--kind", "password", "--meta", "scope=read"]);
			const listed = run(["list"]);
			expect(listed.out.join("\n")).toContain("openai_key");
			expect(listed.out.join("\n")).toContain("sk-…1111");
			expect(listed.out.join("\n")).not.toContain(VALUE);
			// A search is by name and metadata only — the value is not readable by search.
			expect(run(["list", "scope"]).out.join("\n")).toContain("openai_key");
			expect(run(["list", VALUE]).out.join("\n")).not.toContain("openai_key");
		} finally {
			dispose();
		}
	});

	it("says what it knows about one secret, including who used it", () => {
		const { run, dispose } = checkout();
		try {
			run(["put", "openai_key", VALUE, "--kind", "password"]);
			// `path` opens the database for writing, so the use is recorded; `print` reads through a read-only
			// handle so it answers while the daemon holds the writer, and records nothing. Both are true and
			// both are why the two commands exist.
			run(["path", "openai_key"]);
			run(["print", "openai_key"]);
			const got = run(["get", "openai_key"]);
			expect(got.out.join("\n")).toMatch(/name {8}openai_key/);
			expect(got.out.join("\n")).toContain("sk-…1111");
			expect(got.out.join("\n")).toContain("used        1 time(s)");
			expect(got.out.join("\n")).toContain("cli used");
			expect(got.out.join("\n")).not.toContain(VALUE);
		} finally {
			dispose();
		}
	});

	it("a read-only reveal still answers, and says nothing about the use", () => {
		const { run, dispose } = checkout();
		try {
			run(["put", "openai_key", VALUE]);
			expect(run(["print", "openai_key"]).out).toEqual([VALUE]);
			const got = run(["get", "openai_key"]);
			expect(got.out.join("\n")).toContain("used        0 time(s)");
			// The put is in the history; the reveal from the read-only handle is not.
			expect(got.out.join("\n")).not.toContain("revealed");
		} finally {
			dispose();
		}
	});

	it("an empty vault says how to fill one, rather than printing a header", () => {
		const { run, dispose } = checkout();
		try {
			expect(run(["list"]).out).toEqual(["flypi secret: the vault is empty. `flypi secret put NAME` stores one, or the web UI's Secrets tab."]);
		} finally {
			dispose();
		}
	});
});

describe("writing", () => {
	it("answers a name it was not given with the usage for that command", () => {
		const { run, dispose } = checkout();
		try {
			expect(run(["get"])).toMatchObject({ code: 2, err: ["flypi secret get NAME"] });
			expect(run(["get", "never-stored"]).code).toBe(1);
		} finally {
			dispose();
		}
	});

	it("a root with no database is a sentence, not a stack trace", () => {
		// The everyday version is a typo in FLYPI_ROOT.
		const dir = mkdtempSync(join(tmpdir(), "flypi-secret-cli-nothing-"));
		const err: string[] = [];
		const code = runSecretCli(["list"], { root: join(dir, "no-such-checkout"), out: () => undefined, err: (line) => err.push(line) });
		rmSync(dir, { recursive: true, force: true });
		expect(code).toBe(1);
		expect(err.join(" ")).toContain("flypi secret:");
		expect(err.join(" ")).not.toContain("    at ");
	});

	it("does not mistake a flag for the value", () => {
		const { run, dispose } = checkout();
		try {
			// `put NAME --kind token` used to store the literal "--kind" as the credential.
			const piped = run(["put", "openai_key", "--kind", "password", "--meta", "scope=read"], "from-pipe");
			expect(piped.code, piped.err.join("\n")).toBe(0);
			expect(run(["print", "openai_key"]).out).toEqual(["from-pipe"]);
			expect(run(["get", "openai_key"]).out.join("\n")).toContain("password");
			expect(run(["get", "openai_key"]).out.join("\n")).toContain("scope=read");
		} finally {
			dispose();
		}
	});

	it("takes the value from stdin when it was not typed, so it stays out of the process list", () => {
		const { run, dispose } = checkout();
		try {
			expect(run(["put", "token"]).code).not.toBe(0);
			expect(run(["put", "token"]).err.join(" ")).toContain("pipe it");
			expect(run(["put", "token"], VALUE)).toEqual({ code: 0, out: [`flypi secret: stored token (#1)`], err: [] });
			expect(run(["print", "token"]).out).toEqual([VALUE]);
		} finally {
			dispose();
		}
	});

	it("will not put the same value in twice, and will not overwrite a name without being asked", () => {
		const { run, dispose } = checkout();
		try {
			run(["put", "one", VALUE]);
			expect(run(["put", "two", VALUE]).out).toEqual(['flypi secret: already stored as "one"']);
			expect(run(["put", "one", "bbbbbb-2222"]).out).toEqual(['flypi secret: "one" is taken — `flypi secret rotate one` replaces its value']);
			expect(run(["rotate", "one", "bbbbbb-2222"]).code).toBe(0);
			expect(run(["print", "one"]).out).toEqual(["bbbbbb-2222"]);
			expect(run(["rotate", "ghost"]).code).toBe(1);
		} finally {
			dispose();
		}
	});

	it("deletes into a tombstone that can be brought back", () => {
		const { run, dispose } = checkout();
		try {
			run(["put", "old", VALUE]);
			expect(run(["delete", "old"]).out[0]).toContain("deleted old");
			expect(run(["print", "old"]).code).toBe(1);
			expect(run(["undelete", "old"]).code).toBe(0);
			expect(run(["print", "old"]).out).toEqual([VALUE]);
			expect(run(["undelete", "nothing"]).code).toBe(1);
		} finally {
			dispose();
		}
	});

	it("writes a plaintext file for the tools that only take a path", () => {
		const { run, paths, dispose } = checkout();
		try {
			run(["put", "id_ed25519", "ssh-ed25519 AAAA…", "--kind", "ssh_private_key"]);
			const file = run(["path", "id_ed25519"]).out[0]!;
			expect(file).toBe(join(paths.secretsDir, "id_ed25519"));
			expect(readFileSync(file, "utf8")).toBe("ssh-ed25519 AAAA…");
			expect(statSync(file).mode & 0o777).toBe(0o400);
			expect(run(["path", "nothing"]).code).toBe(1);
		} finally {
			dispose();
		}
	});

	it("imports the public keys a user already has, named after the files", () => {
		const { run, paths, dispose } = checkout();
		try {
			const dir = join(paths.root, "keys");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "id_ed25519.pub"), "ssh-ed25519 AAAAC3Nz user@host\n");
			writeFileSync(join(dir, "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n");
			expect(run(["import-ssh", join(dir, "id_ed25519.pub"), join(dir, "id_rsa"), join(dir, "missing")]).code).toBe(0);
			const listed = run(["list"]).out.join("\n");
			expect(listed).toContain("ssh_id_ed25519.pub");
			expect(listed).toContain("ssh_id_rsa");
			// A public key and a private one are different kinds, and the extension of the file says which.
			expect(listed).toContain("ssh_public_key");
			expect(listed).toContain("ssh_private_key");
			expect(run(["import-ssh"]).code).toBe(2);
		} finally {
			dispose();
		}
	});
});

describe("the key", () => {
	it("reports what it is and whether any row is sealed under an older one", () => {
		const { run, dispose } = checkout();
		try {
			run(["put", "one", "aaaaaa-1111"]);
			expect(run(["key"]).out.join("\n")).toContain("current v1");
			expect(run(["key"]).out.join("\n")).toContain("1, 0 sealed under an older key");
		} finally {
			dispose();
		}
	});

	it("rotates it and re-seals the rows in the same command, so no row is left unreadable", () => {
		const { run, dispose } = checkout();
		try {
			run(["put", "one", "aaaaaa-1111"]);
			// The CLI is the path where waiting is right: a person typed the command and wants the vault
			// consistent before they close the terminal.
			expect(run(["rotate-key"]).out).toEqual(["flypi secret: new key v2; re-sealed 1 row(s)"]);
			expect(run(["key"]).out.join("\n")).toContain("current v2");
			expect(run(["key"]).out.join("\n")).toContain("0 sealed under an older key");
			expect(run(["print", "one"]).out).toEqual(["aaaaaa-1111"]);
		} finally {
			dispose();
		}
	});
});

describe("getting it wrong", () => {
	it("a name that is not there is a sentence and a non-zero code", () => {
		const { run, dispose } = checkout();
		try {
			expect(run(["print", "nothing"])).toEqual({ code: 1, out: [], err: ['no secret named "nothing"'] });
		} finally {
			dispose();
		}
	});

	it("an unknown command is the usage, and a missing name is the usage for that command", () => {
		const { run, dispose } = checkout();
		try {
			expect(run(["vault"]).code).toBe(2);
			expect(run(["vault"]).err[0]).toContain("usage: flypi secret list");
			expect(run(["print"]).code).toBe(2);
			expect(run(["put"]).code).toBe(2);
		} finally {
			dispose();
		}
	});

	it("a checkout with no database says so, rather than stack-tracing", () => {
		const dir = mkdtempSync(join(tmpdir(), "flypi-secret-cli-empty-"));
		const err: string[] = [];
		try {
			expect(runSecretCli(["list"], { root: join(dir, "missing"), err: (line) => err.push(line) })).toBe(1);
			expect(err[0]).toContain("flypi secret:");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
