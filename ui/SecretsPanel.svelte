<script lang="ts">
	import { onMount } from "svelte";
	import type { FlypiAppState } from "./lib/app-state.svelte.ts";
	import type { SecretKind, SecretRow } from "../src/server/protocol.ts";

	let { app }: { app: FlypiAppState } = $props();

	// Asked for when this view opens — by the key button or by a URL that names it — never polled. The snapshot
	// has no value field at all (SecretsSnapshot in src/server/protocol.ts), so nothing in this file can put a
	// secret on screen by accident: a value only ever arrives through `revealSecret`, one name at a time.
	onMount(() => app.showSecrets());

	const rows = $derived(app.secrets?.secrets ?? []);
	const active = $derived(rows.filter((row) => row.status === "active"));
	const deleted = $derived(rows.filter((row) => row.status === "deleted"));
	const references = $derived(app.secrets?.references ?? []);
	const key = $derived(app.secrets?.key);
	const tooShort = $derived(app.secrets?.tooShortToRedact ?? []);
	/** A row still sealed under an older key than the keyring's current one (docs/secrets.md rotation). */
	const drifted = $derived((key?.stale ?? 0) > 0);

	// The kinds the vault's schema accepts (src/secrets/crypto.ts). The kind decides how the value is masked, and
	// for `yaml` it decides whether the value is accepted at all: the vault parses it before storing.
	const KINDS: SecretKind[] = ["password", "ssh_private_key", "ssh_public_key", "yaml", "generic"];
	/** The kinds whose value is a multi-line blob rather than one line of characters. */
	const MULTILINE: SecretKind[] = ["ssh_private_key", "ssh_public_key", "yaml"];
	/**
	 * What the value box says about itself, per kind. `password` is one kind covering an api key, a token and a
	 * password — the kind name alone reads like a login, so the field says all three. Keyed by the kind, so the
	 * compiler makes a new kind say something here.
	 */
	const HINT: Record<SecretKind, string> = {
		password: "api key, token or password — whatever the service gave you",
		ssh_private_key: "the whole key, header and footer included",
		ssh_public_key: "the one line from the .pub file — type and key together",
		yaml: "the whole document — it is stored as one value, and read back as one file",
		generic: "anything else, stored exactly as written",
	};

	/**
	 * A revealed value goes back to being a mask by itself. The page asked for it, so the page is the thing that
	 * remembers for how long — 30 seconds is a read-and-copy window, and there is no second copy of it anywhere:
	 * `app.revealed` is a field in memory that leaving the view also clears (ui/lib/app-state.svelte.ts).
	 */
	const REVEAL_MS = 30_000;
	let revealTimer: ReturnType<typeof setTimeout> | undefined;

	$effect(() => {
		const revealed = app.revealed;
		clearTimeout(revealTimer);
		if (!revealed) return;
		revealTimer = setTimeout(() => app.hideSecret(), REVEAL_MS);
	});
	onMount(() => () => clearTimeout(revealTimer));

	/**
	 * What the one modal is adding or rotating. `name` is the existing row's name when rotating — the name is the
	 * key the config files write down, so a rotated credential keeps it and a renamed one would be a second row
	 * sitting next to the old one. `meta` is the non-secret half (host, username, the path of an SSH key), typed
	 * in the same `k=v` lines the CLI's `--meta` takes (src/secrets/cli.ts).
	 */
	type Draft = { name: string | null; values: { name: string; kind: SecretKind; value: string; meta: string } };
	let draft = $state<Draft | null>(null);
	// A pasted key or kubeconfig has to be readable to be checked, so those kinds get a textarea. It shows the
	// value plainly: this modal is already the one place a value is on screen (the mask is about what the vault
	// lists, not about what is typed), so masking the typing would only hide the paste from the person doing it.
	const multiline = $derived(draft !== null && MULTILINE.includes(draft.values.kind));
	// A line this page could not read as a `name=value` pair. It is said here rather than sent to the server:
	// a frame the wire schema refuses has no requestId to answer, so the modal would just close on nothing.
	let formError = $state("");

	const newSecret = (): Draft => {
		formError = "";
		return { name: null, values: { name: "", kind: "password", value: "", meta: "" } };
	};

	const metaText = (meta: Record<string, string>): string =>
		Object.entries(meta).map(([name, value]) => `${name}=${value}`).join("\n");

	function rotate(row: SecretRow): void {
		formError = "";
		draft = {
			name: row.name,
			values: { name: row.name, kind: row.kind, value: "", meta: metaText(row.meta) },
		};
	}

	/** The textarea back into the map the wire wants. A line without `=` is the page's mistake, not the server's. */
	function metaPairs(text: string): Record<string, string> {
		const meta: Record<string, string> = {};
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			const at = line.indexOf("=");
			if (at < 1) throw new Error(`"${line}" is not a name=value pair`);
			meta[line.slice(0, at).trim()] = line.slice(at + 1).trim();
		}
		return meta;
	}

	function submit(): void {
		if (!draft) return;
		const name = draft.values.name.trim();
		const value = draft.values.value;
		if (!name || !value) {
			formError = "a name and a value are both needed — a secret with no value is only a note";
			return;
		}
		let meta: Record<string, string>;
		try {
			meta = metaPairs(draft.values.meta);
		} catch (error) {
			formError = (error as Error).message;
			return;
		}
		// One edit per frame, and the value never comes back: the ack carries the refreshed snapshot, whose rows
		// hold masks. A duplicate value is the vault's `already stored as "name"` (src/secrets/vault.ts), which
		// is why pressing Add twice is safe.
		app.saveSecrets([{ name, kind: draft.values.kind, value, meta }]);
		formError = "";
		draft = null;
	}

	/**
	 * Delete is a tombstone, so the undo is a Restore on the same name — the value was never thrown away, and
	 * this page never held it in the first place (docs/secrets.md: the same rule as memories).
	 */
	const remove = (row: SecretRow): void => app.saveSecrets([{ name: row.name, remove: true }]);
	const restore = (row: SecretRow): void => app.saveSecrets([{ name: row.name, restore: true }]);

	/** Only a revealed value can be copied: copying is what the reveal is for. */
	function copyRevealed(): void {
		const revealed = app.revealed;
		if (revealed) void navigator.clipboard?.writeText(revealed.value);
	}

	/**
	 * The modal is a real `<dialog>`: Escape closes it, focus stays inside it, and the page behind is inert —
	 * all of which the element does and a `<div>` would have to be given. Svelte decides whether it exists
	 * (`draft`), so all this action has to do is put it on screen while it does.
	 */
	function modal(node: HTMLDialogElement): { destroy: () => void } {
		node.showModal();
		return { destroy: () => node.close() };
	}

	const uses = (row: SecretRow): string =>
		row.useCount === 0 ? "never used" : `used ${row.useCount}×${row.lastUsedAt ? `, last ${row.lastUsedAt.slice(0, 10)}` : ""}`;
