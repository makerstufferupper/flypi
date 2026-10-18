/**
 * The Memory tab's server side (docs/memory.md Phase 6): the store as a browser needs it — every row in
 * every status, the turns that say what recall was shown and what an answer actually cited, the wiki as it
 * was last rendered, and the hit-rate numbers.
 *
 * Two things this file is responsible for:
 *
 * - It is a **read of the store, not a search**. The browser filters what it was given, so a row a search
 *   would rank last is still listed, and a superseded chain is still traceable. `search()` would also move
 *   `use_count` for every row the page happens to look at, which would make a promotion gate count browsing.
 * - Every write it applies is one the user asked for, with the actor named `ui`. The store refuses the same
 *   call from an unattended actor (`UNATTENDED_ACTORS` in src/memory/store.ts), and nothing here can set
 *   `origin_class` — provenance has never been an argument.
 */
import type { DatabaseSync } from "node:sqlite";
import { estimateTokens, type MemoryRow, type MemoryStore } from "../memory/store.ts";
import { readWiki } from "../memory/wiki.ts";
import type { MemoryEdit, MemorySnapshot, MemoryTurnRow } from "./protocol.ts";

/** How many turns the browser shows. Enough to answer "why was this injected" for anything on screen. */
const TURN_ROWS = 50;

export interface MemoryApi {
	/** The store, the turn log, the wiki and the numbers, as they are right now. */
	snapshot(): MemorySnapshot;
	/** Edit, tombstone or undo. Returns the refreshed snapshot; a refused edit throws, and the panel shows why. */
	apply(edits: MemoryEdit[]): MemorySnapshot;
}

export function memoryApi(store: MemoryStore, db: DatabaseSync, options: { readOnly?: boolean } = {}): MemoryApi {
	const entry = (row: MemoryRow) => ({
		id: row.id,
		kind: row.kind,
		body: row.body,
		tags: row.tags,
		status: row.status,
		originClass: row.origin_class,
		sessionKind: row.session_kind,
		strength: row.strength,
		useCount: row.use_count,
		citedCount: row.cited_count,
		createdAt: row.created_at,
		lastVerifiedAt: row.last_verified_at,
		supersedes: row.supersedes,
		supersededBy: row.superseded_by,
		mergedFrom: row.merged_from,
		history: store.history(row.id).map((audit) => ({
			id: audit.id,
			action: audit.action,
			actor: audit.actor,
			reason: audit.reason ?? "",
			createdAt: audit.created_at,
			// The stored text, not a re-render: it is what the row looked like before the change, and the
			// page has no business guessing at columns it does not own.
			preImage: JSON.stringify(audit.pre_image ?? {}),
		})),
	});

	const turns = (): MemoryTurnRow[] =>
		(db
			.prepare("SELECT id, conversation_id, created_at, user_text, retrieved_json, cited_json FROM turns ORDER BY id DESC LIMIT ?")
			.all(TURN_ROWS) as unknown as {
			id: number;
			conversation_id: string;
			created_at: string;
			user_text: string;
			retrieved_json: string | null;
			cited_json: string | null;
		}[]
		).map((turn) => {
			const retrieved = turn.retrieved_json ? (JSON.parse(turn.retrieved_json) as number[]) : [];
			return {
				id: turn.id,
				conversationId: turn.conversation_id,
				createdAt: turn.created_at,
				userText: turn.user_text,
				retrieved,
				cited: turn.cited_json ? (JSON.parse(turn.cited_json) as number[]) : [],
				// What the rows shown to this turn would have cost, estimated the same way the injection budget
				// is estimated (src/memory/store.ts `estimateTokens`) — so the number on screen is the number
				// the recall budget was working against.
				injectedTokens: retrieved.reduce((total, id) => total + estimateTokens(store.memory(id)?.body ?? ""), 0),
			};
		});

	const snapshot = (): MemorySnapshot => {
		const hit = store.memoryHitRate();
		// The summary, not `indexIdentity()`: looking at the store must not queue a re-embed, and a process
		// holding the database read-only could not write the queue row it would try to make.
		const index = store.indexSummary();
		return {
			// Newest first: the browser is where you check what the agent learned *today*.
			memories: (db.prepare("SELECT id FROM memories ORDER BY id DESC").all() as unknown as { id: number }[])
				.map((row) => store.memory(row.id))
				.filter((row): row is MemoryRow => row !== undefined)
				.map(entry),
			turns: turns(),
			wiki: readWiki(db).map((page) => ({
				slug: page.slug,
				title: page.title,
				topicKey: page.topic_key,
				body: page.body,
				claimIds: page.claim_ids,
				model: page.model,
				generatedAt: page.generated_at,
				sections: page.sections.map((section) => ({ heading: section.heading, body: section.body, claimIds: section.claim_ids })),
			})),
			stats: {
				turns: hit.turns,
				turnsShownMemories: hit.turns_shown_memories,
				turnsCiting: hit.turns_citing,
				memoriesRetrieved: hit.memories_retrieved,
				memoriesCited: hit.memories_cited,
				rate: hit.rate,
				indexRows: index.rows,
				indexStale: index.stale,
				embedModel: index.expected?.model ?? null,
			},
		};
	};

	return {
		snapshot,
		apply: (edits) => {
			// A second process may read the store; only the one that owns the writer may change it. Said as a
			// sentence rather than left to SQLite, whose "attempting to write a readonly database" is not a
			// thing a reader can act on — the same rule the Secrets panel follows for a read-only vault.
			if (options.readOnly === true) {
				throw new Error("this process has the memory database open read-only — `flypi start` is the one that can change it");
			}
			for (const edit of edits) {
				// Undo first: it names the audited change to reverse, so the page never has to hold what the
				// row looked like before (that is what the audit row is for).
				if (edit.undoAudit !== undefined) {
					store.undo(edit.id, edit.undoAudit, "ui");
					continue;
				}
				if (edit.remove === true) {
					store.forget(edit.id, "ui", "deleted in the memory browser");
					continue;
				}
				if (edit.body === undefined && edit.kind === undefined && edit.tags === undefined) {
					throw new Error(`memory #${edit.id}: nothing to change`);
				}
				store.editMemory(
					edit.id,
					{
						...(edit.body === undefined ? {} : { body: edit.body }),
						...(edit.kind === undefined ? {} : { kind: edit.kind }),
						...(edit.tags === undefined ? {} : { tags: edit.tags }),
					},
					"ui",
				);
			}
			return snapshot();
		},
	};
}
