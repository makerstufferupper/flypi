<script lang="ts">
	import type { FlypiAppState } from "./lib/app-state.svelte.ts";
	import { formatCache, type RenderedMessage, type ToolCard } from "../src/shared/transcript.ts";

	let { app }: { app: FlypiAppState } = $props();

	/**
	 * The machinery behind the answers, in the order the turn produced it: thinking, tool calls with
	 * their live output, and results that arrived with no card. The middle panel keeps only the
	 * conversation; nothing here is a second copy of the transcript — it is the same view model.
	 */
	type Entry =
		| { kind: "thinking"; text: string }
		| { kind: "tool"; card: ToolCard }
		| { kind: "orphan"; text: string; isError: boolean };

	const entries = $derived.by(() => {
		const listed: Entry[] = [];
		const messages: RenderedMessage[] = app.transcript.streaming
			? [...app.transcript.messages, app.transcript.streaming]
			: app.transcript.messages;
		for (const message of messages) {
			for (const block of message.blocks) {
				if (block.kind === "thinking") listed.push({ kind: "thinking", text: block.text });
				// A tool call with no card has only half streamed; there is no state to show yet.
				else if (block.kind === "tool-call") {
					const card = app.transcript.tools[block.id];
					if (card) listed.push({ kind: "tool", card });
				} else if (block.kind === "tool-result") {
					listed.push({ kind: "orphan", text: block.output, isError: block.isError });
				}
			}
		}
		return listed;
	});

	let open = $state(false);

	// The newest entry should stay on screen: the panel is where you watch a turn happen. Scroll up
	// and it stops pulling you back down, so reading older output survives the next tool call.
	let list = $state<HTMLOListElement | undefined>();
	let following = $state(true);

	function onScroll() {
		if (list) following = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
	}

	$effect(() => {
		entries; // re-runs on any change to the list, including a card's output growing
		if (list && following) list.scrollTop = list.scrollHeight;
	});

	function toggle() {
		open = !open;
		// Ask when it is opened, not on a timer: the debug view is a snapshot of the live session.
		if (open) {
			app.showDebug();
			// The queue is the daemon's, not the conversation's, so it is a separate request — and this is the
			// only place it is shown (docs/architecture.md Phase 4.5).
			app.loadScheduler();
		}
	}

	function duration(card: ToolCard): string {
		if (card.startedAt === undefined || card.endedAt === undefined) return "";
		return ` · ${((card.endedAt - card.startedAt) / 1000).toFixed(1)}s`;
	}
</script>

<aside class="activity-panel" aria-label="Thinking and tool activity">
	<h2>Activity <span class="count" data-role="count">{entries.length}</span></h2>

	{#if !entries.length}
		<p class="activity-empty">nothing yet — thinking and tool output land here</p>
	{/if}

	<ol class="activity" bind:this={list} onscroll={onScroll}>
		{#each entries as entry}
			<li>
				{#if entry.kind === "thinking"}
					<!-- Expanded: unlike the chat, this panel is nothing but machinery, so there is nothing to keep out of the way. -->
					<details class="thinking" open><summary>thinking</summary><pre>{entry.text}</pre></details>
				{:else if entry.kind === "tool"}
					<article class="tool-card" data-tool={entry.card.name} data-state={entry.card.state}>
						<header>
							<span class="tool-name">{entry.card.name}</span>
							{#if entry.card.args}<code class="tool-args" data-role="args">{JSON.stringify(entry.card.args)}</code>{/if}
							<span class="tool-state">{entry.card.state}{duration(entry.card)}</span>
						</header>
						{#if entry.card.output}
							<pre class="tool-output" data-role="output">{entry.card.output}</pre>
						{/if}
					</article>
				{:else}
					<pre class="orphan-result" data-error={String(entry.isError)}>{entry.text}</pre>
				{/if}
			</li>
		{/each}
	</ol>

	<footer>
		<!-- Still the session's own snapshot, just no longer a panel of its own (docs/architecture.md). -->
		<button type="button" class="debug-toggle" onclick={toggle}>{open ? "Hide debug" : "Debug"}</button>

		{#if open && app.debug}
			<h2>System prompt</h2>
			<pre class="system-prompt">{app.debug.systemPrompt}</pre>

			<h2>Active tools</h2>
			<ul class="active-tools">
				{#each app.debug.activeTools as tool}
					<li>{tool}</li>
				{/each}
			</ul>

			<h2>Injected memory</h2>
			<!-- What went into this turn, not what a recall would return now (docs/architecture.md Phase 4). -->
			<pre class="memory-block">{app.debug.memoryBlock ?? "no memory block injected"}</pre>
		{:else if open}
			<p class="debug-empty">no debug info yet</p>
		{/if}

		{#if open}
			<!-- What the injected block cost the prompt cache (docs/prompt-cache.md Phase 4.6 A2). These are
			     the reducer's own `turn`/`total` sums — the same accounting `src/memory/recall.ts` writes into
			     the `turns` row — so the number on screen and the number in the store cannot drift. "This
			     conversation" covers everything the session holds, including history a reopened chat re-seeded. -->
			<h2>Prompt cache</h2>
			<pre class="cache-usage" data-role="cache">{app.transcript.running ? "this turn" : "last turn"}: {formatCache(app.transcript.turn)}
this conversation: {formatCache(app.transcript.total)}</pre>

			<!-- What the daemon has queued and what it last changed. Every maintenance job writes a
			     `job_runs` row, so this is that record rather than a status the process remembers. -->
			<h2>Scheduler</h2>
			{#if app.schedulerError}
				<p class="scheduler-empty" data-role="scheduler-error">{app.schedulerError}</p>
			{:else if !app.scheduler}
				<p class="scheduler-empty">no scheduler info yet</p>
			{:else}
				<ul class="scheduler-jobs" data-role="scheduler-jobs">
					{#each app.scheduler.jobs as job}
						<li data-kind={job.kind}>{job.kind} — {job.running ? "running" : `due ${job.nextRunAt}`}</li>
					{:else}
						<li class="muted">nothing queued</li>
					{/each}
				</ul>
				<ul class="scheduler-runs" data-role="scheduler-runs">
					{#each app.scheduler.jobRuns as run}
						<li data-kind={run.kind} data-status={run.status}>
							{run.kind} {run.status}{#if run.detail} — {run.detail}{/if}
						</li>
					{:else}
						<li class="muted">no job has run yet</li>
					{/each}
				</ul>
			{/if}
		{/if}
	</footer>
</aside>
