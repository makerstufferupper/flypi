/**
 * The WS wire protocol (docs/protocol.md). One JSON object per frame, in both directions.
 *
 * Commands are validated on the way in — this is the trust boundary. The pi event payloads
 * carried by `event` frames are passed through unchanged, so a reassembled transcript is
 * identical to what the session emitted (that equality is Phase 1's feature, not a
 * nice-to-have). The frame around them is what this file owns: `seq`, `conversationId`,
 * `requestId`.
 */
import { Type, type Static } from "typebox";
import { Check, Errors } from "typebox/value";
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from "../shared/attachments.ts";

export const PROTOCOL_VERSION = 1;

const Id = Type.String({ minLength: 1, maxLength: 512 });
const RequestId = Type.String({ minLength: 1, maxLength: 100 });

/** `steer` interrupts the running turn, `followUp` waits for it. Required while streaming. */
const QueueMode = Type.Union([Type.Literal("steer"), Type.Literal("followUp")]);

/**
 * A pasted file (src/shared/attachments.ts). Bytes as base64, so the size limit is checked here as a
 * character count — the trust boundary cannot know what the bytes decode to.
 */
const Attachment = Type.Object({
	name: Type.String({ minLength: 1, maxLength: 200 }),
	mimeType: Type.String({ minLength: 1, maxLength: 100 }),
	data: Type.String({ minLength: 1, maxLength: Math.ceil(MAX_ATTACHMENT_BYTES * 4 / 3) }),
});

export const PromptCommand = Type.Object({
	type: Type.Literal("prompt"),
	conversationId: Id,
	/** Empty is allowed only with an attachment; the registry refuses a prompt that has neither. */
	text: Type.String(),
	attachments: Type.Optional(Type.Array(Attachment, { maxItems: MAX_ATTACHMENTS })),
	mode: Type.Optional(QueueMode),
	requestId: Type.Optional(RequestId),
});

export const AbortCommand = Type.Object({
	type: Type.Literal("abort"),
	conversationId: Id,
	requestId: Type.Optional(RequestId),
});

export const NewSessionCommand = Type.Object({
	type: Type.Literal("newSession"),
	cwd: Type.Optional(Id),
	requestId: Type.Optional(RequestId),
});

/** Rebind this conversation to an existing session file (the sidebar's "open"). */
export const SwitchSessionCommand = Type.Object({
	type: Type.Literal("switchSession"),
	conversationId: Id,
	sessionPath: Id,
	requestId: Type.Optional(RequestId),
});

/**
 * Branch the conversation at one of its answers, into a new conversation.
 *
 * The message is named by the `seq` of the `message_end` frame that carried it — the same number the
 * UI already holds for the message it is rendering. A position we each counted separately (nth answer,
 * nth rendered message) would have to agree across the wire by coincidence; the seq is the identity the
 * stream gave that message.
 */
export const ForkCommand = Type.Object({
	type: Type.Literal("fork"),
	conversationId: Id,
	messageSeq: Type.Integer({ minimum: 1 }),
	requestId: Type.Optional(RequestId),
});

export const SetModelCommand = Type.Object({
	type: Type.Literal("setModel"),
	conversationId: Id,
	provider: Id,
	modelId: Id,
	requestId: Type.Optional(RequestId),
});

export const SetThinkingLevelCommand = Type.Object({
	type: Type.Literal("setThinkingLevel"),
	conversationId: Id,
	level: Type.Union([
		Type.Literal("off"),
		Type.Literal("minimal"),
		Type.Literal("low"),
		Type.Literal("medium"),
		Type.Literal("high"),
		Type.Literal("xhigh"),
		Type.Literal("max"),
	]),
	requestId: Type.Optional(RequestId),
});

/**
 * The answer to an extension's question (`ctx.ui.select` / `confirm` / `input`, pushed as an
 * `extensionUi` frame). `value` is the option or the text; null is "cancelled", which is what pi's
 * own dialogs report when the user dismisses them.
 */
export const ExtensionReplyCommand = Type.Object({
	type: Type.Literal("extensionReply"),
	conversationId: Id,
	dialogId: Id,
	value: Type.Union([Type.String({ maxLength: 8000 }), Type.Null()]),
	requestId: Type.Optional(RequestId),
});

/** Reconnect: "send me everything after seq N". */
export const ResumeCommand = Type.Object({
	type: Type.Literal("resume"),
	conversationId: Id,
	afterSeq: Type.Integer({ minimum: 0 }),
	requestId: Type.Optional(RequestId),
});

/** The sidebar's "open": the session files flypi owns. No conversation needed. */
export const ListSessionsCommand = Type.Object({
	type: Type.Literal("listSessions"),
	requestId: Type.Optional(RequestId),
});

/** Rename the current conversation's session (pi's own session name, not a flypi side-store). */
export const RenameSessionCommand = Type.Object({
	type: Type.Literal("renameSession"),
	conversationId: Id,
	name: Type.String({ minLength: 1, maxLength: 200 }),
	requestId: Type.Optional(RequestId),
});

