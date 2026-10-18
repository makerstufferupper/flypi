/**
 * The agent-dir files the settings UI edits: model provider endpoints in `models.json`, MCP servers in
 * `mcp.json`, and the default a new conversation starts on in `settings.json` (`getConfig` /
 * `saveConfig` in docs/protocol.md).
 *
 * Every write reads the file, changes the one entry named, and writes the rest back untouched.
 * These files hold far more than the panel shows — a model entry carries `compat`, `cost` and
 * `contextWindow`, a provider can carry `headers` — so a panel that rewrote them from its own
 * fields would quietly destroy a working configuration. Model entries are only ever added to:
 * removing one is an edit to the file, because there is no way to tell "delete this model" from
 * "the panel does not show it". The raw editor (`files` below) is how the fields its forms do not hold get
 * edited: it replaces a whole file, so it is checked against the text the editor was loaded with.
 *
 * Values stay in the form pi reads them: an `apiKey`, a header or an `env` value may be `${ENV_VAR}` or
 * `"!command"`
 * (docs/secrets.md), so the panel never turns a reference into a plaintext secret.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { FlypiConfigError } from "./runtime.ts";
import type { FlypiPaths } from "./paths.ts";

/** pi's own rule for MCP server names (docs/mcp.md "Configuration rules"), which tools are named after. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** What the settings panel shows for one provider. Only the fields pi itself documents. */
export interface EndpointRow {
	name: string;
	baseUrl: string;
	api: string;
	apiKey: string;
	/** The model ids that provider defines. Read-only in the panel; adding is additive. */
	models: string[];
}

/** What the settings panel shows for one `mcp.json` entry, with pi's defaults filled in. */
export interface McpRow {
	name: string;
	url: string;
	command: string;
	args: string[];
	/** `headers.Authorization`, the one header the panel edits; the rest stay in the file. */
	authorization: string;
	/** Every `env` entry, held exactly as the file holds it — a `${NAME}` or `!command` is not resolved. */
	env: Record<string, string>;
	cwd: string;
	description: string;
	exposure: McpExposure;
	/** Per-tool overrides of `exposure`, keyed as pi reads them: an offered tool name or a `*` pattern. */
	toolExposure: Record<string, McpExposure>;
	oauth: McpOAuth;
	enabled: boolean;
}

/**
 * The four OAuth fields the panel edits. pi has more (`clientName`, `clientRegistration`, `callbackPort`,
 * `authServerMetadataUrl`); those stay in the file untouched, the same way the headers this form does not
 * show do.
 */
export interface McpOAuth {
	clientId: string;
	clientSecret: string;
	callbackUrl: string;
	scope: string;
}

const OAUTH_FIELDS = ["clientId", "clientSecret", "callbackUrl", "scope"] as const;

export type McpExposure = "direct" | "deferred" | "codemode" | "hidden";

export interface ConfigSnapshot {
	endpoints: EndpointRow[];
	mcpServers: McpRow[];
	/** What a new conversation starts on: `defaultProvider` / `defaultModel` in settings.json. */
	defaults: Defaults;
	/** `models.json` and `settings.json` as their exact bytes, for the raw editor. */
	files: ConfigFileRow[];
	/** A config file that will not parse. The panel says so rather than listing an empty config. */
	errors: string[];
}

/** The two files the panel offers as text. `mcp.json` is not one: its form already covers every field. */
export type ConfigFileName = "models" | "settings";

const FILE_PATHS: Record<ConfigFileName, "modelsPath" | "settingsPath"> = { models: "modelsPath", settings: "settingsPath" };

export interface ConfigFileRow {
	name: ConfigFileName;
	/** The file exactly as it is on disk, `""` when it does not exist yet. */
	text: string;
}

export interface ConfigFileEdit {
	name: ConfigFileName;
	/** The whole file, as typed. */
	text: string;
	/** The text the editor was loaded with. See `applyConfigEdits`. */
	base?: string;
}

/**
 * The pair `resolveConfiguredModel()` reads (src/agent/runtime.ts). Both halves are needed: an endpoint
 * can define several models, so "this endpoint is the default" is only finished once one of its ids is
 * named.
 */
export interface Defaults {
	provider: string;
	model: string;
}

export interface EndpointEdit {
	name: string;
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	/** New model ids to add. An id already defined is left alone, with its `compat` and cost. */
	models?: string[];
	remove?: true;
}

