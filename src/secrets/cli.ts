/**
 * `flypi secret …` (docs/secrets.md Phase 5.5).
 *
 * Two jobs, and they are not the same one:
 *
 * - `print NAME` is the command a config file references — `"apiKey": "!flypi secret print NAME"` in
 *   auth.json, or an `env`/`headers` value in mcp.json (pi runs a leading `!` command and uses its stdout,
 *   docs/models.md). That is why this exists as a process rather than only as a UI form: it has to answer in
 *   any shell, with nothing in the environment, and print the value and nothing else.
 * - `list`, `get`, `put`, `rotate`, `delete`, `import-ssh` are the ones a person types.
 *
 * Reads open the memory database read-only, so a second process can answer while the daemon holds the write
 * lock (risk 15). Writes are short transactions: the plan's rule is that the CLI is never a second long-lived
 * writer, and a put that returns in one statement does not become one.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FlypiPaths } from "../agent/paths.ts";
import { flypiPaths } from "../agent/paths.ts";
import { openMemoryDb, openMemoryDbReadOnly } from "../memory/db.ts";
import { secretFilePath } from "./config.ts";
import { closeSecretSource } from "./redact.ts";
import { keyfileProvider, type SecretKind } from "./crypto.ts";
import { SecretStore, type SecretRow } from "./vault.ts";

const USAGE = `usage: flypi secret list | get NAME | print NAME | put NAME [value] [--kind K] [--meta k=v]
       flypi secret rotate NAME [value] | delete NAME | undelete NAME | path NAME
       flypi secret import-ssh ~/.ssh/id_ed25519.pub | key | rotate-key
a value left out of put/rotate is read from stdin, which keeps it out of the process list`;

const READS = ["list", "get", "print", "key"];
const WRITES = ["put", "rotate", "delete", "undelete", "path", "import-ssh", "rotate-key"];

export interface SecretCliOptions {
	/** Defaults to the checkout the command was run from, like every other flypi entrypoint. */
	root?: string;
	out?: (line: string) => void;
	err?: (line: string) => void;
	/** Only tests pass these; a real run opens the databases itself. */
	db?: DatabaseSync;
	stdin?: string;
}

/** Returns the exit code, and never calls `process.exit`, so a test can assert on it. */
export function runSecretCli(argv: string[], options: SecretCliOptions = {}): number {
	const paths = flypiPaths(options.root ?? process.cwd());
	const say = options.out ?? ((line: string) => console.log(line));
	const fail = options.err ?? ((line: string) => console.error(line));
	const args = argv;
	const command = args[0] ?? "list";
	const reading = READS.includes(command);
	if (!reading && !WRITES.includes(command)) {
		fail(USAGE);
		return 2;
	}

	let db: DatabaseSync;
	try {
		db = options.db ?? (reading ? openMemoryDbReadOnly(paths.memoryDbPath) : openMemoryDb(paths.memoryDbPath));
	} catch (cause) {
		fail(`flypi secret: ${(cause as Error).message}`);
		return 1;
	}
	// A read command opened the database read-only, so it must know that: `print` still answers, it just
	// cannot record the use while another process owns the writer.
	const store = new SecretStore(db, keyfileProvider(paths.secretKeyPath), reading && options.db === undefined);
	try {
		const run = reading ? (a: string[]) => read(a, store, paths, say, fail) : (a: string[]) => write(a, store, paths, say, fail, options.stdin);
		return run(args);
	} catch (cause) {
		// One place, so a bad name or a key the provider does not hold is a sentence, not a stack trace.
		fail(`flypi secret: ${(cause as Error).message}`);
		return 1;
	} finally {
		if (!options.db) db.close();
		// A CLI run is short-lived, but the redaction source is process-wide: leave it where we found it.
		closeSecretSource();
	}
}

function read(args: string[], store: SecretStore, paths: FlypiPaths, say: (line: string) => void, fail: (line: string) => void): number {
	const [command, ...rest] = args;
	if (command === "print") {
		const name = rest[0];
		if (!name) {
			fail("flypi secret print NAME");
			return 2;
		}
		const value = store.value(name, { actor: "cli", action: "revealed" });
		if (value === undefined) {
			fail(`no secret named "${name}"`);
			return 1;
		}
		// The value and nothing else, because a config file's API key is this process's stdout.
		say(value);
		return 0;
	}
	if (command === "get") {
		const name = rest[0];
		if (!name) {
			fail("flypi secret get NAME");
			return 2;
		}
		const row = store.row(name);
		if (!row) {
			fail(`no secret named "${name}"`);
			return 1;
		}
		say(`name        ${row.name}`);
		say(`kind        ${row.kind}`);
		say(`mask        ${row.mask}`);
		say(`key         v${row.key_version}`);
		say(`created     ${row.created_at}${row.updated_at ? ` (updated ${row.updated_at})` : ""}`);
		say(`used        ${row.use_count} time(s)${row.last_used_at ? `, last ${row.last_used_at}` : ""}`);
		if (row.status === "deleted") say(`status      deleted (flypi secret undelete ${row.name} brings it back)`);
		for (const [key, value] of Object.entries(row.meta)) say(`meta        ${key}=${value}`);
		for (const use of store.uses(row.name)) say(`history     ${use.created_at} ${use.actor} ${use.action}${use.reason ? ` (${use.reason})` : ""}`);
		return 0;
	}
	if (command === "key") {
		const drift = store.keyDrift();
		say(`key provider ${drift.keyProvider}, current v${drift.current}`);
		say(`rows         ${drift.rows}, ${drift.stale} sealed under an older key`);
		if (drift.stale > 0) say("             `flypi secret rotate-key` re-seals them");
		return 0;
	}
	const rows = store.list(rest[0] ?? "", true);
	if (rows.length === 0) {
		say("flypi secret: the vault is empty. `flypi secret put NAME` stores one, or the web UI's Secrets tab.");
		return 0;
	}
	say(`${"name".padEnd(22)} ${"kind".padEnd(16)} ${"mask".padEnd(28)} used  status`);
	for (const row of rows) say(listLine(row));
	return 0;
}

