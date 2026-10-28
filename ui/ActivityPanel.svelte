<script lang="ts">
	import type { FlypiAppState } from "./lib/app-state.svelte.ts";
	import { FollowNewest } from "./lib/follow.ts";
	import { formatCache, type RenderedMessage, type Transcript, type ToolCard } from "../src/shared/transcript.ts";
	import type { TaskItem, TaskStatus } from "../src/agent/goals.ts";

	// `GOAL_TOOL`/`TASK_TOOL` in `src/agent/goals.ts`, spelled out rather than imported: that module reads
	// `node:crypto` and `node:fs`, and this component is in the browser bundle. Only its types come over.
	const GOAL_TOOL = "goal";
	const TASK_TOOL = "task_write";

	let {
		app,
		sheet = false,
		onsheet,
	}: { app: FlypiAppState; sheet?: boolean; onsheet?: () => void } = $props();

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

	let debugOpen = $state(false);

	// The newest entry should stay on screen: the panel is where you watch a turn happen. Scroll up
	// and it stops pulling you back down, so reading older output survives the next tool call — and the
	// place belongs to the session, so switching chats does not inherit the last one's scroll position.
	let list = $state<HTMLOListElement | undefined>();
	const follow = new FollowNewest();

	function placedIn(): string | undefined {
		return app.sessionPath ?? app.conversationId;
	}

	function onScroll() {
		follow.remember(placedIn(), list);
	}

	$effect(() => {
		entries; // re-runs on any change to the list, including a card's output growing
		if (!list) return;
		if (follow.switched(placedIn())) follow.land(placedIn(), list);
		else follow.keep(list);
	});

	/**
	 * The sheet grows to its height over 0.18s, and while it is closed the list is `display: none`, so it
	 * comes back at the top. Land at the newest entry once the height has settled, or the one line the
	 * peek advertised ("running bash · 5 entries") is not the line you are shown. `reduced-motion` removes
	 * the transition, not the wait, so the timer is the one path that covers both.
	 */
	let wasOpen = false;
	$effect(() => {
		if (sheet === wasOpen) return;
		wasOpen = sheet;
		const node = list;
		if (!sheet || !node) return;
		const land = () => follow.land(placedIn(), node);
		const timer = setTimeout(land, 220);
		return () => clearTimeout(timer);
	});

	/** The tool still running, if any: what the closed sheet's one line says first. */
	const runningTool = $derived.by(() => {
		for (const entry of entries) if (entry.kind === "tool" && entry.card.state === "running") return entry.card;
		return undefined;
	});

	/**
	 * The peek line — the whole of the closed sheet. It has to be worth the 51px: what is running, how much
	 * has happened, and the round when a goal is driving. The same values the open panel shows, composed
	 * here because Svelte's interpolated multi-branch text is what eats the `ui/**` branch floor.
	 */
	const peekLabel = $derived.by(() => {
		const count = `${entries.length} ${entries.length === 1 ? "entry" : "entries"}`;
		if (runningTool) return `running ${runningTool.name} · ${count}`;
		if (goal?.round) return `Activity · ${entries.length} · ${goal.round}`;
		if (!entries.length) return "Activity · nothing yet";
		return `Activity · ${count}`;
	});

	function toggle() {
		debugOpen = !debugOpen;
		// Ask when it is opened, not on a timer: the debug view is a snapshot of the live session.
		if (debugOpen) {
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

	/**
	 * The goal and its checklist, read off the tool cards alone (docs/goals.md 9.4): a session reopened from its
	 * file replays messages and nothing else, so the cards are the only goal view that survives it. Only a `done`
	 * card counts — the tool refuses a bad write with no list in the result, and a refusal must not repaint one.
	 *
	 * The strings are composed here rather than in the template: Svelte compiles every interpolated expression in
	 * text position into a nullish branch, and those are what has been eating the `ui/**` branch floor
	 * (docs/testing.md).
	 */
	const goal = $derived(goalOf(app.transcript));
	const tasks = $derived(tasksOf(app.transcript));

	/** The phase each action leaves the goal in. `edit` is absent — it rewords without moving — and `clear`
	 *  drops the goal before the lookup. The driver's cap-block is an entry rather than a card, so a goal the
	 *  round limit stopped still reads `active` here (docs/goals.md risk 10). */
	const PHASE: Record<string, string> = { create: "active", pause: "paused", resume: "active", complete: "complete", blocked: "blocked" };
	const GLYPH: Record<TaskStatus, string> = { completed: "✓", in_progress: "◐", pending: "○" };

	/** Where the conversation's own `goal` calls left it: the last objective, and the last phase it moved to. */
	function goalOf(transcript: Transcript): { objective: string; phase: string; round: string } | undefined {
		let objective = "";
		let phase = "";
		let maxRounds: number | undefined;
		for (const card of Object.values(transcript.tools)) {
			if (card.name !== GOAL_TOOL || card.state !== "done") continue;
			const args = card.args as { action?: string; objective?: string; max_rounds?: number } | undefined;
			if (!args?.action) continue;
			if (args.action === "clear") {
				objective = "";
				phase = "";
				maxRounds = undefined;
				continue;
			}
			if (args.objective) objective = args.objective;
			if (args.max_rounds !== undefined) maxRounds = args.max_rounds;
			phase = PHASE[args.action] ?? phase;
		}
		if (!objective) return undefined;
		return { objective, phase, round: roundLine(transcript.goalRound, maxRounds) };
	}

	/** `Round 3/16`. The cap is only in the cards when `create` was given `max_rounds`, and the round only
	 *  arrives with the live entries, so a reopened conversation shows neither and says nothing instead. */
	function roundLine(round: number | undefined, maxRounds: number | undefined): string {
		if (round === undefined) return "";
		return maxRounds === undefined ? `Round ${round}` : `Round ${round}/${maxRounds}`;
	}

	/** The last list the tool accepted. Every call replaces the whole list, so that write is the whole truth. */
	function tasksOf(transcript: Transcript): TaskItem[] {
		let list: TaskItem[] = [];
		for (const card of Object.values(transcript.tools)) {
			if (card.name !== TASK_TOOL || card.state !== "done") continue;
			const written = (card.args as { tasks?: TaskItem[] } | undefined)?.tasks;
			if (written) list = written;
		}
		return list;
	}

	function taskLine(task: TaskItem): string {
		return `${GLYPH[task.status] ?? "○"} ${task.content}`;
	}
</script>

<aside class="activity-panel" id="flypi-activity" aria-label="Thinking and tool activity">
	<!-- The sheet's only control, in both states: closed it is the peek line, open it stays at the top of the
		 panel. A bar button would be a second toggle to keep in agreement with this one. -->
	<button
		type="button"
		class="sheet-handle"
		aria-controls="flypi-activity"
		aria-expanded={sheet}
		title={sheet ? "Close the activity sheet" : "Open the activity sheet"}
		onclick={() => onsheet?.()}
	>
		{peekLabel}
	</button>

	{#if goal}
		<section class="goal-block" data-role="goal">
			<h2>Goal <span class="goal-phase" data-role="goal-phase">{goal.phase}</span></h2>
			<p class="goal-objective">{goal.objective}</p>
			{#if goal.round}
				<p class="goal-round" data-role="goal-round">{goal.round}</p>
			{/if}
		</section>
	{/if}

	{#if tasks.length}
		<section class="task-block">
			<h2>Tasks <span class="count">{tasks.length}</span></h2>
			<ul class="tasks" data-role="tasks">
				{#each tasks as task}
					<li data-status={task.status}>{taskLine(task)}</li>
				{/each}
			</ul>
		</section>
	{/if}

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
		<button type="button" class="debug-toggle" onclick={toggle}>{debugOpen ? "Hide debug" : "Debug"}</button>

		{#if debugOpen && app.debug}
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
		{:else if debugOpen}
			<p class="debug-empty">no debug info yet</p>
		{/if}

		{#if debugOpen}
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