</script>

{#snippet editGlyph()}
	<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L20 8l-4-4L4 16v4Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" /><path d="M14.2 5.8 18.2 9.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
{/snippet}
{#snippet eyeGlyph()}
	<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" /><circle cx="12" cy="12" r="2.6" fill="none" stroke="currentColor" stroke-width="1.8" /></svg>
{/snippet}
{#snippet removeGlyph()}
	<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4.5h6V7M6.5 7l.8 12.5h9.4L17.5 7M10.2 10.5v6m3.6-6v6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
{/snippet}

<!-- `settings-view` is the layout hook both config views share in app.css (a full-width panel that replaces
	 the chat and the activity column) — the vault is the agent's own configuration, not this conversation. -->
<section class="settings-view" aria-label="Secrets" data-role="secrets-view">
	<header class="panel-head">
		<h2>Secrets</h2>
		<!-- The way back, spelled out rather than left to the key in the sidebar — and the address bar follows it,
			 because the page's view is mirrored into the URL (App.svelte, ui/lib/route.ts). Leaving here is also
			 where a revealed value stops existing. -->
		<button type="button" data-role="back-to-chat" onclick={() => app.openChat()}>Back to chat</button>
	</header>

	{#if app.secretsError}
		<!-- The vault refused a write (a name it cannot use, a value already stored under another name) or could
			 not be opened at all. Nothing on disk changed, so the refusal has to be said here: a list that still
			 shows the old rows reads as a save that worked. -->
		<ul class="cfg-errors" role="alert" data-role="save-error">
			<li class="error">{app.secretsError}</li>
		</ul>
	{/if}

	<div class="cfg-stack">
		<section>
			<div class="cfg-section">
				<h3>The vault</h3>
				<button type="button" data-role="secret-add" onclick={() => (draft = newSecret())}>Add secret</button>
			</div>
			<p class="cfg-note" data-role="key-state">
				<!-- Where the key that unlocks this table lives, in the panel's words: a backup of the DB without
					 this file is a table of ciphertext. -->
				sealed with {key?.provider === "keyfile" ? "a keyring file" : `the ${key?.provider ?? "unknown"} key provider`}
				{#if key?.provider === "keyfile"}(<code>.flypi/secret.key</code>, mode 0600){/if},
				key v{key?.currentVersion ?? "?"} · {key?.rows ?? 0} rows.
				{#if drifted}
					<!-- Rotation is not a silent full-table rewrite: the rows are re-sealed as they are used, through
						 the scheduler's `secrets.reencrypt` job (docs/secrets.md). -->
					<b>{key?.stale} {key?.stale === 1 ? "row is" : "rows are"}</b> still sealed under an older key —
					{key?.reencryptQueued ? "a re-encrypt is queued" : "they are re-sealed the next time each is used"}.
				{/if}
			</p>
			<p class="cfg-note">
				Values are stored sealed (AES-256-GCM per row) and are never shown here unless asked for. The agent
				uses them through <code>secret_env</code> / <code>secret_file</code> and never sees them in its
				environment; anything it prints comes back with <code>[secret:NAME]</code> in place of the value
				(docs/secrets.md). Only the process holding the vault's write lock — <code>flypi start</code> — takes a
				new value: a second one (a <code>serve</code> or the dev server) reads and redacts, and says so here if
				a write is refused.
			</p>

			<ul class="cfg-list" data-role="secrets">
				{#each active as row (row.id)}
					<li data-role="secret" title={`stored ${row.createdAt.slice(0, 10)} · fingerprint ${row.fingerprint.slice(0, 12)}`}>
						<button type="button" class="cfg-name" data-role="secret-name" onclick={() => rotate(row)}>{row.name}</button>
						{#if app.revealed?.name === row.name}
							<!-- The only plaintext this page can show, and only because it was asked for by name. -->
							<code class="revealed" data-role="revealed-value">{app.revealed.value}</code>
							<button type="button" data-role="secret-copy" onclick={() => copyRevealed()}>Copy</button>
							<button type="button" data-role="secret-hide" onclick={() => app.hideSecret()}>Hide</button>
						{:else}
							<code>{row.mask}</code>
							<button
								type="button"
								class="icon"
								data-role="secret-reveal"
								aria-label="Reveal {row.name}"
								title="Show this value here for a few seconds; the vault records that it was revealed"
								onclick={() => app.revealSecret(row.name)}
							>
								{@render eyeGlyph()}
							</button>
						{/if}
						<span class="cfg-state">{row.kind}</span>
						<span class="cfg-state">{uses(row)}</span>
						{#if key && row.keyVersion !== key.currentVersion}
							<!-- The row is readable but sealed under an older key: the drift the docs make visible
								 rather than fixing silently on start. -->
							<span class="cfg-state failed" data-role="key-drift">sealed under key v{row.keyVersion}</span>
						{/if}
						{#if Object.keys(row.meta).length}
							<span class="cfg-state" data-role="secret-meta">{metaText(row.meta).replace(/\n/g, " ")}</span>
						{/if}
						<button type="button" class="icon" data-role="secret-edit" aria-label="Rotate {row.name}" title="Store a new value under this name" onclick={() => rotate(row)}>
							{@render editGlyph()}
						</button>
						<button type="button" class="icon remove" data-role="secret-remove" aria-label="Delete {row.name}" title="Delete this secret" onclick={() => remove(row)}>
							{@render removeGlyph()}
						</button>
					</li>
				{:else}
					<li class="cfg-none" data-role="no-secrets">{app.secrets ? "none stored" : "the vault has not answered yet"}</li>
				{/each}
			</ul>

			{#if tooShort.length}
				<!-- The gap in the redaction, said rather than hidden: a value this short is not matched in a
					 transcript or a memory, so these names are stored but unprotected where the model repeats them. -->
				<p class="cfg-note" data-role="short-warning">
					{tooShort.join(", ")} {tooShort.length === 1 ? "is" : "are"} shorter than the redaction floor, so a
					transcript or a memory that repeats {tooShort.length === 1 ? "it" : "them"} will not be rewritten.
				</p>
			{/if}

			<p class="cfg-note" data-role="stream-caveat">
				The live answer is redacted as it streams, which means a value is masked once its last piece has
				arrived: the part of it still on its way can be on screen for a moment. That is the one place a
				secret may briefly appear — the session file, the transcript table and any memory of the turn hold
				<code>[secret:NAME]</code>.
			</p>

			{#if deleted.length}
				<!-- A credential is never deleted quietly: the row stays as a tombstone so it can tell you it went,
					 which is also what makes undo possible without this page ever having held the value. -->
				<div class="cfg-section"><h3>Deleted</h3></div>
				<ul class="cfg-list" data-role="deleted-secrets">
					{#each deleted as row (row.id)}
						<li data-role="deleted-secret">
							<span class="cfg-name">{row.name}</span>
							<code>{row.mask}</code>
							<span class="cfg-state">deleted {row.createdAt.slice(0, 10)}</span>
							<button type="button" data-role="secret-restore" onclick={() => restore(row)}>Restore</button>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<section>
			<div class="cfg-section"><h3>Used by</h3></div>
			<p class="cfg-note">
				<code>auth.json</code> and <code>mcp.json</code> point at a name with
				<code>{"!flypi secret print NAME"}</code>; pi runs that command once per process, so a rotated value
				takes effect after <code>flypi restart</code>. A secret listed here as used N× says how often it was
				read, not by which conversation — the vault keeps the audit rows, this page does not list them.
			</p>
			<ul class="cfg-list" data-role="references">
				{#each references as reference (`${reference.file} ${reference.path}`)}
					<li data-role="reference">
						<code>{reference.file} · {reference.path}</code>
						<span class="cfg-state">→</span>
						<span class="cfg-name">{reference.name}</span>
					</li>
				{:else}
					<!-- Not "none": a name nobody points at is normal — most credentials are used by the agent's own
						 tools, not by a config file. -->
					<li class="cfg-none">no <code>auth.json</code> or <code>mcp.json</code> entry names a secret</li>
				{/each}
			</ul>
		</section>
	</div>

	{#if draft}
		<!-- One modal, two jobs: a new name, or a new value under a name that exists. The name is fixed while
			 rotating because the config files reference it — editing it would leave the old row behind. -->
		<dialog class="cfg-modal" use:modal>
			<form class="secret-form" data-role="secret-form" onsubmit={(event) => { event.preventDefault(); submit(); }}>
				<div class="cfg-section">
					<h3>{draft.name === null ? "Add a secret" : `Rotate ${draft.name}`}</h3>
					<button type="button" onclick={() => (draft = null)}>Cancel</button>
				</div>
				<div class="cfg-inline">
					<label class="field">
						Name
						<input
							name="name"
							bind:value={draft.values.name}
							disabled={draft.name !== null}
							data-role="form-name"
							placeholder="lowercase, dots, dashes — the handle config files will name"
							autocomplete="off"
						/>
					</label>
					<label class="field">
						Kind
						<select name="kind" bind:value={draft.values.kind} data-role="form-kind">
							{#each KINDS as kind}<option value={kind}>{kind}</option>{/each}
						</select>
					</label>
				</div>
				<label class="field">
					Value
					{#if multiline}
						<textarea
							name="value"
							rows="10"
							bind:value={draft.values.value}
							data-role="form-value"
							spellcheck="false"
							placeholder={HINT[draft.values.kind]}
						></textarea>
					{:else}
						<!-- A password field, because this is the one place the value is visible: the mask is about what
							 is stored and listed, not about typing. It is never read back out of the vault into here. -->
						<input name="value" type="password" bind:value={draft.values.value} data-role="form-value" autocomplete="new-password" placeholder={HINT[draft.values.kind]} />
					{/if}
				</label>
				<label class="field">
					Notes<textarea name="meta" rows="3" bind:value={draft.values.meta} data-role="form-meta" placeholder={"host=192.168.1.1\nusername=admin"}></textarea>
				</label>
				<p class="cfg-note">
					Non-secret notes only — host, port, username, the path of an SSH key. The same
					<code>{"--meta k=v"}</code> the CLI takes. Notes written here are stored with the row; changing
					them on an existing secret means storing its value again, because this page cannot read it back.
				</p>
				{#if formError}
					<!-- Nothing was sent, so the reason belongs in the modal: a line this page could not read is the
						 page's mistake, not the vault's, and nothing on disk changed either way. -->
					<p class="error" role="alert" data-role="form-error">{formError}</p>
				{/if}
				<div class="cfg-actions"><button type="submit">{draft.name === null ? "Store secret" : "Rotate secret"}</button></div>
			</form>
		</dialog>
	{/if}
</section>

<style>
	/* The revealed value is the one thing on this page worth reading, so it is not muted like a mask. */
	.revealed { color: var(--ink); }
</style>
