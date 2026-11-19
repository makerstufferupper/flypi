/**
 * The compat list stays true (docs/pi-upgrades.md Phase 8.2). Two independent jobs:
 *
 * - the list equals what the source actually imports — a new `from "@earendil-works/…"` that nobody added to
 *   the list makes this fail, because a hand-kept list that drifts reports a clean pass (risk 14);
 * - the probe says ok for the installed pi and names the damage in a doctored copy.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PI_COMPAT, checkPiCompat, extensionPiImports } from "../../src/agent/pi-compat.ts";

const root = process.cwd();

/** Every source file that can hold an import. `ui/` is included so a future pi import there is not invisible. */
function sourceFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (["node_modules", ".git", "dist", "coverage", ".scratch"].includes(entry)) continue;
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) sourceFiles(path, out);
		else if (/\.(ts|mjs)$/.test(entry)) out.push(path);
	}
	return out;
}

/** What the source imports from `@earendil-works/*`, read off the files rather than off anyone's memory. */
function importedFromSource(): Map<string, { values: Set<string>; types: Set<string> }> {
	const found = new Map<string, { values: Set<string>; types: Set<string> }>();
	const files = ["src", "scripts", "tests", "ui"].flatMap((dir) => sourceFiles(resolve(root, dir)));
	for (const file of files) {
		for (const [, typeKeyword, names, specifier] of readFileSync(file, "utf8").matchAll(/import\s+(type\s+)?\{([^}]*)\}\s*from\s*"(@earendil-works\/[^"]+)"/g)) {
			const whole = Boolean(typeKeyword);
			const entry = found.get(specifier!) ?? { values: new Set<string>(), types: new Set<string>() };
			for (const raw of names!.split(",").map((name) => name.trim()).filter(Boolean)) {
				const name = raw.replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim();
				(whole || raw.startsWith("type ") ? entry.types : entry.values).add(name);
			}
			found.set(specifier!, entry);
		}
	}
	return found;
}

