# flypi

A local, multi-model agent tool with a browser UI and a personal knowledge wiki, built on the
[pi SDK](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) running in-process.

**Status:** Phases 0–2 are done: an isolated pi runtime, a headless agent server with a resumable streaming
protocol, and a browser UI (chat, an activity panel with thinking and tool output, sessions). The memory store
(Phase 3) is built, and now reaches the agent: every turn is searched against it before the model is asked
anything, and the model can write to it through the MCP tools in `.flypi/agent/mcp.json`.
Everything through Phase 5.5 is built — the daemon and scheduler, the tool permission gate, the secrets
vault — and the recall block is a session entry now (Phases 4.6–4.7).
Next is the review fork (Phase 4.8), then the consolidation sweep, the wiki and the memory browser.
Everything flypi reads or writes lives in
`.flypi/`, never in `~/.pi`.

## Requirements

Node ≥ 22.19 (24+ recommended for the built-in `node:sqlite`).

## Start the dev instance

```bash
./start.sh        # macOS + Linux
start.cmd         # Windows, from cmd or PowerShell
```

That is the whole startup. Node is the only thing it needs, and it does, in order:

1. **Checks Node ≥ 22.19** and stops if it is older.
2. **`npm install`** — only when `node_modules` is missing or `package-lock.json` moved since the last
   install (a hash stamp in `.flypi/install-stamp`).
3. **Writes the config a fresh clone cannot have**: `.flypi/agent/settings.json` and `models.json`
   templates *when absent*, and the `flypi-memory` entry in `mcp.json` with a token generated once and
   read back on later runs, so re-running never orphans a store that already has memories. An existing
   file is never rewritten — a working `models.json` carries `compat`, `cost` and context windows no
   script can guess.
4. **Downloads the two memory models** into `.flypi/models` (`npm run models:warm`: EmbeddingGemma 2 for
   vectors, `nli-deberta-v3-xsmall` for the contradiction judge — ~1.7 GB the first time, instant after).
5. **Verifies**: `npm run probe -- --no-turn` (the config starts a session, and the runtime stays inside
   `.flypi/`), plus one real model turn — only on a config it just wrote, because that is the thing worth
   proving once and nothing new on every later start.
6. **Starts both halves** — the memory MCP server and Vite — after refusing any port something already
   holds, and prints the URL. **Ctrl-C stops all three**; if one half dies, the other goes with it, since
   a chat that silently forgets is worse than one that is plainly down.

What you get: the UI on `http://localhost:5173`, the agent server inside the Vite process on `56789`, the
memory MCP on `8790`. Flags: `--skip-models`, `--skip-verify`, `--turn` (force the turn check),
`--root DIR` (which `.flypi/` the instance owns; npm still runs in the checkout).

The one manual step it cannot do for you: the `models.json` template names a placeholder model id, so set
the provider, `baseUrl` and id your server actually serves — in the file, or from the settings gear in the
UI (`/settings`), which edits the same file. Until you do, the UI comes up and the model turn fails
with that said out loud.

### By hand

```bash
npm install
npm run models:warm                        # optional: fetch the models before the first chat needs them
npm run memory -- --port 8790 --token …    # one shell: the memory store as an MCP server
npm run dev                                # another: Vite + the agent server
```

`npm run dev` alone is a working chat with no memory: the store is a separate process by design (one
writer per database), and `mcp.json` is what points the agent at it — see below for the token.

The packaged shape is the daemon, one process for everything (`flypi` on PATH once installed):

```bash
flypi start --port 8791 --host 0.0.0.0    # --host is needed in a container: a published port cannot
                                          # reach the container's own loopback
flypi start --embeddings none --judge none  # skip the model download entirely
flypi restart                               # keeps the --port/--host above; the memory flags are per-run,
                                          # the settings file is where they belong permanently
flypi stop && flypi start                 # still 8791: the port and interface you named are remembered in
                                          # `.flypi/daemon-flags.json`, so a stop/start does not move the URL
                                          # your bookmarks and your published Docker port point at
flypi update --check                      # is a newer flypi published? `flypi update` installs it
```

