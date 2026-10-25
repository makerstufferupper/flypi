/**
 * A real flypi server on the stub model, for the page-level tests: the page, the socket and the registry
 * all real, only the model faked. It prints `READY <port> <token> <root>` on stdout when it is listening.
 *
 * Run as a child process (`npx tsx`) rather than in-process: the UI tests run under happy-dom, where
 * importing the server's WebSocket dependency fails.
 *
 * `--root <path>` and `--port <n>` let a test restart the server over the same state — a fresh registry,
 * which is what a daemon restart looks like to a page that is holding a conversation.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionRegistry } from "../../src/server/session-registry.ts";
import { startFlypiServer } from "../../src/server/index.ts";
import { stubCreateSession, toolTurn } from "./flypi-harness.ts";
import { createTempFlypiRoot } from "./flypi-root.ts";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
	const at = argv.indexOf(`--${name}`);
	return at >= 0 ? argv[at + 1] : undefined;
};
const root = flag("root") ?? createTempFlypiRoot();
const port = Number(flag("port") ?? 0);
// The harness's checkout, without the harness: a restart needs the same root and its own registry.
mkdirSync(join(root, ".flypi", "agent"), { recursive: true });
writeFileSync(join(root, ".flypi", "agent", "auth.json"), "{}\n");

let turns = 0;
const registry = new SessionRegistry({
	root,
	// About two seconds per answer at this rate, so the page can move between sessions mid-turn.
	createSession: stubCreateSession(root, () => {
		turns += 1;
		return toolTurn(`answer number ${turns} ${"word ".repeat(40)}`)();
	}, {
		tokensPerSecond: 20,
		// The same isolation `harness()` gives its sessions: without it the stub runtime reads the developer's
		// own `~/.pi/agent/auth.json` (and writes its lock), so a UI test would depend on whose machine ran it.
		authPath: join(root, ".flypi", "agent", "auth.json"),
	}),
});
const server = await startFlypiServer({ registry, port });
console.log(`READY ${server.port} ${server.token} ${root}`);
