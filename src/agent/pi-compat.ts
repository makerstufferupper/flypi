/**
 * The surface of pi that flypi depends on, and a check that a candidate tree still offers it
 * (docs/pi-upgrades.md Phase 8.2, risk 14).
 *
 * This is a **pre-filter, not a gate**. It catches the dominant breakage class — a renamed or dropped export,
 * a moved internal file, a raised Node floor — in about a second and without restarting anything. It cannot
 * see the behavioural half of pi-api.md: pi 1.4.0 kept every export and changed the *shape* of the
 * `before_agent_start` event, which no `typeof` check can find. Only `npm test` and `npm run smoke` catch
 * that class, and they are the gate.
 *
 * The list is **generated from the source, never maintained by hand**: `tests/scripts/pi-compat.test.ts`
 * greps every `from "@earendil-works/…"` in `src/ scripts/ tests/ ui/` and fails when the two disagree. A
 * hand-kept list that drifts reports a clean pass, which is worse than no list.
 *
 * Three specifiers, not one (docs/pi-upgrades.md C3): `pi-coding-agent` is the bulk, `pi-mcp` is imported by
 * the memory smoke script and three tests without being a declared dependency of flypi, and
 * `pi-ai/providers/faux` is the stub every model-touching test runs on. A probe that checked only
 * `pi-coding-agent` would report a clean pass while the whole suite was broken.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** One specifier flypi imports from, and what it takes from it. */
export interface PiImport {
	/** The bare specifier, exactly as the source writes it. */
	specifier: string;
	/** Names with a runtime presence. flypi calls every one of them, so each must stay a function. */
	values: string[];
	/** Type-only names: no runtime check is possible, so the entry's `.d.ts` is checked instead. */
	types: string[];
}

export interface PiDeepImport {
	/** The package whose internals flypi reaches into by path. */
	specifier: string;
	/** The file inside it, as `src/agent/pi-mcp.ts` joins it onto `getPackageDir()`. */
	path: string;
}

/** What flypi imports from pi. Kept honest by `tests/scripts/pi-compat.test.ts`, not by anyone's memory. */
export const PI_COMPAT: { imports: PiImport[]; deep: PiDeepImport[] } = {
	imports: [
		{
			specifier: "@earendil-works/pi-coding-agent",
			values: [
				"createAgentSession",
				"DefaultResourceLoader",
				"DefaultPackageManager",
				"SettingsManager",
				"SessionManager",
				"ModelRuntime",
				"getAgentDir",
				"getPackageDir",
				"parseFrontmatter",
				"createEventBus",
				"createMcpExtension",
				"createToolSearchExtension",
			],
			types: [
				"AgentSessionEvent",
				"CreateAgentSessionOptions",
				"CustomMessageEntry",
				"EventBus",
				"ExtensionAPI",
				"ExtensionContext",
				"ExtensionFactory",
				"ExtensionUIContext",
				"ExtensionUIDialogOptions",
				"LoadedMcpConfig",
				"McpExtensionOptions",
				"McpServerConfig",
				"McpServerEntry",
				"PackageSource",
				"SessionEntry",
			],
		},
		{ specifier: "@earendil-works/pi-mcp", values: ["McpClient", "StreamableHttpTransport"], types: [] },
		{
			specifier: "@earendil-works/pi-ai/providers/faux",
			values: ["fauxAssistantMessage", "fauxProvider", "fauxText", "fauxThinking", "fauxToolCall"],
			types: ["FauxProviderHandle", "FauxResponseStep"],
		},
	],
	// Reached by path because the entry does not export them and its `exports` map hides the types
	// (src/agent/pi-mcp.ts). A moved internal file breaks flypi while every export still passes.
	deep: [
		{ specifier: "@earendil-works/pi-coding-agent", path: "dist/extensions/mcp/runtime.js" },
		{ specifier: "@earendil-works/pi-coding-agent", path: "dist/core/auth-storage.js" },
		{ specifier: "@earendil-works/pi-coding-agent", path: "dist/core/resolve-config-value.js" },
	],
};

/** `engines.node: ">=22.19.0"` against the Node that would run it. Numeric parts, left to right. */
function nodeSatisfied(range: string, version: string): boolean {
	const min = /(\d+)\.(\d+)\.(\d+)/.exec(range);
	if (!min) return true;
	const parts = version.split(".").map(Number);
	for (let i = 1; i <= 3; i++) {
		const diff = Math.sign((parts[i - 1] ?? 0) - Number(min[i]));
		if (diff) return diff > 0;
	}
	return true;
}

/** Walk up from a resolved file to the package that owns it — `dist/index.js` is not the package root. */
function packageRoot(fromFile: string, name: string): string | null {
	let dir = dirname(fromFile);
	while (dir !== dirname(dir)) {
		try {
			if ((JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string }).name === name) return dir;
		} catch {
			/* keep walking */
		}
		dir = dirname(dir);
	}
	return null;
}

