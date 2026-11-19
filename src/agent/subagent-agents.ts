/**
 * `.flypi/agent/agents/*.md` — the agent types flypi's subagent extension can spawn — and the one import that
 * fills that directory from the `~/.pi/agent/agents` the operator already keeps.
 *
 * The two halves stay apart. **The files**: what a `.md` says, read from the filesystem, with the model and thinking
 * level carried **as written**. **A model answer over them**: whether flypi can serve what a file asks for, which is
 * the warning this feature exists for — the extension degrades a configured model that does not resolve to the
 * parent's model and says nothing (`pi-subagents/src/index.ts:1965-1972`), so a panel that stayed silent would lie.
 * `availableModels` is the only I/O in the second half (pi's runtime, no more than a session start already opens)
 * and `resolveAgentModel` is a pure function over a row, that set and a fallback, so the answer is testable with no
 * runtime at all.
 *
 * What is **not** answered here is the level a running subagent was actually given: pi clamps per model
 * (`clampThinkingLevel`, pi-ai/dist/models.js:705-720) and that truth needs a session, so it belongs to the fleet's
 * `subagents:usage.requestedThinking` and not to a settings-list row. This says whether the model the run lands on
 * can do the asked level at all, which is knowable from pi's own `Model.reasoning` / `Model.thinkingLevelMap`.
 *
 * Two rules hold the whole file.
 *
 * **A file already in flypi's dir is never overwritten.** The import is a convenience offered to somebody with a
 * directory of their own; their hand-edited `scout.md` outranks whatever the host copy says, and a copy that
 * replaced it would destroy the one file the operator wrote in the one place flypi writes for them. A name that
 * exists is reported in `skipped` and left byte for byte as it is.
 *
 * **Only a regular `.md` is a candidate.** `copyFileSync` follows symlinks, so a `link.md` pointing outside the
 * source dir would be copied *through* — the host file's contents landing in the agent dir under a name its own
 * directory never held. A subdirectory and a `.txt` are not types either. All three are named in `ignored`, so
 * "it copied nothing" and "it copied the wrong thing" stay two different answers.
 *
 * The **list** applies `isFile()` too, which is a limit rather than parity with the loader: the extension follows a
 * `link.md`, so a link flypi hides here is a type `Agent` offers — the import never creates one, and reading a fifo
 * to name it would hang.
 *
 * The copy is verbatim, it lands whole or the operator finds the directory exactly as it was (written beside the
 * destination, then moved), and the destination is `0600`, like every other file flypi writes in the agent dir
 * (`writeText`, src/agent/config-files.ts). Nothing here reformats, normalises or re-serialises a frontmatter
 * block: these files belong to the operator, and pi's loader is the only parser that has to agree with them.
 */
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { ModelRuntime, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { assertFlypiOwned, type FlypiPaths } from "./paths.ts";

/**
 * The host pi's own config directory, spelled as `assertFlypiOwned` spells it (src/agent/paths.ts) rather than
 * imported as pi's `CONFIG_DIR_NAME`: that export is a string, and the compat pin admits only callables into
 * `PI_COMPAT.imports[].values` — listing it there is measured to turn ten rows of
 * `tests/scripts/pi-compat.test.ts` red, because the probe then tells every candidate pi it is broken. A pi
 * repackaged under another config dir would need a flypi change either way.
 */
const HOST_CONFIG_DIR = ".pi";

/**
 * The directory the operator's own agent types live in: `~/.pi/agent/agents`.
 *
 * This is the only place flypi reads the host tree, and risk 1 is about flypi's own paths resolving there
 * (docs/risks.md risk 1, src/agent/paths.ts) — this is the operator's one-shot read of one directory, started by
 * their click, that writes only into `paths.agentsDir`. Nothing opens it at startup, on a timer, or unprompted.
 *
 * Deliberately **not** `getAgentDir()`: flypi pins `PI_CODING_AGENT_DIR` to its own agent dir at process start
 * (`forceFlypiAgentDir`, src/agent/paths.ts), so pi's own resolver answers with the import *target* here, and the
 * two would be the same directory — which is the one import that must never happen.
 */
export function hostAgentsDir(): string {
	return join(homedir(), HOST_CONFIG_DIR, "agent", "agents");
}

/** What one `.md` says, before anyone asks whether its model exists. */
export interface AgentFileRow {
	/** The `name:` key if it declares one, else the filename without `.md` (`custom-agents.ts:158-187`). */
	type: string;
	/** The file itself, inside `paths.agentsDir`. */
	file: string;
	description?: string;
	/** `provider/modelId` as written. */
	model?: string;
	/** As written; the extension's own levels. */
	thinking?: string;
	/** Why this file will not become a type. The file stays on disk; the panel says why. */
	invalid?: string;
}

/** What the import did — one line each for the three lists, so the panel can report it instead of shrugging. */
export interface AgentImportReport {
	/** The directory that was read, resolved. */
	source: string;
	/** Whether there was a directory there at all. Part of the answer, not an exception: "no agent types yet" and
	 *  "there is nothing to import from here" are different sentences, and the dev container is permanently the
	 *  second one. */
	exists: boolean;
	/** Destinations, in the order they were written. */
	copied: string[];
	/** Types that were already in flypi's dir, by type name — never overwritten. */
	skipped: string[];
	/** Entries that are not a regular `.md`: a symlink, a subdirectory, any other file. */
	ignored: string[];
	/** Set instead of throwing, when the import was refused before it read anything — the caller renders the
	 *  sentence. Today there is one such case: the source *is* flypi's own dir. */
	error?: string;
}

/** The directory as the filesystem really has it; one that does not exist yet has nothing to resolve. */
function realDir(dir: string): string {
	try {
		return realpathSync(dir);
	} catch {
		return resolve(dir); // nothing there to follow, so `resolve` is the best answer to compare against
	}
}

/** The extension's own field reader: a string or nothing (`custom-agents.ts:312-314`). */
function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/**
 * One file as a row, mirroring how the loader reads it: `name:` is the type when it declares one, and a declared
 * name holding a `:` is refused rather than substituted — the extension reserves the colon for plugin-scoped
 * identifiers and skips the file outright (`custom-agents.ts:30,161-177`), so flypi says so instead of listing a
 * type nobody can spawn. A file whose frontmatter will not parse is listed as invalid for the same reason: it is
 * on disk, and silence is the failure this list exists to remove.
 */
function agentRow(file: string): AgentFileRow {
	const stem = basename(file, ".md");
	let fm: Record<string, unknown>;
	// pi's own parser, because the extension that turns these files into agent types parses them with the same one
	// (`custom-agents.ts:7`); a file flypi reads differently is a row that disagrees with what `Agent` offers.
	try {
		fm = parseFrontmatter(readFileSync(file, "utf8")).frontmatter;
	} catch (error) {
		return { type: stem, file, invalid: `unreadable frontmatter: ${(error as Error).message}` };
	}
	const declared = str(fm.name)?.trim();
	if (declared?.includes(":")) {
		return { type: declared, file, invalid: `the name "${declared}" contains a ':', which the extension reserves for plugin-scoped names` };
	}
	const description = str(fm.description);
	const model = str(fm.model);
	const thinking = str(fm.thinking);
	return {
		type: declared || stem,
		file,
		...(description ? { description } : {}),
		...(model ? { model } : {}),
		...(thinking ? { thinking } : {}),
	};
}

/**
 * What flypi's own `agents/` dir holds, in filename order. Reads only — a read that wrote, or created, anything
 * would make the settings panel's refresh a mutation (`readPackages`, src/agent/packages.ts, is the precedent). An
 * absent dir is an empty list rather than an error: flypi never creates it, and "no agent types yet" is a state
 * the panel has a sentence for.
 */
export function listAgentFiles(paths: FlypiPaths): AgentFileRow[] {
	try {
		return readdirSync(paths.agentsDir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
			.map((entry) => agentRow(join(paths.agentsDir, entry.name)))
			.sort((a, b) => a.file.localeCompare(b.file));
	} catch {
		return []; // the directory is not there to walk
	}
}

/**
 * Copy the source dir's `*.md` into `paths.agentsDir`.
 *
 * `sourceDir` defaults to the host dir (`hostAgentsDir`); the caller passes nothing in the normal case and a temp
 * dir in a test. Nothing else about this is configurable, because the spec is one sentence long: copy `*.md`,
 * never overwrite a name that already exists, report each copy.
 *
 * `assertFlypiOwned` runs first, because this is the module that writes in the agent dir (docs/risks.md risk 1).
 * A source that *is* flypi's own dir — by path or by symlink — is refused rather than run: every file would be
 * "already there", the copy would report a directory of nothing but skips, and the operator would be told the
 * import worked.
 */
export function importAgentFiles(paths: FlypiPaths, sourceDir = hostAgentsDir()): AgentImportReport {
	assertFlypiOwned(paths);
	const source = resolve(sourceDir);
	const report: AgentImportReport = { source, exists: false, copied: [], skipped: [], ignored: [] };
	// `realpathSync`, not `resolve`: a source that is a *link* to the agents dir resolves to somewhere else and
	// slips the guard, so the run would walk the whole directory reporting skips as a success.
	if (realDir(sourceDir) === realDir(paths.agentsDir)) return { ...report, error: `${source} is flypi's own agents directory — there is nothing to import from here` };
	if (!existsSync(source)) return report;
	report.exists = true;
	for (const entry of readdirSync(source, { withFileTypes: true })) {
		const file = join(source, entry.name);
		if (!entry.isFile() || !entry.name.endsWith(".md")) {
			report.ignored.push(entry.name);
			continue;
		}
		const dest = join(paths.agentsDir, entry.name);
		// `lstatSync`, not `existsSync`: the latter follows symlinks, so a dangling `scout.md` pointing outside the
		// tree — exactly what a stow-style dotfiles manager leaves behind — reads as "not there", and the import
		// writes that entry away (with a plain `copyFileSync`, *through* the link, into a file outside flypi's dir).
		const existing = lstatSync(dest, { throwIfNoEntry: false });
		if (existing) {
			// A link, a fifo, anything that is not the regular file the loader would read: it is still *there*, and
			// reading it to find its declared name is how a fifo turns a settings-panel click into a hang. A regular
			// file is named by the type it declares; the filename is only the fallback the loader itself uses.
			report.skipped.push(existing.isFile() ? agentRow(dest).type : basename(entry.name, ".md"));
			continue;
		}
		mkdirSync(dirname(dest), { recursive: true });
		// Byte for byte, frontmatter and all, written beside the destination and moved in: a copy that dies partway
		// (ENOSPC, EIO) must not leave a truncated `scout.md` that every later import reports as `skipped` forever.
		const tmp = `${dest}.tmp`;
		copyFileSync(file, tmp);
		chmodSync(tmp, 0o600); // copyFileSync keeps the source's mode; the agent dir's files are never group-readable
		renameSync(tmp, dest); // atomic within the dir: a half-copy is never what the operator finds
		report.copied.push(dest);
	}
	return report;
}

/** How a model is addressed inside flypi: the pair, never the `provider/modelId` string it displays as. */
export interface ModelRef {
	provider: string;
	modelId: string;
}

/** One entry of the available set: the pair, plus the two fields of pi's `Model` that decide a thinking ask. */
export interface AvailableModel extends ModelRef {
	/** pi's `Model.reasoning` (pi-ai/dist/types.d.ts:650): false means no thinking level is on offer at all. */
	reasoning: boolean;
	/** pi's `Model.thinkingLevelMap`: a `null` value marks a level this model cannot do (pi-ai/dist/models.js:693-703). */
	thinkingLevelMap?: Record<string, string | null | undefined>;
}

/** What the run will actually be, and what to say before it starts. */
export interface AgentModelAnswer {
	/** What the file asked for, or nothing when it inherits. */
	model?: string;
	/** "provider/modelId" the subagent will actually run on: the asked model, or the conversation default. */
	runsOn: string;
	/** False when the file named a model flypi cannot serve — the warning row. */
	resolvable: boolean;
	/** True when the file asked for a thinking level the resolved model cannot do. */
	thinkingUnsupported?: boolean;
	/** True when the file asked for no model, so `runsOn` is the conversation's model and not a choice this file made —
	 *  four of the five agent files the host ships are this shape, and the panel says "inherits the conversation". */
	inherited?: boolean;
}

/**
 * The pair as the one display string flypi uses — `provider/modelId`, the same form a session reports its model in
 * (`src/agent/runtime.ts:419-423`). The subagent extension takes a single string, so this is where the pair becomes
 * one; nowhere else spells the format, or it would drift the moment one side changed.
 */
function modelLabel(ref: ModelRef): string {
	return `${ref.provider}/${ref.modelId}`;
}

/** The address the extension compares: the same string, lower-cased, as its resolver does (`model-resolver.ts:46,53`). */
function modelKey(ref: ModelRef): string {
	return modelLabel(ref).toLowerCase();
}

/**
 * The `model:` as an address, split where the extension splits it — the first `/` is the provider
 * (`pi-subagents/src/model-resolver.ts:49-51`). A `model:` with no `/` is not an address flypi can check, so it
 * stays unresolvable rather than becoming a guess about which provider the operator meant.
 */
function askedModel(ask: string | undefined): ModelRef | undefined {
	if (!ask) return undefined;
	const slash = ask.indexOf("/");
	return slash === -1 ? undefined : { provider: ask.slice(0, slash), modelId: ask.slice(slash + 1) };
}

/**
 * The models flypi could serve right now, read the way the debug panel reads them
 * (`getProviders()` × `getAvailable(id)`, src/server/session-registry.ts:333-336) — because that set, and not
 * `models.json`, is what the extension's resolver accepts (`model-resolver.ts:46-47`): a provider with no
 * credential is not a model a subagent can run on, however carefully it is written into the file.
 *
 * Local. `ModelRuntime.create` gets the same two paths a session start passes (`src/agent/runtime.ts:119-121`) and
 * no `allowModelNetwork`, so pi keeps the catalog refresh off the network (`model-runtime.js:100`), and asking one
 * provider whether it is available resolves a credential rather than calling it.
 */
export async function availableModels(paths: FlypiPaths): Promise<AvailableModel[]> {
	const runtime = await ModelRuntime.create({ authPath: paths.authPath, modelsPath: paths.modelsPath });
	const perProvider = await Promise.all(
		runtime
			.getProviders()
			.map(async (provider) =>
				(await runtime.getAvailable(provider.id)).map((model) => ({
					provider: provider.id,
					modelId: model.id,
					reasoning: model.reasoning,
					thinkingLevelMap: model.thinkingLevelMap,
				})),
			),
	);
	return perProvider.flat();
}

/**
 * Whether flypi can run what this row asks for, over the available set and the conversation's own model.
 *
 * The `fallback` is `defaultProvider`/`defaultModel` from `settings.json`, passed in by the caller: this module does
 * not decide what "the conversation's model" means, and a row that guessed would be wrong for every conversation
 * that picked one.
 *
 * Only the extension's **first** resolution tier is repeated here — the asked `provider/modelId` matched against the
 * available set. Its fuzzy and cross-provider tiers (`model-resolver.ts:59-110`) are deliberately not
 * reimplemented: a second resolver is a second thing to keep in step, and whichever way the extension lands, an ask
 * that is not in the available set is a run on a model other than the one the file named.
 */
export function resolveAgentModel(row: AgentFileRow, available: readonly AvailableModel[], fallback: ModelRef): AgentModelAnswer {
	const asked = askedModel(row.model);
	const served = asked ? available.find((model) => modelKey(model) === modelKey(asked)) : undefined;
	const answer: AgentModelAnswer = {
		...(row.model ? { model: row.model } : {}),
		// The silent degrade, stated: an ask that does not resolve runs on the parent's model
		// (`pi-subagents/src/index.ts:1965-1972`), so one row carries both halves of "asked X, will run on Y".
		runsOn: modelLabel(served ?? fallback),
		// Asked and could not be served is the warning; asked nothing is the conversation's own model. A `model:`
		// that is not an address at all counts as asked-and-not-served, because the panel quotes what the file wrote.
		resolvable: !row.model || !!served,
		...(!row.model ? { inherited: true } : {}),
	};
	// Which model that run lands on: the ask when it resolved, the conversation's model otherwise — and when flypi
	// cannot see that model at all it says nothing about levels, rather than promising one it has not checked.
	const lands = served ?? available.find((model) => modelKey(model) === modelKey(fallback));
	if (row.thinking && lands && (!lands.reasoning || lands.thinkingLevelMap?.[row.thinking] === null)) answer.thinkingUnsupported = true;
	return answer;
}
