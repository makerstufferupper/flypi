/**
 * The redaction boundary (docs/secrets.md Phase 5.5).
 *
 * A secret's value is not stored anywhere except in a row of the vault, but it passes through a conversation
 * as often as a user or a tool mentions it: memory bodies, turn rows, tool output, the HTML export, and the
 * context of every later turn. So every durable write in flypi calls `redactSecrets` — `src/memory/store.ts`
 * for turns and memory bodies, `src/daemon/jobs.ts` for job details, and the session extension in
 * `src/secrets/extension.ts` for tool results and what the model says back.
 *
 * Which values count as secrets is *read from the vault*, not pushed at it: `setSecretSource` names where to
 * ask, and the list is rebuilt when it is older than `DEFAULT_MAX_AGE_MS`. That is deliberate. The process
 * that redacts is usually not the process that edits the vault — `flypi secret put` is its own process, and
 * the memory server is another — and a pull with a short TTL needs no signalling between them. A process that
 * changes the vault invalidates the cache itself, so it never redacts with a stale list.
 *
 * What is not here: the vault, or anything that decrypts. This module is given plaintext and turns text into
 * text; `redactSecrets` is called on the hot path of every turn and must stay that cheap to reason about.
 */

/** A placeholder must not survive a second pass as someone else's secret. */
export const placeholder = (name: string): string => `[secret:${name}]`;

/**
 * Below this, a value is not treated as a secret when redacting text. `hunter2` is a password; redacting
 * every occurrence of `token` inside a memory about tokens would shred the memory. The vault refuses a name
 * of its own below four characters, and anything shorter than this is reported by the status surface rather
 * than redacted.
 */
export const MIN_SECRET_CHARS = 6;

/**
 * How long a redactor may answer from the list it already read. Short enough that a secret stored in another
 * process is protected within a turn or two; long enough that storing one does not mean a decrypt of the
 * whole vault before every memory write.
 */
export const DEFAULT_MAX_AGE_MS = 5_000;

export interface ActiveSecret {
	name: string;
	value: string;
}

let source: (() => ActiveSecret[]) | undefined;
let maxAgeMs = DEFAULT_MAX_AGE_MS;
let cached: ActiveSecret[] | undefined;
let cachedAt = 0;
let sorted: string[] = [];
/** Each value → the placeholders it maps to. A value stored under two names redacts to both, so the text says which. */
let placeholders = new Map<string, string>();

/**
 * Where this process asks for the current secrets — usually `() => vault.activeValues()`. The list is
 * decrypted on demand, once per `DEFAULT_MAX_AGE_MS`, and `invalidateSecrets()` ends that window the moment
 * this process changes the vault.
 */
export function setSecretSource(next: () => ActiveSecret[], options: { maxAgeMs?: number } = {}): void {
	source = next;
	maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
	invalidateSecrets();
}

/**
 * This process is finished with the vault it was reading (a CLI that opened one and closed it, or a daemon
 * shutting down). Redaction goes back to matching nothing: a source pointing at a closed database would
 * otherwise turn an unrelated write into an error three frames away from the cause.
 */
export function closeSecretSource(): void {
	source = undefined;
	invalidateSecrets();
	buildIndex([]);
}

/** Drop what this process has read, so the next redaction asks again. */
export function invalidateSecrets(): void {
	cached = undefined;
	cachedAt = 0;
}

function currentSecrets(): ActiveSecret[] {
	// The cache is the whole point — a memory write must not decrypt the vault — and its expiry is the whole
	// point of the cache being allowed at all: a secret stored by another process still gets redacted.
	if (cached !== undefined && Date.now() - cachedAt < maxAgeMs) return cached;
	const list = source === undefined ? [] : source();
	cached = list;
	cachedAt = Date.now();
	buildIndex(list);
	return list;
}

/** The active values, longest first, so `sk-very-long` wins over `sk` inside the same string. */
function buildIndex(list: ActiveSecret[]): void {
	sorted = list.map((secret) => secret.value).filter((value) => value.length >= MIN_SECRET_CHARS).sort((a, b) => b.length - a.length);
	placeholders = new Map<string, string>();
	for (const { name, value } of list) {
		const mark = placeholders.get(value) ?? "";
		placeholders.set(value, mark === "" ? placeholder(name) : `${mark}${placeholder(name)}`);
	}
}

/** The names of the active values too short to redact — the gap in this boundary, made visible. */
export function shortSecrets(): string[] {
	return currentSecrets()
		.filter((secret) => secret.value.length < MIN_SECRET_CHARS)
		.map((secret) => secret.name)
		.sort();
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pattern(): RegExp | undefined {
	// Reads the source first (and only re-reads it when the cached list has aged out), then matches. Kept in
	// one place so `redactSecrets` and `containsSecret` cannot disagree about what the current secrets are.
	currentSecrets();
	if (sorted.length === 0) return undefined;
	return new RegExp(sorted.map(escapeRegExp).join("|"), "g");
}

/** Replace every active secret value in `text` with a named placeholder. Idempotent: a placeholder never matches. */
export function redactSecrets(text: string): string {
	const regex = pattern();
	if (regex === undefined) return text;
	// Every match came out of `pattern()`, which is built from these same keys, so the lookup cannot miss.
	return text.replace(regex, (value) => placeholders.get(value) as string);
}

/** Does this text contain an active secret? Used to refuse a memory rather than rewrite it. */
export function containsSecret(text: string): boolean {
	const regex = pattern();
	return regex !== undefined && regex.test(text);
}
