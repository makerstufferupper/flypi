/**
 * Phase 3's gate in one command (docs/memory.md, docs/testing.md): the SQLite file, both halves of
 * search, the status rules, and the MCP-over-HTTP surface — against the real `.flypi/memory/flypi.db`
 * the plan says must stay queryable with `sqlite3`.
 *
 * It is a driver, not a test: the assertions live in tests/memory/*. What it adds is that the same
 * file opens, migrates, and answers a client that speaks MCP.
 *
 * Run: npm run smoke:memory            (add -- --no-embeddings to skip the model download)
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { flypiPaths } from "../src/agent/paths.ts";
import { memoryConfig } from "../src/memory/config.ts";
import { openMemoryDb } from "../src/memory/db.ts";
import { createEmbedder } from "../src/memory/embed.ts";
import { startMemoryServer } from "../src/memory/mcp.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { consolidate, planSweep } from "../src/memory/consolidate.ts";
import { readWiki, renderWiki } from "../src/memory/wiki.ts";

const paths = flypiPaths(process.cwd());
const flagValue = (name) => {
	const i = process.argv.indexOf(name);
	return i === -1 ? undefined : process.argv[i + 1];
};
const dbFile = flagValue("--db") ?? paths.memoryDbPath;
const config = memoryConfig(paths);
if (process.argv.includes("--no-embeddings")) config.embeddings.provider = "none";

const embedder = await createEmbedder(config.embeddings);
const db = openMemoryDb(dbFile);
const store = new MemoryStore(db, embedder);

const ok = (line) => console.log(`ok: ${line}`);
const fail = (line) => {
	console.error(`FAIL: ${line}`);
	process.exit(1);
};

const marker = `smoke-${Date.now()}`;
const write = (body, extra = {}) =>
	store.addMemory({ kind: "smoke", body, tags: ["smoke"], origin_class: "agent", session_kind: "interactive", actor: "smoke", ...extra });

// 1. Write, then find it by its own words.
const { id } = await write(`${marker}: the build command is npm run build`);
const byKeyword = await store.search({ query: marker });
if (!byKeyword.results.some((row) => row.id === id)) fail(`#${id} was not found by its own marker`);
ok(
	`store + keyword search — #${id} in ${byKeyword.results.length} hit(s)` +
		(byKeyword.partial ? `, keyword-only (${embedder.error ?? "embeddings off"})` : `, embeddings ${embedder.identity?.model}`),
);

// 2. The one automatic transition: active → superseded, both rows kept. The two rows must be different
// facts — the dedup gate is meant to catch the same fact worded differently (see NEAR_DUPLICATE).
const { id: replacement } = await write(`${marker}: the deploy target is 10.0.0.7`);
store.markSuperseded(id, replacement, "smoke");
const retired = store.memory(id);
if (retired.status !== "superseded" || retired.superseded_by !== replacement) fail("supersede did not leave both rows linked");
if (store.memory(replacement).status !== "active") fail("the replacement is not active");
if ((await store.search({ query: marker })).results.some((row) => row.id === id)) fail("a superseded row is still searchable");
ok(`status rules — #${id} superseded by #${replacement}, both rows still in the table`);

// 3. Nothing deletes a row except an explicit forget; a repeat write is not a second row.
const { id: throwaway } = await write(`${marker}: this one is only here to be forgotten`);
const repeated = await write(`${marker}: this one is only here to be forgotten`);
if (repeated.duplicateOf !== throwaway) fail(`a repeat of #${throwaway} wrote #${repeated.id} instead of pointing back`);
if (store.memory(id).use_count === 0) fail("the search in step 1 did not count as a use");
ok(`dedup + counters — a repeat points at #${throwaway}, retrieval counted ${store.memory(id).use_count} use(s)`);

const rowsBefore = db.prepare("SELECT count(*) AS n FROM memories").get().n;
store.forget(throwaway, "smoke");
if (store.memory(throwaway).status !== "deleted") fail("forget did not reach status=deleted");
if (db.prepare("SELECT count(*) AS n FROM memories").get().n !== rowsBefore) fail("a memory row disappeared; Phase 3 never hard-deletes");
ok(`audit + delete rules — ${db.prepare("SELECT count(*) AS n FROM memory_audit WHERE memory_id = ?").get(throwaway).n} audit rows for #${throwaway}, still ${rowsBefore} memory rows`);

// 4. The index is one vector space, or it says so.
const index = store.indexIdentity();
if (index.stale > 0 && !index.reembedQueued) fail("a stale index did not queue memory.reembed");
ok(`index identity — ${index.rows} vectors, ${index.stale} from another model, reembed queued: ${index.reembedQueued}`);

// 5. The same store over HTTP, through the MCP client pi uses.
const server = await startMemoryServer({ store, token: "smoke-token", principal: "mcp:smoke" });
const client = new McpClient({ name: "flypi-smoke", version: "0.0.0" });
await client.connect(new StreamableHttpTransport({ url: server.url, headers: { authorization: "Bearer smoke-token" } }));
const tools = await client.listTools();
// The surface the agent can reach, named rather than counted: a tool appearing or vanishing is a
// decision, and a bare number cannot say which one moved (this sat at 7 while `memory_cite` shipped).
// These are the ten the server registers today — see docs/memory.md Phase 4 on the read tools the
// plan describes and this server does not have.
const SURFACE = ["memory_capture", "memory_cite", "memory_forget", "memory_index_status", "memory_media", "memory_read", "memory_search", "memory_supersede", "memory_turn", "memory_write"];
const names = tools.map((tool) => tool.name).sort();
if (names.join(",") !== [...SURFACE].sort().join(",")) fail(`memory tools changed: expected ${SURFACE.join(", ")}, got ${names.join(", ")}`);
const overTheWire = JSON.parse((await client.callTool("memory_search", { query: marker })).content[0].text);
if (!overTheWire.results.some((row) => row.id === id || row.id === replacement)) fail("the MCP search did not see the row the store wrote");
// A turn of a real conversation reaches the store the same way: the memory server is the only writer, and
// the hit-rate metrics are what tell flypi whether recall paid for itself. Asked about this run's own
// conversation by id — the store may hold turns from earlier sessions, and `memoryHitRate()` counts them all.
await client.callTool("memory_turn", { conversation_id: "smoke-conv", user_text: "what do we use?", retrieved: [id], cited: [id] });
const turnRow = db.prepare("SELECT retrieved_json AS retrieved, cited_json AS cited FROM turns WHERE conversation_id = 'smoke-conv'").get();
if (!turnRow || turnRow.retrieved === null || turnRow.cited === null) fail("the turn log did not record what was shown and cited");
const measured = store.memoryHitRate();
if (typeof measured.rate !== "number" || measured.turns < 1) fail(`the hit-rate metric did not compute: ${JSON.stringify(measured)}`);
ok(`MCP over HTTP — ${tools.length} tools at ${server.url}, search reached #${overTheWire.results.map((row) => row.id).join(", #")}, turn ${turnRow.retrieved} retrieved / ${turnRow.cited} cited, store hit rate ${measured.rate} over ${measured.turns} turn(s)`);

// 6. A picture and a recording: a path in, a vector in the same space, the bytes back out. This is the
// mechanism with the real model — whether the *meaning* of a photo is retrieved well is what the recall
// corpus measures (docs/memory.md Phase 4), so nothing semantic is asserted here.
const dir = mkdtempSync(join(tmpdir(), "flypi-smoke-media-"));
const pictureFile = join(dir, "shape.png");
const toneFile = join(dir, "tone.wav");
const pictureBytes = png(64, 64, (x, y) => ((x - 32) ** 2 + (y - 32) ** 2 < 400 ? [0, 0, 0] : [255, 255, 255]));
const toneBytes = wav(0.6, 220);
writeFileSync(pictureFile, pictureBytes);
writeFileSync(toneFile, toneBytes);

const picture = JSON.parse((await client.callTool("memory_write", { body: `${marker}: a black circle on white`, kind: "smoke", media_path: pictureFile })).content[0].text);
const recording = JSON.parse((await client.callTool("memory_write", { body: `${marker}: a short tone`, kind: "smoke", media_path: toneFile })).content[0].text);
if (!picture.id || !recording.id) fail(`a media write was refused: ${picture.error ?? recording.error}`);
for (const [written, kind] of [[picture, "image"], [recording, "audio"]]) {
	const row = store.memory(written.id);
	if (row.modality !== kind) fail(`#${written.id} is ${row.modality}, not ${kind}`);
	// With a model, both must be in the index; without one, both must say why they are not.
	if (embedder.identity ? row.embed?.dims !== 768 : written.indexed !== false || !written.note) {
		fail(`#${written.id} ${embedder.identity ? `has no ${kind} vector in the current index` : `did not report why it is keyword-only`}`);
	}
}
if (embedder.identity && store.indexIdentity().stale !== 0) fail("the media vectors did not land in the current index");

const asked = JSON.parse((await client.callTool("memory_search", { query: `${marker} tone` })).content[0].text);
if (!asked.results.some((row) => row.id === recording.id && row.modality === "audio")) fail("the search did not report the recording's modality");
const back = JSON.parse((await client.callTool("memory_media", { id: picture.id })).content[0].text);
if (back.mime !== "image/png" || !Buffer.from(back.base64, "base64").equals(pictureBytes)) fail("the image bytes did not come back unchanged");
ok(`media — #${picture.id} (image) and #${recording.id} (audio) stored and found, bytes round-tripped${embedder.identity ? ", both embedded at 768d" : ", keyword-only as configured"}`);

const unsupported = await client.callTool("memory_write", { body: `${marker}: a song`, kind: "smoke", media_path: join(dir, "song.mp3") });
if (!unsupported.isError) fail("an mp3 was accepted; only wav audio is supported");
ok("an unsupported container is refused with what to do about it");

// 8. Phase 6: the sweep and the wiki. The daemon runs the sweep when the store is quiet; here it is forced,
// because the gate is that the same file answers a whole-store pass and that the wiki comes out of it readable
// with its `#id` spine. The merge is only run against a scratch database — a sweep over the real store would
// merge someone's real rows to watch a script work.
const twin = await write(`${marker}: the deploy host is the small box`);
const twinCopy = await write(`${marker}: the deploy host is the small box at home`);
const scratch = dbFile !== paths.memoryDbPath;
const rowsBeforeSweep = db.prepare("SELECT count(*) AS n FROM memories").get().n;
// Against the real store this is the plan only — `planSweep` is pure, which is the whole reason the sweep can
// be interrupted without half-applying, and the same property means a smoke can look without merging anyone's
// rows. Against a scratch file the pass actually writes.
const sweep = scratch
	? consolidate(store)
	: planSweep(store.activeMemories(), store.activeVectors(), store.citationEvidence());
if (db.prepare("SELECT count(*) AS n FROM memories").get().n !== rowsBeforeSweep) fail("a sweep made a memory row disappear");
const rendered = renderWiki(store, db);
const page = readWiki(db).find((entry) => entry.slug === "smoke");
if (!page || !page.body.includes(`#${twin.id}`)) fail("the wiki did not render this run's rows with their #id citations");
ok(
	`sweep + wiki — ${scratch ? `merged ${sweep.merges.length} cluster(s),` : `planned ${sweep.merges.length} cluster(s) (plan only; pass --db to write),`} ` +
		`${rowsBeforeSweep} rows before and after, ${rendered.pages} page(s) with ${page.sections.length} section(s), spine cites #${twin.id}`,
);
if (scratch && (sweep.merges.length === 0 || store.memory(twinCopy.id).status !== "superseded")) {
	fail(`the sweep did not collapse #${twinCopy.id} into #${twin.id}`);
}

await client.close();
await server.close();
rmSync(dir, { recursive: true, force: true });

console.log(`\nthe file: ${dbFile}`);
// The smoke's own rows stay in the table with status='deleted' — Phase 3 never hard-deletes, and
// forgetting them is what stops a later run's near-identical sentence from deduping against this one.
for (const row of [id, replacement, throwaway, picture.id, recording.id]) store.forget(row, "smoke:cleanup");
// A turn row is a measurement, not a memory, so the never-hard-delete rule does not apply to it: leaving
// this smoke's turn in a real store would quietly move its hit-rate numbers.
db.prepare("DELETE FROM turns WHERE conversation_id = 'smoke-conv'").run();
ok(`cleanup — #${id}, #${replacement}, #${throwaway} are status=deleted; ${db.prepare("SELECT count(*) AS n FROM memories WHERE status='active'").get().n} active rows left`);
console.log(`  sqlite3 '${dbFile}' 'select count(*) from memories'`);
db.close();
process.exit(0);

/** A PNG the image encoder can actually see: solid shapes, no photo, so nothing semantic is implied. */
function png(width, height, pixel) {
	const stride = width * 3 + 1;
	const raw = Buffer.alloc(stride * height);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) pixel(x, y).forEach((value, channel) => (raw[y * stride + 1 + x * 3 + channel] = value));
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // truecolour
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

function chunk(type, body) {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(body.length, 0);
	head.write(type, 4);
	const crc = Buffer.alloc(4);
	let check = ~0;
	for (const byte of Buffer.concat([Buffer.from(type), body])) { // the CRC covers the type and the body, not the length
		check ^= byte;
		for (let bit = 0; bit < 8; bit += 1) check = (check >>> 1) ^ (0xedb88320 & -(check & 1));
	}
	crc.writeUInt32BE(~check >>> 0, 0);
	return Buffer.concat([head, body, crc]);
}

/** `seconds` of a `hertz` tone, 16 kHz mono — what a recorder would produce. */
function wav(seconds, hertz) {
	const frames = Math.round(seconds * 16_000);
	const data = Buffer.alloc(frames * 2);
	for (let i = 0; i < frames; i += 1) data.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * hertz * i) / 16_000)), i * 2);
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + data.length, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(16_000, 24);
	header.writeUInt32LE(32_000, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(data.length, 40);
	return Buffer.concat([header, data]);
}
