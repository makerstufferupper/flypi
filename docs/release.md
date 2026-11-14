# Releasing flypi

One command does the release, and it is not just a version bump:

```js
// scripts/release.mjs
run("npm", ["version", kind, "-m", "release %s"]);   // bumps package.json, commits, tags v<version>
run("git", ["push", "--follow-tags"], { remote: true });
run("npm", ["publish", "--access", "public"]);       // npm runs prepublishOnly: typecheck + test + build
```

**The bump *is* the release.** Everything below follows from that.

## Order — merge first, then release

```bash
node scripts/release-check.mjs                              # 1. the rehearsal, nothing published
git checkout main && git merge --ff-only pi-upgrades && git push origin main   # 2. merge
npm run release patch --dry-run                             # 3. see it, run none of it
npm run release patch                                       # 4. bump + tag + push + publish
```

Never bump on a feature branch: `npm version` puts the release commit and the `v<version>` tag on whatever
branch you are standing on, and `npm publish` then ships branch code that `main` has never seen. Merge,
then release from `main`, and the tag is on `main` the moment it exists.

`main` is protected with **`required_linear_history`**, so `--ff-only` is the only merge that lands — a
merge commit is rejected. It also fails loudly if `main` moved while you were working. Push rights are
restricted; check `gh api repos/makerstufferupper/flypi/branches/main/protection` if a push is refused.

## Publishing needs an authenticator code

`npm publish` ends with:

```
npm error code EOTP — This operation requires a one-time password.
```

The URL it prints authenticates the CLI session; **completing it does not publish**. Re-run afterwards:

```bash
npm publish --access public --otp=<6-digit>
npm view @makerstufferupper/flypi@<version> version    # must print <version>
```

If the bump and tag already landed, **do not re-run `npm run release`** — that bumps again and publishes
`0.1.5`. The retry is publish-only, from the release commit. A published version number can never be
reused, so dry-run first and be sure before the publish.

## Then the image — after the publish, never before

The image installs the **published** package, by design, so an image and `npm install -g` cannot drift:

```dockerfile
ARG FLYPI_VERSION=latest
RUN npm install -g --no-audit --no-fund @makerstufferupper/flypi@${FLYPI_VERSION}
```

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  --build-arg FLYPI_VERSION=<version> \
  -t makerstufferupper/flypi:<version> -t makerstufferupper/flypi:latest --push .
node scripts/release-check.mjs --published
```

**Always pass `--build-arg FLYPI_VERSION=<version>`.** With the default `latest` the build resolves whatever
the registry currently calls latest — build too early and you bake the *previous* version under the new tag,
silently. Pinned, the build either gets the version you released or fails, which is the answer you wanted.

## The registry propagates in two stages

`npm publish` returns success, and then:

| | visible |
|---|---|
| package metadata — `dist-tags.latest`, the `time` entry | immediately |
| the **tarball** `https://registry.npmjs.org/@makerstufferupper/flypi/-/flypi-<version>.tgz` | ~2 minutes later |

So `npm view @makerstufferupper/flypi@<version> version` can succeed while `npm install -g
@makerstufferupper/flypi@<version>` still fails with `404`. That is exactly how a pinned image build dies
right after a good publish. Poll the tarball URL for `200` before building — `release-check.mjs
--published` does this for you. The same lag cuts the other way: a registry check run seconds *before*
someone else's publish lands reads as "not published". Re-check rather than re-state.

## Verify what shipped

```bash
node scripts/release-check.mjs --published
```

It confirms the tarball is served, that `latest` is the version you released, that the pushed manifest
carries `linux/amd64` **and** `linux/arm64`, and that a container started from the published image reports
that version and names the pi it loaded. Details in [release-checks.md](release-checks.md).

## Gotchas, all of them paid for

