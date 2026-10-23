<script lang="ts">
	import { onMount } from "svelte";
	import type { FlypiAppState } from "./lib/app-state.svelte.ts";
	import type { EndpointEdit, EndpointRow, McpEdit, McpExposure, McpRow, McpStatusRow, PackageRow } from "../src/server/protocol.ts";

	let { app }: { app: FlypiAppState } = $props();

	// Asked for when this view opens, by the gear or by a URL that names it — never polled. A command sent
	// before the socket is up is queued by it (ui/lib/client.ts), so a page that loads straight into
	// settings still gets its files. The servers are asked at the same moment: the panel shows what they
	// answer, and asking is a thing that takes seconds, so it happens once per visit rather than on a timer.
	onMount(() => {
		app.showConfig();
		app.checkMcp();
		app.showPackages();
		app.showPiVersions();
	});

	const endpoints = $derived(app.config?.endpoints ?? []);
	const servers = $derived(app.config?.mcpServers ?? []);
	const packages = $derived(app.packages?.packages ?? []);
	/**
	 * One stamp for both checks. The daemon writes `pi-check.json` and `package-check.json` in the same daily
	 * pass (src/daemon/index.ts `updatePass`), so they are the same moment; either one alone answers when the
	 * other was never asked.
	 */
	const lastChecked = $derived(app.piVersions?.checkedAt ?? app.packages?.checkedAt);
	/** The source to install, typed in: `npm:…`, a git URL or a path. pi's own forms, unvalidated here. */
	let newPackage = $state("");
	/** The pi version whose switch has been asked for and not yet confirmed. */
	let confirmingPi = $state<string | undefined>(undefined);
	/** The version chosen in each extension row's picker, per source; unset means the newest it shows. */
	const pick = $state<Record<string, string>>({});

	/**
	 * The source that installs `version` of this npm extension: pi's own pin form. Sending it as an install
	 * replaces the row's entry rather than adding a second one — pi matches an npm source by its package name,
	 * so `npm:foo@1.2.3` overwrites `npm:foo` and the code moves to that version with it (docs/pi-upgrades.md).
	 * A pinned source is then left where it is by the daily update, which is the way back.
	 */
	const pinSource = (row: PackageRow, version: string): string => `npm:${row.name}@${version}`;
	/** What the picker would install if it was never touched: the newest release it shows. */
	const pickedVersion = (row: PackageRow): string => pick[row.source] ?? row.versions?.at(-1) ?? "";

	/**
	 * The live answer for one row, or undefined when it has not been asked — or when the files were edited
	 * since, which retires the answer (ui/lib/app-state.svelte.ts). "not checked" is a state of its own:
	 * a panel that showed nothing would look like a server that is not there.
	 */
	const statusOf = (name: string): McpStatusRow | undefined => app.mcpStatus?.servers.find((row) => row.name === name);
	/** Words a reader acts on, not the protocol's identifiers. */
	const STATE_WORDS: Record<McpStatusRow["state"], string> = {
		connected: "connected",
		disabled: "off — disabled in the file",
		failed: "not reachable",
		"needs-auth": "needs authorisation",
	};
	/**
	 * Whether this row can be signed in to: an HTTP server that sends no `Authorization` header of its own.
	 * That is pi's own rule for OAuth (src/agent/pi-mcp.ts), so the button never offers a sign-in the file
	 * would ignore — a server with a header needs the header fixed, which is what the modal is for.
	 */
	const canSignIn = (row: McpRow): boolean => row.enabled && !!row.url && !row.authorization;
	/** The address the browser was redirected to, typed in per row while its sign-in waits for it. */
	const redirect = $state<Record<string, string>>({});

	// pi takes any api string; these are the ones pi-ai implements, offered only as a hint.
	const APIS = ["openai-completions", "openai-responses", "azure-openai-responses", "anthropic-messages", "google-generative-ai", "mistral-conversations"];
	const EXPOSURES: McpExposure[] = ["direct", "deferred", "codemode", "hidden"];

	/**
	 * What the one modal is editing: an entry from the files, or a new one. `name` is the entry's key when it
	 * already exists — the key never changes, because a renamed provider would be a second provider sitting
	 * next to the old one. The fields are plain strings so a `${NAME}` or `!command` reference is held exactly
	 * as the file holds it; pi resolves it, not this page.
	 */
	type Draft =
		| { kind: "endpoint"; name: string | null; values: { name: string; baseUrl: string; api: string; apiKey: string; models: string } }
		| {
				kind: "mcp";
				name: string | null;
				values: McpValues;
		  };
	/** The maps are held as the text they are typed in, so a `${NAME}` or `!command` survives untouched. */
	type McpValues = {
		name: string;
		url: string;
		command: string;
		args: string;
		authorization: string;
		env: string;
		cwd: string;
		description: string;
		exposure: McpExposure;
		toolExposure: string;
		oauthClientId: string;
		oauthClientSecret: string;
		oauthCallbackUrl: string;
		oauthScope: string;
		enabled: boolean;
	};

	let draft = $state<Draft | null>(null);
	// A line this page could not read as a `name=value` pair. It is said here rather than sent to the server:
	// a frame the wire schema refuses has no requestId to answer, so the modal would just close on nothing.
	let formError = $state("");

	const newEndpoint = (): Draft => {
		formError = "";
		return { kind: "endpoint", name: null, values: { name: "", baseUrl: "", api: "openai-completions", apiKey: "", models: "" } };
	};
	const newServer = (): Draft => {
		formError = "";
		return {
			kind: "mcp",
			name: null,
			values: { name: "", url: "", command: "", args: "", authorization: "", env: "", cwd: "", description: "", exposure: "codemode", toolExposure: "", oauthClientId: "", oauthClientSecret: "", oauthCallbackUrl: "", oauthScope: "", enabled: true },
		};
	};

	function editEndpoint(row: EndpointRow): void {
		formError = "";
		draft = { kind: "endpoint", name: row.name, values: { name: row.name, baseUrl: row.baseUrl, api: row.api, apiKey: row.apiKey, models: "" } };
	}

	function editServer(row: McpRow): void {
		formError = "";
		draft = {
			kind: "mcp",
			name: row.name,
			values: {
				name: row.name,
				url: row.url,
				command: row.command,
				args: row.args.join(" "),
				authorization: row.authorization,
				env: pairText(row.env),
				cwd: row.cwd,
				description: row.description,
				exposure: row.exposure,
				toolExposure: pairText(row.toolExposure),
				oauthClientId: row.oauth.clientId,
				oauthClientSecret: row.oauth.clientSecret,
				oauthCallbackUrl: row.oauth.callbackUrl,
				oauthScope: row.oauth.scope,
				enabled: row.enabled,
			},
		};
	}

	// flypi's own memory store over MCP (`npm run memory`), with `direct`: its tools have to reach the model,
	// not only a codemode script. The token stays a reference — pi resolves `${…}` itself, so this page never
	// writes a secret, and the port is the one `npm run memory` documents.
	function fillMemory(): void {
		if (draft?.kind !== "mcp") return;
		draft.values = {
			...draft.values,
			name: "flypi-memory",
			url: "http://127.0.0.1:8790/mcp",
			authorization: "Bearer ${FLYPI_MEMORY_TOKEN}",
			description: "flypi memory store: memory_search, memory_write, memory_read, memory_supersede, memory_forget, memory_media, memory_index_status",
			exposure: "direct",
			// The server has to be `direct` and still not offer everything: these three are what flypi counts
			// after a turn, and a number the model can raise about itself is not a measurement
			// (docs/memory.md Phase 4). `toolExposure` is the only way to hide them from a direct server.
			toolExposure: pairText({ memory_cite: "hidden", memory_capture: "hidden", memory_turn: "hidden" }),
		};
	}

	/** Model ids and stdio args are typed as one line; the file holds them as a list. */
	const words = (value: string): string[] => value.split(/[\s,]+/).filter(Boolean);

	/** A map as it is typed in the modal: one `name=value` per line, which is also how it reads back. */
	const pairText = (pairs: Record<string, string>): string => Object.entries(pairs).map(([key, value]) => `${key}=${value}`).join("\n");

	/** A row says its server has per-tool exceptions at all: a tool the model is not offered is invisible otherwise. */
	const exceptionNote = (row: McpRow): string => {
		const count = Object.keys(row.toolExposure).length;
		return count ? ` · ${count} tool exception${count === 1 ? "" : "s"}` : "";
	};

	/**
	 * The other direction, and nothing typed is dropped quietly: a line that is not a pair, or a per-tool level
	 * that is not one of pi's four, throws and the modal says why — a form that swallowed it would read as a
	 * file that was written. `levels` is for the exposure map, whose values are not free text.
	 * shortcut: one pair per line, so a value containing a newline cannot be typed here; it stays in the file.
	 */
	function pairs(value: string, levels: boolean): Record<string, string> {
		const out: Record<string, string> = {};
		for (const line of value.split("\n")) {
			if (!line.trim()) continue;
			const eq = line.indexOf("=");
			const key = line.slice(0, eq).trim();
			const item = line.slice(eq + 1).trim();
			// A line left as `NAME=` is not a mistake: it is how the form says "take that key out of the file".
			if (eq < 0 || !key) throw new Error(`“${line.trim()}” is not a name=value line`);
			if (levels && item && !EXPOSURES.includes(item as McpExposure)) throw new Error(`“${item}” is not an exposure: ${EXPOSURES.join(", ")}`);
			out[key] = item;
		}
		return out;
	}

	/**
	 * One edit for one entry, never the list the panel happens to be showing (docs/protocol.md): the file also
	 * holds `compat`, cost, the other headers and pi's other OAuth keys this form does not have. An empty field
	 * means "take that key out of the file", which is how a key moves over to auth.json.
	 */
	function commit(event: SubmitEvent): void {
		event.preventDefault();
		if (!draft) return;
		const name = draft.name ?? draft.values.name;
		if (draft.kind === "endpoint") {
			const { baseUrl, api, apiKey, models } = draft.values;
			const edit: EndpointEdit = { name, baseUrl, api, apiKey, models: words(models) };
			app.saveConfig({ endpoints: [edit] });
		} else {
			const values = draft.values;
			let edit: McpEdit;
			try {
				edit = {
					name,
					url: values.url,
					command: values.command,
					args: words(values.args),
					authorization: values.authorization,
					env: pairs(values.env, false),
					cwd: values.cwd,
					description: values.description,
					exposure: values.exposure,
					toolExposure: pairs(values.toolExposure, true) as Record<string, McpExposure>,
					oauth: { clientId: values.oauthClientId, clientSecret: values.oauthClientSecret, callbackUrl: values.oauthCallbackUrl, scope: values.oauthScope },
					enabled: values.enabled,
				};
			} catch (error) {
				formError = (error as Error).message;
				return;
			}
			app.saveConfig({ mcpServers: [edit] });
		}
		formError = "";
		draft = null;
	}

	function remove(kind: "endpoints" | "mcpServers", name: string): void {
		app.saveConfig(kind === "endpoints" ? { endpoints: [{ name, remove: true }] } : { mcpServers: [{ name, remove: true }] });
	}

	/**
	 * Which endpoint a new conversation starts on (`defaultProvider` / `defaultModel` in settings.json, read
	 * by `resolveConfiguredModel()`). Both halves always: an endpoint can define several models, so "this
	 * one" is only a working default once one of its ids is named. Nothing here re-reads a file — the ack
	 * comes back with the refreshed snapshot, so the row that moved to being the default redraws itself.
	 */
	const defaults = $derived(app.config?.defaults ?? { provider: "", model: "" });

	function setDefault(provider: string, model: string | undefined): void {
		if (provider && model) app.saveConfig({ defaults: { provider, model } });
	}

	/**
	 * The raw editor: the two files as text, so a field these forms do not hold is still editable without
	 * leaving the browser. Two maps rather than one, because a save has to say what the box was *loaded*
	 * with: the server refuses a write over a file that moved since, which is what a list edit in this very
	 * panel does to it.
	 */
	let rawText = $state<Record<string, string>>({});
	let rawBase = $state<Record<string, string>>({});
	const rawFiles = $derived(app.config?.files ?? []);

	// Fill a box when the files arrive, but never over text that is being typed: one file's ack refreshes every
	// file, and another box may hold an edit not yet sent. When the typed text *is* the new text this page wrote
	// it, so the base moves up to it and a second save is not refused by its own ack.
	$effect(() => {
		for (const file of rawFiles) {
			const typed = rawText[file.name];
			if (typed !== undefined && typed !== rawBase[file.name] && typed !== file.text) continue;
			rawText[file.name] = file.text;
			rawBase[file.name] = file.text;
		}
	});

	/** One file per save: the other box keeps what is in it, and its own base still guards its save. */
	function saveRaw(name: string): void {
		app.saveConfig({ files: [{ name: name as "models" | "settings", text: rawText[name] ?? "", base: rawBase[name] }] });
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
</script>

<!-- The two actions on a list row, as glyphs: the rows are the list and words in every one of them would
     make the words the thing you read. Same stroke style as the sidebar's icons; the button's aria-label is
     the name, and the entry it acts on is named there. -->
{#snippet editGlyph()}
	<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L20 8l-4-4L4 16v4Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" /><path d="M14.2 5.8 18.2 9.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
{/snippet}
{#snippet removeGlyph()}
	<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4.5h6V7M6.5 7l.8 12.5h9.4L17.5 7M10.2 10.5v6m3.6-6v6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
{/snippet}
{#snippet defaultGlyph()}
	<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4.4l2.3 4.8 5.2.6-3.9 3.6 1 5.1-4.6-2.6-4.6 2.6 1-5.1L4.5 9.8l5.2-.6Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" /></svg>
{/snippet}

<section class="settings-view" aria-label="Settings" data-role="settings-view">
	<header class="panel-head">
		<h2>Settings</h2>
		<!-- The way back, spelled out rather than left to the gear in the sidebar — and the address bar
			follows it, because the page's view is mirrored into the URL (App.svelte, ui/lib/route.ts). -->
		<button type="button" data-role="back-to-chat" onclick={() => app.openChat()}>Back to chat</button>
	</header>
	{#if app.config?.errors.length}
		<!-- A file that will not parse is listed rather than shown as an empty config: an empty list would
		     read as "no endpoints", which is a different problem. -->
		<ul class="cfg-errors" role="alert" data-role="config-error">
			{#each app.config.errors as error}<li class="error">{error}</li>{/each}
		</ul>
	{/if}

	{#if app.configError}
		<!-- The server refused an edit: a name it cannot use, an endpoint with no base URL, a default it could
			not resolve. The files on disk are unchanged, so the refusal has to be said here — a list that
			quietly still shows the old values reads as a save that worked. -->
		<ul class="cfg-errors" role="alert" data-role="save-error">
			<li class="error">{app.configError}</li>
		</ul>
	{/if}

	<div class="cfg-stack">
		<section>
			<div class="cfg-section">
				<h3>Model endpoints</h3>
				<button type="button" data-role="endpoint-add" onclick={() => (draft = newEndpoint())}>Add endpoint</button>
			</div>
			<p class="cfg-note">
				<code>.flypi/agent/models.json</code> — a key may be {"${NAME}"} or <code>!command</code>; a model's
				<code>input</code>, <code>contextWindow</code> and cost are edits to the file.
			</p>
			<ul class="cfg-list" data-role="endpoints">
				{#each endpoints as row (row.name)}
					<li data-role="endpoint">
						<button type="button" class="cfg-name" onclick={() => editEndpoint(row)}>{row.name}</button>
						<code>{`${row.baseUrl || "no base URL"} · ${row.models.length ? row.models.join(", ") : "no models"}`}</code>
						{#if row.name === defaults.provider}
							<!-- Already the default: the one thing left to say is which of its models to start on.
								 A provider can define several, so the model is picked, never assumed. -->
							<label class="cfg-default">
								default
								<select data-role="default-model" aria-label="Default model for {row.name}" onchange={(event) => setDefault(row.name, event.currentTarget.value)}>
									{#each [defaults.model, ...row.models.filter((id) => id !== defaults.model)] as id}<option value={id}>{id}</option>{/each}
								</select>
							</label>
						{:else}
							<!-- An endpoint with no model id cannot be a default: settings.json needs a model, and
								 `resolveConfiguredModel()` fails the next conversation without one. -->
							<button
								type="button"
								class="icon"
								data-role="endpoint-default"
								aria-label="Set {row.name} as default"
								title={row.models.length ? "Start new conversations on this endpoint" : "This endpoint defines no model id to start on"}
								disabled={!row.models.length}
								onclick={() => setDefault(row.name, row.models[0])}
							>
								{@render defaultGlyph()}
							</button>
						{/if}
						<button type="button" class="icon" data-role="endpoint-edit" aria-label="Edit {row.name}" title="Edit this endpoint" onclick={() => editEndpoint(row)}>
							{@render editGlyph()}
						</button>
						<button type="button" class="icon remove" data-role="endpoint-remove" aria-label="Delete {row.name}" title="Delete this endpoint" onclick={() => remove("endpoints", row.name)}>
							{@render removeGlyph()}
						</button>
					</li>
				{:else}
					<li class="cfg-none">none configured</li>
				{/each}
			</ul>
			<!-- One of these endpoints is what a NEW conversation starts on: settings.json's `defaultProvider`
				and `defaultModel`, the pair `resolveConfiguredModel()` reads. The chat on screen keeps its own
				model — that choice belongs to the conversation, and lives in its session file. -->
			<p class="cfg-note" data-role="default-line">
				default for new conversations:
				{#if defaults.provider}
					<code>{`${defaults.provider}/${defaults.model}`}</code>
					{#if !endpoints.some((row) => row.name === defaults.provider)}— not one of these endpoints.{/if}
				{:else}
					<b>nothing set</b> — pick one below.
				{/if}
			</p>
		</section>

		<section>
			<div class="cfg-section">
				<h3>MCP servers</h3>
				<button type="button" data-role="mcp-check" onclick={() => app.checkMcp()} disabled={app.mcpChecking}>
					{app.mcpChecking ? "Checking…" : "Check connections"}
				</button>
				<button type="button" data-role="mcp-add" onclick={() => (draft = newServer())}>Add server</button>
			</div>
			<p class="cfg-note">
				<code>.flypi/agent/mcp.json</code> — a URL or a command, not both. An open conversation keeps its
				connections.
			</p>
			<ul class="cfg-list" data-role="mcp-servers">
				{#each servers as row (row.name)}
					<li data-role="mcp">
						<button type="button" class="cfg-name" onclick={() => editServer(row)}>{row.name}</button>
						<code>{`${row.url || `${row.command} ${row.args.join(" ")}`} · ${row.exposure}${exceptionNote(row)}`}</code>
						{#if !row.enabled}
							<span class="cfg-off">disabled</span>
						{:else}
							<!-- The connection state, next to the row it describes: "is this up" is a question
							     about the entry you are looking at. -->
							{@const status = statusOf(row.name)}
							<span class="cfg-state {status?.state ?? "unchecked"}" data-role="mcp-state">
								{status ? STATE_WORDS[status.state] : "not checked"}{status?.state === "connected" ? ` · ${status.tools.length} tools` : ""}
							</span>
							{#if status?.error}<code class="cfg-state-error" data-role="mcp-error">{status.error}</code>{/if}
						{/if}
						{#if canSignIn(row)}
							<!-- The browser round-trip (docs/architecture.md Phase 5, risk 5): flypi runs headless, so a
							     server that needs a sign-in gets the URL here and the redirect back as a paste. -->
							<button type="button" data-role="mcp-signin" onclick={() => app.signInMcp(row.name)} disabled={app.mcpSigningIn}>
								{app.mcpSignIn?.name === row.name ? "Sign-in waiting…" : "Sign in"}
							</button>
						{/if}
						<button type="button" class="icon" data-role="mcp-edit" aria-label="Edit {row.name}" title="Edit this server" onclick={() => editServer(row)}>
							{@render editGlyph()}
						</button>
						<button type="button" class="icon remove" data-role="mcp-remove" aria-label="Delete {row.name}" title="Delete this server" onclick={() => remove("mcpServers", row.name)}>
							{@render removeGlyph()}
						</button>
						{#if app.mcpSignIn?.name === row.name}
							<div class="cfg-signin" data-role="mcp-signin-box">
								<p class="cfg-note">If the browser cannot reach this machine, paste the redirect URL.</p>
								<p><a href={app.mcpSignIn.url} target="_blank" rel="noreferrer" data-role="mcp-auth-url">{app.mcpSignIn.url}</a></p>
								<form
									class="cfg-signin-form"
									onsubmit={(event) => {
										event.preventDefault();
										app.submitMcpRedirect(row.name, redirect[row.name] ?? "");
									}}
								>
									<label class="field">Redirect URL
										<input name="redirect" bind:value={redirect[row.name]} placeholder="http://127.0.0.1:port/callback?code=…" />
									</label>
									<button type="submit" data-role="mcp-redirect">Finish sign-in</button>
									<button type="button" data-role="mcp-signin-cancel" onclick={() => app.submitMcpRedirect(row.name, "")}>Cancel</button>
								</form>
							</div>
						{/if}
					</li>
				{:else}
					<li class="cfg-none">none configured</li>
				{/each}
			</ul>
			{#if app.mcpStatus}
				{#if app.mcpStatus.log}
					<pre class="cfg-log" data-role="mcp-log">{app.mcpStatus.log}</pre>
				{:else}
					<p class="cfg-note" data-role="mcp-log">nothing logged in <code>.flypi/agent/mcp.log</code></p>
				{/if}
			{/if}
		</section>

		<!-- Which pi this flypi runs, and moving it (docs/pi-upgrades.md Phase 8.4). The restart is the whole
			cost of the operation and it takes this page down with it, so the button asks first and says what it
			will do; the automatic way back is not a button, it is what the CLI does when the new process never
			answers (docs/risks.md risk 13). -->
		<section>
			<div class="cfg-section"><h3>pi</h3></div>
			{#if app.piVersions}
				<p class="cfg-note" data-role="pi-running">
					{`running pi ${app.piVersions.running}${app.piVersions.pinned ? " (pinned)" : ""}`}
				</p>
				<ul class="cfg-list" data-role="pi-versions">
					{#if app.piVersions.next && app.piVersions.next !== app.piVersions.running}
						<li data-role="pi-next">
							<code>{`pi ${app.piVersions.next}`}</code>
							<span class="cfg-state">published</span>
							{#if confirmingPi === app.piVersions.next}
								<span class="cfg-state" data-role="pi-confirm">
									{`this restarts the daemon${app.sessions.length ? `; ${app.sessions.length} conversation(s) are listed` : ""}`}
								</span>
								<button type="button" data-role="pi-use-confirm" onclick={() => app.usePi(app.piVersions!.next!)} disabled={app.piBusy}>
									{app.piBusy ? "Restarting…" : `Confirm — use ${app.piVersions.next}`}
								</button>
								<button type="button" class="icon remove" data-role="pi-use-cancel" onclick={() => (confirmingPi = undefined)} title="Do not switch">
									{@render removeGlyph()}
								</button>
							{:else}
								<button type="button" data-role="pi-use" onclick={() => (confirmingPi = app.piVersions!.next!)} disabled={app.piBusy}>Use this version</button>
							{/if}
						</li>
					{/if}
					{#each app.piVersions.trees.filter((version) => version !== app.piVersions!.running) as version (version)}
						<li data-role="pi-tree">
							<code>{`pi ${version}`}</code>
							<span class="cfg-state">on disk</span>
							<button type="button" data-role="pi-rollback" onclick={() => app.usePi(version)} disabled={app.piBusy}>
								{app.piBusy ? "Restarting…" : `Switch back to ${version}`}
							</button>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="cfg-note" data-role="pi-none">which pi this process runs is shown in the sidebar; moving it is a CLI thing in a checkout.</p>
			{/if}
			<p class="cfg-note" data-role="pi-checked">
				{lastChecked ? `last checked ${lastChecked}` : "not checked yet"}
				{#if app.piVersions}
					<button type="button" data-role="pi-check" onclick={() => app.checkPi()}>Check for pi updates</button>
				{/if}
			</p>
		</section>

		<section>
			<div class="cfg-section">
				<h3>Extensions</h3>
			</div>
			<p class="cfg-note">
				<code>packages</code> in <code>.flypi/agent/settings.json</code> — <code>npm:…</code>, a git URL or a
				path. An extension runs as flypi runs, with your files and your keys.
			</p>
			<form
				class="cfg-install"
				onsubmit={(event) => {
					event.preventDefault();
					if (!newPackage.trim()) return;
					app.savePackages({ install: [newPackage.trim()] });
					newPackage = "";
				}}
			>
				<label class="field">Source
					<input name="source" bind:value={newPackage} placeholder="npm:pi-web-access" data-role="package-source" />
				</label>
				<button type="submit" data-role="package-install" disabled={app.packagesBusy || !newPackage.trim()}>
					{app.packagesBusy ? "Working…" : "Install"}
				</button>
			</form>
			{#if app.packages?.errors.length}
				<ul class="cfg-errors" role="alert" data-role="package-errors">
					{#each app.packages.errors as error}<li class="error">{error}</li>{/each}
				</ul>
			{/if}
			<ul class="cfg-list" data-role="packages">
				{#each packages as row (row.source)}
					<li data-role="package">
						<code>{row.source}</code>
						{#if row.version}<span class="cfg-state" data-role="package-version">pi sees {row.version}</span>{/if}
						<span class="cfg-state {row.installed ? "connected" : "failed"}" data-role="package-state">
							{row.installed ? "installed" : "not installed"}
						</span>
						{#if row.update}
							<span class="cfg-state" data-role="package-update">update available</span>
							<button type="button" data-role="package-update-now" aria-label="Update {row.source}" onclick={() => app.savePackages({ update: [row.source] })} disabled={app.packagesBusy}>
								Update
							</button>
						{/if}
						<!-- Installed → published, and the published list: going back is a pin, not an update, because
							the only thing that stops the daily check moving a source is the source naming a version. -->
						{#if row.name && row.versions?.length}
							<span class="cfg-state" data-role="package-available">
								{row.available ? `newest published ${row.available}` : "nothing newer published"}
							</span>
							<label class="field">Version
								<select data-role="package-version-pick" aria-label={`Version of ${row.source}`} onchange={(event) => (pick[row.source] = event.currentTarget.value)}>
									{#each row.versions.slice().reverse() as version (version)}
										<option value={version}>{version === row.version ? `${version} — installed` : version}</option>
									{/each}
								</select>
							</label>
							<button
								type="button"
								data-role="package-pin"
								aria-label="Install {pickedVersion(row)} of {row.source}"
								onclick={() => {
									const version = pickedVersion(row);
									if (!version) return;
									app.savePackages({ install: [pinSource(row, version)] });
								}}
								disabled={app.packagesBusy}
							>
								{app.packagesBusy ? "Working…" : `Install ${pickedVersion(row)}`}
							</button>
						{/if}
						{#if row.name && row.source !== `npm:${row.name}`}
							<span class="cfg-state" data-role="package-pinned">pinned</span>
						{/if}
						<button type="button" class="icon remove" data-role="package-remove" aria-label="Remove {row.source}" title="Remove this package" onclick={() => app.savePackages({ remove: [row.source] })}>
							{@render removeGlyph()}
						</button>
					</li>
				{:else}
					<li class="cfg-none">none installed</li>
				{/each}
			</ul>
		</section>

		<section data-role="raw-files">
			<div class="cfg-section"><h3>The files as text</h3></div>
			<p class="cfg-note">Saving replaces the file. It must parse as JSON.</p>
			{#each rawFiles as file (file.name)}
				<label class="field">
					{file.name}.json{file.text === "" ? " (not created yet)" : ""}
					<textarea class="cfg-raw" rows="14" spellcheck="false" data-role={`raw-${file.name}`} bind:value={rawText[file.name]}></textarea>
				</label>
				<button type="button" data-role={`raw-save-${file.name}`} onclick={() => saveRaw(file.name)}>Save {file.name}.json</button>
			{/each}
		</section>
	</div>

	{#if draft}
		<dialog class="cfg-modal" data-role="config-modal" use:modal onclose={() => (draft = null)} aria-label={draft.kind === "endpoint" ? "Model endpoint" : "MCP server"}>
			<div class="cfg-section">
				<h3>{draft.name === null ? (draft.kind === "endpoint" ? "Add an endpoint" : "Add a server") : `Edit ${draft.name}`}</h3>
				<button type="button" class="linklike" onclick={() => (draft = null)}>Cancel</button>
			</div>

			{#if draft.kind === "endpoint"}
				<form class="cfg-form" data-role="endpoint-form" onsubmit={commit}>
					<label class="field">Name
						<!-- The name is the key in the file: an edit that changed it would add a provider and leave
							 the old one behind, so an existing one is fixed. -->
						<input name="name" bind:value={draft.values.name} disabled={draft.name !== null} placeholder="chatgml" required />
					</label>
					<label class="field">Base URL<input name="baseUrl" bind:value={draft.values.baseUrl} placeholder="https://chatgml.dev/v1" required /></label>
					<label class="field">API<input name="api" bind:value={draft.values.api} list="flypi-api-kinds" required /></label>
					<label class="field">Key<input name="apiKey" bind:value={draft.values.apiKey} placeholder="{'${chatgml_API_KEY}'}" /></label>
					<label class="field">Add model ids<input name="models" bind:value={draft.values.models} placeholder="comma-separated; the models already there are kept" /></label>
					<p class="cfg-note">{draft.name === null ? "" : `Already defines: ${endpoints.find((row) => row.name === draft?.name)?.models.join(", ") || "nothing"}`}</p>
					<div class="cfg-actions"><button type="submit">Save endpoint</button></div>
				</form>
			{:else}
				<form class="cfg-form" data-role="mcp-form" onsubmit={commit}>
					<div class="cfg-section">
						<!-- The one server this project has a recipe for, spelled out: URL, bearer reference and
							 `direct` are what its own serve script documents. -->
						<span></span>
						<button type="button" class="linklike" data-role="memory-mcp" onclick={fillMemory}>use flypi's memory MCP</button>
					</div>
					<label class="field">Name<input name="name" bind:value={draft.values.name} disabled={draft.name !== null} placeholder="flypi-memory" required /></label>
					<label class="field">URL<input name="url" bind:value={draft.values.url} placeholder="http://127.0.0.1:8790/mcp" /></label>
					<label class="field">Command<input name="command" bind:value={draft.values.command} placeholder="npx (for a stdio server)" /></label>
					<label class="field">Arguments<input name="args" bind:value={draft.values.args} placeholder="-y @modelcontextprotocol/server-filesystem ." /></label>
					<label class="field">Authorization header<input name="authorization" bind:value={draft.values.authorization} placeholder="Bearer {'${FLYPI_MEMORY_TOKEN}'}" /></label>
					<label class="field">Description<input name="description" bind:value={draft.values.description} placeholder="what this server offers" /></label>
					<div class="cfg-inline">
						<label class="field">Exposure<select name="exposure" bind:value={draft.values.exposure}>{#each EXPOSURES as level}<option value={level}>{level}</option>{/each}</select></label>
						<label class="field cfg-enabled"><input type="checkbox" name="enabled" bind:checked={draft.values.enabled} /> enabled</label>
					</div>
					<!-- The fields a server needs only sometimes, behind the platform's own disclosure: the modal stays
						 one screen for the case that matters (a URL and a token), and none of this is unreachable. -->
					<details class="cfg-extra" data-role="mcp-extra">
						<summary>Environment, working directory, tool exceptions, OAuth</summary>
						<p class="cfg-note">One <code>name=value</code> per line; <code>NAME=</code> removes a key.</p>
						<label class="field">Working directory<input name="cwd" bind:value={draft.values.cwd} placeholder="relative to the session's working directory (stdio)" /></label>
						<label class="field">Environment<textarea name="env" bind:value={draft.values.env} rows="3" data-role="mcp-env" placeholder="{'API_KEY=${OPENROUTER_API_KEY}'}"></textarea></label>
						<label class="field">Tool exceptions<textarea name="toolExposure" bind:value={draft.values.toolExposure} rows="3" data-role="mcp-tool-exposure" placeholder="memory_cite=hidden, or read_*=direct for a pattern"></textarea></label>
						<label class="field">OAuth client id<input name="oauthClientId" bind:value={draft.values.oauthClientId} placeholder="for a server that does not register clients itself" /></label>
						<label class="field">OAuth client secret<input name="oauthClientSecret" bind:value={draft.values.oauthClientSecret} placeholder="{'${NAME}'} or !command, not a typed secret" /></label>
						<label class="field">OAuth redirect URI<input name="oauthCallbackUrl" bind:value={draft.values.oauthCallbackUrl} placeholder="http://localhost:8080/oauth/callback" /></label>
						<label class="field">OAuth scopes<input name="oauthScope" bind:value={draft.values.oauthScope} placeholder="space-separated, as the server advertises them" /></label>
					</details>
					{#if formError}
						<!-- Nothing was sent, so the reason belongs in the modal: a line this page could not read is the
							 page's mistake, not the server's, and the file on disk is unchanged either way. -->
						<p class="error" role="alert" data-role="form-error">{formError}</p>
					{/if}
					<div class="cfg-actions"><button type="submit">Save server</button></div>
				</form>
			{/if}
		</dialog>
	{/if}
	<datalist id="flypi-api-kinds">{#each APIS as api}<option value={api}></option>{/each}</datalist>
</section>
