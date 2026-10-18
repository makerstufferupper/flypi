/**
 * The wiki (docs/memory.md Phase 6): a render-only projection of the active rows. What is asserted here is
 * the two properties that make it safe to exist at all — the provenance spine is deterministic (the same
 * active set renders the same sections over the same claims, whatever the prose does), and it is never a
 * recall source, so nothing a human reads in the wiki can come back to a model as a fact.
 */
import { describe, expect, it } from "vitest";
import { WIKI_JOB, readWiki, renderWiki } from "../../src/memory/wiki.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import { startMemoryServer } from "../../src/memory/mcp.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openTestDb, wordEmbedder } from "../helpers/memory-db.ts";

type Db = import("node:sqlite").DatabaseSync;

function fresh(): { store: MemoryStore; db: Db } {
	const db = openTestDb();
	return { store: new MemoryStore(db, wordEmbedder()), db };
}

const remember = async (store: MemoryStore, kind: string, body: string, tags: string[] = []) =>
	(await store.addMemory({ kind, body, tags, origin_class: "owner", session_kind: "interactive", actor: "user" })).id;

describe("the wiki", () => {
	it("renders one page per kind, sections by tag, every claim cited by its row id", async () => {
		const { store, db } = fresh();
		const deploy = await remember(store, "Deploy targets", "the deploy host is the small box", ["home-lab"]);
		const other = await remember(store, "Deploy targets", "the deploy port is 9090", ["home-lab"]);
		const untagged = await remember(store, "deploy targets", "ssh to the small box as mats");
		const packages = await remember(store, "convention", "we use pnpm, never npm", ["packages"]);

		expect(renderWiki(store, db)).toEqual({ pages: 2, sections: 3 });
		const pages = readWiki(db);
		// `Deploy targets` and `deploy targets` are one page: the key is the kind made into a slug, so the
		// page cannot depend on how the kind happened to be capitalised.
		expect(pages.map((page) => page.slug)).toEqual(["convention", "deploy-targets"]);
		expect(pages[1]!.title).toBe("Deploy targets");
		expect(pages[1]!.sections.map((section) => section.heading)).toEqual(["general", "home-lab"]);
		expect(pages[1]!.sections[1]).toMatchObject({ claim_ids: [deploy, other], body: `[#${deploy}] the deploy host is the small box\n[#${other}] the deploy port is 9090` });
		expect(pages[1]!.claim_ids).toEqual([untagged, deploy, other]);
		expect(pages[0]!.sections[0]!.body).toContain(`[#${packages}]`);
		// The page body is the spine a reader can follow: every claim on it names its row.
		expect(pages[1]!.body).toContain(`# Deploy targets`);
		expect(pages[1]!.body).toContain(`## home-lab`);
	});

	it("renders the same active set to the same bytes, and only the active rows", async () => {
		const { store, db } = fresh();
		const kept = await remember(store, "convention", "we use pnpm, never npm", ["packages"]);
		const retired = await remember(store, "convention", "the deploy host is the small box", ["deploy"]);
		const first = renderWiki(store, db);
		const before = readWiki(db);

		// A superseded row and a deleted one leave the wiki on the next render — and neither was ever
		// rendered as a fact of its own: the page is a projection of `status = 'active'`.
		store.markSuperseded(retired, kept, "test", "the other row says it better");
		store.forget(kept, "ui", "no longer true");
		expect(renderWiki(store, db)).toEqual({ pages: 0, sections: 0 });
		expect(readWiki(db)).toEqual([]);

		// Rebuild from scratch equals the incremental render: the same rows in, the same bytes out.
		const store2 = fresh();
		await remember(store2.store, "convention", "we use pnpm, never npm", ["packages"]);
		await remember(store2.store, "convention", "the deploy host is the small box", ["deploy"]);
		renderWiki(store2.store, store2.db);
		const again = readWiki(store2.db);
		renderWiki(store2.store, store2.db);
		expect(readWiki(store2.db).map((page) => ({ ...page, generated_at: "" }))).toEqual(again.map((page) => ({ ...page, generated_at: "" })));
		// And the first store's render is reproducible too, which is the gate the plan asks for: the prose may
		// vary in a future model pass, the claims behind a section may not.
		expect(before[0]!.sections.map((section) => section.claim_ids)).toEqual([[retired], [kept]]);
		expect(first).toEqual({ pages: 1, sections: 2 });
	});

	it("is never a recall source: a wiki page does not reach the block, the search or the tools", async () => {
		const { store, db } = fresh();
		const id = await remember(store, "convention", "the registry login is flypi-registry", ["secrets-adjacent"]);
		renderWiki(store, db);
		// A sentence only the wiki holds. It is derived text, so it must be unreachable from the model.
		db.prepare("INSERT INTO wiki_pages (slug, title, topic_key, body, claim_ids, model, generated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
			"wiki-only",
			"Wiki only",
			"wiki only",
			"# Wiki only\n\n## page\n\nthe wiki says the staging token is rotate-me-every-tuesday",
			JSON.stringify([id]),
			null,
			new Date().toISOString(),
		);

		expect((await store.search({ query: "staging token rotate", count: false })).results.map((row) => row.id)).not.toContain(id);
		const server = await startMemoryServer({ store, token: "t", principal: "test" });
		const client = new Client({ name: "wiki-probe", version: "0.0.0" });
		try {
			await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}?token=${server.token}`)));
			const found = await client.callTool({ name: "memory_search", arguments: { query: "staging token rotate-me" } });
			expect(String((found.content as { text: string }[])[0]!.text)).not.toContain("rotate-me-every-tuesday");
			const read = await client.callTool({ name: "memory_read", arguments: { id } });
			expect(String((read.content as { text: string }[])[0]!.text)).not.toContain("rotate-me-every-tuesday");
		} finally {
			await client.close();
			await server.close();
		}
	});

	it("gives a kind with no letters a page anyway, and a page with no sections reads as empty", async () => {
		const { store, db } = fresh();
		const id = await remember(store, "💡", "a light kind still needs a page");
		expect(renderWiki(store, db)).toEqual({ pages: 1, sections: 1 });
		const [page] = readWiki(db);
		expect(page).toMatchObject({ slug: "untitled", title: "💡", claim_ids: [id] });

		// A page row whose sections were never written (or were cleared) is an empty page, not a crash: the
		// browser renders `page.body` and lists sections it has.
		db.prepare("DELETE FROM wiki_sections").run();
		expect(readWiki(db)[0]!.sections).toEqual([]);
	});

	it("leaves the pages it had when a render fails halfway", async () => {
		const { store, db } = fresh();
		await remember(store, "convention", "we use pnpm, never npm", ["packages"]);
		renderWiki(store, db);
		const before = readWiki(db);

		await remember(store, "convention", "the deploy host is the small box", ["deploy"]);
		const prepare = db.prepare.bind(db);
		db.prepare = ((sql: string) => {
			if (sql.startsWith("INSERT INTO wiki_pages")) throw new Error("disk full");
			return prepare(sql);
		}) as typeof db.prepare;
		expect(() => renderWiki(store, db)).toThrow("disk full");
		db.prepare = prepare as typeof db.prepare;

		// The old render is still there in full — the delete and the inserts are one transaction, so a failed
		// render cannot leave half a wiki, which is the only way this view could ever mislead a reader.
		expect(readWiki(db).map((page) => ({ ...page, generated_at: "" }))).toEqual(before.map((page) => ({ ...page, generated_at: "" })));
		expect(renderWiki(store, db)).toEqual({ pages: 1, sections: 2 });
	});

	it("is a queue kind the daemon can be asked about, and a rebuild is idempotent", () => {
		const { store, db } = fresh();
		expect(store.queueJob(WIKI_JOB).length).toBe(1);
		// Asking again brings the same row forward rather than queueing a second render.
		expect(store.queueJob(WIKI_JOB)).toEqual(store.queueJob(WIKI_JOB));
	});
});