/**
 * Delete one session file, permanently. Path-scoped like `listSessions`: the sidebar's rows are
 * keyed by path, and deleting is not something you can undo. The `result` carries the refreshed
 * `sessions` list, so the row that was deleted is gone from the screen as soon as it is gone from disk.
 */
export const DeleteSessionCommand = Type.Object({
	type: Type.Literal("deleteSession"),
	sessionPath: Id,
	requestId: Type.Optional(RequestId),
});

/**
 * What the debug panel shows, and what the sidebar's model/thinking selectors list.
 * `memoryBlock` is the block the last turn actually injected, or null when none was.
 */
export const DebugCommand = Type.Object({
	type: Type.Literal("debug"),
	conversationId: Id,
	requestId: Type.Optional(RequestId),
});

/**
 * The scheduler: what is queued, when it next runs, and what the last runs did
 * (docs/architecture.md Phase 4.5). Not conversation-scoped — the queue belongs to the daemon.
 */
export const SchedulerCommand = Type.Object({
	type: Type.Literal("scheduler"),
	requestId: Type.Optional(RequestId),
});

/**
 * What the settings panel reads and edits: provider endpoints in `.flypi/agent/models.json` and MCP
 * servers in `.flypi/agent/mcp.json`. Neither is conversation-scoped — they are the agent dir's config,
 * like `listSessions` is the session files. `getConfig` answers with the current files; `saveConfig`
 * applies edits and answers with the refreshed files, so the panel shows what is on disk after the write.
 *
 * An edit carries only the fields the user touched, and `models` only *adds* ids: the files hold far
 * more than the panel shows (`compat`, `cost`, extra headers), and flypi never rewrites what it does not
 * show. `remove: true` deletes one entry. `files` is the exception, and the way to reach what the forms do
 * not hold: it replaces `models.json` or `settings.json` with the text typed in, checked against the text
 * the editor was shown. See `src/agent/config-files.ts`.
 */
export const GetConfigCommand = Type.Object({
	type: Type.Literal("getConfig"),
	requestId: Type.Optional(RequestId),
});

/** Names become provider keys and `mcp__<server>__<tool>` tool names, so the server's own rule is checked here. */
const ConfigName = Type.String({ minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" });
const Text = Type.String({ maxLength: 500 });
/**
 * The OAuth fields the panel edits. pi's others (`clientName`, `clientRegistration`, `callbackPort`,
 * `authServerMetadataUrl`) are read field by field as well, so an entry that has them keeps them.
 */
const OAuthFields = Type.Object({
	clientId: Type.Optional(Text),
	clientSecret: Type.Optional(Text),
	callbackUrl: Type.Optional(Text),
	scope: Type.Optional(Text),
});

/** pi's own tool-reach settings for a server (docs/mcp.md "Control tool exposure"). */
const McpExposure = Type.Union([
	Type.Literal("direct"),
	Type.Literal("deferred"),
	Type.Literal("codemode"),
	Type.Literal("hidden"),
]);

export const EndpointEdit = Type.Object({
	name: ConfigName,
	baseUrl: Type.Optional(Text),
	api: Type.Optional(Type.String({ maxLength: 100 })),
	/** May be a literal, `${ENV_VAR}` or `!command` — passed through exactly as pi reads it. */
	apiKey: Type.Optional(Text),
	models: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 100 })),
	remove: Type.Optional(Type.Literal(true)),
});

export const McpEdit = Type.Object({
	name: ConfigName,
	url: Type.Optional(Text),
	command: Type.Optional(Text),
	args: Type.Optional(Type.Array(Text, { maxItems: 100 })),
	/** Written as `headers.Authorization`; the other headers of an entry are never touched. */
	authorization: Type.Optional(Text),
	/** Written as the whole `env` map (a row carries every entry the file has); an empty value removes that key. */
	env: Type.Optional(Type.Record(Type.String(), Text)),
	cwd: Type.Optional(Text),
	description: Type.Optional(Text),
	exposure: Type.Optional(McpExposure),
	/** Per-tool overrides of `exposure`, keyed as pi reads them: an offered tool name or a `*` pattern. */
	toolExposure: Type.Optional(Type.Record(Type.String(), McpExposure)),
	oauth: Type.Optional(OAuthFields),
	enabled: Type.Optional(Type.Boolean()),
	remove: Type.Optional(Type.Literal(true)),
});

/**
 * Which endpoint a new conversation starts on — `defaultProvider` and `defaultModel` in
 * `.flypi/agent/settings.json`, the pair `resolveConfiguredModel()` reads (src/agent/runtime.ts).
 * The model is named as well as the provider because one endpoint can define several.
 */
export const DefaultsEdit = Type.Object({
	provider: ConfigName,
	model: Type.String({ minLength: 1, maxLength: 200 }),
});

/** The same pair as read from the file: plain strings, because settings.json may not name one yet. */
export const DefaultsRow = Type.Object({
	provider: Type.String(),
	model: Type.String(),
});

/**
 * The two files the settings view offers as text — everything its forms do not hold (`compat`, cost,
 * `contextWindow`, a model's `input`, settings.json's thinking level, tool list and `permissions`).
 * `mcp.json` is not one of them: its form already covers every field the daemon reads.
 */