/** The files flypi reaches into by path, as `src/agent/pi-mcp.ts` writes them. */
function deepFromSource(): Set<string> {
	const paths = new Set<string>();
	for (const file of ["src", "scripts", "tests"].flatMap((dir) => sourceFiles(resolve(root, dir)))) {
		for (const [, path] of readFileSync(file, "utf8").matchAll(/join\(dir,\s*"(dist\/[^"]+)"/g)) paths.add(path!);
	}
	return paths;
}

/** Copy a package and whatever it needs, the way `npm install --prefix` would: a candidate tree is complete,
 *  and a half-copied one fails for reasons that are not the candidate's. */
function copyTree(realModules: string, names: string[], dest: string): void {
	for (const name of names) {
		const from = join(realModules, name);
		if (!existsSync(from)) continue;
		const to = join(dest, name);
		if (existsSync(to)) continue;
		cpSync(from, to, { recursive: true });
		const deps = JSON.parse(readFileSync(join(from, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
		copyTree(realModules, Object.keys(deps.dependencies ?? {}), dest);
	}
}

/** A candidate whose pi has one export renamed and one deep file deleted. */
function doctoredCandidate(prefix: string): string {
	const candidate = mkdtempSync(join(tmpdir(), prefix));
	copyTree(join(root, "node_modules"), ["@earendil-works/pi-coding-agent", "@earendil-works/pi-mcp", "@earendil-works/pi-ai"], join(candidate, "node_modules"));
	const packageDir = join(candidate, "node_modules", "@earendil-works", "pi-coding-agent");
	const entry = join(packageDir, "dist", "index.js");
	writeFileSync(entry, readFileSync(entry, "utf8").replace("export { createToolSearchExtension } from", "export { createToolSearchExtension as movedAway } from"));
	// The file flypi reaches for that pi's own entry does not import — deleting one pi imports internally
	// would make the entry itself throw, which is a different (and correct) answer, tested separately below.
	rmSync(join(packageDir, "dist", "extensions", "mcp", "runtime.js"));
	return candidate;
}

/** The specifier as a module built against pi spells it. The split is load-bearing: the source-scan row
 *  above reads every line of this file for `from "@earendil-works/…"` fixtures and would count a whole one
 *  written here as flypi's own import (D8, met from the other side). The file on disk gets the real text. */
const piSpec = (pkg: string) => `@earendil${"-works"}/${pkg}`;

/** The built output of an extension package: a `package.json` (pass null for the one that has none) and
 *  one `dist/index.js` holding `body` — the imports as the extension's own build
 *  would leave them, which is what the probe reads (`src/agent/pi-compat.ts`). */
function fixtureExtension(dir: string, body: string, manifest: string | null = JSON.stringify({ name: "flypi-fixture-ext", version: "0.0.1" })): string {
	mkdirSync(join(dir, "dist"), { recursive: true });
	if (manifest !== null) writeFileSync(join(dir, "package.json"), manifest);
	writeFileSync(join(dir, "dist", "index.js"), body);
	return dir;
}

const listed = new Map(PI_COMPAT.imports.map((entry) => [entry.specifier, { values: new Set(entry.values), types: new Set(entry.types) }]));

describe("the pi compat list", () => {
	it("is exactly what the source imports", () => {
		const actual = importedFromSource();
		expect([...actual.keys()].sort()).toEqual([...listed.keys()].sort());
		for (const [specifier, names] of actual) {
			const declared = listed.get(specifier)!;
			expect([...names.values].sort(), `${specifier} values`).toEqual([...declared.values].sort());
			expect([...names.types].sort(), `${specifier} types`).toEqual([...declared.types].sort());
		}
	});

	it("lists every deep path the source reaches for, and no others", () => {
		expect([...deepFromSource()].sort()).toEqual(PI_COMPAT.deep.map((deep) => deep.path).sort());
	});

	// The list says these are callable. If pi turns one into an object, the recorded expectation is wrong and
	// the probe would pass a candidate flypi cannot actually use.
	it("records every value name as a function in the installed pi", async () => {
		for (const entry of PI_COMPAT.imports) {
			const mod = (await import(entry.specifier)) as Record<string, unknown>;
			for (const name of entry.values) expect(typeof mod[name], `${entry.specifier}.${name}`).toBe("function");
		}
	});
});

describe("the probe", () => {
	it("is clean against the pi this checkout resolves", async () => {
		expect(await checkPiCompat(root)).toEqual([]);
	});

	it("refuses a directory that is not a candidate tree instead of resolving flypi's own pi", async () => {
		// The trap this closes: `import.meta.resolve` falls back to the caller's tree when the anchor does not
		// exist, so a bogus candidate would otherwise report a clean pass.
		const missing = join(mkdtempSync(join(tmpdir(), "flypi-no-candidate-")), "nope");
		expect(await checkPiCompat(missing)).toEqual([`${missing} is not a directory — nothing to probe`]);
		const empty = mkdtempSync(join(tmpdir(), "flypi-empty-candidate-"));
		try {
			expect(await checkPiCompat(empty)).toEqual([`${empty} has no @earendil-works in its node_modules — that is not a candidate pi tree`]);
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});

	// One doctored tree for the two damage cases — copying 36 MB is the slow part of this file, and the
	// second case only adds to what the first already did.
	let candidate = "";
	const doctored = () => (candidate ||= doctoredCandidate("flypi-candidate-"));
	// Both cases pay that copy plus fresh `tsx` processes, which blows vitest's 5 s default when the whole
	// suite runs in parallel. It is a slow answer, not a wrong one — same shape as the embedder timeout
	// noted in docs/release-checks.md.
	const SLOW = 30_000;

	it("names a renamed export and a moved deep file, and only those", async () => {
		expect(await checkPiCompat(doctored())).toEqual([
			"@earendil-works/pi-coding-agent: createToolSearchExtension is undefined, and flypi calls it as a function",
			"@earendil-works/pi-coding-agent: dist/extensions/mcp/runtime.js is not there, and flypi imports it by path",
		]);
	}, SLOW);

	it("exits 1 with one line per problem, and 0 when there are none", async () => {
		const { execFileSync } = await import("node:child_process");
		const run = (dir: string) => {
			try {
				const out = execFileSync(process.execPath, ["--import", "tsx", "scripts/probe-pi.ts", "--candidate", dir], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
				return { code: 0, out };
			} catch (error) {
				return { code: (error as { status?: number }).status ?? 0, out: `${(error as { stdout?: string }).stdout ?? ""}${(error as { stderr?: string }).stderr ?? ""}` };
			}
		};
		expect(run(root)).toMatchObject({ code: 0 });
		const empty = mkdtempSync(join(tmpdir(), "flypi-candidate-cli-"));
		mkdirSync(join(empty, "node_modules"), { recursive: true });
		// A file pi's own entry imports: the probe cannot get far enough to check names, and saying so is the
		// whole point — this is the failure that would take the web UI down with it (risk 13). Asked of a fresh
		// process, because a process that already imported the entry has it cached.
		rmSync(join(doctored(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "auth-storage.js"));
		const broken = run(doctored());
		expect(broken.code).toBe(1);
		expect(broken.out).toContain("importing it threw");
		expect(broken.out).toContain("auth-storage.js");
		try {
			const nothing = run(empty);
			expect(nothing.code).toBe(1);
			expect(nothing.out).toContain("has no @earendil-works in its node_modules");
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	}, SLOW);

	// T46.2.4: the declared extension is loaded through jiti with no type check, so its own imports need a
	// probe too. They never join PI_COMPAT (that list is pinned against flypi's source above); they are read
	// off the installed package, and the candidate is asked whether it still offers them.
	it("names a symbol a declared extension imports that the candidate does not export", async () => {
		const ext = fixtureExtension(mkdtempSync(join(tmpdir(), "flypi-ext-")), `import { createAgentSession, noSuchPiExport } from "${piSpec("pi-coding-agent")}";\n`);
		try {
			expect(await checkPiCompat(root, [ext])).toEqual([
				"flypi-fixture-ext: imports noSuchPiExport from @earendil-works/pi-coding-agent, which this pi does not export",
			]);
			// The one-argument call is the daemon's `deps.probe` seam and every existing row above: no
			// extensions named, no extension talk.
			expect(await checkPiCompat(root)).toEqual([]);
		} finally {
			rmSync(ext, { recursive: true, force: true });
		}
	}, SLOW);

	it("says nothing about a declared package that is not on disk", async () => {
		const base = mkdtempSync(join(tmpdir(), "flypi-ext-absent-"));
		try {
			expect(await checkPiCompat(root, [join(base, "not-installed")])).toEqual([]);
			expect([...extensionPiImports(join(base, "not-installed"))]).toEqual([]);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	}, SLOW);

	it("reads the import forms off the built output, naming only what the runtime module asks for", () => {
		const dir = mkdtempSync(join(tmpdir(), "flypi-ext-forms-"));
		mkdirSync(join(dir, "dist", "nested"), { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "flypi-forms-ext", version: "0.0.1" }));
		writeFileSync(
			join(dir, "dist", "index.js"),
			[
				`import { createAgentSession, type ErasedAtBuild,`,
				"\tgetAgentDir } from \"" + piSpec("pi-coding-agent") + "\";",
				`import type { NeverRuntime } from "${piSpec("pi-ai")}";`,
				`import * as tui from "${piSpec("pi-tui")}";`,
				`import legacy from "${piSpec("pi-legacy")}";`,
				'export const x = 1;',
			].join("\n"),
		);
		writeFileSync(join(dir, "dist", "index.d.ts"), `import type { AlsoErased } from "${piSpec("pi-coding-agent")}";\n`);
		writeFileSync(join(dir, "dist", "nested", "deep.js"), `import { DefaultResourceLoader } from "${piSpec("pi-coding-agent")}";\n`);
		try {
			const found = extensionPiImports(dir);
			// The type-only clause never reaches the map at all: pi is not asked about names that were
			// erased before the module existed. The namespace and default forms record the specifier and
			// claim no names, because there is no name to claim.
			expect([...found.keys()].sort()).toEqual(["@earendil-works/pi-coding-agent", "@earendil-works/pi-legacy", "@earendil-works/pi-tui"]);
			expect(found.get("@earendil-works/pi-coding-agent")).toEqual(["DefaultResourceLoader", "createAgentSession", "getAgentDir"]);
			expect(found.get("@earendil-works/pi-tui")).toEqual([]);
			expect(found.get("@earendil-works/pi-legacy")).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("says so when an extension imports a specifier the candidate cannot resolve", async () => {
		const ext = fixtureExtension(mkdtempSync(join(tmpdir(), "flypi-ext-unresolved-")), `import { someTool } from "${piSpec("pi-not-here")}";\n`);
		try {
			expect(await checkPiCompat(root, [ext])).toEqual([`flypi-fixture-ext: imports @earendil-works/pi-not-here, which does not resolve from inside ${root}`]);
		} finally {
			rmSync(ext, { recursive: true, force: true });
		}
	}, SLOW);

	it("says so when the specifier an extension imports throws on its way in", async () => {
		// Its own dependency resolves from the candidate and is broken — the shape a half-installed or
		// circular pi tree takes, where the import itself is the failure.
		const candidate = mkdtempSync(join(tmpdir(), "flypi-candidate-throw-"));
		const broken = join(candidate, "node_modules", "@earendil-works", "pi-throwing");
		mkdirSync(broken, { recursive: true });
		writeFileSync(join(broken, "package.json"), JSON.stringify({ name: "pi-throwing", main: "index.js" }));
		writeFileSync(join(broken, "index.js"), "this is ( not javascript");
		const ext = fixtureExtension(mkdtempSync(join(tmpdir(), "flypi-ext-throw-")), `import { whatever } from "${piSpec("pi-throwing")}";\n`);
		try {
			const failures = await checkPiCompat(candidate, [ext]);
			expect(failures.some((line) => line.startsWith("flypi-fixture-ext: importing @earendil-works/pi-throwing threw"))).toBe(true);
		} finally {
			rmSync(candidate, { recursive: true, force: true });
			rmSync(ext, { recursive: true, force: true });
		}
	}, SLOW);

	it("names an extension by its package name, and by the directory when the manifest gives it none", async () => {
		const unnamed = fixtureExtension(mkdtempSync(join(tmpdir(), "flypi-ext-nameless-")), `import { goneEitherWay } from "${piSpec("pi-coding-agent")}";\n`, JSON.stringify({ version: "0.0.1" }));
		const manifestless = fixtureExtension(mkdtempSync(join(tmpdir(), "flypi-ext-nomanifest-")), `import { goneEitherWay } from "${piSpec("pi-coding-agent")}";\n`, null);
		try {
			expect(await checkPiCompat(root, [unnamed, manifestless])).toEqual([
				`${basename(unnamed)}: imports goneEitherWay from @earendil-works/pi-coding-agent, which this pi does not export`,
				`${basename(manifestless)}: imports goneEitherWay from @earendil-works/pi-coding-agent, which this pi does not export`,
			]);
		} finally {
			rmSync(unnamed, { recursive: true, force: true });
			rmSync(manifestless, { recursive: true, force: true });
		}
	}, SLOW);

	afterAll(() => rmSync(candidate, { recursive: true, force: true }));
});
