/**
 * The Memory tab (docs/memory.md Phase 6). What is asserted here is the page's half of the design: it is a
 * view of its own that replaces the chat; the list is the store in every status, so a superseded chain and a
 * tombstone are both visible and both undoable; "why was this injected" answers with the store's own turn
 * record — the question, what the block cost, whether the answer cited it; an edit sends one entry and comes
 * back with the audit chain it wrote; undo names the audited change rather than the old value; and a refusal
 * from the store is said in this panel. What the store does with those writes is covered in
 * tests/memory/consolidate.test.ts and tests/server/memory-server.test.ts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import App from "./App.svelte";
import type { ClientCommand, MemoryEdit, MemorySnapshot, ServerFrame } from "../src/server/protocol.ts";
import type { Transport } from "./lib/client.ts";

class FakeTransport implements Transport {
	sent: ClientCommand[] = [];
	#handlers = new Set<(signal: ServerFrame | { type: "connected" } | { type: "disconnected" }) => void>();

	on(handler: (signal: ServerFrame | { type: "connected" } | { type: "disconnected" }) => void): () => void {
		this.#handlers.add(handler);
		return () => this.#handlers.delete(handler);
	}

	send(command: ClientCommand): void {
		this.sent.push(command);
	}

	emit(signal: Parameters<Parameters<Transport["on"]>[0]>[0]): void {
		for (const handler of this.#handlers) handler(signal);
	}
}

const SNAPSHOT: MemorySnapshot = {
	memories: [
		{
			id: 3,
			kind: "convention",
			body: "we use pnpm, never npm",
			tags: ["packages"],
			status: "active",
			originClass: "owner",
			sessionKind: "interactive",
			strength: 1.5,
			useCount: 7,
			citedCount: 4,
			createdAt: "2026-09-01T09:00:00.000Z",
			lastVerifiedAt: "2026-10-01T09:00:00.000Z",
			supersedes: null,
			supersededBy: null,
			mergedFrom: [4],
			history: [
				{ id: 1, action: "create", actor: "user", reason: "", createdAt: "2026-09-01T09:00:00.000Z", preImage: "{}" },
				{
					id: 2,
					action: "verify",
					actor: "sweep",
					reason: "promotion gates: cited by three turns across three questions",
					createdAt: "2026-10-11T03:00:00.000Z",
					preImage: '{"strength":1,"status":"active"}',
				},
			],
		},
		{
			id: 4,
			kind: "convention",
			body: "we use pnpm, never npm, for every install",
			tags: [],
			status: "superseded",
			originClass: "agent",
			sessionKind: "interactive",
			strength: 1,
			useCount: 2,
			citedCount: 1,
			createdAt: "2026-09-02T09:00:00.000Z",
			lastVerifiedAt: null,
			supersedes: 3,
			supersededBy: 3,
			mergedFrom: [],
			history: [
				{ id: 3, action: "create", actor: "agent", reason: "", createdAt: "2026-09-02T09:00:00.000Z", preImage: "{}" },
				{
					id: 4,
					action: "supersede",
					actor: "sweep",
					reason: "consolidation: the same fact as #3",
					createdAt: "2026-10-11T03:00:00.000Z",
					preImage: '{"status":"active","id":4}',
				},
			],
		},
		{
			id: 5,
			kind: "note",
			body: "the deploy host is the small box",
			tags: [],
			status: "deleted",
			originClass: "owner",
			sessionKind: "interactive",
			strength: 1,
			useCount: 0,
			citedCount: 0,
			createdAt: "2026-08-01T09:00:00.000Z",
			lastVerifiedAt: null,
			supersedes: null,
			supersededBy: null,
			mergedFrom: [],
			history: [
				{ id: 5, action: "create", actor: "user", reason: "", createdAt: "2026-08-01T09:00:00.000Z", preImage: "{}" },
				{ id: 6, action: "forget", actor: "ui", reason: "deleted in the memory browser", createdAt: "2026-10-12T09:00:00.000Z", preImage: '{"status":"active"}' },
			],
		},
	],
	turns: [
		{
			id: 11,
			conversationId: "conv-1",
			createdAt: "2026-10-10T10:00:00.000Z",
			userText: "which package manager do we use?",
			retrieved: [3, 4],
			cited: [3],
			injectedTokens: 26,
		},
		{
			id: 12,
			conversationId: "conv-1",
			createdAt: "2026-10-11T10:00:00.000Z",
			userText: "and the deploy host?",
			retrieved: [3, 5],
			cited: [],
			injectedTokens: 31,
		},
	],
	wiki: [
		{
			slug: "convention",
			title: "convention",
			topicKey: "convention",
			body: "# convention\n\n## packages\n\n[#3] we use pnpm, never npm",
			claimIds: [3],
			model: null,
			generatedAt: "2026-10-11T03:05:00.000Z",
			sections: [{ heading: "packages", body: "[#3] we use pnpm, never npm", claimIds: [3] }],
		},
	],
	stats: {
		turns: 2,
		turnsShownMemories: 2,
		turnsCiting: 1,
		memoriesRetrieved: 4,
		memoriesCited: 1,
		rate: 0.5,
		indexRows: 2,
		indexStale: 0,
		embedModel: "onnx-community/embeddinggemma-2-ONNX",
	},
};

async function mount(): Promise<FakeTransport> {
	const transport = new FakeTransport();
	render(App, { props: { transport } });
	await tick();
	transport.emit({ type: "connected" });
	await tick();
	return transport;
}

/** The sidebar's memory button, then the snapshot the store answers with. */
async function openMemory(transport: FakeTransport, memory: MemorySnapshot = SNAPSHOT): Promise<void> {
	fireEvent.click(screen.getByRole("button", { name: /^memory$/i }));
	await tick();
	transport.emit({ type: "result", requestId: lastRequestId(transport, "memory"), memory });
	await tick();
}