/**
 * Resolve specifiers **from inside the candidate tree**. `import.meta.resolve(spec, parentURL)` cannot do
 * it — Node 24 ignores the parent argument and resolves from the calling module, which would have the probe
 * check flypi's own pi and report a clean pass for a candidate that is not even there. A module written at
 * the candidate's root resolves from its own location, which is the tree being probed.
 */
async function resolverFor(root: string): Promise<(specifier: string) => string | null> {
	const helper = join(root, ".flypi-probe-resolver.mjs");
	writeFileSync(helper, "export const resolveFrom = (specifier) => import.meta.resolve(specifier);\n");
	let resolveFrom: (specifier: string) => string;
	try {
		({ resolveFrom } = await import(pathToFileURL(helper).href));
	} finally {
		rmSync(helper, { force: true });
	}
	return (specifier) => {
		try {
			const url = resolveFrom(specifier);
			return fileURLToPath(url).startsWith(join(root, "node_modules") + "/") ? url : null;
		} catch {
			return null;
		}
	};
}

/** Every importable file under a directory, nested included. Throws when the directory is not there to walk. */
function builtFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) builtFiles(path, out);
		// `.d.ts` stays out: its imports are type positions, so reading it would blame a pi for a name the
		// runtime module never asked for.
		else if (/\.(js|ts)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(path);
	}
	return out;
}

/**
 * The directories the package's own `pi.extensions` entries point into. pi loads those, and a package that
 * stops publishing a `dist/` would otherwise leave the scan with nothing to read and nothing to say.
 * Empty when the manifest names none or will not parse.
 */
function declaredDirs(pkgDir: string): string[] {
	try {
		const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { pi?: { extensions?: unknown } };
		const entries = Array.isArray(manifest.pi?.extensions) ? manifest.pi.extensions : [];
		return [...new Set(entries.filter((entry): entry is string => typeof entry === "string").map((entry) => dirname(resolve(pkgDir, entry))))];
	} catch {
		return [];
	}
}

/**
 * What one installed extension imports from each `@earendil-works/*` specifier, read off the code that runs:
 * its `dist/` plus the directories its own `pi.extensions` entries name, de-duplicated. Type-only imports
 * are invisible either way — erased by the build in `dist/`, stripped by the parser in a `.ts` source — and
 * reporting one would blame a pi for a name it was never asked for. Namespace and default imports name a
 * module, not a symbol — the specifier is recorded with no names, which is as far as a name-check can
 * honestly go.
 *
 * `imports` is empty, and `unreadable` false, when the package ships none of those directories: that is the
 * uninstalled package skipping the check. `unreadable` is for the other case — the code is there and some of
 * it would not read — which is said rather than passed off as "nothing to ask of the candidate". Names
 * collected before the failure are kept.
 */
