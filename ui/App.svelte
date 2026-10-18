<script lang="ts">
	import { FlypiAppState } from "./lib/app-state.svelte.ts";
	import type { Transport } from "./lib/client.ts";
	import Sidebar from "./Sidebar.svelte";
	import Chat from "./Chat.svelte";
	import ActivityPanel from "./ActivityPanel.svelte";
	import SettingsPanel from "./SettingsPanel.svelte";
	import SecretsPanel from "./SecretsPanel.svelte";
	import MemoryPanel from "./MemoryPanel.svelte";
	import { clampWidth, limits, loadWidth, saveWidth, type Panel } from "./lib/panels.ts";
	import { readRoute, sessionId, writeRoute } from "./lib/route.ts";

	let { transport }: { transport: Transport } = $props();
	// svelte-ignore state_referenced_locally — the transport is fixed for the life of the page.
	const app = new FlypiAppState(transport);
	app.watch();

	// Column widths are the page's own setting, like the theme (ui/lib/theme.ts).
	const width = $state<Record<Panel, number>>({ sidebar: loadWidth("sidebar"), activity: loadWidth("activity") });

	function remPx(): number {
		// The drag is in pixels and the layout is in rem; the root size is 16px unless the user changed it.
		return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
	}

	// The middle column is whatever is left, so one axis per gutter is all there is: grabbing the
	// right-hand gutter and pulling left makes that panel wider.
	function grab(event: PointerEvent, panel: Panel) {
		event.preventDefault();
		const from = event.clientX;
		const start = width[panel];
		const move = (event: PointerEvent) => {
			width[panel] = clampWidth(panel, start + ((event.clientX - from) * sign(panel)) / remPx());
		};
		const release = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", release);
			window.removeEventListener("pointercancel", release);
			saveWidth(panel, width[panel]);
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", release);
		window.addEventListener("pointercancel", release);
	}

	function nudge(event: KeyboardEvent, panel: Panel) {
		const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
		if (step === undefined) return;
		event.preventDefault();
		width[panel] = clampWidth(panel, width[panel] + sign(panel) * step);
		saveWidth(panel, width[panel]);
	}

	function sign(panel: Panel): number {
		return panel === "sidebar" ? 1 : -1;
	}

	// The address bar always says which session is on screen (ui/lib/route.ts): the session the app is
	// in is mirrored into it, and a URL that opens the page on someone else's session is opened as
	// soon as the socket has handed over a conversation to rebind it to.
	// The address bar names where this page starts, not where it stays: applied once, when the first
	// conversation arrives. Watching forever, it would pull every later click back to that session — and
	// the effect above writes that same URL, so a reload would pin the page to whatever was last shown.
	const start = readRoute();
	let deepLink = start.session;
	// The view is the page's own state, not the socket's: a URL that names settings or the vault opens the page
	// there, and every change to the view or the session writes the address back, so reload and bookmark land
	// where the page was.
	if (start.view === "settings") app.openSettings();
	if (start.view === "secrets") app.openSecrets();
	if (start.view === "memory") app.openMemory();

	$effect(() => writeRoute(app.view, app.sessionPath ?? null));

	$effect(() => {
		// No session named, or the app is already in it: nothing to do. Reading the conversation id is
		// what makes this run again when the connect hands one over — that is the one time this applies.
		if (!deepLink || !app.conversationId) return;
		const name = deepLink;
		deepLink = null;
		// The address names the session by file name, the conversation by full path (ui/lib/route.ts).
		if (name !== sessionId(app.sessionPath ?? "")) app.openSession(name);
	});

	// What the daemon knows about updates — a newer flypi published, and the one it has already downloaded.
	// That answer is on `/healthz` rather than the socket because the daemon decides on its own schedule and
	// this page only reports it: no new frame, and the same channel `flypi status` reads.
	const update = $state<{ available: string | null; ready: string | null }>({ available: null, ready: null });
	const banner = $derived(update.ready ? { version: update.ready, ready: true } : update.available ? { version: update.available, ready: false } : null);
	/**
	 * Which flypi is answering, kept outside the reactive state on purpose: the restart watch below has to read
	 * it without re-arming itself on every poll. `startedAt` changes with every restart, so it says whether the
	 * process this page connected to is still the one running.
	 */
	let daemon: { version: string | null; startedAt: string | null } = { version: null, startedAt: null };

	async function askHealth(): Promise<void> {
		try {
			const health = (await (await fetch("/healthz")).json()) as { version?: string; startedAt?: string; updateAvailable?: string; updateReady?: string };
			update.available = health.updateAvailable ?? null;
			update.ready = health.updateReady ?? null;
			daemon = { version: health.version ?? null, startedAt: health.startedAt ?? null };
		} catch {
			// No health page to ask — a headless server, or a page opened somewhere else. Say nothing.
		}
	}

	$effect(() => {
		void askHealth();
		// The daemon re-checks once a day and installs on its own idle; a minute is often enough to notice.
		const timer = setInterval(() => void askHealth(), 60_000);
		return () => clearInterval(timer);
	});

	/**
	 * The install replaces the files the daemon runs from and restarts it (src/daemon/index.ts), so the page
	 * that asked for it is left attached to a process that is gone, holding a build the new one no longer
	 * serves. While that is going on the page says so instead of showing a chat that cannot answer, and it comes
	 * back on its own: a new process answering on a new version means new asset names, so the only way back to a
	 * working page is a reload. A new process on the same version needs none — this page's build is still the
	 * one being served. And an install that failed never restarts anything, so the wait is bounded: the page
	 * hands itself back with what went wrong on the update line rather than sitting here forever.
	 */
	const RESTART_WAIT_MS = 120_000;
	$effect(() => {
		if (!app.updateInstalling) return;
		// shortcut: only the page that pressed the button watches for the restart; a second tab (or a
		// `flypi update` at a keyboard) reconnects on the old build, and reloads when someone reloads it.
		const before = daemon;
		const since = Date.now();
		const timer = setInterval(() => {
			void askHealth().then(() => {
				// Still the same process — or none answering yet, which leaves `daemon` as it was.
				if (daemon.version === before.version && daemon.startedAt === before.startedAt) {
					if (Date.now() - since >= RESTART_WAIT_MS) {
						app.updateError = "the daemon never restarted — the install may have failed";
						app.updateInstalling = false;
					}
					return;
				}
				if (before.version && daemon.version !== before.version) location.reload();
				else app.updateInstalling = false;
			});
		}, 1000);
		return () => clearInterval(timer);
	});