const sent = (transport: FakeTransport, type: string) => transport.sent.filter((command) => command.type === type);
const lastRequestId = (transport: FakeTransport, type: string) =>
	(sent(transport, type).at(-1) as { requestId?: string }).requestId ?? "";
const edits = (transport: FakeTransport): MemoryEdit[] =>
	transport.sent.flatMap((command) => (command.type === "saveMemory" ? command.memories : []));

const view = () => document.querySelector('[data-role="memory-view"]');
const row = (id: number) =>
	[...document.querySelectorAll('[data-role="memory-entry"]')].find((element) => element.querySelector('[data-role="memory-body"]')?.textContent?.startsWith(`#${id} `)) as HTMLElement;
const form = () => document.querySelector('[data-role="memory-form"]') as HTMLFormElement;

async function type(name: string, value: string): Promise<void> {
	fireEvent.input(form().querySelector(`[name="${name}"]`) as HTMLInputElement, { target: { value } });
	await tick();
}

async function clickIn(scope: HTMLElement | null, role: string): Promise<void> {
	fireEvent.click((scope ?? document).querySelector(`[data-role="${role}"]`) as HTMLElement);
	await tick();
}

const text = (element: Element | null | undefined): string => (element?.textContent ?? "").replace(/\s+/g, " ").trim();

afterEach(() => {
	cleanup();
	history.replaceState(null, "", "/");
});

