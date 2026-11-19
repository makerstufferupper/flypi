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
 * runtime at all. `readAgentTypes` is where the two halves meet — one call for the panel, with the root's default
 * pair and the errors worth rendering beside the rows.
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
import { readForWrite } from "./config-files.ts";
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
	/** pi's `Model.thinkingLevelMap`: a `null` marks a level this model cannot do, and for `xhigh`/`max` a missing
	 *  key means the same thing (pi's `getSupportedThinkingLevels`, pi-ai/dist/models.js:693-703). */
	thinkingLevelMap?: Record<string, string | null | undefined>;
}

/** What the run will actually be, and what to say before it starts. */
export interface AgentModelAnswer {
	/** What the file asked for, or nothing when it inherits. */
	model?: string;
	/** "provider/modelId" the subagent will actually run on: the asked model, or the conversation default.
	 *  Absent when flypi has no model to name — a root whose `settings.json` never configured a default has no
	 *  conversation model, and `undefined/undefined` or a guessed one would be a claim, not an answer. */
	runsOn?: string;
	/** False when the file named a model flypi cannot serve — the warning row. Absent when flypi could not ask at
	 *  all (`readAgentTypes` hands that case to `errors`), which is neither a warning nor an all-clear. */
	resolvable?: boolean;
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

/** The two normalisations the extension applies before it matches (`model-resolver.ts:53,64`). Its scoring
 *  tail is deliberately not mirrored: flypi cannot import the package, so a second scorer could only drift. */
const norm = (s: string) => s.toLowerCase().replace(/\./g, "-");

/**
 * The models flypi could serve right now, read the way the debug panel reads them
 * (`getProviders()` × `getAvailable(id)`, src/server/session-registry.ts:333-336) — because that set, and not
 * `models.json`, is what the extension's resolver accepts (`model-resolver.ts:46-47`): a provider with no
 * credential is not a model a subagent can run on, however carefully it is written into the file.
 *
 * Local, and **not a pure read**: `ModelRuntime.create` derives pi's catalog cache from `dirname(modelsPath)` and
 * persists it to `models-store.json` there, and creates `authPath` when the root has none (`model-runtime.js:80,85`;
 * measured in a temp root as the file appearing, content `{}`). A session start makes the identical call
 * (`src/agent/runtime.ts:119-121`), so nothing new lands in any root and no guard is needed — but a settings-panel
 * refresh touching those paths is worth knowing, because whoever reads this signature next will assume a read is pure.
 * The call gets the same two paths a session start passes and no `allowModelNetwork`, so pi keeps the catalog refresh
 * off the network (`model-runtime.js:100`), and asking one provider whether it is available resolves a credential
 * rather than calling it.
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
 * that picked one. It is optional because a fresh root has none, and a row about a model that does not exist is the
 * one answer worse than no answer (`runsOn` is absent for exactly that case).
 *
 * Only the extension's **first** resolution tier is repeated here — the asked address, as a string and as a bare id,
 * matched against the available set, with the two normalisations its resolver applies first. Its scoring tail and
 * the cross-provider retry (`model-resolver.ts:59-110`) are deliberately not reimplemented: flypi cannot import the
 * package (plan D10), so a second scorer could only drift from the first one in silence. The asymmetry that leaves
 * is deliberate and one-directional: flypi warns about what it cannot match, and a warning may be conservative — a
 * needless "will run on the conversation's model instead" line costs a sentence — but it must never claim a model
 * the run will not use.
 */
export function resolveAgentModel(row: AgentFileRow, available: readonly AvailableModel[], fallback?: ModelRef): AgentModelAnswer {
	const ask = row.model === undefined ? undefined : norm(row.model);
	// The extension's exact tier over the **full** address comes first (`model-resolver.ts:52-57`), and only then the
	// same exact match on the bare id, which is how it reads a `model:` that names no provider: an exact id scores 100
	// over every provider (`:64,88`), so a `model: qwen3` legitimately lands on `lmstudio/qwen3`. Two passes rather than
	// one `find` with both arms: pi's openrouter catalog ships ids that keep their slash
	// (`anthropic/claude-haiku-4.5`, `pi-ai/dist/providers/data/openrouter.json`), so such an entry satisfies the ask
	// `anthropic/claude-haiku-4.5` on its id alone and would be named for a run that went to
	// `anthropic/claude-haiku-4-5`, where the extension short-circuits on the full address before it scores anything.
	const served =
		ask === undefined ? undefined :
		available.find((model) => norm(modelKey(model)) === ask) ??
		// The one ask this cannot settle: a bare id that really exists under two credentialed providers. flypi takes the
		// first in its own ordering, the extension the first in its, and the tie needs the resolver itself (plan D10) — so
		// `runsOn` says which model flypi matched, not a promise about which one ran.
		available.find((model) => norm(model.modelId) === ask);
	// What the run lands on, when flypi is able to name it.
	const landsOn = served ?? fallback;
	const answer: AgentModelAnswer = {
		...(row.model ? { model: row.model } : {}),
		// The silent degrade, stated: an ask that does not resolve runs on the parent's model
		// (`pi-subagents/src/index.ts:1965-1972`), so one row carries both halves of "asked X, will run on Y".
		...(landsOn ? { runsOn: modelLabel(landsOn) } : {}),
		// Asked and could not be served is the warning; asked nothing is the conversation's own model.
		resolvable: !row.model || !!served,
		...(!row.model ? { inherited: true } : {}),
	};
	// Which model that run lands on, as an entry of the available set — and when flypi cannot see that model at all
	// it says nothing about levels, rather than promising one it has not checked. The ask is measured against pi's rule
	// whole, in pi's order (`getSupportedThinkingLevels`, pi-ai/dist/models.js:692-706): a model that cannot think
	// supports `off` and nothing else, and for a reasoning model a `null` mapping refuses **any** level — `off`
	// included, which `claude-fable-5`, `claude-sonnet-5-5` and `claude-opus-5-5` really do map
	// (`pi-ai/dist/providers/data/anthropic.json`). A blanket "`off` never warns" guard is not pi's rule: it hides the
	// reasoning models that refuse to think at all.
	const lands = landsOn ? available.find((model) => norm(modelKey(model)) === norm(modelKey(landsOn))) : undefined;
	if (row.thinking && lands) {
		const lv = row.thinking;
		const mapped = lands.thinkingLevelMap?.[lv];
		// pi's order: a `null` refuses the level at **any** level, and for `xhigh`/`max` a *missing key* refuses it too —
		// pi answers `mapped !== undefined` for those two, so a map of `{low, high}` cannot do `xhigh`, which is what
		// `researcher.md` and `reviewer.md` both ask. For every other level a missing key *is* provider defaults,
		// which is no warning here. The doc comment beside `thinkingLevelMap` ("missing keys use provider defaults")
		// is wrong for `xhigh`/`max`; the code is the truth.
		const unsupported = lands.reasoning
			? mapped === null || ((lv === "xhigh" || lv === "max") && mapped === undefined)
			: lv !== "off";
		if (unsupported) answer.thinkingUnsupported = true;
	}
	return answer;
}

/** One agent file plus the answer about its model — what the panel lists. `runsOn` and `resolvable` are optional
 *  because the resource row (sub-task 3) renders `errors` and omits both when flypi could not ask at all. */
export interface AgentTypeRow extends AgentFileRow, AgentModelAnswer {}

/**
 * What the `subagentAgents` resource answers with. The shape is this module's (the way `PackageSnapshot` owns
 * packages', src/agent/packages.ts); the typebox that validates it on the wire is `SubagentAgentsSnapshot`
 * in `src/server/protocol.ts`, and neither half imports the other's runtime.
 *
 * `source` is part of the snapshot rather than a thrown refusal: "no agent types yet" and "there is nothing to
 * import from here" are two sentences the panel renders, and the second is the dev container's permanent state.
 * The available-model set the answers were computed over is not here at all — 402 entries for a `runsOn` string
 * the row already carries.
 */
export interface AgentTypesSnapshot {
	rows: AgentTypeRow[];
	/** The directory an import would read from, and whether it is there. */
	source: { path: string; exists: boolean };
	/** One sentence per thing that left the rows only half answered, never a false warning. */
	errors: string[];
}

/**
 * The list, the model answer for every row and the root's own default, joined — one function because that join is
 * what a caller gets wrong: the fallback has to come from `settings.json` through `readForWrite`, an `inherited`
 * row's `runsOn` is the conversation's default rather than something the file chose, and the available set is never
 * part of a row.
 *
 * **Nothing this returns carries the available set.** With two credentialed providers it measured **402 entries**,
 * and a row carries its own answer; whoever writes the `subagentAgents` resource (sub-task 3) keeps it off the wire.
 *
 * `models` is a parameter so a caller (or a test) that already paid for `availableModels` can reuse it; it defaults
 * to reading them. **With `models` passed** this is reads-only, like `listAgentFiles`; **without it** the read goes
 * through pi's runtime, which persists its catalog cache to `models-store.json` beside `models.json` exactly as a
 * session start does (`availableModels`, `src/agent/runtime.ts:119-121`).
 *
 * A set that cannot be read is **one** sentence in `errors` and rows with no model claims, not `resolvable: false`
 * on every row: five warnings would be five claims about five models the run could not serve, from one file pi
 * would not parse. House style of `readPackages().errors` (src/agent/packages.ts).
 */
export async function readAgentTypes(paths: FlypiPaths, models?: readonly AvailableModel[]): Promise<{ rows: AgentTypeRow[]; errors: string[] }> {
	const errors: string[] = [];
	// The conversation's model, as `settings.json` holds it — the same two keys `readConfig` reads
	// (src/agent/config-files.ts:203-204). No pair is a state, not an error: a fresh root has none. A settings.json
	// that will not parse **throws** through here, like every other `readForWrite` caller in that module; the panel
	// already reports that file through `readConfig().errors`, so sub-task 3 must not swallow it into `errors` here.
	const settings = readForWrite(paths.settingsPath);
	const provider = str(settings.defaultProvider);
	const modelId = str(settings.defaultModel);
	const fallback = provider && modelId ? { provider, modelId } : undefined;
	let available: readonly AvailableModel[] | undefined = models;
	if (available === undefined) {
		try {
			available = await availableModels(paths);
			// The real failure pi does **not** report: `ModelRuntime.create` swallows a `models.json` it cannot parse and
			// answers an empty set, so on a root whose providers are declared in that file every row would warn "will run
			// on the conversation's model" with nothing to explain it. One sentence naming the operator's own file, before
			// the panel blames an agent file for it. A root that never had the file is a different state (onboarding has
			// not run) and gets no sentence.
			if (available.length === 0 && existsSync(paths.modelsPath)) {
				errors.push(`${paths.modelsPath} defines no model flypi can serve — check that file before blaming an agent file`);
			}
		} catch (error) {
			errors.push((error as Error).message); // pi's own sentence, which names the file it could not read
		}
	}
	const rows = listAgentFiles(paths).map((row) => ({ ...row, ...(available ? resolveAgentModel(row, available, fallback) : {}) }));
	return { rows, errors };
}