export interface McpEdit {
	name: string;
	url?: string;
	command?: string;
	args?: string[];
	authorization?: string;
	env?: Record<string, string>;
	cwd?: string;
	description?: string;
	exposure?: McpExposure;
	toolExposure?: Record<string, McpExposure>;
	oauth?: Partial<McpOAuth>;
	enabled?: boolean;
	remove?: true;
}

export interface ConfigEdits {
	endpoints?: EndpointEdit[];
	mcpServers?: McpEdit[];
	/** Write the default pair into settings.json. Absent means that file is not touched. */
	defaults?: Defaults;
	/** Replace one of the two files wholesale — the raw editor's way to reach what the forms do not hold. */
	files?: ConfigFileEdit[];
}

export function readConfig(paths: FlypiPaths): ConfigSnapshot {
	const errors: string[] = [];
	const models = readJsonObject(paths.modelsPath, errors);
	const mcp = readJsonObject(paths.mcpPath, errors);
	const settings = readJsonObject(paths.settingsPath, errors);
	return {
		endpoints: Object.entries(objects(models.providers)).map(([name, entry]) => ({
			name,
			baseUrl: text(entry.baseUrl),
			api: text(entry.api),
			// pi resolves the credential from auth.json first; the panel edits what models.json holds.
			apiKey: text(entry.apiKey),
			models: modelIdsOf(models, name),
		})),
		mcpServers: Object.entries(objects(mcp.mcpServers)).map(([name, entry]) => ({
			name,
			url: text(entry.url),
			command: text(entry.command),
			args: list(entry.args).filter((arg): arg is string => typeof arg === "string"),
			authorization: text(objects(entry.headers).Authorization),
			env: strings(entry.env),
			cwd: text(entry.cwd),
			description: text(entry.description),
			exposure: exposure(entry.exposure),
			toolExposure: toolExposures(entry.toolExposure),
			oauth: oauthFields(entry.oauth),
			enabled: entry.enabled !== false,
		})),
		defaults: {
			// Empty strings rather than an error: settings.json may legitimately not say yet, and the panel
			// has to say so instead of failing the whole snapshot.
			provider: text(settings.defaultProvider),
			model: text(settings.defaultModel),
		},
		files: (Object.keys(FILE_PATHS) as ConfigFileName[]).map((name) => ({
			name,
			text: existsSync(paths[FILE_PATHS[name]]) ? readFileSync(paths[FILE_PATHS[name]], "utf8") : "",
		})),
		errors,
	};
}

/**
 * The memory endpoint as `.flypi/agent/mcp.json` describes it — the same file `recall()` connects through,
 * so no process can listen on one port and the agent on another (docs/decisions.md: one source of truth).
 * A `${FLYPI_MEMORY_TOKEN}` placeholder means the token comes from the environment.
 *
 * Every entrypoint that starts sessions asks this before serving anyone a chat, and prints `note` when there
 * is one. Without it the only symptom is a model reporting that the memory tools are missing: the entry is
 * valid, the server may be up, and the request is simply refused for want of a token nobody exported
 * (docs/risks.md risk 8 — nothing about memory is allowed to be silent).
 */
export function memoryEndpoint(
	paths: FlypiPaths,
): { port?: number; token?: string; note?: string } {
	const row = readConfig(paths).mcpServers.find((server) => server.name === "flypi-memory" && server.enabled);
	if (!row) return { note: "no flypi-memory entry in .flypi/agent/mcp.json — flypi's own agent will not see the memory tools" };
	const endpoint = row.url ? new URL(row.url) : undefined;
	const bearer = /^Bearer\s+(.*)$/.exec(row.authorization)?.[1];
	if (bearer === "${FLYPI_MEMORY_TOKEN}") {
		const fromEnv = process.env.FLYPI_MEMORY_TOKEN;
		return {
			...(endpoint?.port ? { port: Number(endpoint.port) } : {}),
			...(fromEnv ? { token: fromEnv } : {}),
			...(!fromEnv ? { note: "mcp.json asks for ${FLYPI_MEMORY_TOKEN}, which is not set — its requests will be refused" } : {}),
		};
	}
	return {
		...(endpoint?.port ? { port: Number(endpoint.port) } : {}),
		...(bearer ? { token: bearer } : {}),
	};
}

/**
 * Write the `flypi-memory` entry into `mcp.json` when the file has none. A daemon that picked its own memory
 * port and minted its own token has no other way to tell the agent where they are, and with no entry the
 * agent has no memory tools — which is the state an installed CLI starts in, having never had an agent dir
 * (docs/architecture.md Phase 7).
 *
 * An entry that already exists is never touched, even a broken one: it may hold `${FLYPI_MEMORY_TOKEN}`, a
 * vault reference or an `exposure` someone chose, and `memoryEndpoint()` reads the file as the source of
 * truth for the port and token the server binds. Returns whether the file was written.
 */
