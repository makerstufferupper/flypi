<script lang="ts">
	import type { FlypiAppState } from "./lib/app-state.svelte.ts";
	import type { FlypiThinkingLevel } from "../src/agent/runtime.ts";
	import { base64Of, isImage, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, type FlypiAttachment } from "../src/shared/attachments.ts";
	import { renderMarkdown } from "../src/shared/markdown.ts";
	import { compact, formatUsage, type RenderedBlock, type RenderedMessage } from "../src/shared/transcript.ts";
	import { formatRate, speedsOf } from "../src/shared/metrics.ts";

	let { app }: { app: FlypiAppState } = $props();

	let draft = $state("");
	let followUp = $state(false);
	const queued = $derived([...app.transcript.queue.steering, ...app.transcript.queue.followUp]);

	// The model and the thinking level belong with the prompt they apply to, not with the sessions.
	const LEVELS: FlypiThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

	function pickModel(event: Event) {
		const [provider = "", ...rest] = (event.currentTarget as HTMLSelectElement).value.split("/");
		app.setModel(provider, rest.join("/"));
	}

	// This panel is the conversation: what was said and what came back. Thinking and tool output are
	// the machinery behind it, and live in the activity panel (ui/ActivityPanel.svelte).
	function spoken(message: RenderedMessage): RenderedBlock[] {
		return message.blocks.filter((block) => block.kind === "text" || block.kind === "image");
	}

	function send() {
		const text = draft.trim();
		if (!text && !attachments.length) return;
		// While a turn is running the same box steers it (or queues a follow-up if you asked for
		// one); pi's own queue does the rest, and `queue_update` is what shows it back to us.
		app.prompt(text, app.transcript.running ? (followUp ? "followUp" : "steer") : "steer", attachments);
		draft = "";
		attachments = [];
	}

	// A pasted file is attached, never typed into the box: an image goes to the model as an image, and any
	// other file is saved by the server and named by path, so the agent opens it with its own tools.
	// Both cross the wire as base64 inside the prompt command (src/shared/attachments.ts).
	let attachments = $state<FlypiAttachment[]>([]);
	let attachmentError = $state("");

	// pi-ai is the one that decides whether an image reaches the provider, and it decides from the model's
	// own `input` list: with text-only it replaces the image with the sentence "(image omitted: model does
	// not support images)", so the paste is silently unseen. The debug snapshot carries that list, so the box
	// says so at paste time. With no snapshot yet we do not know the model, and no message beats a wrong one.
	const seesImages = $derived(app.debug?.model?.input.includes("image") ?? true);

	async function attach(files: File[]): Promise<void> {
		attachmentError = "";
		for (const file of files) {
			if (attachments.length >= MAX_ATTACHMENTS) {
				attachmentError = `at most ${MAX_ATTACHMENTS} attachments`;
				return;
			}
			if (file.size > MAX_ATTACHMENT_BYTES) {
				attachmentError = `${file.name} is over ${Math.floor(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB`;
				continue;
			}
			if (!seesImages && isImage({ mimeType: file.type })) {
				attachmentError = `${file.name}: ${app.debug?.model?.modelId ?? "this model"} has no image input`;
				continue;
			}
			attachments.push({ name: file.name || "pasted", mimeType: file.type || "application/octet-stream", data: base64Of(await file.arrayBuffer()) });
		}
	}

	function onPaste(event: ClipboardEvent) {
		const files = [...(event.clipboardData?.files ?? [])];
		if (!files.length) return;
		// Without this the browser pastes the file's name, or nothing, into the box.
		event.preventDefault();
		void attach(files);
	}

	// Enter sends, Shift+Enter keeps the newline; the Send button goes through the form.
	function onKeydown(event: KeyboardEvent) {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			send();
		}
	}

	// Same as the activity panel: the newest message stays on screen, and scrolling up releases it.
	let list = $state<HTMLOListElement | undefined>();
	let following = $state(true);

	// pi dispatches a slash command itself — `session.prompt` runs an extension command before it sends
	// anything (docs/extensions.md) — so the box only has to say which ones this conversation has. The list
	// rides on the debug snapshot the chat already asks for, so there is no second request for it.
	const commandHints = $derived(
		draft.startsWith("/") ? (app.debug?.commands ?? []).filter((command) => command.name.startsWith(draft.slice(1).split(/\s/)[0])).slice(0, 8) : [],
	);
	// The answer to an extension's `ctx.ui.input`.
	let typed = $state("");

	function onScroll() {
		if (list) following = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
	}

	$effect(() => {
		app.transcript; // the reducer replaces the whole transcript per event, so this covers a streaming message too
		if (list && following) list.scrollTop = list.scrollHeight;
	});

	// The metrics strip. Speeds are measured from event arrival times (src/shared/metrics.ts); context
	// usage is pi's own estimate, which the server sends with the debug snapshot.
	// A rate the provider has reported keeps aging while its answer streams (its window grows with the
	// clock), so the strip re-reads the clock while a response streams.
	let tick = $state(0);
	$effect(() => {
		if (!app.metrics.live) return;
		tick = Date.now();
		const timer = setInterval(() => (tick = Date.now()), 500);
		return () => clearInterval(timer);
	});

	const rates = $derived(speedsOf(app.metrics, tick));
	const context = $derived(app.debug?.context);
	const percent = $derived(context?.percent ?? null);
	const contextText = $derived(
		!context || context.tokens === null
			? "context unknown"
			: `${compact(context.tokens)} / ${compact(context.contextWindow)} in context · ${Math.round(context.percent ?? 0)}%`,
	);

	function speed(value: number | null): string {
		return value === null ? "—" : `${formatRate(value)} tok/s`;
	}

	// A rate describes one chat on one model, so the strip says which one its numbers came from.
	const measuredBy = $derived(app.measuredOn ? `measured on ${app.measuredOn} in this chat` : "measured in this chat");

	/**
	 * A fresh install has no endpoint and no default, and the first prompt would only say
	 * `settings.json must set defaultProvider and defaultModel`. So the page says it first, and points at the
	 * one place that fixes it. The pair decides, not the list alone: with no endpoint but a default naming one
	 * of pi's built-in providers, a conversation does start.
	 */
	const noModel = $derived(!!app.config && app.config.endpoints.length === 0 && !app.config.defaults.provider);
	let setupDismissed = $state(false);

	/** The `<dialog>` does Escape, focus and an inert page behind; this only puts it on screen (as in SettingsPanel). */
	function modal(node: HTMLDialogElement): { destroy: () => void } {
		node.showModal();
		return { destroy: () => node.close() };
	}
