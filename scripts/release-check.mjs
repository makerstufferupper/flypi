#!/usr/bin/env node
/**
 * The release rehearsal (docs/release-checks.md). It runs the checks that have to pass before a version goes
 * to the registry, and with `--published` the ones that prove what landed there is what was built.
 *
 *   node scripts/release-check.mjs                 # gates → pack → npm-install → image
 *   node scripts/release-check.mjs --published     # registry + pushed image + run the published image
 *   node scripts/release-check.mjs --skip-gates    # the docker half only
 *   node scripts/release-check.mjs --keep          # leave the containers and volumes for a look
 *
 * It never publishes, pushes an image, or touches a container it did not create: everything it makes is named
 * `flypi-check-*` on ports 8792/8793, so the serving `flypi` container on 8791 and its `flypi-data` volume are
 * out of reach. Exit code is the number of failed checks.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
	const at = argv.indexOf(flag);
	return at === -1 ? undefined : argv[at + 1];
};
const version = valueOf("--version") ?? JSON.parse(readFileSync("package.json", "utf8")).version;

if (has("--help") || has("-h")) {
	console.log(`flypi release rehearsal — docs/release-checks.md

  npm run release:check                        gates → pack → npm-install → image
  npm run release:check -- --published         the registry and the pushed image, after the publish
  npm run release:check -- --skip-gates        the docker half only
  npm run release:check -- --keep              leave the containers and volumes for a look
  npm run release:check -- --version <v>       check a version other than package.json's
  npm run release:check -- --help              this list (-h is the same)

It never publishes or pushes, and only touches containers named flypi-check-*.`);
	process.exit(0);
}
const IMAGE = "makerstufferupper/flypi";
const TARBALL_URL = `https://registry.npmjs.org/@makerstufferupper/flypi/-/flypi-${version}.tgz`;

let failures = 0;
const ok = (name, detail) => console.log(`  ok    ${name}${detail ? ` — ${detail}` : ""}`);
const bad = (name, detail) => {
	failures++;
	console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
};
/** One check: run something, say whether it worked, keep going either way. */
function check(name, command, args, options = {}) {
	const result = spawnSync(command, args, { encoding: "utf8", ...options });
	if (result.status === 0) {
		ok(name, options.show && result.stdout ? result.stdout.trim().split("\n").at(-1) : undefined);
		return result;
	}
	bad(name, `${command} ${args.join(" ")} exited ${result.status}${result.stderr ? `: ${result.stderr.trim().split("\n")[0]}` : ""}`);
	return result;
}

const packDir = mkdtempSync(join(tmpdir(), "flypi-release-"));
const created = { containers: [], volumes: [], images: [] };

function docker(args, options = {}) {
	return spawnSync("docker", args, { encoding: "utf8", ...options });
}
/** A container of our own, on a port and a volume nothing else is using. */
function freshContainer(name, image, port, volume, command) {
	docker(["rm", "-f", name]);
	docker(["volume", "rm", volume]);
	created.containers.push(name);
	created.volumes.push(volume);
	const run = docker(["run", "-d", "--name", name, "-p", `127.0.0.1:${port}:${port}`, "-v", `${volume}:/data`, "-e", "FLYPI_ROOT=/data", image, ...command]);
	return run.status === 0 ? name : (bad(`docker run ${image}`, run.stderr.trim().split("\n")[0]), null);
}
/** Poll /healthz — the first start of a fresh state root is not instant. */
async function health(port, seconds = 180) {
	const deadline = Date.now() + seconds * 1000;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/healthz`);
			if (response.ok) return await response.json();
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}
	return null;
}
/** The three things every serving flypi owes: its own version, the pi it loaded, and a page. */
async function assertServing(name, port, expectVersion) {
	const body = await health(port);
	if (!body) return bad(`${name}: /healthz never answered`, `port ${port}`);
	body.version === expectVersion
		? ok(`${name}: /healthz reports flypi ${body.version}`)
		: bad(`${name}: /healthz version`, `expected ${expectVersion}, got ${body.version}`);
	body.pi?.version
		? ok(`${name}: it loaded pi ${body.pi.version}`, body.pi.pinned ? "pinned" : "not pinned")
		: bad(`${name}: /healthz names no pi`, "Phase 8.1 — the loaded version must be reported");
	const page = spawnSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", `http://127.0.0.1:${port}/`], { encoding: "utf8" });
	page.stdout === "200" ? ok(`${name}: GET / is 200`) : bad(`${name}: GET /`, `got ${page.stdout || "no answer"}`);
	return body;
}
function cleanup() {
	if (has("--keep")) return console.log(`\nkept: ${created.containers.join(", ")} · volumes ${created.volumes.join(", ")} · ${packDir}`);
	for (const name of created.containers) docker(["rm", "-f", name]);
	for (const volume of created.volumes) docker(["volume", "rm", volume]);
	for (const image of created.images) docker(["rmi", image]);
	rmSync(packDir, { recursive: true, force: true });
}

