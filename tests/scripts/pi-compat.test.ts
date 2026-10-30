/**
 * The compat list stays true (docs/pi-upgrades.md Phase 8.2). Two independent jobs:
 *
 * - the list equals what the source actually imports — a new `from "@earendil-works/…"` that nobody added to
 *   the list makes this fail, because a hand-kept list that drifts reports a clean pass (risk 14);
 * - the probe says ok for the installed pi and names the damage in a doctored copy.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PI_COMPAT, checkPiCompat } from "../../src/agent/pi-compat.ts";

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

	afterAll(() => rmSync(candidate, { recursive: true, force: true }));
});