const ConfigFileName = Type.Union([Type.Literal("models"), Type.Literal("settings")]);

/** One of those files, exactly as it is on disk — `""` when it does not exist yet. */
export const ConfigFileRow = Type.Object({
	name: ConfigFileName,
	text: Type.String(),
});

/**
 * Replace one of those files wholesale. `base` is the text the editor was loaded with: a file that has
 * moved since then is refused rather than overwritten, because these files hold credentials and the
 * panel's own lists write them too. The text has to parse as a JSON object — see `applyConfigEdits`.
 */
export const ConfigFileEdit = Type.Object({
	name: ConfigFileName,
	text: Type.String({ maxLength: 200_000 }),
	base: Type.Optional(Type.String({ maxLength: 200_000 })),
});

export const SaveConfigCommand = Type.Object({
	type: Type.Literal("saveConfig"),
	endpoints: Type.Optional(Type.Array(EndpointEdit, { maxItems: 50 })),
	mcpServers: Type.Optional(Type.Array(McpEdit, { maxItems: 50 })),
	/** Sets the default. Omitted means settings.json is not touched at all. */
	defaults: Type.Optional(DefaultsEdit),
	/** Replaces one of the two files with the text typed in the raw editor. */
	files: Type.Optional(Type.Array(ConfigFileEdit, { maxItems: 2 })),
	requestId: Type.Optional(RequestId),
});

/**
 * Are the configured MCP servers reachable? Asked for when the settings view is opened, never polled: a
 * probe spawns an stdio server and opens an HTTP connection, which is not something to do on a timer.
 * Answers with `mcpStatus` — flypi's own connections to those servers, not the ones a running conversation
 * happens to hold (src/agent/mcp-status.ts).
 */
export const McpStatusCommand = Type.Object({
	type: Type.Literal("mcpStatus"),
	requestId: Type.Optional(RequestId),
});

/**
 * Sign one configured MCP server in through the browser (docs/architecture.md Phase 5, risk 5). The request
 * stays open until the sign-in ends: the URL to open arrives as an `mcpAuth` frame, and the ack is the
 * refreshed `mcpStatus` — the row the user was looking at, now answering. A server this cannot sign in to
 * (a stdio entry, one with its own `Authorization` header) is an `error` frame for the `requestId`.
 */
export const McpSignInCommand = Type.Object({
	type: Type.Literal("mcpSignIn"),
	name: ConfigName,
	requestId: Type.Optional(RequestId),
});

/**
 * The address the browser was redirected to, pasted back for the sign-in named `name` — the answer to its
 * `mcpAuth` frame, so no `requestId` of its own. Empty cancels. Nothing else answers a sign-in: when the
 * browser can reach this machine, the loopback callback finishes it and no frame is needed.
 */
export const McpRedirectCommand = Type.Object({
	type: Type.Literal("mcpRedirect"),
	name: ConfigName,
	url: Type.String({ maxLength: 4096 }),
	requestId: Type.Optional(RequestId),
});

/**
 * One extension package: pi's own source string, kept exactly as `.flypi/agent/settings.json` holds it — an
 * npm spec, a git URL or a path (pi's docs/packages.md). No name pattern: a URL and a path are both legal.
 */
const PackageSource = Type.String({ minLength: 1, maxLength: 500 });

/**
 * What the settings view lists for `packages`. `installed` is false when the entry names something the code
 * is not on disk for yet; `update` is the daemon's daily answer (src/agent/packages.ts), never a live check —
 * asking the registries and every git remote is not something to do when a panel opens.
 */
export const PackageRow = Type.Object({
	source: Type.String({ minLength: 1 }),
	scope: Type.Union([Type.Literal("user"), Type.Literal("project")]),
	installed: Type.Boolean(),
	path: Type.String(),
	update: Type.Optional(Type.Boolean()),
});

export const PackagesSnapshot = Type.Object({
	packages: Type.Array(PackageRow),
	/** When the daemon last asked the registries; absent until it has. */
	checkedAt: Type.Optional(Type.String()),
	/** A `settings.json` pi could not read — said, rather than shown as "no packages". */
	errors: Type.Array(Type.String()),
});

/**
 * The extension packages the agent loads, as `.flypi/agent/settings.json` declares them. Asked when the
 * settings view opens; reaches no network (src/agent/packages.ts).
 */
export const PackagesCommand = Type.Object({
	type: Type.Literal("packages"),
	requestId: Type.Optional(RequestId),
});

/**
 * Install, remove or update packages. pi's own package manager does it, so its source forms and its rules
 * apply: a source naming a version or a git ref is pinned and `update` leaves it where it is. The install
 * runs npm or git, which takes seconds — the page shows a busy state rather than polling. The `result` carries
 * the refreshed list; a source pi could not install is an `error` frame, and edits earlier in the same request
 * have already been applied.
 */