// ── stages ────────────────────────────────────────────────────────────────────────────────────────────────

function gates() {
	console.log(`gates — the suite this version would be published with`);
	check("tsc --noEmit", "npm", ["run", "typecheck"]);
	check("npm test", "npm", ["test"]);
	check("npm run smoke", "npm", ["run", "smoke"]);
	check("npm run probe:pi", "npm", ["run", "probe:pi"]);
}

function pack() {
	console.log(`\npack — the artifact, before anything installs it`);
	check("npm run build (dist/ui)", "npm", ["run", "build"]);
	check(`npm pack`, "npm", ["pack", "--pack-destination", packDir]);
	const tgz = `makerstufferupper-flypi-${version}.tgz`;
	const packed = spawnSync("tar", ["xzOf", join(packDir, tgz), "package/package.json"], { encoding: "utf8" });
	if (packed.status !== 0) return bad(`read ${tgz}`, "npm pack produced nothing readable");
	const pkg = JSON.parse(packed.stdout);
	pkg.version === version ? ok(`tarball version ${pkg.version}`) : bad("tarball version", `package.json says ${pkg.version}`);
	const self = Object.keys(pkg.dependencies).filter((d) => d.includes("makerstufferupper"));
	self.length ? bad("no self-dependency", `${self.join(", ")} — flypi must not depend on flypi`) : ok("no self-dependency in dependencies");
	const listed = spawnSync("tar", ["tzf", join(packDir, tgz)], { encoding: "utf8" }).stdout.split("\n");
	for (const file of ["dist/ui/index.html", "bin/flypi.mjs", "src/daemon/pi.ts"]) {
		listed.includes(`package/${file}`) ? ok(`ships ${file}`) : bad(`ships ${file}`, "missing from the tarball — check package.json `files`");
	}
	const stray = listed.filter((f) => /package\/(\.scratch|\.flypi|node_modules|coverage)\//.test(f));
	stray.length ? bad("no stray files", stray.slice(0, 3).join(", ")) : ok("nothing stray (.scratch, .flypi, node_modules, coverage)");
	return tgz;
}

async function npmInstall(tgz) {
	console.log(`\nnpm-install — the tarball in a clean container, the way \`npm install -g\` does it`);
	const name = "flypi-check-npm";
	const container = freshContainer(name, "node:24-slim", 8792, "flypi-check-npm-data", ["sleep", "7200"]);
	if (!container) return;
	if (docker(["cp", join(packDir, tgz), `${name}:/tmp/flypi.tgz`]).status !== 0) return bad("docker cp the tarball");
	check("npm i -g /tmp/flypi.tgz", "docker", ["exec", name, "npm", "i", "-g", "--no-audit", "--no-fund", "/tmp/flypi.tgz"]);
	const installed = docker(["exec", name, "node", "-e", `console.log(require("/usr/local/lib/node_modules/@makerstufferupper/flypi/package.json").version)`]);
	installed.stdout?.trim() === version ? ok(`installed package reports ${version}`) : bad("installed package version", installed.stdout?.trim() || installed.stderr?.trim());
	docker(["exec", "-d", name, "flypi", "start", "--foreground", "--port", "8792", "--host", "0.0.0.0", "--embeddings", "none", "--judge", "none"]);
	await assertServing(name, 8792, version);
}

async function image(tgz) {
	console.log(`\nimage — the published image's runtime shape, built from the same tarball`);
	copyFileSync("docker/Dockerfile.local", join(packDir, "Dockerfile"));
	const tag = `flypi-check:${version}`;
	const built = docker(["build", "-q", "--build-arg", `FLYPI_TGZ=${tgz}`, "-t", tag, packDir]);
	if (built.status !== 0) return bad("docker build", built.stderr.trim().split("\n").slice(-3).join(" "));
	created.images.push(tag);
	ok(`docker build ${tag}`);
	const name = "flypi-check-image";
	// Keyword-only memory: the image's own CMD would fetch ~900 MB of models into a volume that is deleted after.
	const container = freshContainer(name, tag, 8793, "flypi-check-image-data", ["flypi", "start", "--foreground", "--port", "8793", "--host", "0.0.0.0", "--embeddings", "none", "--judge", "none"]);
	if (!container) return;
	await assertServing(name, 8793, version);
	// The container must refuse to move pi in one sentence, not a stack trace (docs/pi-upgrades.md 8.3).
	const refused = docker(["exec", name, "flypi", "pi", "use", "0.0.0"]);
	/std|not writable|not the npm global/.test(`${refused.stdout}${refused.stderr}`) && refused.status !== 0
		? ok("flypi pi use refuses in a container, in one sentence")
		: bad("flypi pi use in a container", `exit ${refused.status}: ${(refused.stderr || refused.stdout).trim().split("\n")[0]}`);
	const state = docker(["exec", name, "sh", "-c", "ls /data/.flypi/pi 2>&1"]);
	/state/.test(state.stdout) ? bad("a refused switch leaves no pin behind", state.stdout.trim()) : ok("a refused switch left nothing behind");
}

async function published() {
	console.log(`\npublished — that ${version} is really in the registry, and the image installs it`);
	// The metadata and the tarball propagate at different speeds: `npm view` can answer minutes before the
	// tarball URL stops 404-ing, which is what kills a pinned image build. Poll the URL, not the tag.
	let code = "000";
	for (let i = 0; i < 30 && code !== "200"; i++) {
		code = spawnSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", TARBALL_URL], { encoding: "utf8" }).stdout;
		if (code !== "200") await new Promise((resolve) => setTimeout(resolve, 10000));
	}
	code === "200" ? ok("the registry serves the tarball") : bad("the registry serves the tarball", `${code} after 5 min — ${TARBALL_URL}`);
	const latest = spawnSync("npm", ["view", "@makerstufferupper/flypi", "version"], { encoding: "utf8" });
	latest.stdout?.trim() === version ? ok(`npm's latest is ${version}`) : bad("npm's latest", `the registry answers ${latest.stdout?.trim() || "nothing"}`);

	const inspect = docker(["buildx", "imagetools", "inspect", `${IMAGE}:${version}`]);
	const platforms = ["linux/amd64", "linux/arm64"].filter((p) => inspect.stdout?.includes(p));
	platforms.length === 2 ? ok("the pushed image carries both platforms") : bad("the pushed image's platforms", platforms.join(", ") || "the manifest was not readable");

	const name = "flypi-check-published";
	const container = freshContainer(name, `${IMAGE}:${version}`, 8793, "flypi-check-published-data", ["flypi", "start", "--foreground", "--port", "8793", "--host", "0.0.0.0", "--embeddings", "none", "--judge", "none"]);
	if (!container) return;
	await assertServing(name, 8793, version);
}

// ── run ───────────────────────────────────────────────────────────────────────────────────────────────────

try {
	if (has("--published")) {
		await published();
	} else {
		if (!has("--skip-gates")) gates();
		const tgz = pack();
		if (tgz) {
			await npmInstall(tgz);
			await image(tgz);
		}
	}
} finally {
	cleanup();
}

console.log(failures ? `\n${failures} check(s) failed` : `\nall checks passed for ${version}`);
process.exit(failures ? 1 : 0);