| | |
|---|---|
| `npm version patch --dry-run --no-git-tag-version` **writes** `package.json` and `package-lock.json` | it only skips the commit and tag. Previewing the number leaves the tree at the new version, and the next `npm run release patch` publishes one further. `scripts/release.mjs --dry-run` is safe by contrast — it runs nothing. |
| Bumping on a feature branch | the tag and release commit live where `main` cannot see them, and you publish branch code |
| Building the image before the publish | ships the previous package under the new tag |
| Re-running `npm run release` after a failed publish | `0.1.5` instead of `0.1.4` |
| House convention | patch bumps so far, including feature releases (`0.1.2`, `0.1.3` each carried a `feat:`). A new protocol command and a new feature area argue for `minor`; the ladder moves one published rung at a time either way. |
| `docker exec flypi flypi stop` / `… restart` | PID 1 is the `flypi start --foreground` CLI and it exits when the daemon it spawned does (`scripts/flypi.mjs`), so a stop signals the daemon, PID 1 returns and the container exits — and **nothing in the deploy sets a `--restart` policy**, so it stays down. `restart` is worse: it kills the daemon and spawns the replacement into a namespace PID 1 is already leaving. `docker restart flypi`, or rerun `npm run dev:container`; `exec … flypi status` is read-only; for the daemon's output use `docker logs flypi`, because a `--foreground` daemon writes to stdout and never to `.flypi/daemon.log` |
| a `/data/.flypi/daemon.json` left in `flypi-data` whose pid is **alive** in the new container | the record outlives `docker rm -f` (it is in the volume) while the pid namespace restarts, so a recycled number can name a live process; `flypi start` then prints `already running` and exits 0, and as PID 1 that ends the container at once. The by-hand `docker run -d` under "Deploying something that is *not* released" below has already printed a container id, so it **reports success over a corpse**; `npm run dev:container` is honest but slow — 180 s of `/healthz` polling, then `never answered /healthz`. A pid that is merely stale is deleted on startup (`scripts/flypi.mjs`), and `alive()` reads a `/proc` state `Z` as a corpse, so this is a collision, not an old file. Clear the record, never the volume: `docker run --rm -v flypi-data:/data alpine rm /data/.flypi/daemon.json`, then redeploy |

## Deploying something that is *not* released

An unpublished branch cannot use the repo Dockerfile — it installs from npm. Build from a local tarball
instead, with the tarball's directory as the build context so the repo's `.dockerignore` (`*.tgz`) never
applies. One command does all of it:

```bash
npm run dev:container   # build → pack → image → replace the flypi container on 127.0.0.1:8791 → /healthz
```

`--lan` publishes that port on every interface instead of loopback only. The image's `CMD` already binds
`0.0.0.0` inside the container, so the host-side mapping is the only thing that changes. It is exposure, not
a password: `GET /__flypi.json` is unauthenticated and returns the socket token (`src/server/index.ts`), so
anyone who can reach the port can drive this agent — its bash tool, its secrets vault, its memory.

```bash
npm run dev:container -- --lan   # the same container, published on 0.0.0.0:8791
```

What it runs, by hand, is this:

```bash
npm run build && npm pack --pack-destination /tmp/flypi-pack
cp docker/Dockerfile.local /tmp/flypi-pack/Dockerfile
docker build --build-arg FLYPI_TGZ=makerstufferupper-flypi-<version>.tgz -t flypi:local-$(git rev-parse --short HEAD) /tmp/flypi-pack
docker run -d --name flypi -p 127.0.0.1:8791:8791 -v flypi-data:/data flypi:local-<that tag>
```

Tag the image with the **commit sha**: the package version inside it collides with the published one.
`scripts/release-check.mjs` runs exactly this path as its `image` stage.

`scripts/dev-container.mjs` adds the two things the hand-run above gets wrong by omission, and one thing it
refuses to do: it passes `--health-start-period 900s` (a fresh state root spends its first quarter hour
downloading the memory models, so an earlier healthcheck calls a good build unhealthy), it waits for
`/healthz` before reporting success, and it never runs `docker volume rm` on `flypi-data` — that volume is
where those models live, and deleting it turns the next start into a download. It removes the `flypi`
container and the `flypi:local-*` images it replaced, and tags `-dirty` when the tree is not clean.