export const SavePackagesCommand = Type.Object({
	type: Type.Literal("savePackages"),
	install: Type.Optional(Type.Array(PackageSource, { maxItems: 10 })),
	remove: Type.Optional(Type.Array(PackageSource, { maxItems: 10 })),
	update: Type.Optional(Type.Array(PackageSource, { maxItems: 10 })),
	requestId: Type.Optional(RequestId),
});

/** What kind of secret a row claims to be — the same list the vault's schema allows (src/secrets/crypto.ts). */
export const SecretKind = Type.Union([
	Type.Literal("password"),
	Type.Literal("ssh_private_key"),
	Type.Literal("ssh_public_key"),
	Type.Literal("yaml"),
	Type.Literal("generic"),
]);

/**
 * The vault (docs/secrets.md Phase 5.5). Asked for when the Secrets tab is opened, like the config files are:
 * nothing here is polled, and a snapshot never carries a value — only masks, counters and key state. The
 * plaintext comes from `revealSecret`, one name at a time, and the page forgets it again after a few seconds.
 */
export const SecretsCommand = Type.Object({
	type: Type.Literal("secrets"),
	requestId: Type.Optional(RequestId),
});

/**
 * Install the update the daemon has already downloaded, now rather than at the idle moment
 * (docs/architecture.md Phase 7). The install replaces the files the daemon runs from, so it restarts and
 * this socket drops with it — the page re-reads its token and reconnects (ui/lib/client.ts). A process that
 * does not manage its own updates (a checkout, a headless server, nothing downloaded) answers an error frame.
 */
export const InstallUpdateCommand = Type.Object({
	type: Type.Literal("installUpdate"),
	requestId: Type.Optional(RequestId),
});
/**
 * One edit to one secret. `value` means put (or rotate, when the name is already there); `remove` is a
 * tombstone; `restore` is the undo that tombstone makes possible without the page ever holding the value.
 */
export const SecretEdit = Type.Object({
	name: Type.String({ minLength: 1, maxLength: 120 }),
	kind: Type.Optional(SecretKind),
	value: Type.Optional(Type.String({ maxLength: 65_536 })),
	/** Non-secret by convention (host, username, the path of an SSH key). Omitted means "leave what is stored". */
	meta: Type.Optional(Type.Record(Type.String(), Type.String())),
	remove: Type.Optional(Type.Boolean()),
	restore: Type.Optional(Type.Boolean()),
});

export const SaveSecretsCommand = Type.Object({
	type: Type.Literal("saveSecrets"),
	secrets: Type.Array(SecretEdit, { maxItems: 20 }),
	requestId: Type.Optional(RequestId),
});

/** Ask for one value, once. This is the only frame in the protocol that carries a secret in plaintext. */
export const RevealSecretCommand = Type.Object({
	type: Type.Literal("revealSecret"),
	name: Type.String({ minLength: 1, maxLength: 120 }),
	requestId: Type.Optional(RequestId),
});

/**
 * The memory browser (docs/memory.md Phase 6). Asked when the Memory view opens, like the vault is: nothing
 * here is polled. The snapshot is the store as it stands — every row in every status (so a superseded chain
 * and a tombstone are both visible), the turns that say what recall was shown and what an answer cited, the
 * wiki as it was last rendered, and the hit-rate numbers.
 *
 * It is a **read of the store**, not a search: the browser filters what it was given, so a row that a search
 * would rank last is still listed. And it is answered only by the process that owns the memory database —
 * `flypi start` writes it, the dev server reads it, and a process with neither says so in an error frame
 * rather than showing an empty store.
 */
export const MemoryCommand = Type.Object({
	type: Type.Literal("memory"),
	requestId: Type.Optional(RequestId),
});

/** One change to one memory. Editing is the browser's, and it is the only place a memory is edited at all —
 *  no automatic pass edits a body, and nothing here can set provenance. */
export const MemoryEdit = Type.Object({
	id: Type.Integer({ minimum: 1 }),
	body: Type.Optional(Type.String({ minLength: 1, maxLength: 8000 })),
	kind: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })),
	tags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 60 }), { maxItems: 20 })),
	/** A tombstone, never a removal: `status='deleted'` takes a user action and stays undoable. */
	remove: Type.Optional(Type.Boolean()),
	/** Reverse one audited change — the undo for anything a sweep did, and for a delete. */
	undoAudit: Type.Optional(Type.Integer({ minimum: 1 })),
});

export const SaveMemoryCommand = Type.Object({
	type: Type.Literal("saveMemory"),
	memories: Type.Array(MemoryEdit, { maxItems: 20 }),
	requestId: Type.Optional(RequestId),
});

/** One audited change to a memory, oldest first. `preImage` is the stored JSON text, shown rather than
 *  re-rendered: it is what the row looked like before, and the page has no business guessing at columns. */
export const MemoryAuditRow = Type.Object({
	id: Type.Integer(),
	action: Type.String(),
	actor: Type.String(),
	reason: Type.String(),
	createdAt: Type.String(),
	preImage: Type.String(),
});

