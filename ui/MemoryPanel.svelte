<script lang="ts">
	import { onMount } from "svelte";
	import type { FlypiAppState } from "./lib/app-state.svelte.ts";
	import type { MemoryEntryRow, MemoryTurnRow } from "../src/server/protocol.ts";

	let { app }: { app: FlypiAppState } = $props();

	// Asked for when this view opens — by the sidebar button or by a URL that names it — never polled, the same
	// way the vault and the scheduler are (docs/memory.md Phase 6). The snapshot is a read of the store, not a
	// search: every row comes back in every status, so a superseded chain and a tombstone are both here.
	onMount(() => app.showMemories());

	const rows = $derived(app.memories?.memories ?? []);
	const turns = $derived(app.memories?.turns ?? []);
	const wiki = $derived(app.memories?.wiki ?? []);
	const stats = $derived(app.memories?.stats);
	const active = $derived(rows.filter((row) => row.status === "active"));
	const superseded = $derived(rows.filter((row) => row.status === "superseded"));
	const deleted = $derived(rows.filter((row) => row.status === "deleted"));

	// The filter is over what the snapshot already holds: the browser is a human tool over a store of hundreds
	// of rows, and asking the store would move `use_count` for every row the page happened to look at — which
	// is the number the promotion gates read.
	let query = $state("");
	const matches = (row: MemoryEntryRow): boolean => {
		const needle = query.trim().toLowerCase();
		if (!needle) return true;
		return `${row.body} ${row.kind} ${row.tags.join(" ")} #${row.id}`.toLowerCase().includes(needle);
	};
	const shown = $derived(active.filter(matches));
	const retired = $derived(superseded.filter(matches));
	const gone = $derived(deleted.filter(matches));

	/** Which rows a merge absorbed, for the survivor's row. */
	const rowById = $derived(new Map(rows.map((row) => [row.id, row])));

	/**
	 * "Why was this injected" — the turns recall fetched it for, in the store's own record: the question that
	 * fetched it, what the block cost that turn, and whether the answer actually cited it. That is the recall
	 * input, not a guess at it, and the token figure is the same estimate the injection budget used.
	 */
	const shownIn = (id: number): MemoryTurnRow[] => turns.filter((turn) => turn.retrieved.includes(id));
	let expanded = $state<Set<number>>(new Set());
	function toggleWhy(id: number): void {
		const next = new Set(expanded);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		expanded = next;
	}

	/** The one modal: editing a row's text, kind or tags. Provenance is not in it — `origin_class` is code's,
	 *  never an argument (docs/memory.md Phase 4), so the page cannot promote its own fact to the user's words. */
	type Draft = { id: number; values: { body: string; kind: string; tags: string } };
	let draft = $state<Draft | null>(null);
	let formError = $state("");

	function edit(row: MemoryEntryRow): void {
		formError = "";
		draft = { id: row.id, values: { body: row.body, kind: row.kind, tags: row.tags.join(", ") } };
	}

	function submit(): void {
		if (!draft) return;
		const body = draft.values.body.trim();
		const kind = draft.values.kind.trim();
		if (!body || !kind) {
			formError = "a memory needs its text and its kind — an empty row is a fact nobody can retrieve";
			return;
		}
		app.saveMemories([
			{
				id: draft.id,
				body,
				kind,
				tags: draft.values.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
			},
		]);
		formError = "";
		draft = null;
	}

	/** Delete is a tombstone, and the undo is the audit row it wrote — the same shape as the vault's Restore. */
	const remove = (row: MemoryEntryRow): void => app.saveMemories([{ id: row.id, remove: true }]);
	const forgetEntry = (row: MemoryEntryRow) => row.history.filter((entry) => entry.action === "forget").at(-1);
	const undoDelete = (row: MemoryEntryRow): void => {
		const entry = forgetEntry(row);
		if (entry) app.saveMemories([{ id: row.id, undoAudit: entry.id }]);
	};
	/** Undo anything a sweep did — a merge, a promotion, an edit — one audited change at a time. */
	const undo = (row: MemoryEntryRow, auditId: number): void => app.saveMemories([{ id: row.id, undoAudit: auditId }]);

	/** A `<dialog>`, as the settings and Secrets modals do: Escape closes it, focus stays inside it. */
	function modal(node: HTMLDialogElement): { destroy: () => void } {
		node.showModal();
		return { destroy: () => node.close() };
	}

	const day = (iso: string): string => iso.slice(0, 10);
	/** A row as it is named everywhere on this page: its id first, so a `#id` in the wiki or a turn log can be
	 *  found by eye in the list. Same spine as the wiki's own `#id` citations. */
	const claim = (row: MemoryEntryRow): string => `#${row.id} ${row.body}`;
	/** How a row is filed: its kind, and its tags when it has any. */
	const filed = (row: MemoryEntryRow): string => (row.tags.length ? `${row.kind} · ${row.tags.join(", ")}` : row.kind);
	const counts = (row: MemoryEntryRow): string =>
		`fetched ${row.useCount}× · cited ${row.citedCount}× · strength ${row.strength.toFixed(2)}`;
