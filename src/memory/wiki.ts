/**
 * The wiki (docs/memory.md Phase 6): a **render-only projection** of the `active` rows.
 *
 * It exists so a human can read what the store has learned, and so duplication is *visible* — two near
 * copies of a fact sit next to each other on one page in a way they never are in a search result. It is not
 * a second source of truth and never becomes one: recall keeps reading `memories`, nothing reads these
 * tables back as a fact, and the whole thing is rebuildable from scratch at any time. There is no editing,
 * no managed blocks and no human-note region — a view has nothing editable, and that is a decision, not a
 * deferral.
 *
 * A page is *a query plus a template*: one page per `kind` (the `topic_key`), sections clustered by the
 * row's first tag, and the provenance spine (`#id` citations) emitted by **code**. The model never decides
 * which claims back a section, which is what makes the spine byte-identical for the same active set — and
 * in this build the model writes no wiki prose at all, so the whole render is deterministic and costs
 * nothing. `wiki_pages.model` is null for that reason, and is where a future prose pass would name itself.
 *
 * It runs as a job after a consolidation sweep (src/daemon/index.ts), not on every write.
 */
import type { DatabaseSync } from "node:sqlite";
import type { MemoryRow, MemoryStore } from "./store.ts";

export const WIKI_JOB = "wiki.render";

export interface WikiSection {
	heading: string;
	body: string;
	claim_ids: number[];
}

export interface WikiPage {
	slug: string;
	title: string;
	topic_key: string;
	body: string;
	claim_ids: number[];
	model: string | null;
	generated_at: string;
	sections: WikiSection[];
}

/** `kind` is free-form text, so the page key is the kind made into a slug. Two kinds that slug the same
 *  way are one page — which is also what makes the primary key impossible to collide. */
const slugOf = (kind: string): string => kind.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "untitled";

/** The heading a claim files under: its first tag, or `general` for an untagged row. */
const headingOf = (row: MemoryRow): string => row.tags[0] ?? "general";

/** One claim, cited by its row id: the spine a reader can follow back to the memory itself. */
const claim = (row: MemoryRow): string => `[#${row.id}] ${row.body}`;

/**
 * Rebuild every page from the active rows. Drop-then-insert inside one transaction, so a render that throws
 * halfway leaves the previous pages rather than half a wiki.
 */
export function renderWiki(store: MemoryStore, db: DatabaseSync): { pages: number; sections: number } {
	const generatedAt = new Date().toISOString();
	const byTopic = new Map<string, { title: string; rows: MemoryRow[] }>();
	for (const row of store.activeMemories()) {
		const slug = slugOf(row.kind);
		const page = byTopic.get(slug);
		// The title is the kind as it was actually written, taken from the oldest row on the page: `kind` is
		// free-form, and "Deploy targets" and "deploy targets" are one page whose title should not depend on
		// which row happened to be inserted first.
		if (!page) byTopic.set(slug, { title: row.kind, rows: [row] });
		else page.rows.push(row);
	}

	db.exec("BEGIN");
	try {
		db.prepare("DELETE FROM wiki_sections").run();
		db.prepare("DELETE FROM wiki_pages").run();
		const pages = db.prepare("INSERT INTO wiki_pages (slug, title, topic_key, body, claim_ids, model, generated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
		const sections = db.prepare("INSERT INTO wiki_sections (slug, heading, body, claim_ids, generated_at) VALUES (?, ?, ?, ?, ?)");
		let pageRows = 0;
		let sectionRows = 0;
		for (const [slug, page] of [...byTopic.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
			const byHeading = new Map<string, MemoryRow[]>();
			for (const row of page.rows) {
				const heading = headingOf(row);
				byHeading.set(heading, [...(byHeading.get(heading) ?? []), row]);
			}
			const rendered = [...byHeading.entries()]
				.sort((a, b) => (a[0] < b[0] ? -1 : 1))
				.map(([heading, rows]) => {
					const ordered = rows.sort((a, b) => a.id - b.id);
					return { heading, body: ordered.map(claim).join("\n"), claim_ids: ordered.map((row) => row.id) };
				});
			const body = [`# ${page.title}`, "", ...rendered.flatMap((section) => [`## ${section.heading}`, "", section.body, ""])].join("\n").trimEnd();
			const claimIds = rendered.flatMap((section) => section.claim_ids);
			pages.run(slug, page.title, page.rows[0]!.kind, body, JSON.stringify(claimIds), null, generatedAt);
			for (const section of rendered) {
				sections.run(slug, section.heading, section.body, JSON.stringify(section.claim_ids), generatedAt);
				sectionRows += 1;
			}
			pageRows += 1;
		}
		db.exec("COMMIT");
		return { pages: pageRows, sections: sectionRows };
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

/** What the memory browser shows: every page with its sections, spine included. */
export function readWiki(db: DatabaseSync): WikiPage[] {
	const pages = db.prepare("SELECT slug, title, topic_key, body, claim_ids, model, generated_at FROM wiki_pages ORDER BY slug").all() as unknown as {
		slug: string;
		title: string;
		topic_key: string;
		body: string;
		claim_ids: string;
		model: string | null;
		generated_at: string;
	}[];
	const sections = db.prepare("SELECT slug, heading, body, claim_ids, generated_at FROM wiki_sections ORDER BY slug, heading, id").all() as unknown as {
		slug: string;
		heading: string;
		body: string;
		claim_ids: string;
		generated_at: string;
	}[];
	const bySlug = new Map<string, WikiSection[]>();
	for (const section of sections) {
		bySlug.set(section.slug, [
			...(bySlug.get(section.slug) ?? []),
			{ heading: section.heading, body: section.body, claim_ids: JSON.parse(section.claim_ids) as number[] },
		]);
	}
	return pages.map((page) => ({
		slug: page.slug,
		title: page.title,
		topic_key: page.topic_key,
		body: page.body,
		claim_ids: JSON.parse(page.claim_ids) as number[],
		model: page.model,
		generated_at: page.generated_at,
		sections: bySlug.get(page.slug) ?? [],
	}));
}
