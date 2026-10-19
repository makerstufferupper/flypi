# flypi

A local, multi-model agent tool with a browser UI and a personal knowledge wiki, built on the
[pi SDK](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) running in-process.
Everything it reads or writes lives in `.flypi/` — never in `~/.pi`.

## Install

```bash
npm install -g @makerstufferupper/flypi
```

Requires Node ≥ 22.19 (24 or newer is recommended, for the built-in `node:sqlite`).

## Run

```bash
flypi start      # starts the daemon and prints the URL with a per-run token
flypi status     # what is running, and which version
flypi logs -f
flypi stop
```

The first start downloads two local models (~900 MB) for the memory store — an embedder and a
contradiction judge. Skip them with `flypi start --embeddings none --judge none`.

## Configure

`.flypi/agent/models.json` names your providers and models, and `.flypi/agent/settings.json` picks
the default pair. The settings page in the UI edits the same two files. Until you add a provider the
UI comes up normally and the model turn says out loud that no default is set.

## What you get

- A chat UI with thinking, tool output, sessions, and image paste.
- A memory wiki: every turn is searched against it before the model is asked anything, and the model
  can write to it over MCP.
- A daemon with a scheduler, a tool permission gate, and an encrypted secrets vault.
- Any endpoint pi supports, including local OpenAI-compatible servers.

## License

MIT
