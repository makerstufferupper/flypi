# Pre-release checks

`scripts/release-check.mjs` (`npm run release:check`) is the rehearsal: it builds the artifact and installs
it the two ways a user can get it, before anything is published. It never publishes, never pushes an image,
and never touches a container it did not create — everything it makes is `flypi-check-*` on ports
**8792/8793**, so a serving `flypi` on 8791 and its `flypi-data` volume are out of reach. Exit code is the
number of failed checks.

```bash
npm run release:check                    # gates → pack → npm-install → image
npm run release:check -- --published     # the registry and the pushed image, after the publish
npm run release:check -- --skip-gates    # the docker half only
npm run release:check -- --keep          # leave the containers and volumes for a look
```

## What each stage proves

| Stage | Runs | Why it is here |
|---|---|---|
| **gates** | `tsc --noEmit`, `npm test`, `npm run smoke`, `npm run probe:pi` | the suite this version would be published with. `npm publish` runs `prepublishOnly` (typecheck + test + build) anyway; running it first means a red suite costs you nothing. |
| **pack** | `npm run build`, `npm pack`, then reads the tarball | the artifact, not the working tree. Asserts the version, **no self-dependency** (flypi once listed itself in `dependencies`, so `npm install` fetched a second copy of flypi), that `dist/ui/index.html`, `bin/flypi.mjs` and `src/daemon/pi.ts` are inside it, and that nothing stray (`.scratch`, `.flypi`, `node_modules`, `coverage`) is. A missing `dist/ui` is the classic bad tarball: `files` lists it, and only `npm run build` produces it. |
| **npm-install** | fresh `node:24-slim` container + fresh volume, `docker cp` the tarball, `npm i -g /tmp/flypi.tgz`, start, poll `/healthz` | the dependency tree resolves from nothing — this is what `npm install -g @makerstufferupper/flypi` gives a stranger. |
| **image** | `docker build` from `docker/Dockerfile.local` (the repo Dockerfile's runtime shape, installing the same tarball), run it, then `flypi pi use 0.0.0` | the container's real shape: uid 10001, `/data` as the state root, the daemon under PID 1. The last check is the one that only a container can catch — moving pi must refuse **in one sentence** and leave no pin behind, because the package dir is root-owned there (docs/pi-upgrades.md 8.3). |
| **published** | polls the registry **tarball URL** for `200`, asserts `latest` is the released version, `docker buildx imagetools inspect` for `linux/amd64` + `linux/arm64`, then runs the published image | that what landed in the registry and on Docker Hub is the thing that was built. The tarball URL, not `dist-tags`: the metadata propagates ~2 min before the tarball does. |

Every serving check is the same three assertions: `/healthz` reports the expected flypi version, `/healthz`
names the **pi the process loaded** (Phase 8.1 — the point is that the loaded and declared versions can
disagree), and `GET /` is 200.

## Two things the script does on purpose

- **Keyword-only memory** (`--embeddings none --judge none`) in the containers it starts. The default
  bring-up fetches ~900 MB of models into a volume that is deleted seconds later.
- **A pinned build arg** for the published image (`--build-arg FLYPI_VERSION=<version>` in the runbook).
  With the default `latest` a build too soon after a publish silently bakes the previous version under the
  new tag; pinned, it fails instead. See [release.md](release.md).

## Standing baseline

`npm test` is **854 pass / 7 skip** with `tsc --noEmit` clean (2026-10-24). The 7 skips are the real-embedder
and contradiction-judge suites, gated on `FLYPI_EMBED_TESTS`:

```bash
npm run models:warm && FLYPI_EMBED_TESTS=1 npm test
```

That half is not in the rehearsal, because it needs the models downloaded and takes minutes; run it by hand
before a release that touches memory. One case there (`embeds an image and a recording into that same
space`) exceeds vitest's 5 s default when the whole suite runs in parallel — it passes in isolation. It is a
timeout, not a wrong answer, and it predates the pi-version work.

## What the rehearsal does not cover

| Gap | Close it with |
|---|---|
| A model turn | configure a provider in `.flypi/agent/models.json` and send one message in the browser |
| The cold ~900 MB model download | start a container with a fresh volume and no `--embeddings none` |
| amd64 behaviour | the pushed manifest carries it, but only an amd64 host runs it |
| The three-OS matrix | not built — there is no CI (TASKS.md T12), so "green" means this machine |