export function ensureMemoryEntry(paths: FlypiPaths, port: number, token: string): boolean {
	if (readConfig(paths).mcpServers.some((server) => server.name === "flypi-memory")) return false;
	applyConfigEdits(paths, {
		mcpServers: [{
			name: "flypi-memory",
			url: `http://127.0.0.1:${port}/mcp`,
			authorization: `Bearer ${token}`,
			// The same entry `scripts/start.mjs` writes for a checkout — that one cannot import this file,
			// because it runs before `npm install` — so both writers produce one shape.
			description: "flypi memory store: memory_search, memory_write, memory_read, memory_supersede, memory_forget",
			// pi's default is `codemode`, which would register the server without ever offering its tools.
			exposure: "direct",
		}],
	});
	return true;
}

/**
 * Write an empty `settings.json` and `models.json` when they are not there. A fresh install has no agent dir
 * at all, and a missing file is reported as `could not read …: ENOENT` — which reads like a broken install,
 * where the truth is that no model is configured yet. With the files present the settings panel lists an
 * empty config you can add to, and a new conversation says which half is missing (`resolveConfiguredModel`,
 * src/agent/runtime.ts). A file that exists is never touched, parseable or not: a working `models.json`
 * carries `compat`, `cost` and `contextWindow` nothing here can rebuild, and a file that will not parse
 * belongs to the operator to fix. Returns what it wrote, so the daemon can say which.
 */
export function ensureAgentConfig(paths: FlypiPaths): string[] {
	const created: string[] = [];
	for (const path of [paths.settingsPath, paths.modelsPath]) {
		if (existsSync(path)) continue;
		writeJson(path, {}); // 0600 and its directory created, like every other agent-dir file
		created.push(path);
	}
	return created;
}

/**
 * Apply the panel's edits. An edit writes only the fields it carries, so an untouched field of an
 * entry is untouched on disk too. Everything is applied and validated before anything is written: a
 * bad name in the second row must not leave the first row half-applied. Adding or deleting an endpoint
 * also keeps the default pair in step (`syncDefault`). The default is written last, into `settings.json`,
 * and checked against the files as they are now — an edit that adds a model id and points the default at it
 * in the same request must not be refused for something it just wrote.
 * That also means a rejected default leaves endpoint edits it travelled with already written: they are
 * different files and different intents, and there is no transaction across three files.
 */