The **daemon keeps itself current**: once a day it asks the registry whether a newer flypi is published,
downloads the package (~0.4 MB, verified against the checksum the registry published with it), and installs it
only after a stretch of nothing happening — no page attached and no turn in flight, held for ten minutes, the
same idle the memory sweep uses. Installing replaces the files the daemon is running from, so it restarts
itself through `flypi restart`, which is what keeps the port above. **It moves one published release at a
time** — `0.1.0 → 0.1.1`, never `0.1.0 → 0.3.0` — because flypi's databases migrate when the version that needs
the migration starts, and a jump would skip the step in between; catching up takes one restart per release. `flypi status` and the sidebar in the UI
say what it found and whether the package is already downloaded; `flypi update` is the version of that you can
ask for at a keyboard, and `flypi update --check` only answers. The sidebar shows the same news with an
**install now** button for someone who will not wait: the daemon restarts to run the install, so the page that
asked for it becomes an **updating** screen and comes back on its own — it watches `/healthz` for a new process,
and reloads into the new build when that process reports a new version (asset names change with every build).
It also re-reads its token and reconnects by itself — the token is per run, so any restart (an update, a crash, a
`flypi restart`) used to leave an open page dialling a token that no longer existed. A **git checkout is not an
installed package** — it has `.git` next to the code, it updates with `git pull`, and the registry has never heard of it,
so the daemon does not ask and `flypi update` says which three commands to run instead.

The settings view also **installs extensions** (`/settings` → Extensions): type an npm spec (`npm:pi-web-access`),
a git URL or a path, and it goes through pi's own package manager into `packages` in
`.flypi/agent/settings.json`, with the code under `.flypi/agent/npm/` — never the host `~/.pi`. The conversation
open on screen is reloaded, so the tool is there without starting a new chat. **Those are kept current the same
way flypi is**: the daemon checks the registries once a day and installs what it finds during the same idle
stretch, and the row says "update available" until it does. A source that names a version (`npm:x@1.2.0`) or a
git ref is pinned and stays there — naming a version is asking for that version. An extension runs with your
files and keys: install what you have read.

An extension that registers a **slash command** gets one in the chat: type `/` in the prompt box and the commands
this conversation has appear under it (pi's own list — extension commands and prompt templates — on the same
snapshot the model selector reads). Sending `/ping` runs it with no model call, and what it says comes back:
`ctx.ui.notify` is shown in the chat, and a `select` / `confirm` / `input` question appears as buttons or a box
the extension waits on. A file in `.flypi/agent/extensions/` is found the same way, without the install.

The **default fetches the memory models** — `onnx-community/embeddinggemma-2-ONNX` (~811 MB) and
`Xenova/nli-deberta-v3-xsmall` (~83 MB) into `.flypi/models` — on the first start, printing progress, and
the daemon is not listening until they are in place. `--embeddings none --judge none` skips that entirely:
keyword-only memory, ~0.4 MB of state, up in seconds. That is the mode the tests and CI run; a later start
finds the weights cached and takes ~13 s instead of ~2 min.

### When it says no

| It says | What it means |
|---|---|
| `something is already listening on 8790` | the always-on daemon owns that port: `node scripts/flypi.mjs stop`, or point `mcp.json` at another port and the script follows it |
| `port 8791 — the one an earlier start used — is already taken` | something else has taken the remembered port by now. A bare `flypi start` binds another and says where it landed; an explicit `--port 8791` stops instead of moving, because a published container port is useless on another number |
| `the config is wired, but the model did not answer` | the endpoint is not serving that model id — fix `models.json`, the UI still starts |
| `the embedding model did not load` | no network or no disk for the download; `--skip-models` starts anyway and memory is keyword-only until it is fetched |
| `mcp.json asks for ${FLYPI_MEMORY_TOKEN}, which is not set` | only reachable by hand-run halves: `start.mjs` puts the token in both children's environment whichever form the file uses |

## Try it

```bash
npm install
npm run start              # the whole dev startup: install, config + memory token, models, verify, run
npm run dev                # the browser UI on http://localhost:5173 + the agent server, one command
npm run models:warm        # fetch/load the two memory models into .flypi/models
npm test                 # every test runs against a deterministic stub model: no provider, no network
npm run typecheck
npm run build && npm run serve   # the production shape: the server serves dist/ui and prints its token
npm run smoke            # the recorded transcript golden + a real multi-tool turn through the server
npm run smoke:memory     # the memory gate: SQLite, hybrid search, status rules, MCP over HTTP
npm run smoke:secrets    # the vault gate: ciphertext at rest, `[secret:name]` in every artifact, a second process reading
npm run secret -- list   # the vault from a shell: list · get · print · put · path · delete · undelete · rotate · import-ssh
npm run memory           # serve the memory store as an MCP server (prints its URL and token)
npm run probe            # prove the pi runtime is isolated to .flypi/ and can complete a turn
npm run record           # regenerate tests/fixtures/transcript-log from the stub model
```

