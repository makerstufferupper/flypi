# flypi

A local, multi-model agent tool with a browser UI and a personal knowledge wiki, built on the
[pi SDK](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) running in-process. Everything it
reads or writes lives in `.flypi/` — never in `~/.pi`.

![flypi in the browser: a session sidebar, the chat with its model and thinking selectors, and an activity panel](https://raw.githubusercontent.com/makerstufferupper/flypi/main/assets/screenshot.png)

## Start a container

```bash
docker run -d --name flypi -p 127.0.0.1:8791:8791 -v flypi-data:/data makerstufferupper/flypi
open http://localhost:8791/
```

No start command: the container starts the daemon and prints its URL in `docker logs`.

`-v flypi-data:/data` is where `.flypi/` lives — conversations, the memory wiki, your config and the ~900 MB
of memory models — so it survives the container being removed. Without it, the download and everything you
wrote go with it.

Bind `127.0.0.1:` unless you want the whole LAN to reach it: the page and `/healthz` are served without the
token.

```bash
docker logs -f flypi                     # the daemon's output, including the model download
docker exec flypi flypi status           # what is running, on which port, which version
docker exec flypi flypi logs -n 100      # the daemon's own log file
docker stop flypi                        # shuts down properly: an in-flight turn is recorded as
                                         # interrupted, never re-run
```

`flypi update` does not work in a container — the package is read-only there. Pull a new image instead.

## Keyword-only memory (no ~900 MB download)

```bash
docker run -d --name flypi -p 127.0.0.1:8791:8791 -v flypi-data:/data makerstufferupper/flypi \
	flypi start --foreground --port 8791 --host 0.0.0.0 --embeddings none --judge none
```

Memory search then works on keywords only. The two local models — an embedder and a contradiction judge —
are what the first command downloads on its first run.

## Tags

`latest` and `<version>` (currently `0.1.3`), each built for `linux/amd64` and `linux/arm64`. The image
installs the published npm package,
[@makerstufferupper/flypi](https://www.npmjs.com/package/@makerstufferupper/flypi), so it is the same code
`npm install -g` gives you.

## Configure

`.flypi/agent/models.json` names your providers and models, and `.flypi/agent/settings.json` picks the
default pair. The Settings page in the UI edits those same two files, so you can set it up in the browser on
first run. Until you add a provider the UI comes up normally and the model turn says out loud that no default
is set. Local OpenAI-compatible servers (LM Studio, llama.cpp, Ollama) work the same as any endpoint pi
supports.

## What you get

- A chat UI with thinking, tool output, sessions, and image paste.
- A memory wiki: every turn is searched against it before the model is asked anything, and the model can
  write to it over MCP.
- A daemon with a scheduler, a tool permission gate, and an encrypted secrets vault.
- Any endpoint pi supports, including local OpenAI-compatible servers.

## Without Docker

```bash
npm install -g @makerstufferupper/flypi
flypi start
```

Requires Node ≥ 22.19 (24 or newer recommended, for the built-in `node:sqlite`).

## License

MIT — [github.com/makerstufferupper/flypi](https://github.com/makerstufferupper/flypi)
