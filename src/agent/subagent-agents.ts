/**
 * `.flypi/agent/agents/*.md` — the agent types flypi's subagent extension can spawn — and the one import that
 * fills that directory from the `~/.pi/agent/agents` the operator already keeps.
 *
 * What one file *says* is answered here; whether flypi can run what it asks for is not, because that answer needs
 * pi's model runtime and this module answers from the filesystem. A row therefore carries the model and thinking
 * level **as written**, so the caller can say "asked xhigh, runs high" instead of quietly dropping the ask.
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
 * The copy is verbatim and the destination is `0600`, like every other file flypi writes in the agent dir
 * (`writeText`, src/agent/config-files.ts). Nothing here reformats, normalises or re-serialises a frontmatter
 * block: these files belong to the operator, and pi's loader is the only parser that has to agree with them.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
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
 * A source that resolves to flypi's own dir is refused rather than run: every file would be "already there", the
 * copy would report a directory of nothing but skips, and the operator would be told the import worked.
 */
export function importAgentFiles(paths: FlypiPaths, sourceDir = hostAgentsDir()): AgentImportReport {
	assertFlypiOwned(paths);
	const source = resolve(sourceDir);
	const report: AgentImportReport = { source, exists: false, copied: [], skipped: [], ignored: [] };
	if (source === resolve(paths.agentsDir)) return { ...report, error: `${source} is flypi's own agents directory — there is nothing to import from here` };
	if (!existsSync(source)) return report;
	report.exists = true;
	for (const entry of readdirSync(source, { withFileTypes: true })) {
		const file = join(source, entry.name);
		if (!entry.isFile() || !entry.name.endsWith(".md")) {
			report.ignored.push(entry.name);
			continue;
		}
		const dest = join(paths.agentsDir, entry.name);
		if (existsSync(dest)) {
			// The type that is already there, which is what the operator's file declares — the filename is only the
			// fallback the loader itself uses.
			report.skipped.push(agentRow(dest).type);
			continue;
		}
		mkdirSync(dirname(dest), { recursive: true });
		copyFileSync(file, dest); // byte for byte, frontmatter and all
		chmodSync(dest, 0o600); // copyFileSync keeps the source's mode; the agent dir's files are never group-readable
		report.copied.push(dest);
	}
	return report;
}
