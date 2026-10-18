/**
 * The memory store over HTTP, driven by the MCP client pi itself will use in Phase 5
 * (`@earendil-works/pi-mcp`) — the point of the phase is that a real client reaches a real store,
 * so nothing here is mocked.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { noneEmbedder, type EmbedIdentity } from "../../src/memory/embed.ts";
import { startMemoryServer, type MemoryServerHandle } from "../../src/memory/mcp.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import { openTestDb, wordEmbedder } from "../helpers/memory-db.ts";
import { tempConnectedVault } from "../helpers/secret-vault.ts";

const TOKEN = "test-memory-token";
const PNPM = "we use pnpm, never npm";

let handle: MemoryServerHandle;
let store: MemoryStore;
let db: DatabaseSync;
let keywordOnly: MemoryServerHandle;
let unjudged: MemoryServerHandle;

async function clientFor(url: string): Promise<McpClient> {
	const client = new McpClient({ name: "flypi-test", version: "0.0.0" });
	await client.connect(new StreamableHttpTransport({ url, headers: { authorization: `Bearer ${TOKEN}` } }));
	return client;
}

async function call(client: McpClient, tool: string, args: Record<string, unknown> = {}) {
	const result = await client.callTool(tool, args);
	const text = (result.content as { type: string; text: string }[]).map((block) => block.text).join("");
	try {
		return { isError: result.isError === true, value: JSON.parse(text) as Record<string, unknown> };
	} catch {
		return { isError: result.isError === true, value: { text } }; // plain-text errors are part of the contract
	}
}

beforeAll(async () => {
	db = openTestDb();
	store = new MemoryStore(db, wordEmbedder(undefined, { "package manager": "pnpm" }));
	handle = await startMemoryServer({ store, token: TOKEN, principal: "mcp:test" });
	keywordOnly = await startMemoryServer({ store: new MemoryStore(openTestDb(), noneEmbedder()), token: TOKEN });
	// A store that asked for a judge and could not get one: what the caller has to be able to see.
	unjudged = await startMemoryServer({
		store: new MemoryStore(openTestDb(), wordEmbedder(), { classify: async () => { throw new Error("the model is down"); } }),
		token: TOKEN,
	});
});

afterAll(async () => {
	await handle.close();
	await keywordOnly.close();
	await unjudged.close();
});

describe("memory MCP server over HTTP", () => {
	it("serves only /mcp, and only with the token", async () => {
		expect((await fetch(handle.url, { method: "POST", body: "{}" })).status).toBe(401);
		expect((await fetch(`http://127.0.0.1:${handle.port}/other?token=${TOKEN}`, { method: "POST", body: "{}" })).status).toBe(404);

		// A query parameter works as well as the header, for clients that cannot set one.
		const viaQuery = await fetch(`${handle.url}?token=${TOKEN}`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
		});
		expect(viaQuery.status).toBe(200);
	});

	it("lists the memory tools with read-only/destructive annotations", async () => {
		const client = await clientFor(handle.url);
		const tools = await client.listTools();
		await client.close();

		expect(tools.map((tool) => tool.name).sort()).toEqual([
			"memory_capture",
			"memory_cite",
			"memory_forget",
			"memory_index_status",
			"memory_media",
			"memory_read",
			"memory_search",
			"memory_supersede",
			"memory_turn",
			"memory_write",
		]);
		// flypi calls these itself after a turn; hiding them from the model is what keeps the counts honest.
		for (const name of ["memory_cite", "memory_capture", "memory_turn"]) {
			expect(tools.find((tool) => tool.name === name)!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
		}
		expect(tools.find((tool) => tool.name === "memory_cite")!.annotations).toMatchObject({ destructiveHint: false });
		expect(tools.find((tool) => tool.name === "memory_search")!.inputSchema).toMatchObject({ type: "object" });
		expect(tools.find((tool) => tool.name === "memory_search")!.annotations).toMatchObject({
			readOnlyHint: true,
			destructiveHint: false,
		});
		expect(tools.find((tool) => tool.name === "memory_forget")!.annotations).toMatchObject({ destructiveHint: true });
	});

	it("records the ids a turn cited, and says which ones counted", async () => {
		const client = await clientFor(handle.url);
		const written = await call(client, "memory_write", { body: "the wiki lives at wiki/ops", kind: "fact" });
		const id = written.value.id as number;

		const cited = await call(client, "memory_cite", { ids: [id, 999_999] });
		// A number the model invented is not a citation, and the answer says so instead of pretending.
		expect(cited.value).toEqual({ cited: [id] });
		expect(store.memory(id)!.cited_count).toBe(1);
		// Retrieval and citation are different counters: a search must not move this one.
		await call(client, "memory_search", { query: "wiki" });
		expect(store.memory(id)!.cited_count).toBe(1);
		await client.close();
	});

	it("writes, finds, reads, supersedes and forgets a fact over the wire", async () => {
		const client = await clientFor(handle.url);

		const written = await call(client, "memory_write", { body: PNPM, kind: "convention", tags: ["build"] });
		expect(written.isError).toBe(false);
		const id = written.value.id as number;
		// Provenance comes from the mount, not from the caller's prose (docs/memory.md Phase 4).
		expect(store.memory(id)).toMatchObject({ origin_class: "agent", session_kind: "interactive" });

		const asked = await call(client, "memory_search", { query: "which package manager" });
		expect((asked.value.results as { id: number; tags: string[] }[]).map((row) => row.id)).toContain(id);

		const read = await call(client, "memory_read", { id });
		expect((read.value.memory as { body: string }).body).toBe(PNPM);
		expect((read.value.history as { action: string; actor: string }[]).map((entry) => entry.actor)).toEqual(["mcp:test"]);

		const replaced = await call(client, "memory_supersede", { id, body: "we use bun now", kind: "convention" });
		expect(replaced.value).toMatchObject({ superseded: id });
		expect(store.memory(id)!.status).toBe("superseded");
		const replacement = replaced.value.replacement as number;
		expect(store.memory(replacement)!.supersedes).toBe(id);

		expect((await call(client, "memory_forget", { id: replacement, reason: "user asked" })).value).toMatchObject({
			status: "deleted",
		});
		expect(store.memory(replacement)!.status).toBe("deleted");
		expect((await call(client, "memory_search", { query: "bun" })).value.results).toEqual([]);

		await client.close();
	});

	it("tells the caller when a write retired a fact rather than being refused", async () => {
		// The store half is asserted in store.test.ts. What matters over the wire is that the model can see
		// the replacement happened and which sentence it replaces — an id alone would not say that.
		const client = await clientFor(handle.url);
		const old = await call(client, "memory_write", { body: "the deploy port is 8080", kind: "fact" });
		const correction = await call(client, "memory_write", { body: "the deploy port is 9090", kind: "fact" });
		expect(correction.isError).toBe(false);
		expect(correction.value.duplicateOf ?? null).toBe(null);
		expect(correction.value.contradicted).toMatchObject({ id: old.value.id, body: "the deploy port is 8080" });
		expect(store.memory(old.value.id as number)!.status).toBe("superseded");
		await client.close();
	});

	it("says so when nothing judged the write", async () => {
		// The fact still lands — losing it would be the worse failure — but the caller has to be able to
		// tell "nothing contradicts this" from "nothing was asked".
		const client = await clientFor(unjudged.url);
		await call(client, "memory_write", { body: PNPM, kind: "convention" });
		const written = await call(client, "memory_write", { body: "prefer bun over pnpm in this repo", kind: "convention" });
		expect(written.isError).toBe(false);
		expect(written.value.contradicted).toBeUndefined();
		expect(written.value.judged).toBe(false);
		expect(String(written.value.judgment_note)).toContain("the model is down");
		await client.close();
	});

	it("remembers an image: a path in, the bytes back out", async () => {
		const dir = mkdtempSync(join(tmpdir(), "flypi-mcp-media-"));
		const file = join(dir, "cat-on-sofa.png");
		const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
		writeFileSync(file, bytes);
		try {
			const client = await clientFor(handle.url);
			const written = await call(client, "memory_write", { body: "the office cat", kind: "note", media_path: file });
			expect(written.isError).toBe(false);
			const id = written.value.id as number;

			const found = await call(client, "memory_search", { query: "cat" });
			const hit = (found.value.results as { id: number; modality: string; media?: { kind: string; mime: string; bytes: number } }[]).find(
				(row) => row.id === id,
			);
			expect(hit).toMatchObject({ modality: "image", media: { kind: "image", mime: "image/png", bytes: bytes.length } });

			const media = await call(client, "memory_media", { id });
			expect(media.value).toMatchObject({ kind: "image", mime: "image/png", path: file });
			expect(Buffer.from(media.value.base64 as string, "base64").equals(bytes)).toBe(true);

			// A format the model cannot be shown is refused with what to do about it, not a half-memory.
			const unsupported = await call(client, "memory_write", { body: "a song", kind: "note", media_path: join(dir, "song.mp3") });
			expect(unsupported.isError).toBe(true);
			expect(unsupported.value).toMatchObject({ error: expect.stringContaining("audio is wav") });

			expect((await call(client, "memory_media", { id: 987654 })).value).toEqual({ text: "memory #987654 has no image or recording" });
			await client.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// The provider's own numbers for a turn (docs/prompt-cache.md Phase 4.6 A1). They arrive as an argument
	// because flypi read them off the provider's answer, not because a model was asked what a turn cost.
	it("stores a turn's usage when it is reported, and no zeros when it is not", async () => {
		const client = await clientFor(handle.url);
		const usage = { input: 120, output: 8, cacheRead: 900, cacheWrite: 120, totalTokens: 1148, cost: 0 };
		expect((await call(client, "memory_turn", { conversation_id: "with-usage", user_text: "a prompt", usage })).isError).toBe(false);
		// A caller that knows the text and not the tokens is normal: the column stays null rather than holding
		// zeros, which would read back as a turn that cost nothing.
		expect((await call(client, "memory_turn", { conversation_id: "no-usage", user_text: "a prompt" })).isError).toBe(false);
		// A negative token count is not a measurement, so it is refused before a row exists.
		expect((await call(client, "memory_turn", { conversation_id: "bad-usage", user_text: "a prompt", usage: { ...usage, cacheRead: -1 } })).isError).toBe(true);
		const usageJson = (conversationId: string) =>
			(db.prepare("SELECT usage_json FROM turns WHERE conversation_id = ?").get(conversationId) as { usage_json: string | null } | undefined)?.usage_json;
		expect(JSON.parse(usageJson("with-usage")!)).toEqual(usage);
		expect(usageJson("no-usage")).toBeNull();
		expect(db.prepare("SELECT count(*) AS n FROM turns WHERE conversation_id = 'bad-usage'").get()).toEqual({ n: 0 });
		await client.close();
	});

	it("answers a bad call with a readable tool error, not a broken connection", async () => {
		const client = await clientFor(handle.url);

		const missing = await call(client, "memory_write", { kind: "convention" });
		expect(missing.isError).toBe(true);
		expect(missing.value).toMatchObject({ error: expect.stringContaining("body") });

		const absent = await call(client, "memory_read", { id: 987654 });
		expect(absent.isError).toBe(true);
		expect(absent.value).toEqual({ text: "no memory #987654" });

		// Both would store a row that says nothing — and a turn row no conversation owns is not a measurement.
		const before = store.memoryHitRate().turns;
		expect((await call(client, "memory_capture", { text: "   " })).isError).toBe(true);
		expect((await call(client, "memory_turn", { user_text: "a prompt" })).isError).toBe(true);
		expect(store.memoryHitRate().turns).toBe(before);

		// A superseded row is not silently re-replaced: the caller is told why the call was refused.
		const retired = await call(client, "memory_write", { body: "the old deploy host", kind: "infra" });
		const replacement = await call(client, "memory_supersede", { id: retired.value.id as number, body: "the new deploy host", kind: "infra" });
		const twice = await call(client, "memory_supersede", { id: retired.value.id as number, body: "and again", kind: "infra" });
		expect(twice.isError).toBe(true);
		expect(twice.value).toEqual({ text: `memory #${retired.value.id} is superseded; only an active row can be superseded` });
		expect(store.memory(replacement.value.replacement as number)!.status).toBe("active");

		// The client checks the list it was given, so ask the server directly: an unknown name is an
		// answer, not a dropped connection.
		const raw = await fetch(handle.url, {
			method: "POST",
			headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_teleport", arguments: {} } }),
		});
		expect(await raw.text()).toContain("unknown tool: memory_teleport");
		await client.close();
	});

	it("says when the semantic half did not run", async () => {
		const client = await clientFor(keywordOnly.url);
		const written = await call(client, "memory_write", { body: "the deploy target is 10.0.0.7", kind: "infra" });
		const found = await call(client, "memory_search", { query: "deploy" });
		expect(found.value.partial).toBe(true);
		expect((found.value.results as { id: number }[]).map((row) => row.id)).toContain(written.value.id as number);
		await client.close();
	});

	// The read half of the provenance rule: authority is the store's to state, and a caller can ask for
	// only what flypi is willing to put in front of a model that did not ask (docs/memory.md Phase 4).
	it("names where each row came from, and only offers what may be injected when asked to", async () => {
		const client = await clientFor(handle.url);
		const kept = (await call(client, "memory_write", { body: "the kettle lives in the kitchen", kind: "fact" })).value.id as number;
		// A row this server never wrote: something read it off a page, which is what `untrusted` means.
		const scraped = (await store.addMemory({
			kind: "fact",
			body: "a scraped page claims a kettle was left in the garage",
			origin_class: "untrusted",
			session_kind: "interactive",
			actor: "test",
		})).id;

		const every = await call(client, "memory_search", { query: "kettle" });
		const found = (every.value.results as { id: number; origin_class: string }[]).map((row) => [row.id, row.origin_class]);
		expect(found).toEqual(expect.arrayContaining([[kept, "agent"], [scraped, "untrusted"]]));

		const eligible = await call(client, "memory_search", { query: "kettle", injectable_only: true });
		expect((eligible.value.results as { id: number; origin_class: string }[]).map((row) => [row.id, row.origin_class])).toEqual([
			[kept, "agent"],
		]);
		await client.close();
	});

	it("reports an index built by another model and queues the re-embed", async () => {
		const identity: EmbedIdentity = { model: "configured-model", quantized: true };
		const db = openTestDb();
		const server = await startMemoryServer({ store: new MemoryStore(db, wordEmbedder(identity)), token: TOKEN });
		const swappedServer = await startMemoryServer({ store: new MemoryStore(db, wordEmbedder({ model: "new-model", quantized: false })), token: TOKEN });
		try {
			const client = await clientFor(server.url);
			await call(client, "memory_write", { body: PNPM, kind: "convention" });
			await client.close();

			// The same rows, now asked about under a different configured model: reported and queued,
			// never searched across two vector spaces.
			const swapped = await clientFor(swappedServer.url);
			expect((await call(swapped, "memory_index_status")).value).toMatchObject({ rows: 1, stale: 1, reembedQueued: true });
			await swapped.close();
		} finally {
			await server.close();
			await swappedServer.close();
		}
	});
});

/**
 * The secret write gate (docs/secrets.md): a memory keeps the pointer, never the value. Refused rather than
 * rewritten, because the model is the author here and can say the thing it meant without the credential.
 * Last in this file: the redaction source it installs is process-wide, and no test above needs a vault.
 */