</script>

{#snippet editGlyph()}
	<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L20 8l-4-4L4 16v4Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" /><path d="M14.2 5.8 18.2 9.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
{/snippet}
{#snippet removeGlyph()}
	<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4.5h6V7M6.5 7l.8 12.5h9.4L17.5 7M10.2 10.5v6m3.6-6v6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
{/snippet}

<section class="settings-view" aria-label="Memory" data-role="memory-view">
	<header class="panel-head">
		<h2>Memory</h2>
		<button type="button" data-role="back-to-chat" onclick={() => app.openChat()}>Back to chat</button>
	</header>

	{#if app.memoryError}
		<!-- The store refused an edit, or this process has no memory database. Nothing changed, so the refusal
			 has to be said here: a list that still shows the old rows reads as a save that worked. -->
		<ul class="cfg-errors" role="alert" data-role="save-error">
			<li class="error">{app.memoryError}</li>
		</ul>
	{/if}

	<div class="cfg-stack">
		<section>
			<div class="cfg-section">
				<h3>The store</h3>
				<input class="search" data-role="memory-search" bind:value={query} placeholder="filter by text, kind, tag or #id" aria-label="Filter memories" />
			</div>
			<p class="cfg-note" data-role="memory-stats">
				{rows.length} rows · {active.length} active.
				{#if stats}
					Recall was shown a memory in {stats.turnsShownMemories} of {stats.turns} turns, and the answer
					cited one in {stats.turnsCiting} — <b>{Math.round(stats.rate * 100)}%</b> of the turns that were
					shown something used it.
					{stats.indexRows} rows have a vector{stats.embedModel ? ` (${stats.embedModel})` : " — none: search is keyword-only here"}{#if stats.indexStale}, {stats.indexStale} from another model{/if}.
				{/if}
			</p>
			<p class="cfg-note">
				Nothing here is deleted automatically: a consolidation sweep may merge and supersede, and
				<code>deleted</code> takes a click on this page. Every change carries its pre-image, so each row of
				the history below can be undone on its own.
			</p>

			<ul class="cfg-list" data-role="memory-list">
				{#each shown as row (row.id)}
					<li class="memory-row" data-role="memory-entry">
						<code class="memory-body" data-role="memory-body">{claim(row)}</code>
						<span class="cfg-state">{filed(row)}</span>
						<span class="cfg-state">{row.originClass}</span>
						<span class="cfg-state" title="How often recall fetched it, how often an answer cited it, and its rank weight">
							{counts(row)}
						</span>
						{#if row.mergedFrom.length}
							<!-- The merge is visible, not implied: these are the rows that were folded into this
								 one, and their citations came with them. -->
							<span class="cfg-state" data-role="merged-from">merged {row.mergedFrom.map((id) => `#${id}`).join(" ")}</span>
						{/if}
						<button type="button" data-role="memory-why" onclick={() => toggleWhy(row.id)}>
							{expanded.has(row.id) ? "Hide why" : "Why was this injected?"}
						</button>
						<button type="button" class="icon" data-role="memory-edit" aria-label="Edit memory {row.id}" title="Edit this memory" onclick={() => edit(row)}>
							{@render editGlyph()}
						</button>
						<button type="button" class="icon remove" data-role="memory-remove" aria-label="Delete memory {row.id}" title="Delete this memory (undoable)" onclick={() => remove(row)}>
							{@render removeGlyph()}
						</button>
						{#if expanded.has(row.id)}
							<div class="memory-why" data-role="memory-why-panel">
								{#if shownIn(row.id).length}
									<!-- The recall inputs, from the store's own turn log: the question that fetched
										 it, what the block cost that turn, and whether the answer cited it. -->
									<ul class="memory-uses" data-role="memory-uses">
										{#each shownIn(row.id) as turn (turn.id)}
											<li data-role="memory-use">
												<q>{turn.userText}</q>
												<span class="cfg-state">{day(turn.createdAt)}</span>
												<span class="cfg-state">{turn.injectedTokens} tokens injected</span>
												<span class="cfg-state {turn.cited.includes(row.id) ? "connected" : ""}">
													{turn.cited.includes(row.id) ? "cited" : "not cited"}
												</span>
											</li>
										{/each}
									</ul>
								{:else}
									<p class="cfg-note" data-role="memory-unused">
										No recorded turn fetched it — it has never been injected in the turns this
										store still holds.
									</p>
								{/if}
								<ul class="memory-history" data-role="memory-history">
									{#each row.history as entry (entry.id)}
										<li data-role="audit-entry">
											<span class="cfg-state">{entry.action} by {entry.actor}</span>
											<span class="cfg-state">{day(entry.createdAt)}</span>
											{#if entry.reason}<span class="cfg-state">{entry.reason}</span>{/if}
											<details class="preimage">
												<summary>pre-image</summary>
												<pre class="memory-block" data-role="pre-image">{entry.preImage}</pre>
											</details>
											{#if entry.action !== "create"}
												<!-- One change, one undo: the pre-image is what the row looked like
													 before that change, and nothing else moves. -->
												<button type="button" data-role="memory-undo" onclick={() => undo(row, entry.id)}>Undo</button>
											{/if}
										</li>
									{/each}
								</ul>
							</div>
						{/if}
					</li>
				{:else}
					<li class="cfg-none" data-role="no-memories">{app.memories ? "nothing remembered" : "the store has not answered yet"}</li>
				{/each}
			</ul>

			{#if retired.length}
				<div class="cfg-section"><h3>Superseded</h3></div>
				<p class="cfg-note">
					A merge or a correction retires a row; it never removes it. These are the copies the sweep
					folded away, each with the pre-image it had when it went and an undo that puts it back.
				</p>
				<ul class="cfg-list" data-role="superseded-list">
					{#each retired as row (row.id)}
						<li data-role="superseded-memory">
							<code class="memory-body">{claim(row)}</code>
							<span class="cfg-state">{row.kind}</span>
							<span class="cfg-state">
								→ {row.supersededBy ? `#${row.supersededBy}` : "nothing"}
								{#if row.supersededBy && rowById.get(row.supersededBy)?.status === "superseded"}(that row is superseded too){/if}
							</span>
							{#each row.history.filter((entry) => entry.action === "supersede") as entry (entry.id)}
								<button type="button" data-role="memory-restore" onclick={() => undo(row, entry.id)}>Undo</button>
							{/each}
						</li>
					{/each}
				</ul>
			{/if}

			{#if gone.length}
				<div class="cfg-section"><h3>Deleted</h3></div>
				<ul class="cfg-list" data-role="deleted-list">
					{#each gone as row (row.id)}
						<li data-role="deleted-memory">
							<code class="memory-body">{claim(row)}</code>
							<span class="cfg-state">deleted {day(row.createdAt)}</span>
							{#if forgetEntry(row)}
								<button type="button" data-role="memory-restore" onclick={() => undoDelete(row)}>Restore</button>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<section>
			<div class="cfg-section"><h3>What recall injected, per turn</h3></div>
			<p class="cfg-note">
				The question, how many rows it fetched, how many the answer cited, and what those rows would have
				cost in prompt tokens — the same estimate the injection budget works against, so a turn that was
				shown too much is visible as a number.
			</p>
			<ul class="cfg-list" data-role="turn-costs">
				{#each turns as turn (turn.id)}
					<li data-role="turn-cost">
						<code class="memory-body">{turn.userText}</code>
						<span class="cfg-state">{day(turn.createdAt)}</span>
						<span class="cfg-state">fetched {turn.retrieved.length}</span>
						<span class="cfg-state">cited {turn.cited.length}</span>
						<span class="cfg-state">{turn.injectedTokens} tokens</span>
					</li>
				{:else}
					<li class="cfg-none">no turns recorded yet</li>
				{/each}
			</ul>
		</section>

		<section>
			<div class="cfg-section"><h3>The wiki</h3></div>
			<p class="cfg-note">
				A render of the active rows — one page per kind, sections by tag, every claim cited as
				<code>#id</code>. It is a view, not a second memory: nothing is injected from it, nothing here is
				editable, and it is rebuilt whole after a consolidation sweep.
			</p>
			{#each wiki as page (page.slug)}
				<div class="wiki-page" data-role="wiki-page">
					<h4>{page.title}</h4>
					<p class="cfg-note">
						{page.sections.length} section{page.sections.length === 1 ? "" : "s"} · {page.claimIds.length}
						claim{page.claimIds.length === 1 ? "" : "s"} · rendered {day(page.generatedAt)}
					</p>
					<pre class="memory-block" data-role="wiki-body">{page.body}</pre>
				</div>
			{:else}
				<p class="cfg-note" data-role="no-wiki">
					Nothing rendered yet — the wiki is rebuilt after a consolidation sweep, which runs when the
					daemon is idle.
				</p>
			{/each}
		</section>
	</div>

	{#if draft}
		<dialog class="cfg-modal" use:modal>
			<form class="memory-form" data-role="memory-form" onsubmit={(event) => { event.preventDefault(); submit(); }}>
				<div class="cfg-section">
					<h3>Edit #{draft.id}</h3>
					<button type="button" onclick={() => (draft = null)}>Cancel</button>
				</div>
				<label class="field">
					Text
					<textarea name="body" rows="5" bind:value={draft.values.body} data-role="form-body" spellcheck="false"></textarea>
				</label>
				<div class="cfg-inline">
					<label class="field">
						Kind
						<input name="kind" bind:value={draft.values.kind} data-role="form-kind" />
					</label>
					<label class="field">
						Tags
						<input name="tags" bind:value={draft.values.tags} data-role="form-tags" placeholder="comma, separated" />
					</label>
				</div>
				<p class="cfg-note">
					What the row says, and how it is filed. Where the fact came from — the user's own words or the
					agent's — is set by the code that wrote it and is not editable here, because a body claiming
					"the user said so" carries no authority (docs/memory.md).
				</p>
				{#if formError}
					<p class="error" role="alert" data-role="form-error">{formError}</p>
				{/if}
				<div class="cfg-actions"><button type="submit">Save memory</button></div>
			</form>
		</dialog>
	{/if}
</section>

<style>
	/* A memory's text is the point of the row, so it takes the line and wraps; the metadata sits under it. */
	.memory-body { flex-basis: 100%; color: var(--ink); }
	.memory-row { align-items: flex-start; }
	.memory-why, .memory-history, .memory-uses { width: 100%; display: grid; gap: 0.25rem; margin: 0.3rem 0 0; padding: 0; list-style: none; }
	.memory-why li, .memory-history li { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; }
	.search { font: inherit; padding: 0.2rem 0.3rem; background: var(--panel); color: var(--ink); border: 1px solid var(--line); border-radius: 4px; }
	.preimage summary { font-size: 11px; color: var(--muted); cursor: pointer; }
	.preimage pre { max-height: 12rem; }
	.wiki-page h4 { margin: 0.8rem 0 0.2rem; font-size: 13px; }
</style>