export const MemoryEntryRow = Type.Object({
	id: Type.Integer(),
	kind: Type.String(),
	body: Type.String(),
	tags: Type.Array(Type.String()),
	status: Type.Union([Type.Literal("active"), Type.Literal("superseded"), Type.Literal("deleted")]),
	/** Authority, set by code at write time and never by the body: the browser shows it because a reader
	 *  cannot use authority it cannot see. */
	originClass: Type.Union([Type.Literal("owner"), Type.Literal("agent"), Type.Literal("untrusted"), Type.Literal("system")]),
	sessionKind: Type.String(),
	strength: Type.Number(),
	useCount: Type.Integer(),
	citedCount: Type.Integer(),
	createdAt: Type.String(),
	lastVerifiedAt: Type.Union([Type.String(), Type.Null()]),
	/** The supersede chain, in both directions, so a merged row can be traced to what replaced it. */
	supersedes: Type.Union([Type.Integer(), Type.Null()]),
	supersededBy: Type.Union([Type.Integer(), Type.Null()]),
	mergedFrom: Type.Array(Type.Integer()),
	history: Type.Array(MemoryAuditRow),
});

/**
 * One recorded turn: the question, which rows recall fetched for it, which ones the answer cited, and what
 * the fetched rows would have cost in prompt tokens. That last number is what makes "why was this injected"
 * answerable in cost rather than in feelings, and it is an estimate (`estimateTokens`) because the store
 * keeps text, not a tokenizer.
 */
export const MemoryTurnRow = Type.Object({
	id: Type.Integer(),
	conversationId: Type.String(),
	createdAt: Type.String(),
	userText: Type.String(),
	retrieved: Type.Array(Type.Integer()),
	cited: Type.Array(Type.Integer()),
	injectedTokens: Type.Integer(),
});

export const WikiSectionRow = Type.Object({
	heading: Type.String(),
	body: Type.String(),
	claimIds: Type.Array(Type.Integer()),
});

export const WikiPageRow = Type.Object({
	slug: Type.String(),
	title: Type.String(),
	topicKey: Type.String(),
	body: Type.String(),
	claimIds: Type.Array(Type.Integer()),
	/** Null while the prose is the template's rather than a model's (src/memory/wiki.ts). */
	model: Type.Union([Type.String(), Type.Null()]),
	generatedAt: Type.String(),
	sections: Type.Array(WikiSectionRow),
});

export const MemoryStats = Type.Object({
	turns: Type.Integer(),
	turnsShownMemories: Type.Integer(),
	turnsCiting: Type.Integer(),
	memoriesRetrieved: Type.Integer(),
	memoriesCited: Type.Integer(),
	rate: Type.Number(),
	/** The embedding index: how many active rows have a vector, and how many of them are from another model. */
	indexRows: Type.Integer(),
	indexStale: Type.Integer(),
	embedModel: Type.Union([Type.String(), Type.Null()]),
});

export const MemorySnapshot = Type.Object({
	memories: Type.Array(MemoryEntryRow),
	turns: Type.Array(MemoryTurnRow),
	wiki: Type.Array(WikiPageRow),
	stats: MemoryStats,
});

export const ClientCommandSchema = Type.Union([
	PromptCommand,
	AbortCommand,
	NewSessionCommand,
	SwitchSessionCommand,
	ForkCommand,
	SetModelCommand,
	SetThinkingLevelCommand,
	ResumeCommand,
	ExtensionReplyCommand,
	ListSessionsCommand,
	RenameSessionCommand,
	DeleteSessionCommand,
	DebugCommand,
	SchedulerCommand,
	GetConfigCommand,
	SaveConfigCommand,
	McpStatusCommand,
	McpSignInCommand,
	McpRedirectCommand,
	PackagesCommand,
	SavePackagesCommand,
	SecretsCommand,
	SaveSecretsCommand,
	RevealSecretCommand,
	MemoryCommand,
	SaveMemoryCommand,
	InstallUpdateCommand,
]);
export type ClientCommand = Static<typeof ClientCommandSchema>;

/** A pi session event, passed through verbatim. Only the discriminator is checked here. */
export const SessionEventFrameBody = Type.Object({ type: Type.String() }, { additionalProperties: true });

/** Which pi answers (docs/pi-upgrades.md Phase 8.1): the version loaded, and what chose it. */
export const PiInfoFrame = Type.Object({
	version: Type.String(),
	pinned: Type.Boolean(),
	/** What the tree flypi was installed with holds, when that is not what is running. */
	bundled: Type.Optional(Type.String()),
});

export const HelloFrame = Type.Object({
	type: Type.Literal("hello"),
	protocolVersion: Type.Integer(),
	serverVersion: Type.String(),
	/** Optional so an older server still parses; every flypi server from here on sends it. */
	pi: Type.Optional(PiInfoFrame),
});

export const EventFrame = Type.Object({
	type: Type.Literal("event"),
	conversationId: Id,
	seq: Type.Integer({ minimum: 1 }),
	event: SessionEventFrameBody,
});

/** A row in the sidebar. `firstMessage` is pi's own excerpt, so flypi stores nothing extra. */
export const SessionSummary = Type.Object({
	path: Id,
	name: Type.Optional(Type.String()),
	modified: Type.String(),
	messageCount: Type.Integer(),
	firstMessage: Type.String(),
});