export function applyConfigEdits(paths: FlypiPaths, edits: ConfigEdits): void {
	if (edits.files?.length) {
		// First, so an endpoint edit or a default in the same request is checked against the file as the raw
		// editor just wrote it.
		for (const file of edits.files) {
			const path = paths[FILE_PATHS[file.name]];
			// A raw write replaces the whole file, credentials and all, so a file that moved since the editor
			// loaded it is refused rather than overwritten: the panel's own lists and the daemon write these too.
			const current = existsSync(path) ? readFileSync(path, "utf8") : "";
			if (file.base !== undefined && file.base !== current) {
				throw new FlypiConfigError(`${file.name}.json changed since this editor loaded it — reload it, re-apply your edit, then save`);
			}
			// pi reads this file for every conversation, so a file it cannot parse is refused here instead of at
			// the next newSession.
			parseJsonObject(file.text, path);
			writeText(path, file.text);
		}
	}

	if (edits.endpoints?.length) {
		const file = readForWrite(paths.modelsPath);
		const providers = objects(file.providers);
		for (const edit of edits.endpoints) {
			const name = checkedName(edit.name, "endpoint");
			if (edit.remove) {
				delete providers[name];
				continue;
			}
			const created = !providers[name];
			const entry = providers[name] ?? (providers[name] = {});
			if (edit.baseUrl !== undefined) entry.baseUrl = edit.baseUrl;
			if (edit.api !== undefined) entry.api = edit.api;
			// Empty means "no key here", which is what lets a key move to auth.json from the panel.
			if (edit.apiKey !== undefined) assign(entry, "apiKey", edit.apiKey);
			if (edit.models?.length) {
				const models = (entry.models ??= []) as unknown[];
				for (const id of edit.models) {
					if (!models.some((model) => isObject(model) && model.id === id)) models.push({ id });
				}
			}
			// Only a new endpoint is held to this: an existing entry may legitimately name no models,
			// because pi's built-in providers supply them.
			if (created) {
				if (!text(entry.baseUrl)) throw new FlypiConfigError(`endpoint "${name}" needs a baseUrl, e.g. http://127.0.0.1:8000/v1`);
				if (!Array.isArray(entry.models) || entry.models.length === 0) {
					throw new FlypiConfigError(`endpoint "${name}" defines no model: name at least one model id, or delete it`);
				}
			}
		}
		file.providers = providers;
		writeJson(paths.modelsPath, file);
		syncDefault(paths, edits.endpoints);
	}

	if (edits.mcpServers?.length) {
		const file = readForWrite(paths.mcpPath);
		const servers = objects(file.mcpServers);
		for (const edit of edits.mcpServers) {
			const name = checkedName(edit.name, "MCP server");
			if (edit.remove) {
				delete servers[name];
				continue;
			}
			const entry = servers[name] ?? (servers[name] = {});
			for (const key of ["url", "command", "description", "cwd"] as const) {
				if (edit[key] !== undefined) assign(entry, key, edit[key] as string);
			}
			if (edit.args !== undefined) assign(entry, "args", edit.args);
			if (edit.authorization !== undefined) {
				const headers = objects(entry.headers);
				assign(headers, "Authorization", edit.authorization);
				assign(entry, "headers", headers);
			}
			// `env` and `toolExposure` are written as whole maps: a row carries every entry the file has, so
			// rewriting one cannot drop another, and an empty value is how the panel says "take that key out".
			if (edit.env !== undefined) assign(entry, "env", kept(edit.env));
			if (edit.toolExposure !== undefined) assign(entry, "toolExposure", kept(edit.toolExposure));
			// Field by field, like the Authorization header: an entry that carries pi's other OAuth keys keeps
			// them, because this form does not show them and so has no right to rewrite them.
			if (edit.oauth !== undefined) {
				const oauth = objects(entry.oauth);
				for (const field of OAUTH_FIELDS) assign(oauth, field, edit.oauth[field]);
				assign(entry, "oauth", oauth);
			}
			// pi treats the defaults (`exposure: "codemode"`, `enabled: true`) as absent keys, so the
			// panel writes them the same way and the file stays what `pi mcp add` would have written.
			// Gated on the edit carrying them: an edit that names only a url — the daemon correcting a port —
			// must not reset an exposure or an enabled flag the operator chose.
			if (edit.exposure !== undefined) assign(entry, "exposure", edit.exposure !== "codemode" ? edit.exposure : undefined);
			if (edit.enabled !== undefined) assign(entry, "enabled", edit.enabled === false ? false : undefined);
			if (!text(entry.url) && !text(entry.command)) {
				throw new FlypiConfigError(`MCP server "${name}" needs a url (HTTP) or a command (stdio)`);
			}
		}
		file.mcpServers = servers;
		writeJson(paths.mcpPath, file);
	}

	if (edits.defaults) {
		const provider = checkedName(edits.defaults.provider, "endpoint");
		const defined = modelIdsOf(readForWrite(paths.modelsPath), provider);
		if (!defined.length) {
			throw new FlypiConfigError(
				`default "${provider}/${edits.defaults.model}" names no endpoint with a model in ${paths.modelsPath}`,
			);
		}
		if (!defined.includes(edits.defaults.model)) {
			throw new FlypiConfigError(
				`default model "${provider}/${edits.defaults.model}" is not defined by that endpoint: it defines ${defined.join(", ")}`,
			);
		}
		// Only these two keys of settings.json are ours; the thinking level, tool list and anything else
		// the user put there stay as they are.
		const file = readForWrite(paths.settingsPath);
		file.defaultProvider = provider;
		file.defaultModel = edits.defaults.model;
		writeJson(paths.settingsPath, file);
	}
}

/**
 * Keep the pair a new conversation starts on in step with the endpoints that exist: an agent dir that has
 * never named one gets the first endpoint this request added, and a default whose endpoint this request
 * deleted moves to another endpoint that defines a model, or is cleared when none does. Anything else is
 * left alone — a pair naming a provider that is not in `models.json` may be one of pi's built-ins, chosen
 * deliberately, and is not dangling just because an unrelated endpoint went away. An explicit `defaults` in
 * the same request still wins: this runs before it.
 */