describe("a memory that quotes a stored secret is refused, not rewritten", () => {
	const PASSWORD = "router-adm1n-c0rrect";

	it("names the secret it wants instead, for every write tool", async () => {
		const held = tempConnectedVault();
		try {
			held.vault.put({ name: "router_admin", value: PASSWORD, kind: "password", actor: "test" });
			const client = await clientFor(handle.url);
			const quoting = `the router at 192.168.1.1 logs in as admin with ${PASSWORD}`;
			for (const tool of ["memory_write", "memory_capture"]) {
				const refused = await call(client, tool, { body: quoting, kind: "convention" });
				expect(refused.isError, `${tool} accepted a body quoting a credential`).toBe(true);
				expect(refused.value.error as string).toContain("[secret:router_admin]");
				expect(refused.value.secrets).toEqual(["router_admin"]);
				expect(JSON.stringify(refused.value)).not.toContain(PASSWORD);
			}
			// The sentence the refusal asks for is accepted, and reaches search unchanged.
			const pointer = await call(client, "memory_write", { body: "the router at 192.168.1.1 authenticates with secret router_admin", kind: "convention" });
			expect(pointer.isError).toBe(false);
			expect(((await call(client, "memory_search", { query: "192.168.1.1" })).value.results as { id: number }[]).map((row) => row.id)).toContain(pointer.value.id as number);
			await client.close();
		} finally {
			held.dispose();
		}
	});

	it("and the store still redacts for a writer that is not a model", async () => {
		const held = tempConnectedVault();
		const store = new MemoryStore(openTestDb(), noneEmbedder());
		try {
			held.vault.put({ name: "router_admin", value: PASSWORD, kind: "password", actor: "test" });
			const { id } = await store.addMemory({ body: `admin password: ${PASSWORD}`, kind: "convention", tags: [], origin_class: "owner", session_kind: "interactive", actor: "script" });
			expect(store.memory(id)!.body).toBe("admin password: [secret:router_admin]");
		} finally {
			held.dispose();
		}
	});
});