/**
 * pi's own context estimate for the session (`AgentSession.getContextUsage()`): what the next request
 * would carry, against the model's window. `tokens`/`percent` are null when pi cannot know yet — right
 * after a compaction, before the next LLM response.
 */
export const ContextUsage = Type.Object({
	tokens: Type.Union([Type.Number(), Type.Null()]),
	contextWindow: Type.Number(),
	percent: Type.Union([Type.Number(), Type.Null()]),
});

export const ModelEntry = Type.Object({
	provider: Id,
	modelId: Type.String(),
	/**
	 * pi's own capability list (`["text"]`, `["text", "image"]`, …), passed through rather than translated:
	 * it is the field pi-ai itself uses to decide whether an image reaches the provider, so it is the only
	 * honest way to say "this model cannot see what you pasted". Empty means the model declares nothing.
	 */
	input: Type.Array(Type.String()),
});

/**
 * One slash command the session answers to, as the chat's `/` list shows it. `name` is what has to be
 * typed: pi's own invocation name, so a command whose name collides with a built-in one arrives as
 * `name:2` rather than being unreachable.
 */
export const CommandRow = Type.Object({
	name: Type.String({ minLength: 1 }),
	description: Type.String(),
	source: Type.Union([Type.Literal("extension"), Type.Literal("prompt")]),
});

export const DebugInfo = Type.Object({
	systemPrompt: Type.String(),
	activeTools: Type.Array(Type.String()),
	/** Every slash command this conversation has: extensions first, then prompt templates. */
	commands: Type.Array(CommandRow),
	models: Type.Array(ModelEntry),
	model: Type.Optional(ModelEntry),
	thinkingLevel: Type.String(),
	sessionName: Type.Optional(Type.String()),
	/**
	 * The `<relevant_memories>` block the last turn actually injected, or null when none was — the
	 * provenance for automatic recall (docs/memory.md Phase 4). It is not what a recall *would* return
	 * now, and it is cleared when a new turn starts. The block is never in the session file or an export,
	 * so this snapshot is the only place it is visible.
	 */
	memoryBlock: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	/** The chat's context gauge. Absent only when the session has no usable model window. */
	context: Type.Optional(ContextUsage),
});

/**
 * One row of a config file, as the panel shows it. Names are plain strings here: a file the user edited
 * by hand may hold something the panel did not write, and showing it beats refusing the whole snapshot.
 */
export const EndpointRow = Type.Object({
	name: Type.String({ minLength: 1 }),
	baseUrl: Type.String(),
	api: Type.String(),
	apiKey: Type.String(),
	models: Type.Array(Type.String()),
});

export const McpRow = Type.Object({
	name: Type.String({ minLength: 1 }),
	url: Type.String(),
	command: Type.String(),
	args: Type.Array(Type.String()),
	authorization: Type.String(),
	env: Type.Record(Type.String(), Type.String()),
	cwd: Type.String(),
	description: Type.String(),
	exposure: McpExposure,
	toolExposure: Type.Record(Type.String(), McpExposure),
	oauth: Type.Object({ clientId: Type.String(), clientSecret: Type.String(), callbackUrl: Type.String(), scope: Type.String() }),
	enabled: Type.Boolean(),
});

export const ConfigSnapshot = Type.Object({
	endpoints: Type.Array(EndpointRow),
	mcpServers: Type.Array(McpRow),
	/** What a new conversation would start on; empty strings when settings.json does not say. */
	defaults: DefaultsRow,
	/** `models.json` and `settings.json` as their exact bytes, for the raw editor. */
	files: Type.Array(ConfigFileRow),
	/** A config file that will not parse — the panel says so instead of listing an empty config. */
	errors: Type.Array(Type.String()),
});

/**
 * One server as the status panel shows it. `tools` is what the server announced when it answered — the two
 * flags are its own annotations (`destructiveHint`, `openWorldHint`), never flypi's guess, and a tool that
 * announced nothing reads as `false`/`false`. This is what a user reads to decide which names belong on
 * `permissions.askBeforeUse` (src/agent/permission-gate.ts), because that gate only ever sees a tool name.
 */
export const McpToolRow = Type.Object({
	name: Type.String({ minLength: 1 }),
	destructive: Type.Boolean(),
	openWorld: Type.Boolean(),
});

export const McpStatusRow = Type.Object({
	name: Type.String({ minLength: 1 }),
	/** "not answering" is a state of its own: a server that hangs is not the same as one that refused. */
	state: Type.Union([Type.Literal("connected"), Type.Literal("disabled"), Type.Literal("failed"), Type.Literal("needs-auth")]),
	transport: Type.Union([Type.Literal("http"), Type.Literal("stdio")]),
	/** The server's own words, for `failed` and `needs-auth`. */
	error: Type.Optional(Type.String()),
	tools: Type.Array(McpToolRow),
});