function syncDefault(paths: FlypiPaths, endpoints: EndpointEdit[]): void {
	const settings = readForWrite(paths.settingsPath);
	const provider = text(settings.defaultProvider);
	const removed = new Set(endpoints.filter((edit) => edit.remove).map((edit) => edit.name));
	if (provider ? !removed.has(provider) : !endpoints.some((edit) => !edit.remove)) return;

	const models = readForWrite(paths.modelsPath);
	// The first endpoint that can actually start a conversation, preferring the ones this request just added:
	// the thing the user acted on is the one they meant, and a provider naming no model id is a
	// `resolveConfiguredModel()` failure whatever it is pointed at.
	const added = endpoints.filter((edit) => !edit.remove).map((edit) => edit.name);
	const next = [...added, ...Object.keys(objects(models.providers))].find((name) => modelIdsOf(models, name).length);
	if (next) {
		settings.defaultProvider = next;
		settings.defaultModel = modelIdsOf(models, next)[0];
	} else {
		delete settings.defaultProvider;
		delete settings.defaultModel;
	}
	writeJson(paths.settingsPath, settings);
}

/** The model ids one provider defines in a models.json object. */
function modelIdsOf(file: Record<string, unknown>, provider: string): string[] {
	const entry = objects(file.providers)[provider];
	if (!entry) return [];
	return list(entry.models).filter(isObject).map((model) => text(model.id)).filter(Boolean);
}

function checkedName(name: string, what: string): string {
	if (!NAME.test(name)) {
		throw new FlypiConfigError(`${what} name "${name}" may contain letters, digits, "-" and "_" only, and must start with a letter or digit`);
	}
	return name;
}

/** Set a key, or remove it when the value is empty/undefined — pi reads an absent key as its default. */
function assign(target: Record<string, unknown>, key: string, value: unknown): void {
	const empty = value === undefined || value === "" || (Array.isArray(value) && value.length === 0) || (isObject(value) && Object.keys(value).length === 0);
	if (empty) delete target[key];
	else target[key] = value;
}

/** Drop the entries saying "remove this key", so a map left with nothing in it can be dropped as a whole. */
function kept<T>(pairs: Record<string, T>): Record<string, T> {
	return Object.fromEntries(Object.entries(pairs).filter(([, value]) => value !== undefined && value !== ""));
}

/** A file that is not there yet starts empty; one that will not parse is never overwritten. */
function readForWrite(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	return parseJsonObject(readFileSync(path, "utf8"), path);
}

function readJsonObject(path: string, errors: string[]): Record<string, unknown> {
	if (!existsSync(path)) return {};
	try {
		return parseJsonObject(readFileSync(path, "utf8"), path);
	} catch (error) {
		errors.push(`${path}: ${(error as Error).message}`);
		return {};
	}
}

function parseJsonObject(raw: string, path: string): Record<string, unknown> {
	const value = JSON.parse(raw) as unknown;
	if (!isObject(value)) throw new FlypiConfigError(`${path} must contain a JSON object`);
	return value;
}

function writeJson(path: string, value: Record<string, unknown>): void {
	writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** One file, byte for byte as given — the raw editor's text is written exactly as it was typed. */
function writeText(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	// Same as auth.json: these files can hold a plaintext key, so they are never readable by the group. The
	// mode in writeFileSync only applies on create, hence the chmod.
	writeFileSync(path, text, { mode: 0o600 });
	chmodSync(path, 0o600);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objects(value: unknown): Record<string, Record<string, unknown>> {
	return isObject(value) ? (value as Record<string, Record<string, unknown>>) : {};
}

/** One map inside an entry (`env`, `toolExposure`, `headers`), as key/value pairs; anything else is nothing. */
function entryList(value: unknown): [string, unknown][] {
	return Object.entries(isObject(value) ? value : {});
}

function list(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** The string values only: a value that is not a string is not something the panel can hold or rewrite. */
function strings(value: unknown): Record<string, string> {
	return Object.fromEntries(entryList(value).filter(([, item]) => typeof item === "string") as [string, string][]);
}

/** pi's own per-tool overrides, minus any level it does not know — an entry the panel cannot hold is not shown. */
function toolExposures(value: unknown): Record<string, McpExposure> {
	return Object.fromEntries(entryList(value).filter(([, item]) => isExposure(item)) as [string, McpExposure][]);
}

/** The four OAuth fields this panel edits. pi's others are not read here, so they are never written back. */
function oauthFields(value: unknown): McpOAuth {
	const oauth = objects(value);
	return { clientId: text(oauth.clientId), clientSecret: text(oauth.clientSecret), callbackUrl: text(oauth.callbackUrl), scope: text(oauth.scope) };
}

function isExposure(value: unknown): value is McpExposure {
	return value === "direct" || value === "deferred" || value === "hidden" || value === "codemode";
}

function exposure(value: unknown): McpExposure {
	return isExposure(value) ? value : "codemode";
}