</script>

{#if app.updateInstalling}
	<!-- The daemon is replacing itself and restarting (see the restart watch above): this page's socket points
		 at a process that is gone and its own code is a build the next one will not serve. There is nothing
		 honest to show but what is happening and what happens next. -->
	<section class="updating" data-role="updating" role="status" aria-live="polite">
		<h2>Updating flypi</h2>
		<p>The daemon is installing the new version and restarting to run it.</p>
		<p>This page goes back on its own once the new one answers.</p>
	</section>
{:else}
	<div class="layout" style="--sidebar-w: {width.sidebar}rem; --activity-w: {width.activity}rem">
		{#snippet gutter(panel: Panel)}
			<!-- A resize handle is a slider: it has a value, a range, and the arrow keys move it. (The ARIA
				splitter pattern uses role="separator", which the compiler insists may not carry these handlers.) -->
			<div
				class="gutter"
				role="slider"
				aria-orientation="vertical"
				aria-label="Resize the {panel === "sidebar" ? "sidebar" : "activity panel"}"
				aria-valuenow={width[panel]}
				aria-valuetext={`${width[panel]} rem`}
				aria-valuemin={limits(panel).min}
				aria-valuemax={limits(panel).max}
				tabindex="0"
				onpointerdown={(event) => grab(event, panel)}
				onkeydown={(event) => nudge(event, panel)}
			></div>
		{/snippet}
		<Sidebar {app} update={banner} />
		{@render gutter("sidebar")}
		{#if app.view === "settings"}
			<!-- The settings view replaces the chat and the activity column: configuring the agent's endpoints
				 and MCP servers is not about this conversation, so nothing of the conversation is on screen with
				 it. The way back is the button on the view (and the gear, which is a toggle). -->
			<SettingsPanel {app} />
		{:else if app.view === "secrets"}
			<!-- Same for the vault: it is about the agent's credentials, not this conversation — and a screen that
				 still showed the transcript next to a revealed value would be a second place the value is written.
				 Only masks are ever rendered here (docs/secrets.md). -->
			<SecretsPanel {app} />
		{:else if app.view === "memory"}
			<!-- And the memory browser: it is about the store, not this conversation, so it replaces the chat the
				 same way (docs/memory.md Phase 6). -->
			<MemoryPanel {app} />
		{:else}
			<Chat {app} />
			{@render gutter("activity")}
			<ActivityPanel {app} />
		{/if}
	</div>
{/if}
