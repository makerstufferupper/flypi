#!/usr/bin/env node
/**
 * The local dev container, rebuilt from the working tree (docs/release.md, "Deploying something that is
 * *not* released"). One command for what used to be four.
 *
 *   npm run dev:container
 *
 * build → pack → `docker build` with `docker/Dockerfile.local` and the tarball's directory as the build
 * context (the repo's `.dockerignore` excludes `*.tgz`, so the repo is never the context) → replace the
 * `flypi` container with one off the new image → wait for `/healthz`.
 *
 * It removes the `flypi` container and the `flypi:local-*` images older than the one it built. It never
 * removes the `flypi-data` volume: that holds the memory models (~933 MB), and re-downloading them is the
 * slowest part of the next start — which is also why the healthcheck gets a 15-minute start period.
 *
 * No gates here; `npm run release:check` is the rehearsal that runs them. This is the fast path, and it
 * touches only the names above: never a published image, never a container this script did not build.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NAME = "flypi";
const PORT = 8791;
const VOLUME = "flypi-data";
// `--lan` publishes the port on every interface instead of loopback only. The image's CMD already listens on
// 0.0.0.0 inside the container, so the host-side mapping is the only thing that changes.
const BIND = process.argv.includes("--lan") ? "0.0.0.0" : "127.0.0.1";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
	console.log(`flypi dev container — docs/release.md "Deploying something that is *not* released"

  npm run dev:container        build → pack → image → replace the ${NAME} container on 127.0.0.1:${PORT}
  npm run dev:container -- --lan
                               the same, published on 0.0.0.0:${PORT} so the LAN can reach it

--lan is exposure, not a password: GET /__flypi.json is unauthenticated and returns the socket token
(src/server/index.ts), so anyone who can reach the port can drive this agent — its bash tool, its secrets
vault, its memory. Loopback is the safe default for a reason.

Removes: the ${NAME} container, and flypi:local-* images older than the one it just built.
Keeps:   the ${VOLUME} volume — the memory models live there, and this script never deletes a volume.
Tags:    flypi:local-<commit sha>, plus -dirty if the tree is not clean, because the package version
         inside such an image collides with the published one.
Stages:  build → pack → image → replace → serve → prune`);
	process.exit(0);
}

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const die = (message) => {
	console.error(`dev:container: ${message}`);
	process.exit(1);
};
function git(args) {
	const result = spawnSync("git", args, { encoding: "utf8" });
	if (result.status !== 0) die(`git ${args.join(" ")}: ${result.stderr.trim()}`);
	return result.stdout.trim();
}
/** One step. It stops at the first failure: a half-replaced dev container is worse than an old one. */
function run(command, args, { quiet = false } = {}) {
	const result = spawnSync(command, args, { encoding: "utf8" });
	if (result.status !== 0) {
		die(`${command} ${args.join(" ")} exited ${result.status}${result.stderr ? `: ${result.stderr.trim().split("\n").slice(-3).join(" ")}` : ""}`);
	}
	if (!quiet && result.stdout) process.stdout.write(result.stdout);
	return result;
}
const step = (what) => console.log(`\n${what}`);

const sha = git(["rev-parse", "--short", "HEAD"]);
const tag = `flypi:local-${sha}${git(["status", "--porcelain"]) ? "-dirty" : ""}`;
const packDir = mkdtempSync(join(tmpdir(), "flypi-dev-"));

try {
	step("build — dist/ui, which the tarball ships");
	run("npm", ["run", "build"]);

	step("pack — the same artifact npm would publish, installed by the image");
	run("npm", ["pack", "--pack-destination", packDir]);
	const tgz = `makerstufferupper-flypi-${version}.tgz`;
	copyFileSync("docker/Dockerfile.local", join(packDir, "Dockerfile"));

	step(`image — ${tag} from ${tgz}`);
	run("docker", ["build", "-q", "--build-arg", `FLYPI_TGZ=${tgz}`, "-t", tag, packDir]);

	step(`replace — container ${NAME} on ${BIND}:${PORT}, volume ${VOLUME} kept`);
	// `rm -f` on a name that is not there exits 1; that is the normal first run, not a failure.
	spawnSync("docker", ["rm", "-f", NAME], { encoding: "utf8" });
	run("docker", [
		"run",
		"-d",
		"--name",
		NAME,
		"-p",
		`${BIND}:${PORT}:${PORT}`,
		"-v",
		`${VOLUME}:/data`,
		"-e",
		"FLYPI_ROOT=/data",
		// The image's own CMD downloads the memory models on a fresh state root, so "unhealthy" for the
		// first quarter hour is the download, not a broken build.
		"--health-cmd",
		`node -e "fetch('http://127.0.0.1:${PORT}/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`,
		"--health-interval",
		"30s",
		"--health-timeout",
		"5s",
		"--health-start-period",
		"900s",
		"--health-retries",
		"3",
		tag,
	]);

	step(`serve — waiting on http://127.0.0.1:${PORT}/healthz`);
	const deadline = Date.now() + 180_000;
	let body = null;
	while (Date.now() < deadline && !body) {
		try {
			const response = await fetch(`http://127.0.0.1:${PORT}/healthz`);
			if (response.ok) body = await response.json();
		} catch {}
		if (!body) await new Promise((resolve) => setTimeout(resolve, 2000));
	}
	if (!body) die(`${NAME} never answered /healthz — docker logs ${NAME}`);
	console.log(`  ok    flypi ${body.version} · pi ${body.pi?.version ?? "?"} · ${tag}`);

	step("prune — the flypi:local-* images this replaces");
	const stale = run("docker", ["image", "ls", "flypi:local-*", "--format", "{{.Repository}}:{{.Tag}}"], { quiet: true }).stdout
		.split("\n")
		.map((image) => image.trim())
		.filter((image) => image && image !== tag);
	for (const image of stale) run("docker", ["rmi", image], { quiet: true });
	console.log(stale.length ? `  removed ${stale.join(", ")}` : "  nothing older to remove");

	console.log(`\n${NAME} is on http://127.0.0.1:${PORT}${BIND === "0.0.0.0" ? `, published on 0.0.0.0:${PORT} so the LAN can reach it` : ""} — docker logs -f ${NAME} to watch it`);
} finally {
	rmSync(packDir, { recursive: true, force: true });
}