export const McpStatusSnapshot = Type.Object({
	servers: Type.Array(McpStatusRow),
	/** The tail of what pi's MCP extension logged for the connections a session really made. Empty when nothing was logged. */
	log: Type.String(),
});

/**
 * One secret as the vault reports it. There is no value field, by construction: the mask is what a list, a
 * debug frame and this page are allowed to hold. `fingerprint` is a hash, so it identifies a value without
 * showing it — which is how a user tells two rows with the same mask apart.
 */
export const SecretRow = Type.Object({
	id: Type.Integer(),
	name: Type.String(),
	kind: SecretKind,
	mask: Type.String(),
	meta: Type.Record(Type.String(), Type.String()),
	status: Type.Union([Type.Literal("active"), Type.Literal("deleted")]),
	createdAt: Type.String(),
	updatedAt: Type.Optional(Type.String()),
	lastUsedAt: Type.Optional(Type.String()),
	useCount: Type.Integer(),
	keyVersion: Type.Integer(),
	fingerprint: Type.String(),
});

/**
 * A config entry that points at a vault name (`!flypi secret print NAME`). This is the "used by" half: a
 * secret cannot be deleted safely without knowing which auth.json or mcp.json entry would stop working, and
 * the vault itself cannot know — the files are the only place that relationship is written down.
 */
export const SecretReferenceRow = Type.Object({
	file: Type.String(),
	path: Type.String(),
	name: Type.String(),
});

export const KeyState = Type.Object({
	provider: Type.String(),
	currentVersion: Type.Integer(),
	rows: Type.Integer(),
	/** Rows still sealed under an older key: the drift the status panel surfaces (docs/secrets.md). */
	stale: Type.Integer(),
	reencryptQueued: Type.Boolean(),
});

export const SecretsSnapshot = Type.Object({
	secrets: Type.Array(SecretRow),
	references: Type.Array(SecretReferenceRow),
	key: KeyState,
	/** A secret too short to redact from a memory or a transcript (src/secrets/redact.ts). Shown, not hidden. */
	tooShortToRedact: Type.Array(Type.String()),
	/** A vault this process could not open, in the panel's words rather than an empty list. */
	error: Type.Optional(Type.String()),
});

/** One revealed value. Transient on both sides: the page drops it after a few seconds. */
export const RevealedSecret = Type.Object({
	name: Type.String(),
	value: Type.String(),
});

/**
 * One row of the daemon's job queue, and one recorded attempt. `detail` is what the job reported —
 * for `memory.reembed`, which ids it re-embedded — and the reason it failed when it failed.
 */
export const JobRow = Type.Object({
	kind: Type.String(),
	nextRunAt: Type.String(),
	running: Type.Boolean(),
});

export const JobRunRow = Type.Object({
	kind: Type.String(),
	status: Type.Union([Type.Literal("running"), Type.Literal("ok"), Type.Literal("failed")]),
	startedAt: Type.String(),
	finishedAt: Type.Optional(Type.String()),
	detail: Type.Optional(Type.String()),
});

export const SchedulerSnapshot = Type.Object({
	jobs: Type.Array(JobRow),
	jobRuns: Type.Array(JobRunRow),
});

/**
 * A turn the daemon found half-finished when it started (its row was still `running`). The chat says
 * so when it opens that session rather than letting the missing answer look like a bug (Phase 4.5).
 */
export const InterruptedRun = Type.Object({
	at: Type.String(),
});

export const ResultFrame = Type.Object({
	type: Type.Literal("result"),
	requestId: RequestId,
	conversationId: Type.Optional(Id),
	sessionPath: Type.Optional(Id),
	sessions: Type.Optional(Type.Array(SessionSummary)),
	debug: Type.Optional(DebugInfo),
	mcpStatus: Type.Optional(McpStatusSnapshot),
	config: Type.Optional(ConfigSnapshot),
	packages: Type.Optional(PackagesSnapshot),
	scheduler: Type.Optional(SchedulerSnapshot),
	secrets: Type.Optional(SecretsSnapshot),
	revealed: Type.Optional(RevealedSecret),
	memory: Type.Optional(MemorySnapshot),
	interrupted: Type.Optional(InterruptedRun),
});

/**
 * The URL a sign-in needs opened (src/agent/mcp-signin.ts). Pushed while the `mcpSignIn` request is still
 * open, and the only frame of its kind: it belongs to a sign-in the page started, not to a request it is
 * waiting on. The page shows it as a link and a paste box.
 */
export const McpAuthFrame = Type.Object({
	type: Type.Literal("mcpAuth"),
	name: ConfigName,
	url: Type.String({ minLength: 1, maxLength: 4096 }),
});

/**
 * An extension spoke to the user (`src/server/extension-ui.ts`). `notify` needs no answer; `select`,
 * `confirm` and `input` carry a `dialogId` the page answers with an `extensionReply` command, and the
 * extension's handler waits for it. Nothing else on pi's extension UI surface has a browser equivalent,
 * so those calls stay no-ops.
 */