Point a model at it first: `.flypi/agent/settings.json` picks the provider and model,
`.flypi/agent/models.json` defines them (a custom OpenAI-compatible provider needs no API key).
`npm run probe` prints exactly which files it read and refuses to run if any of it is missing. The app can do
that editing too: the gear in the sidebar (or `/settings`) opens a settings view listing those endpoints
and the MCP servers in `.flypi/agent/mcp.json`, and marks which endpoint and model a **new** conversation
starts on — an existing conversation keeps the model its session was created with.

Anything that is *not* a model-provider key belongs to the vault: the key in that same sidebar row (or
`/secrets`) lists credentials as masks — head, tail, notes, what uses them — and a value appears only
when you ask for it, and hides itself again. Nothing copies it anywhere: what the agent prints, what the
session file keeps, and what memory stores all say `[secret:NAME]`, and `.flypi/agent/*.json` may name a value
with `"!flypi secret print NAME"` instead of holding it.

That file is what connects the memory store to the agent, and the store is a separate process: memory is live
when both halves are up.

```bash
export FLYPI_MEMORY_TOKEN=something-long          # the name ${FLYPI_MEMORY_TOKEN} in mcp.json reads
npm run memory -- --port 8790                     # the port the same file points at
```

With the server down nothing is silent: every turn's recall block says the search failed and names the tool to
call instead, and the memory tools are simply absent from the session.

Start either half without `FLYPI_MEMORY_TOKEN` and the entry cannot authenticate at all — the file is valid and
the store may be up, so nothing else would say so. Every entrypoint prints it at startup
(`flypi: mcp.json asks for ${FLYPI_MEMORY_TOKEN}, which is not set …`), and the sessions then say nothing about
memory either: no standing instruction, no recall, and no note telling the model to call a tool that was never
connected.

## Open the UI

`npm run dev` gives you Vite (HMR) proxying to an agent server it started for you; `npm run build &&
npm run serve` is the same app served by the server itself. The page reads its token from `/__flypi.json`
on its own origin, so neither needs config — and the token in the printed URL is the same one.

What is on screen is what the protocol carries: the transcript is rendered by the same mapper
(`src/shared/transcript.ts`) the fixture golden and `npm run smoke` use. Tool cards are keyed by pi's own
`toolCallId`; usage and cost are read out of the message events rather than counted again; the sidebar's
model/thinking selectors and the debug section behind the activity panel come from the `debug` command. Under
the prompt box a strip reports the model live: prefill and decode tokens/sec, measured from when the events
arrive and averaged over the answers a question streamed, so a tool call's wait lands in no window
(`src/shared/metrics.ts` — pi reports tokens, not rates, and a local server reports them in the stream's
last chunk, so an answer counts for nothing until it reports its own tokens and the strip holds the last
numbers it measured while you wait), and the context window as a circular gauge
fed by pi's own `getContextUsage()` estimate rather than a second count. Paste an image or a file into the prompt
box and the image reaches the model as an image, while anything else is written to `.flypi/uploads/` and named by
path so the agent opens it with its own tools — and the box says so when the model you are on has no image input at
all, because pi would otherwise swap the image for a sentence about it. Open a session from the sidebar
and its history replays over the same
`resume` path a reconnecting tab uses. Deleting a session from its row removes the session file for good, and
the conversation on it with it.

## Talk to the server

`npm run serve` prints the URL with the token in it, so there is no config file to consult:

```bash
wscat -c 'ws://127.0.0.1:56789/?token=<token>'
```

```json
{"type":"newSession","requestId":"1"}
{"type":"prompt","conversationId":"<from the result frame>","text":"List the files in this directory."}
```

The first turn comes back as a stream of `event` frames — `agent_start`, a `tool_execution_start` for the
real `bash` call, `message_update` deltas, `agent_end`, `agent_settled`. Now close the tab mid-turn and
reopen it, holding the last `seq` you saw:

```json
{"type":"resume","conversationId":"<same id>","afterSeq":14}
```

The rest of the turn replays from the beginning of what you missed, with the same sequence numbers. The
server kept working while no client was connected; that is the point of Phase 1.
