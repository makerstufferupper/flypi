/**
 * Phase 5.5's gate in one command (docs/secrets.md, docs/testing.md): the vault in the memory file, the CLI
 * as a second process while a writer holds the database, redaction at the boundary where text is stored, the
 * `!flypi secret print NAME` reference form, and a key rotation with the re-encrypt job that finishes it.
 *
 * It is a driver, not a test: the assertions live in tests/secrets/*. What it adds is that these are real
 * processes and a real file — the two things a unit test can only imitate are a second process reading while
 * the daemon writes, and the bytes on disk that a backup would carry.
 *
 * Run: npm run smoke:secrets
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { flypiPaths } from "../src/agent/paths.ts";
import { openMemoryDb } from "../src/memory/db.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { createEmbedder } from "../src/memory/embed.ts";
import { memoryConfig } from "../src/memory/config.ts";
import { secretReferences } from "../src/secrets/config.ts";
import { openSecretVault } from "../src/secrets/vault.ts";
import { schemaVersion } from "../src/shared/sqlite.ts";

// The checkout this script lives in — where `tsx` and the app's imports resolve from, which is not the
// temp root the smoke runs against (same reason scripts/flypi.mjs has it).
const checkout = resolve(fileURLToPath(import.meta.url), "..", "..");

const ok = (line) => console.log(`ok: ${line}`);
const fail = (line) => {
	console.error(`FAIL: ${line}`);
	process.exit(1);
};

const root = mkdtempSync(join(tmpdir(), "flypi-smoke-secrets-"));
const paths = flypiPaths(root);
const TOKEN = "ghp_Smoke1111111111111111AAAAAAAA";

// 1. The writer: the same database the memory store uses, opened the way the daemon opens it.
const db = openMemoryDb(paths.memoryDbPath);
const vault = openSecretVault(paths, { db, write: true });
ok(`vault in the memory file — ${paths.memoryDbPath} at schema v${schemaVersion(db)}, one file for memories and secrets`);

// 2. The CLI as another process, value on stdin so it never appears in the process list, while this process
// still holds the write handle. This is the everyday case: the daemon is running and someone types a command.
const cli = (args, input) => {
	const run = spawnSync(process.execPath, ["--import", "tsx", join(checkout, "scripts", "secret.ts"), "--root", root, ...args], {
		cwd: checkout,
		encoding: "utf8",
		...(input === undefined ? {} : { input }),
	});
	return { code: run.status ?? 1, out: run.stdout ?? "", err: run.stderr ?? "" };
};
const stored = cli(["put", "github_token", "--kind", "password", "--meta", "purpose=smoke"], TOKEN);
if (stored.code !== 0) fail(`secret put failed: ${stored.err || stored.out}`);
const printed = cli(["print", "github_token"]);
// pi trims a `!command`'s stdout (resolve-config-value.js), so a trailing newline is what a config file wants.
if (printed.out.trim() !== TOKEN) fail(`a second process did not read the value back: ${JSON.stringify(printed.out)}`);
ok(`second process reads while the writer holds the file — print answered ${TOKEN.slice(0, 4)}…${TOKEN.slice(-4)} with the daemon's writer busy (exit ${printed.code})`);

const listed = cli(["list"]);
if (!listed.out.includes("ghp…AAAA") || listed.out.includes(TOKEN)) fail(`list leaked a value or lost its mask:\n${listed.out}`);
const described = cli(["get", "github_token"]);
if (described.code !== 0 || !described.out.includes("purpose=smoke") || described.out.includes(TOKEN)) fail(`get did not describe the row without the value:\n${described.out}`);
ok("list and get answer with masks — no plaintext on either path");

// 3. The file itself. A backup of this database must not carry the credential in the clear.
for (const file of [paths.memoryDbPath, `${paths.memoryDbPath}-wal`]) {
	if (existsSync(file) && readFileSync(file).includes(TOKEN)) fail(`${file} contains the plaintext`);
}
const row = db.prepare("SELECT name, mask, length(value_cipher) AS bytes, length(value_nonce) AS nonce, length(value_tag) AS tag, fingerprint, key_version FROM secrets WHERE name = 'github_token'").get();
if (row.bytes === 0 || row.nonce !== 12 || row.tag !== 16 || !/^[0-9a-f]{64}$/.test(row.fingerprint) || row.key_version !== 1) {
	fail(`the row is not sealed the way the design says: ${JSON.stringify(row)}`);
}
ok(`bytes on disk are ciphertext — ${row.bytes} B cipher, ${row.nonce} B nonce, ${row.tag} B tag, key v${row.key_version}, and the file does not contain the value`);

// 4. The redaction boundary, at the place it matters: text being stored. A memory and a turn's tool calls go
// through the same function the transcript hooks call (src/memory/store.ts).
const embeddings = memoryConfig(paths).embeddings;
embeddings.provider = "none";
const store = new MemoryStore(db, await createEmbedder(embeddings));
const remembered = await store.addMemory({
	kind: "smoke",
	body: `the github token is ${TOKEN} — do not paste it in a wiki`,
	tags: ["smoke"],
	origin_class: "agent",
	session_kind: "interactive",
	actor: "smoke",
});
const storedBody = store.memory(remembered.id).body;
if (storedBody.includes(TOKEN)) fail("a memory body kept the secret in the clear");
if (!storedBody.includes("[secret:github_token]")) fail(`a memory body did not name what it hid: ${storedBody}`);
// A turn row belongs to a conversation the memory DB knows (`turns.conversation_id` is a foreign key), so the
// row exists before the turn is recorded — the same order the server keeps them in (src/memory/store.ts).
db.prepare("INSERT INTO conversations (id, cwd, pi_session_file, created_at) VALUES ('smoke-conv', ?, '/tmp/smoke.jsonl', ?)").run(paths.root, new Date().toISOString());
store.recordTurn("smoke-conv", {
	userText: `look up ${TOKEN}`,
	assistantText: `found it: ${TOKEN}`,
	toolCalls: [{ name: "bash", arguments: { command: `gh api -H "Authorization: Bearer ${TOKEN}"` } }],
});
const turn = db.prepare("SELECT user_text, assistant_text, tool_calls_json FROM turns WHERE conversation_id = 'smoke-conv'").get();
for (const column of [turn.user_text, turn.assistant_text, turn.tool_calls_json]) {
	if (String(column).includes(TOKEN)) fail(`a turn column kept the secret: ${column}`);
}
ok(`redaction at the store — memory #${remembered.id} and the turn's tool calls both say [secret:github_token]`);

// 5. A command that only takes a path, and the reference form pi's config files use.
const pathOut = cli(["path", "github_token"]);
const secretFile = pathOut.out.trim();
if (statSync(secretFile).mode & 0o077 || !readFileSync(secretFile, "utf8").includes(TOKEN)) fail(`path did not write a 0400 file with the value: ${pathOut.out}`);
// The agent dir is there only once something has been written into it; a config file is what creates it.
mkdirSync(dirname(paths.mcpPath), { recursive: true });
writeFileSync(paths.mcpPath, JSON.stringify({ mcpServers: { github: { url: "https://api.github.com/mcp", headers: { Authorization: "!flypi secret print github_token" } } } }, null, 2));
const found = secretReferences(paths);
if (found.length !== 1 || found[0].name !== "github_token" || !found[0].path.includes("headers.Authorization")) fail(`the reference in mcp.json was not found: ${JSON.stringify(found)}`);
// Run that reference exactly as pi would run it. `flypi secret print` is the command a config file would hold.
const viaFlypi = execFileSync(process.execPath, [join(checkout, "scripts", "flypi.mjs"), "secret", "print", "github_token"], { cwd: checkout, encoding: "utf8", env: { ...process.env, FLYPI_ROOT: root } });
if (viaFlypi.trim() !== TOKEN) fail(`\`!flypi secret print github_token\` printed ${JSON.stringify(viaFlypi)}`);
ok(`a config reference resolves — mcp.json at ${found[0].path} → \`flypi secret print github_token\` → the value; a path-only tool gets a 0400 file`);

// 6. Key rotation: the old key keeps working, the drift is reported, and the job that fixes it runs here
// because the daemon would have queued it.
const before = vault.row("github_token");
const rotated = vault.rotateKey("smoke");
const drift = vault.keyDrift();
// Rotating a key must not silently strand a row: the drift is visible and the job to fix it is already queued
// (src/daemon/index.ts queues it at startup too, in case the process died between the two).
if (drift.stale !== 1 || drift.current !== rotated.version || !drift.reencryptQueued) fail(`key rotation did not report the drift it caused: ${JSON.stringify(drift)}`);
const stillOpens = vault.value("github_token", { actor: "smoke", action: "used" });
if (stillOpens !== TOKEN) fail("a row under the old key stopped opening — a missing key must be loud, not wrong");
const resealed = vault.reencrypt();
const after = vault.row("github_token");
if (resealed.rows !== 1 || after.key_version !== rotated.version) fail(`re-encrypt did not move the row: ${JSON.stringify(resealed)}`);
if (vault.value("github_token", { actor: "smoke", action: "used" }) !== TOKEN) fail("the row stopped opening after re-encrypting");
if (vault.keyDrift().stale !== 0) fail("the drift is still reported after the job ran");
const audit = db.prepare("SELECT action, count(*) AS n FROM secret_audit WHERE secret_id = ? GROUP BY action ORDER BY action").all(before.id);
ok(`key rotation — v${before.key_version} → v${rotated.version}, the old key kept opening until the job re-sealed ${resealed.rows} row(s) under v${after.key_version}, audit ${audit.map((a) => `${a.action}×${a.n}`).join(" ")}`);

// 7. Deletion is a tombstone, and a tombstone is restorable without anyone holding the value.
cli(["delete", "github_token"]);
if (vault.row("github_token").status !== "deleted") fail("delete did not leave a tombstone");
if (cli(["list"]).out.includes(TOKEN)) fail("the tombstone list leaked a value");
cli(["undelete", "github_token"]);
if (vault.row("github_token").status !== "active") fail("undelete did not bring the row back");
ok("delete is a tombstone, and `undelete` finds it again — the value never had to be typed twice");

db.close();
vault.close();
rmSync(root, { recursive: true, force: true });
console.log(`\nthe checkout: ${root} (removed)`);
console.log("  the same checks against a real store: flypi secret list; sqlite3 .flypi/memory/flypi.db 'select name, mask, key_version from secrets'");
process.exit(0);