export function extensionPiImports(pkgDir: string): { imports: Map<string, string[]>; unreadable: boolean } {
	const found = new Map<string, Set<string>>();
	let unreadable = false;
	for (const dir of new Set([join(pkgDir, "dist"), ...declaredDirs(pkgDir)])) {
		if (!existsSync(dir)) continue; // a layout this package does not ship, as an uninstalled one ships none
		try {
			for (const file of builtFiles(dir)) {
				let text: string;
				try {
					text = readFileSync(file, "utf8");
				} catch {
					unreadable = true; // one file that would not read is that file's affair, not the whole build's
					continue;
				}
				// The clause excludes quotes and semicolons, so it cannot run past the specifier of the import
				// before it — named clauses in the shape `importedFromSource` pins for flypi's own source.
				for (const [, clause, specifier] of text.matchAll(/import\s+([^;'"]*?)\s*from\s*"(@earendil-works\/[^"]+)"/g)) {
					if (/^type\s/.test(clause!)) continue; // a whole clause that is type-only
					// The list is keyed by the bare specifier the source writes, while pi's own `loader.js getAliases`
					// rewrites an extension's `@earendil-works/pi-ai` import to `pi-ai-extension-view.js`, "a strict
					// superset of the core entrypoint": the first extension naming a pi-ai value exported only there
					// would be refused over a pi that loads it fine. No installed extension names a pi-ai value today.
					const names = found.get(specifier!) ?? new Set<string>();
					found.set(specifier!, names);
					if (clause!.startsWith("{")) {
						for (const raw of clause!.slice(1, -1).split(",").map((name) => name.trim()).filter(Boolean)) {
							if (raw.startsWith("type ")) continue;
							names.add(raw.split(/\s+as\s+/)[0]!);
						}
					}
					// else: `import * as x from` / `import x from` — the specifier is recorded, its usage is not nameable.
				}
			}
		} catch {
			unreadable = true; // a directory that would not list: the same sentence as a file that would not read
		}
	}
	return { imports: new Map([...found].map(([specifier, names]) => [specifier, [...names].sort()])), unreadable };
}

/**
 * What a candidate tree is missing — one sentence per problem, empty when it looks usable. A complete tree
 * resolves its own third-party dependencies, so the probe asks the candidate rather than flypi.
 *
 * `extensions` are installed package directories whose own pi imports are checked against the candidate too
 * (T46.2.4). The parameter is optional because the daemon's `deps.probe` seam and every existing caller use
 * the one-argument call.
 */
export async function checkPiCompat(candidateRoot: string, extensions: string[] = []): Promise<string[]> {
	const failures: string[] = [];
	let root: string;
	try {
		root = realpathSync(candidateRoot);
	} catch {
		return [`${candidateRoot} is not a directory — nothing to probe`];
	}
	if (!existsSync(join(root, "node_modules", "@earendil-works"))) return [`${candidateRoot} has no @earendil-works in its node_modules — that is not a candidate pi tree`];
	const resolveFrom = await resolverFor(root);

	for (const entry of PI_COMPAT.imports) {
		const url = resolveFrom(entry.specifier);
		if (!url) {
			failures.push(`${entry.specifier}: does not resolve from inside ${candidateRoot}`);
			continue;
		}
		let mod: Record<string, unknown>;
		try {
			// The query busts the ESM module cache: asked twice in one process, the probe has to look at the
			// tree again rather than at what the first look left loaded.
			mod = (await import(`${url}?pi-probe=1`)) as Record<string, unknown>;
		} catch (error) {
			failures.push(`${entry.specifier}: importing it threw — ${(error as Error).message}`);
			continue;
		}
		for (const name of entry.values) {
			if (typeof mod[name] !== "function") failures.push(`${entry.specifier}: ${name} is ${typeof mod[name]}, and flypi calls it as a function`);
		}
		if (entry.types.length === 0) continue;
		// The entry's own declaration file: `dist/index.d.ts` for the package entry,
		// `dist/providers/faux.d.ts` for the subpath. Every type flypi imports is re-exported there by name.
		const declaration = fileURLToPath(url.replace(/\.js$/, ".d.ts"));
		if (!existsSync(declaration)) {
			failures.push(`${entry.specifier}: no ${declaration.slice(declaration.lastIndexOf("/") + 1)} beside the entry, so its type exports cannot be checked`);
			continue;
		}
		const text = readFileSync(declaration, "utf8");
		for (const name of entry.types) {
			if (!new RegExp(`\\b${name}\\b`).test(text)) failures.push(`${entry.specifier}: the type ${name} is no longer re-exported from the entry`);
		}
	}

	for (const deep of PI_COMPAT.deep) {
		const url = resolveFrom(deep.specifier);
		const owner = url ? packageRoot(fileURLToPath(url), deep.specifier) : null;
		const file = owner ? join(owner, deep.path) : "";
		if (!url || !owner || !existsSync(file)) failures.push(`${deep.specifier}: ${deep.path} is not there, and flypi imports it by path`);
	}

	// What the installed extensions import from pi, against the candidate. A bundled extension is TypeScript
	// loaded through jiti with no type check (extensions/loader.js), so this is the only thing standing
	// between a pi bump and a silently missing tool. Its imports never join PI_COMPAT — that list is pinned
	// against flypi's own source (tests/scripts/pi-compat.test.ts, decision 9 / D8).
	for (const pkgDir of extensions) {
		let pkgName: string;
		try {
			pkgName = (JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { name?: string }).name ?? basename(pkgDir);
		} catch {
			pkgName = basename(pkgDir);
		}
		const { imports, unreadable } = extensionPiImports(pkgDir);
		// The check cannot say "fine" about code it never read, and it says which one happened: no build at all
		// is an uninstalled package skipping, build present but unreadable is a check that did not run.
		if (unreadable) failures.push(`${pkgName}: its own build could not be read, so its pi imports were not checked`);
		for (const [specifier, names] of imports) {
			const url = resolveFrom(specifier);
			if (!url) {
				// An extension that cannot resolve what it imports from pi is exactly the drift this probe exists for.
				failures.push(`${pkgName}: imports ${specifier}, which does not resolve from inside ${candidateRoot}`);
				continue;
			}
			let mod: Record<string, unknown>;
			try {
				mod = (await import(`${url}?pi-probe=1`)) as Record<string, unknown>;
			} catch (error) {
				failures.push(`${pkgName}: importing ${specifier} threw — ${(error as Error).message}`);
				continue;
			}
			for (const name of names) {
				// `undefined` rather than `typeof !== "function"`: an extension imports objects and classes too,
				// and "does not export" must only be said about a name that is genuinely not there.
				if (mod[name] === undefined) failures.push(`${pkgName}: imports ${name} from ${specifier}, which this pi does not export`);
			}
		}
	}

	// The Node floor: a candidate that needs a newer Node than the daemon runs on fails at import, which is
	// the failure that leaves no web UI to click rollback on (docs/risks.md risk 13).
	const entry = resolveFrom("@earendil-works/pi-coding-agent");
	if (entry) {
		const packageJson = join(packageRoot(fileURLToPath(entry), "@earendil-works/pi-coding-agent") ?? "", "package.json");
		const engines = existsSync(packageJson) ? (JSON.parse(readFileSync(packageJson, "utf8")) as { engines?: { node?: string } }).engines?.node : undefined;
		if (engines && !nodeSatisfied(engines, process.versions.node)) failures.push(`this pi needs Node ${engines}; this process is ${process.versions.node}`);
	}

	return failures;
}
