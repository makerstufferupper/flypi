<script lang="ts">
	import type { FlypiAppState } from "./lib/app-state.svelte.ts";
	import type { SessionSummary } from "../src/server/protocol.ts";
	import { currentTheme, setTheme, type Theme } from "./lib/theme.ts";

	let { app, update }: { app: FlypiAppState; update?: { version: string; ready: boolean } | null } = $props();

	// The page's own setting, so it does not go through the app state or the socket.
	let theme = $state<Theme>(currentTheme() ?? "light");

	function toggleTheme() {
		theme = theme === "dark" ? "light" : "dark";
		setTheme(theme);
	}

	// A row is named by what the user called it, then by its first message, then by its path. The row
	// you are in edits the first two of those: the first message is the hint for a session that has no
	// name yet, and a brand-new session has no first message, so its field is blank by itself.
	function hint(session: SessionSummary): string {
		return session.name || session.firstMessage;
	}

	function title(session: SessionSummary): string {
		return hint(session) || session.path;
	}

	// The row you are in is an inline rename field, so it fires on Enter and on clicking away;
	// a name you did not actually change sends nothing.
	function rename(current: string, event: Event) {
		const next = (event.currentTarget as HTMLInputElement).value.trim();
		if (next && next !== current.trim()) app.rename(next);
	}

	// Deleting is the one thing here that cannot be undone: the session file goes, and with it the
	// conversation. It goes straight away — the trash icon is deliberate, and a row is a click away.
	function remove(session: SessionSummary) {
		app.deleteSession(session.path);
	}

	/**
	 * The sessions with a turn running right now. A session keeps answering when you leave it, so the row is
	 * the only place that turn is visible — and the row on screen says it from its own transcript, since the
	 * daemon's list is only as fresh as the last fetch.
	 */
	const running = $derived(new Set(app.sessions.filter((session) => app.isRunning(session.path)).map((session) => session.path)));
</script>