export const ExtensionUiFrame = Type.Object({
	type: Type.Literal("extensionUi"),
	conversationId: Id,
	kind: Type.Union([
		Type.Literal("notify"),
		Type.Literal("select"),
		Type.Literal("confirm"),
		Type.Literal("input"),
	]),
	message: Type.String(),
	title: Type.Optional(Type.String()),
	/** The choices for a `select`. */
	options: Type.Optional(Type.Array(Type.String())),
	level: Type.Optional(Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")])),
	dialogId: Type.Optional(Id),
});

export const ErrorFrame = Type.Object({
	type: Type.Literal("error"),
	message: Type.String(),
	/** Stable reason for clients: `replay_gap` means some events were already evicted. */
	code: Type.Optional(Type.String()),
	conversationId: Type.Optional(Id),
	requestId: Type.Optional(RequestId),
});

export const ServerFrameSchema = Type.Union([HelloFrame, EventFrame, ResultFrame, McpAuthFrame, ExtensionUiFrame, ErrorFrame]);
export type HelloFrame = Static<typeof HelloFrame>;
export type EventFrame = Static<typeof EventFrame>;
export type ResultFrame = Static<typeof ResultFrame>;
export type ErrorFrame = Static<typeof ErrorFrame>;
export type McpAuthFrame = Static<typeof McpAuthFrame>;
export type ExtensionUiFrame = Static<typeof ExtensionUiFrame>;
export type CommandRow = Static<typeof CommandRow>;
export type ServerFrame = Static<typeof ServerFrameSchema>;
export type SessionSummary = Static<typeof SessionSummary>;
export type DebugInfo = Static<typeof DebugInfo>;
export type ConfigSnapshot = Static<typeof ConfigSnapshot>;
export type SchedulerSnapshot = Static<typeof SchedulerSnapshot>;
export type JobRow = Static<typeof JobRow>;
export type JobRunRow = Static<typeof JobRunRow>;
export type InterruptedRun = Static<typeof InterruptedRun>;
export type DefaultsEdit = Static<typeof DefaultsEdit>;
export type DefaultsRow = Static<typeof DefaultsRow>;
export type ConfigFileRow = Static<typeof ConfigFileRow>;
export type ConfigFileEdit = Static<typeof ConfigFileEdit>;
export type EndpointRow = Static<typeof EndpointRow>;
export type McpRow = Static<typeof McpRow>;
export type McpStatusRow = Static<typeof McpStatusRow>;
export type McpToolRow = Static<typeof McpToolRow>;
export type McpStatusSnapshot = Static<typeof McpStatusSnapshot>;
export type EndpointEdit = Static<typeof EndpointEdit>;
export type McpEdit = Static<typeof McpEdit>;
export type McpExposure = Static<typeof McpExposure>;
export type McpOAuth = Static<typeof OAuthFields>;
export type PackageRow = Static<typeof PackageRow>;
export type PackagesSnapshot = Static<typeof PackagesSnapshot>;
export type SecretKind = Static<typeof SecretKind>;
export type SecretRow = Static<typeof SecretRow>;
export type SecretReferenceRow = Static<typeof SecretReferenceRow>;
export type SecretsSnapshot = Static<typeof SecretsSnapshot>;
export type RevealedSecret = Static<typeof RevealedSecret>;
export type KeyState = Static<typeof KeyState>;
export type SecretEdit = Static<typeof SecretEdit>;
export type MemoryEdit = Static<typeof MemoryEdit>;
export type MemoryEntryRow = Static<typeof MemoryEntryRow>;
export type MemoryAuditRow = Static<typeof MemoryAuditRow>;
export type MemoryTurnRow = Static<typeof MemoryTurnRow>;
export type MemoryStats = Static<typeof MemoryStats>;
export type MemorySnapshot = Static<typeof MemorySnapshot>;
export type WikiPageRow = Static<typeof WikiPageRow>;
export type WikiSectionRow = Static<typeof WikiSectionRow>;
export type ModelEntry = Static<typeof ModelEntry>;
export type ContextUsage = Static<typeof ContextUsage>;

/** Parse a client frame. Never throws: a bad frame is an error message, not a stack trace. */
export function parseClientCommand(raw: string): { ok: true; command: ClientCommand } | { ok: false; message: string } {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (error) {
		return { ok: false, message: `not JSON: ${(error as Error).message}` };
	}
	if (Check(ClientCommandSchema, value)) return { ok: true, command: value };
	return { ok: false, message: `not a flypi command: ${describe(ClientCommandSchema, value)}` };
}

export function encodeFrame(frame: ServerFrame): string {
	return JSON.stringify(frame);
}

/** Validate a frame before sending it. Used by the tests; a malformed frame is our bug. */
export function checkServerFrame(frame: unknown): { ok: true } | { ok: false; message: string } {
	if (Check(ServerFrameSchema, frame)) return { ok: true };
	return { ok: false, message: describe(ServerFrameSchema, frame) };
}

// `Errors` reports a reason for every `Check` failure, so the joined list is never empty.
function describe(schema: unknown, value: unknown): string {
	return Errors(schema as never, value)
		.slice(0, 3)
		.map((error) => `${error.instancePath} ${error.keyword}`)
		.join("; ");
}
