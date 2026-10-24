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

## Deploying something that is *not* released

An unpublished branch cannot use the repo Dockerfile — it installs from npm. Build from a local tarball
instead, with the tarball's directory as the build context so the repo's `.dockerignore` (`*.tgz`) never
applies:

```bash
npm run build && npm pack --pack-destination /tmp/flypi-pack
cp docker/Dockerfile.local /tmp/flypi-pack/Dockerfile
docker build --build-arg FLYPI_TGZ=makerstufferupper-flypi-<version>.tgz -t flypi:local-$(git rev-parse --short HEAD) /tmp/flypi-pack
docker run -d --name flypi -p 127.0.0.1:8791:8791 -v flypi-data:/data flypi:local-<that tag>
```

Tag the image with the **commit sha**: the package version inside it collides with the published one.
`scripts/release-check.mjs` runs exactly this path as its `image` stage.