<aside class="sidebar">
	<!-- The title row carries the panel's identity and nothing else; the icons you can press are below it. -->
	<header class="panel-head">
		<!-- Each logo file is tinted for one palette and has no transparency, so only the one matching
			the theme goes in the DOM. The theme state is already here for the toggle below. -->
		<img class="logo" src={theme === "dark" ? "/flypi-logo-dark.jpeg" : "/flypi-logo-light.jpeg"} alt="" />
		<h1>flypi{#if !app.sessionPath} <span class="port">· new</span>{/if}</h1>
	</header>

	<!-- The actions get their own row rather than a share of the title row: five icons beside a 2.5rem logo
		is more than a 15rem panel holds, and a wrapping row splits them across two lines. Icons are a fixed
		size, so this row never wraps and they stay on one line. -->
	<div class="panel-actions">
		<button type="button" class="icon" aria-label="New session" title="New session" onclick={() => { app.openChat(); app.newSession(); }}>
			<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
		</button>
		<button
			type="button"
			class="icon"
			aria-label="Switch to {theme === "dark" ? "light" : "dark"} theme"
			title="Switch to {theme === "dark" ? "light" : "dark"} theme"
			onclick={toggleTheme}
		>
			{#if theme === "dark"}
				<!-- Showing the theme you are about to get, so the glyph and the label agree. -->
				<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4m0-14.2-1.4 1.4M6.3 17.7l-1.4 1.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
			{:else}
				<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 13.1A8.5 8.5 0 1 1 10.9 3a7.5 7.5 0 0 0 10.1 10.1Z" fill="currentColor" /></svg>
			{/if}
		</button>
		<!-- Model endpoints and MCP servers are the agent dir's config files, not this session's state, and
			 the view that edits them replaces the chat — so which view is up is shared app state, mirrored
			 into the address bar (App.svelte, ui/lib/route.ts). -->
		<!-- The store's own browser (docs/memory.md Phase 6): what is remembered, why it was injected, what a
			 sweep did to it and what the wiki says. A stack of pages, because what it opens is the reading half
			 of memory rather than the chat's writing half. -->
		<button
			type="button"
			class="icon"
			data-role="memory"
			onclick={() => app.toggleMemory()}
			aria-pressed={app.view === "memory"}
			aria-label="Memory"
			title="Memory — what is remembered, and why"
		>
			<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 6.2h6.2c1 0 1.8.8 1.8 1.8v9.6c0-1 .8-1.8 1.8-1.8h5.2V6.2H4.5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" /><path d="M12.5 17.6c0-1 .8-1.8 1.8-1.8h5.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" /></svg>
		</button>
		<!-- The vault is the agent's credentials, not this session's state either, so it is the same kind of
			 thing as the gear: a view of its own, shared app state, mirrored into the address bar. A key, because
			 what it opens lists sealed values rather than files (SecretsPanel.svelte, docs/secrets.md). -->
		<button
			type="button"
			class="icon"
			data-role="secrets"
			onclick={() => app.toggleSecrets()}
			aria-pressed={app.view === "secrets"}
			aria-label="Secrets"
			title="Secrets — the encrypted vault"
		>
			<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="7.8" cy="7.8" r="3.6" fill="none" stroke="currentColor" stroke-width="1.8" /><path d="M10.4 10.4 19.5 19.5M15.4 15.4l2.4-2.4M12.9 12.9l2-2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
		</button>
		<button
			type="button"
			class="icon"
			data-role="settings"
			onclick={() => app.toggleSettings()}
			aria-pressed={app.view === "settings"}
			aria-label="Model endpoints and MCP servers"
			title="Model endpoints and MCP servers"
		>
			<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /><circle cx="9" cy="7" r="2" fill="currentColor" /><circle cx="15" cy="12" r="2" fill="currentColor" /><circle cx="11" cy="17" r="2" fill="currentColor" /></svg>
		</button>
	</div>

	<!-- The daemon's own answer about updates (its `/healthz`, read by App.svelte): what it found, and whether
		the package is already on this machine. It installs itself during a stretch of nothing happening; the
		button is the same install asked for now, which restarts the daemon — and the page that asked for it
		becomes the updating page until the new one answers (ui/App.svelte). -->
	{#if update}
		<p class="update" data-role="update">
			flypi {update.version} {update.ready ? "is downloaded — it installs when nothing is running" : "is available"}
			<button
				type="button"
				class="icon"
				data-role="install-update"
				disabled={app.updateInstalling}
				onclick={() => app.installUpdate()}
				title="Install {update.version} now — the daemon restarts to run it"
			>{app.updateInstalling ? "installing…" : "install now"}</button>
		</p>
		{#if app.updateError}<p class="update error" data-role="update-error">{app.updateError}</p>{/if}
	{/if}

	<!-- Which pi answers (docs/pi-upgrades.md Phase 8.1): the version loaded, not the range flypi declares.
		"pinned" means `flypi pi use` chose it; the other number is what the installed tree holds, and the two
		disagreeing is the whole reason this line exists. -->
	{#if app.pi}
		<p class="update" data-role="pi-version">
			{`pi ${app.pi.version}${app.pi.pinned ? " (pinned)" : ""}${app.pi.bundled ? ` · installed tree holds ${app.pi.bundled}` : ""}`}
		</p>
	{/if}

	<!-- Every session flypi owns, listed as soon as there is a conversation: the list *is* the
		navigation, so there is no Open button to press first. Rows are plain text that light up when
		you point at one, keyed by path so a refresh cannot interrupt an inline rename, and the row you
		are in is both marked and editable — the only one flypi can rename. Any row can be deleted: the
		list is keyed by path, and so is the delete. -->
	<ul class="sessions">
		{#each app.sessions as session (session.path)}
			<!-- A session with a turn still running gets its dot: leaving a chat does not stop it, and this is
				 where you can see that without opening it. -->
			<li class:running={running.has(session.path)}>
				{#if running.has(session.path)}
					<span class="run-dot" role="img" aria-label="Running" title="A turn is running in this session"></span>
				{/if}
				{#if session.path === app.sessionPath}
					<!-- Only the name and the first-message hint, never the path: a new session reads as
						an empty field that says what it is. -->
					<input
						class="name current"
						value={hint(session)}
						placeholder="New session"
						aria-label="Session name"
						onblur={(event) => rename(hint(session), event)}
						onkeydown={(event) => {
							if (event.key === "Enter") rename(hint(session), event);
							else if (event.key === "Escape") (event.currentTarget as HTMLInputElement).value = hint(session);
						}}
					/>
				{:else}
					<!-- Picking a conversation is the other way back to the chat: the settings view has no
						 conversation of its own, so opening one means leaving it. -->
					<button type="button" class="session" onclick={() => { app.openChat(); app.openSession(session.path); }}>{title(session)}</button>
				{/if}
				<button
					type="button"
					class="icon remove"
					aria-label="Delete {title(session)}"
					title="Delete this session"
					onclick={() => remove(session)}
				>
					<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4.5h6V7M6.5 7l.8 12.5h9.4L17.5 7M10.2 10.5v6m3.6-6v6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
				</button>
			</li>
		{/each}
	</ul>
</aside>