describe("the Memory view", () => {
	it("replaces the chat, and the address bar says so; the way back puts the chat back", async () => {
		history.replaceState(null, "", "/");
		const transport = await mount();
		expect(document.querySelector(".chat")).toBeTruthy();
		expect(location.pathname).toBe("/");

		await openMemory(transport);
		expect(document.querySelector(".chat")).toBeNull();
		expect(document.querySelector(".activity-panel")).toBeNull();
		expect(view()).toBeTruthy();
		expect(document.querySelector(".sidebar")).toBeTruthy();
		expect(location.pathname).toBe("/memory");

		fireEvent.click(screen.getByRole("button", { name: /back to chat/i }));
		await tick();
		expect(document.querySelector(".chat")).toBeTruthy();
		expect(view()).toBeNull();
		expect(location.pathname).toBe("/");
	});

	it("opens where the address bar says, and asks for the store then — once", async () => {
		history.replaceState(null, "", "/memory");
		const transport = await mount();
		expect(view()).toBeTruthy();
		expect(sent(transport, "memory")).toHaveLength(1);
	});

	it("lists every row in every status, with its counts, its origin and what a sweep did to it", async () => {
		const transport = await mount();
		await openMemory(transport);
		expect(row(3).textContent).toContain("we use pnpm, never npm");
		expect(row(3).textContent).toContain("owner");
		expect(row(3).textContent).toContain("fetched 7× · cited 4× · strength 1.50");
		expect(row(3).textContent).toContain("merged #4");
		// A superseded row is not mixed in with the live ones, and it names the row that replaced it.
		expect(row(4)).toBeUndefined();
		expect(text(document.querySelector('[data-role="superseded-memory"]'))).toContain("we use pnpm, never npm, for every install convention → #3");
		expect(text(document.querySelector('[data-role="deleted-memory"]'))).toContain("the deploy host is the small box");
		// The hit rate, in words: what recall was shown against what the answers used.
		expect(text(document.querySelector('[data-role="memory-stats"]'))).toContain("cited one in 1 — 50% of the turns that were shown something used it");
	});

	it("filters the list without asking the store again", async () => {
		const transport = await mount();
		await openMemory(transport);
		fireEvent.input(document.querySelector('[data-role="memory-search"]') as HTMLInputElement, { target: { value: "pnpm" } });
		await tick();
		expect(document.querySelectorAll('[data-role="memory-entry"]')).toHaveLength(1);
		expect(sent(transport, "memory")).toHaveLength(1);
		expect(sent(transport, "saveMemory")).toHaveLength(0);
	});

	it("answers why a memory was injected with the turn that fetched it, and what that cost", async () => {
		const transport = await mount();
		await openMemory(transport);
		await clickIn(row(3), "memory-why");
		const uses = [...document.querySelectorAll('[data-role="memory-use"]')];
		// The recall inputs, from the store's own log: the question, the token cost of the block, and whether
		// the answer cited it.
		expect(text(uses[0])).toContain("which package manager do we use? 2026-10-10 26 tokens injected cited");
		expect(text(uses[1])).toContain("and the deploy host? 2026-10-11 31 tokens injected not cited");
		await clickIn(row(3), "memory-why");
		expect(document.querySelector('[data-role="memory-why-panel"]')).toBeNull();
	});

	it("says so when a memory has never been fetched", async () => {
		const transport = await mount();
		await openMemory(transport);
		await clickIn(row(3), "memory-why");
		expect(document.querySelectorAll('[data-role="memory-use"]')).toHaveLength(2);
		const empty = structuredClone(SNAPSHOT);
		empty.turns = [];
		transport.emit({ type: "result", requestId: lastRequestId(transport, "memory"), memory: empty });
		await tick();
		// Still open: the row's own "why" did not change, only the turns the store holds did.
		expect(text(document.querySelector('[data-role="memory-unused"]'))).toContain("No recorded turn fetched it");
	});

	it("edits one row, and the audit chain that comes back is the undo", async () => {
		const transport = await mount();
		await openMemory(transport);
		await clickIn(row(3), "memory-edit");
		await type("body", "we use pnpm, never npm or yarn");
		await type("tags", "packages, installs");
		fireEvent.submit(form());
		await tick();
		expect(edits(transport)).toEqual([{ id: 3, body: "we use pnpm, never npm or yarn", kind: "convention", tags: ["packages", "installs"] }]);

		// The store's answer: the same row with one more audit entry holding the pre-image. The page never had
		// the old text, and it does not need it to offer the undo.
		const after = structuredClone(SNAPSHOT);
		after.memories[0]!.body = "we use pnpm, never npm or yarn";
		after.memories[0]!.history.push({ id: 7, action: "edit", actor: "ui", reason: "edited in the memory browser", createdAt: "2026-10-12T10:00:00.000Z", preImage: '{"body":"we use pnpm, never npm"}' });
		transport.emit({ type: "result", requestId: lastRequestId(transport, "saveMemory"), memory: after });
		await tick();
		await clickIn(row(3), "memory-why");
		const entries = [...document.querySelectorAll('[data-role="audit-entry"]')];
		// Every change is listed with its pre-image, and every one but the write has an Undo: undoing a
		// `create` would be deleting a fact, which is a delete, not an undo.
		expect(entries.map((entry) => text(entry))).toEqual([
			"create by user 2026-09-01 pre-image {}",
			"verify by sweep 2026-10-11 promotion gates: cited by three turns across three questions pre-image {\"strength\":1,\"status\":\"active\"} Undo",
			"edit by ui 2026-10-12 edited in the memory browser pre-image {\"body\":\"we use pnpm, never npm\"} Undo",
		]);
		expect([...document.querySelectorAll('[data-role="pre-image"]')].at(-1)?.textContent).toContain("we use pnpm, never npm");
	});

	it("sends one edit however many times Save is pressed", async () => {
		const transport = await mount();
		await openMemory(transport);
		await clickIn(row(3), "memory-edit");
		await type("body", "we use pnpm, never npm or yarn");
		const node = form();
		fireEvent.submit(node);
		// The form is gone the moment the write goes out; a second press on the element still in the DOM must
		// not send a second edit of a row that has already been saved.
		fireEvent.submit(node);
		await tick();
		expect(edits(transport)).toHaveLength(1);
	});

	it("refuses to save a memory with no text, and sends nothing", async () => {
		const transport = await mount();
		await openMemory(transport);
		await clickIn(row(3), "memory-edit");
		await type("body", "   ");
		fireEvent.submit(form());
		await tick();
		expect(edits(transport)).toEqual([]);
		expect(document.querySelector('[data-role="form-error"]')?.textContent).toContain("text and its kind");
	});

	it("undoes one audited change a sweep made, by its audit id", async () => {
		const transport = await mount();
		await openMemory(transport);
		await clickIn(row(3), "memory-why");
		await clickIn(document.querySelector('[data-role="memory-history"]') as HTMLElement, "memory-undo");
		// The `verify` entry is the only one of that row's two that can be undone: a `create` has no pre-image.
		expect(edits(transport)).toEqual([{ id: 3, undoAudit: 2 }]);
	});

	it("undoes a supersede from the superseded list, and restores a delete from the deleted one", async () => {
		const transport = await mount();
		await openMemory(transport);
		await clickIn(document.querySelector('[data-role="superseded-memory"]') as HTMLElement, "memory-restore");
		expect(edits(transport).at(-1)).toEqual({ id: 4, undoAudit: 4 });
		await clickIn(document.querySelector('[data-role="deleted-memory"]') as HTMLElement, "memory-restore");
		expect(edits(transport).at(-1)).toEqual({ id: 5, undoAudit: 6 });
	});

	it("deletes a row into a tombstone", async () => {
		const transport = await mount();
		await openMemory(transport);
		await clickIn(row(3), "memory-remove");
		expect(edits(transport)).toEqual([{ id: 3, remove: true }]);
	});

	it("shows what recall injected per turn, and the wiki with its #id citations", async () => {
		const transport = await mount();
		await openMemory(transport);
		const costs = [...document.querySelectorAll('[data-role="turn-cost"]')];
		expect(costs.map(text)).toEqual([
			"which package manager do we use? 2026-10-10 fetched 2 cited 1 26 tokens",
			"and the deploy host? 2026-10-11 fetched 2 cited 0 31 tokens",
		]);
		expect(text(document.querySelector('[data-role="wiki-page"]'))).toContain("convention 1 section · 1 claim · rendered 2026-10-11");
		expect(document.querySelector('[data-role="wiki-body"]')?.textContent).toContain("[#3] we use pnpm, never npm");
	});

	it("says a refusal from the store in this panel, and stops saying it when the store answers", async () => {
		const transport = await mount();
		await openMemory(transport);
		await clickIn(row(3), "memory-why");
		await clickIn(document.querySelector('[data-role="memory-history"]') as HTMLElement, "memory-undo");
		transport.emit({ type: "error", requestId: lastRequestId(transport, "saveMemory"), message: "audit #2 wrote memory #3: undo puts back what was there before a change" });
		await tick();
		expect(document.querySelector('[data-role="save-error"]')?.textContent).toContain("before a change");
		expect(row(3).textContent).toContain("we use pnpm, never npm");

		transport.emit({ type: "result", requestId: lastRequestId(transport, "memory"), memory: SNAPSHOT });
		await tick();
		expect(document.querySelector('[data-role="save-error"]')).toBeNull();
	});

	it("says an empty store is empty, in every section, rather than showing nothing at all", async () => {
		const transport = await mount();
		await openMemory(transport, { ...SNAPSHOT, memories: [], turns: [], wiki: [] });
		expect(text(document.querySelector('[data-role="no-memories"]'))).toBe("nothing remembered");
		expect(text(document.querySelector('[data-role="turn-costs"]'))).toContain("no turns recorded yet");
		expect(text(document.querySelector('[data-role="no-wiki"]'))).toContain("Nothing rendered yet");
	});

	it("names what replaced a superseded row, and says so when that row was retired too", async () => {
		const transport = await mount();
		const chain = structuredClone(SNAPSHOT);
		chain.memories = [
			{ ...SNAPSHOT.memories[0]!, tags: [] },
			{ ...SNAPSHOT.memories[1]!, id: 7, supersededBy: 3 },
			{ ...SNAPSHOT.memories[1]!, id: 8, supersededBy: 7 },
			{ ...SNAPSHOT.memories[1]!, id: 9, supersededBy: null },
		];
		await openMemory(transport, chain);
		const retired = [...document.querySelectorAll('[data-role="superseded-memory"]')];
		// #7 went to #3, which is still active. #8 went to #7, which is itself gone — the chain is said, not
		// hidden, because an undo that lands on a retired row is worth knowing about.
		expect(text(retired[0])).toContain("→ #3");
		expect(text(retired[0])).not.toContain("superseded too");
		expect(text(retired[1])).toContain("→ #7 (that row is superseded too)");
		expect(text(retired[2])).toContain("→ nothing");
		// An active row with no tags files itself without a trailing separator.
		expect(text(row(3))).toContain("convention owner");
	});

	it("offers no Restore for a row that has no delete in its history", async () => {
		const transport = await mount();
		await openMemory(transport, { ...SNAPSHOT, memories: [{ ...SNAPSHOT.memories[2]!, history: [SNAPSHOT.memories[2]!.history[0]!] }] });
		const gone = document.querySelector('[data-role="deleted-memory"]') as HTMLElement;
		expect(text(gone)).toContain("the deploy host is the small box deleted 2026-08-01");
		expect(gone.querySelector('[data-role="memory-restore"]')).toBeNull();
	});

	it("says when there is no embedding model, and counts the rows another model wrote", async () => {
		const transport = await mount();
		await openMemory(transport, { ...SNAPSHOT, stats: { ...SNAPSHOT.stats, embedModel: null, indexStale: 3 } });
		expect(text(document.querySelector('[data-role="memory-stats"]'))).toContain("2 rows have a vector — none: search is keyword-only here, 3 from another model");
	});

	it("counts a wiki page's sections and claims in the plural", async () => {
		const transport = await mount();
		await openMemory(transport, {
			...SNAPSHOT,
			wiki: [{ ...SNAPSHOT.wiki[0]!, sections: [...SNAPSHOT.wiki[0]!.sections, { heading: "deploys", body: "[#4] ship it", claimIds: [4] }], claimIds: [3, 4] }],
		});
		expect(text(document.querySelector('[data-role="wiki-page"]'))).toContain("2 sections · 2 claims · rendered 2026-10-11");
	});

	it("refuses to save a memory with no kind", async () => {
		const transport = await mount();
		await openMemory(transport);
		await clickIn(row(3), "memory-edit");
		await type("kind", "  ");
		fireEvent.submit(form());
		await tick();
		expect(edits(transport)).toEqual([]);
		expect(document.querySelector('[data-role="form-error"]')?.textContent).toContain("text and its kind");
	});

	it("closes again when the sidebar button is pressed a second time", async () => {
		const transport = await mount();
		await openMemory(transport);
		fireEvent.click(screen.getByRole("button", { name: /^memory$/i }));
		await tick();
		expect(view()).toBeNull();
		expect(document.querySelector(".chat")).toBeTruthy();
		// Reopening re-reads the store — a sweep may have merged rows while you were in the chat — and the
		// rows already on screen stay until the new snapshot arrives, so the panel never blanks.
		fireEvent.click(screen.getByRole("button", { name: /^memory$/i }));
		await tick();
		expect(row(3)).toBeTruthy();
		expect(sent(transport, "memory")).toHaveLength(2);
	});	it("says the store has not answered yet, rather than an empty list", async () => {
		const transport = await mount();
		fireEvent.click(screen.getByRole("button", { name: /^memory$/i }));
		await tick();
		expect(text(document.querySelector('[data-role="no-memories"]'))).toBe("the store has not answered yet");
	});
});