</script>

{#snippet blocks(items: RenderedBlock[])}
	{#each items as block}
		{#if block.kind === "text"}
			<div class="markdown">{@html renderMarkdown(block.text)}</div>
		{:else if block.kind === "image"}
			<img class="attachment-image" src={`data:${block.mimeType};base64,${block.data}`} alt="attachment" loading="lazy" />
		{/if}
	{/each}
{/snippet}

<section class="chat" aria-label="Chat">
	{#if app.protocolMismatch}
		<p class="error" role="alert" data-role="protocol">{app.protocolMismatch}</p>
	{/if}
	{#if app.lastError}
		<p class="error" role="alert">{app.lastError}</p>
	{/if}
	{#if app.interruptedAt}
		<!-- Phase 4.5: the daemon knows which turn was in flight when it died. Saying so is the whole point of
		     the `runs` table — an answer that never came back otherwise looks like a model that stopped
		     talking, and its tools may already have written to the world. -->
		<p class="notice" role="status" data-role="interrupted">
			The turn in this chat was interrupted when flypi stopped ({app.interruptedAt}). It is not re-run: its
			tools may already have written to the world.
		</p>
	{/if}

	<ol class="messages" bind:this={list} onscroll={onScroll}>
		{#each app.transcript.messages as message}
			{#if spoken(message).length}
				<li class="msg" data-role={message.role}>
					<span class="role">{message.role}</span>
					{#if message.usage}
						<span class="usage" data-role="usage">{formatUsage(message.usage)}</span>
					{/if}
					{@render blocks(spoken(message))}
					<!-- Forking belongs on the answer it starts from, and only on answers: a prompt would
					     carry nothing. The seq is the identity this message arrived with, so the server
					     branches at this exact message, not at a position either side counted. -->
					{#if message.role === "assistant" && message.seq}
						<button
							type="button"
							class="icon fork"
							aria-label="Fork from this answer"
							title="Fork this session from this answer"
							onclick={() => app.fork(message.seq!)}
						>
							<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3v12m0 6a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm12-18a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm0 6a9 9 0 0 1-9 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
						</button>
					{/if}
				</li>
			{/if}
		{/each}

		{#if app.transcript.streaming && spoken(app.transcript.streaming).length}
			<li class="msg streaming" data-role={app.transcript.streaming.role}>
				<span class="role">{app.transcript.streaming.role}</span>
				{@render blocks(spoken(app.transcript.streaming))}
			</li>
		{/if}
	</ol>

	{#if queued.length}
		<ul class="queue" aria-label="Queued messages">
			{#each queued as text}<li class="queued">{text}</li>{/each}
		</ul>
	{/if}

	<!-- What an extension command said. pi keeps this out of the session file — `ctx.ui.notify` is a UI call,
	     not a message — so it is shown here rather than woven into the transcript it cannot be ordered against. -->
	{#if app.extensionNotes.length}
		<ul class="extension-output" aria-label="Extension output" data-role="extension-output">
			{#each app.extensionNotes as note}
				<li class="extension-note" data-level={note.level}>{note.message}</li>
			{/each}
		</ul>
	{/if}

	<!-- An extension is waiting on this: its handler is parked until the page answers, so Cancel is an answer
	     too (null is what pi's own dialogs report for a dismissed one). -->
	{#if app.extensionDialog}
		{@const dialog = app.extensionDialog}
		<div class="extension-dialog" role="group" aria-label={dialog.title || "Extension question"} data-role="extension-dialog">
			<p class="ask">{[dialog.title, dialog.message].filter(Boolean).join(" — ")}</p>
			<div class="answers">
				{#each dialog.options ?? [] as option}
					<button type="button" class="choice" data-role="extension-choice" onclick={() => app.answerExtension(dialog.dialogId!, option)}>{option}</button>
				{/each}
				{#if dialog.kind === "confirm"}
					<button type="button" class="choice" data-role="extension-yes" onclick={() => app.answerExtension(dialog.dialogId!, "yes")}>Yes</button>
				{/if}
				{#if dialog.kind === "input"}
					<form
						class="answer-input"
						onsubmit={(event) => {
							event.preventDefault();
							app.answerExtension(dialog.dialogId!, typed);
							typed = "";
						}}
					>
						<input bind:value={typed} placeholder={dialog.message} aria-label="Answer" />
						<button type="submit" data-role="extension-submit">Answer</button>
					</form>
				{/if}
				<button type="button" class="cancel" data-role="extension-cancel" onclick={() => app.answerExtension(dialog.dialogId!, null)}>Cancel</button>
			</div>
		</div>
	{/if}

	<div class="picker">
		<label class="field">
			Model
			<select class="model" onchange={pickModel}>
				{#if app.debug?.model}
					<option value={`${app.debug.model.provider}/${app.debug.model.modelId}`} selected>
						{app.debug.model.modelId} (current)
					</option>
				{/if}
				{#each app.debug?.models ?? [] as model}
					<option value={`${model.provider}/${model.modelId}`}>{model.provider}/{model.modelId}</option>
				{/each}
			</select>
		</label>
		<label class="field">
			Thinking
			<select
				class="thinking-level"
				onchange={(event) => app.setThinkingLevel((event.currentTarget as HTMLSelectElement).value as FlypiThinkingLevel)}
			>
				{#each LEVELS as level}
					<option value={level} selected={app.debug?.thinkingLevel === level}>{level}</option>
				{/each}
			</select>
		</label>
	</div>

	<form
		class="composer"
		onsubmit={(event) => {
			event.preventDefault();
			send();
		}}
	>
		{#if attachments.length}
			<ul class="attachments" aria-label="Attached files">
				{#each attachments as attachment, index}
					<li class="attachment">
						{#if isImage(attachment)}
							<img class="thumb" src={`data:${attachment.mimeType};base64,${attachment.data}`} alt="" />
						{/if}
						<span class="name">{attachment.name}</span>
						<button type="button" class="remove" aria-label={`Remove ${attachment.name}`} onclick={() => attachments.splice(index, 1)}>✕</button>
					</li>
				{/each}
			</ul>
		{/if}
		{#if attachmentError}<p class="error" role="alert" data-role="attachment">{attachmentError}</p>{/if}
		<textarea bind:value={draft} rows="3" onkeydown={onKeydown} onpaste={onPaste} placeholder={app.transcript.running ? "steer the running turn…" : "what should flypi do?"} aria-label="Prompt"></textarea>
		{#if commandHints.length}
			<!-- Clicking only completes the name: what runs is what gets sent, and pi answers the command. -->
			<ul class="commands" aria-label="Slash commands" data-role="commands">
				{#each commandHints as command}
					<li>
						<button type="button" class="command" data-role="command" title={command.source} onclick={() => (draft = `/${command.name} `)}>
							/{command.name}
							{#if command.description}<span class="desc">{command.description}</span>{/if}
						</button>
					</li>
				{/each}
			</ul>
		{/if}
		<div class="controls">
			<button type="submit">Send</button>
			{#if app.transcript.running}
				<label class="followup"><input type="checkbox" bind:checked={followUp} /> follow up</label>
				<button type="button" class="stop" onclick={() => app.abort()}>Stop</button>
			{/if}
			{#if !app.connected}<span class="offline">reconnecting…</span>{/if}

			<!-- Live metrics on the send row, pushed to the right of the buttons: the model's speed and how
				 full the context window is. The ring is a meter, so the percentage is announced as a number and
				 the text next to it carries the token counts. The rates belong to this chat on the model it is
				 using: they read live while a response streams, stay up as this chat's last answer once it is
				 done, and come back from the browser's own storage when you reopen the chat
				 (ui/lib/last-answer.ts). -->
			<div class="metrics" role="group" aria-label="Live model metrics">
				<div
					class="gauge"
					role="meter"
					aria-label="Context window used"
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={Math.round(percent ?? 0)}
					aria-valuetext={contextText}
					title={contextText}
				>
					<svg viewBox="0 0 20 20" aria-hidden="true">
						<circle class="track" cx="10" cy="10" r="7" pathLength="100" />
						<circle class="fill" cx="10" cy="10" r="7" pathLength="100" style="stroke-dasharray: {Math.max(0, Math.min(100, percent ?? 0))} 100" />
					</svg>
				</div>
				<span class="metric" data-role="context">{contextText}</span>
				<span class="metric" data-role="decode" title={measuredBy}>decode <b>{speed(rates.decode)}</b></span>
				<span class="metric" data-role="prefill" title={measuredBy}>prefill <b>{speed(rates.prefill)}</b></span>
			</div>
		</div>
	</form>

	{#if noModel && !setupDismissed}
		<!-- The same `<dialog>` idiom as the settings modal. The address bar is the link: `/settings` is the
		     URL that opens the page on the settings view (ui/lib/route.ts), so it can be middle-clicked or copied,
		     while the handler keeps the click inside the page. -->
		<dialog class="cfg-modal" data-role="no-endpoint" use:modal onclose={() => (setupDismissed = true)} aria-label="No model endpoint configured">
			<h3>No model endpoint configured</h3>
			<p class="cfg-note">flypi has no built-in default model, so a new conversation cannot start yet.</p>
			<div class="cfg-actions">
				<a
					href="/settings"
					data-role="no-endpoint-settings"
					onclick={(event) => {
						event.preventDefault();
						app.openSettings();
					}}
				>Open the settings page</a>
				<button type="button" data-role="no-endpoint-dismiss" onclick={() => (setupDismissed = true)}>Not now</button>
			</div>
		</dialog>
	{/if}
</section>