function write(args: string[], store: SecretStore, paths: FlypiPaths, say: (line: string) => void, fail: (line: string) => void, stdin?: string): number {
	const [command, name, ...rest] = args;
	if (!name && command !== "import-ssh" && command !== "rotate-key") {
		fail(`flypi secret ${command} NAME`);
		return 2;
	}
	const kind = flag(args, "--kind") as SecretKind | undefined;
	if (command === "put" || command === "rotate") {
		const value = valueFrom(rest, stdin, fail);
		if (value === undefined) return 1;
		if (command === "put") {
			const result = store.put({ name: name!, value, kind, meta: metaFrom(args), actor: "cli" });
			if (result.status === "exists") say(`flypi secret: already stored as "${result.name}"`);
			else if (result.status === "name taken") say(`flypi secret: "${name}" is taken — \`flypi secret rotate ${name}\` replaces its value`);
			else say(`flypi secret: stored ${name} (#${result.id})`);
			return result.status === "stored" ? 0 : 1;
		}
		const result = store.rotate({ name: name!, value, kind, actor: "cli" });
		say(result.status === "rotated" ? `flypi secret: rotated ${name}` : `flypi secret: no secret named "${name}"`);
		return result.status === "rotated" ? 0 : 1;
	}
	if (command === "delete" || command === "undelete") {
		const result = command === "delete" ? store.remove(name!, { actor: "cli" }) : store.restore(name!, { actor: "cli" });
		const done = result.status === "deleted" || result.status === "restored";
		say(done ? `flypi secret: ${result.status} ${name}${command === "delete" ? ` (\`flypi secret undelete ${name}\` brings it back)` : ""}` : `flypi secret: no secret named "${name}"`);
		return done ? 0 : 1;
	}
	if (command === "path") {
		// A path, for the tools that only take one: ssh, gpg. The plaintext goes in a 0400 file under
		// .flypi/secrets/ — never the environment, which every child process would inherit (risk 13).
		const value = store.value(name!, { actor: "cli", action: "used" });
		if (value === undefined) {
			fail(`no secret named "${name}"`);
			return 1;
		}
		mkdirSync(paths.secretsDir, { recursive: true });
		const file = secretFilePath(paths, name!);
		writeFileSync(file, value, { mode: 0o400 });
		chmodSync(file, 0o400);
		say(file);
		return 0;
	}
	if (command === "import-ssh") {
		// The paths come after the subcommand, so the first one landed in `name` above.
		const files = name ? [name, ...rest] : [];
		if (files.length === 0) {
			fail("flypi secret import-ssh ~/.ssh/id_ed25519.pub [more files…] — a public key is safe to store; a private one is your call");
			return 2;
		}
		let stored = 0;
		for (const target of files) {
			const file = target.startsWith("~") ? join(homedir(), target.slice(1)) : target;
			let text: string;
			try {
				text = readFileSync(file, "utf8");
			} catch {
				fail(`cannot read ${file}`);
				continue;
			}
			// Named after the file, because that is the name a user would write in a config file, and the kind
			// follows from the extension: `.pub` is public, anything else is a private key.
			const base = basename(file);
			const keyKind: SecretKind = base.endsWith(".pub") ? "ssh_public_key" : "ssh_private_key";
			const result = store.put({ name: `ssh_${base}`, value: text.trim(), kind: keyKind, meta: { source: file }, actor: "cli" });
			if (result.status === "stored") stored += 1;
			say(result.status === "stored" ? `flypi secret: stored ssh_${base} (#${result.id}) as ${keyKind}` : `flypi secret: already stored as "${result.name}"`);
		}
		return stored > 0 ? 0 : 1;
	}
	const rotated = store.rotateKey("cli");
	const reencrypted = store.reencrypt();
	say(`flypi secret: new key v${rotated.version}; re-sealed ${reencrypted.rows} row(s)`);
	return 0;
}

/** stdin when no value was typed on the command line — argv is visible in `ps`, a credential should not be. */
function valueFrom(rest: string[], stdin: string | undefined, fail: (line: string) => void): string | undefined {
	// Only a leading argument that is not a flag is the value. `put NAME --kind password` used to store the
	// literal "--kind". A value that starts with a dash belongs on stdin, as the usage says.
	const first = rest[0];
	if (first !== undefined && !first.startsWith("-")) return first;
	const piped = stdin?.trim();
	if (piped) return piped;
	fail('no value. Pass one as an argument, or pipe it: printf %s "$TOKEN" | flypi secret put NAME');
	return undefined;
}

function metaFrom(args: string[]): Record<string, string> {
	const meta: Record<string, string> = {};
	for (const pair of valuesOf(args, "--meta")) {
		const at = pair.indexOf("=");
		if (at > 0) meta[pair.slice(0, at)] = pair.slice(at + 1);
	}
	return meta;
}

const flag = (args: string[], name: string): string | undefined => valuesOf(args, name)[0];

function valuesOf(args: string[], name: string): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i += 1) {
		const value = args[i + 1];
		if (args[i] === name && value !== undefined) out.push(value);
	}
	return out;
}

function listLine(row: SecretRow): string {
	return `${row.name.padEnd(22)} ${row.kind.padEnd(16)} ${row.mask.padEnd(28)} ${String(row.use_count).padEnd(5)} ${row.status}`;
}
