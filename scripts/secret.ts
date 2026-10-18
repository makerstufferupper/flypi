#!/usr/bin/env node
/**
 * The vault from a shell (docs/secrets.md Phase 5.5): `flypi secret list | get | print | put | rotate |
 * delete | undelete | path | import-ssh | rotate-key`.
 *
 *   echo 'sk-…' | flypi secret put openai_key --kind password
 *   flypi secret print openai_key          # the value, for `!flypi secret print NAME` in a config file
 *
 * The value comes from stdin, not argv, so it does not appear in the process list next to a username. Read
 * commands open the database read-only, which is why they answer while the daemon is running.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runSecretCli } from "../src/secrets/cli.ts";

const argv = process.argv.slice(2);
const rootAt = argv.indexOf("--root");
const root = rootAt === -1 ? process.env.FLYPI_ROOT ?? process.cwd() : (argv[rootAt + 1] ?? "");
if (rootAt !== -1) argv.splice(rootAt, 2);

// A piped value, read here so `runSecretCli` stays synchronous and testable (src/secrets/cli.ts). A terminal
// would block on stdin, so only a pipe or a redirect counts.
const stdin = process.stdin.isTTY ? undefined : readFileSync(0, "utf8");
process.exit(runSecretCli(argv, { root: resolve(root), ...(stdin === undefined ? {} : { stdin }) }));
