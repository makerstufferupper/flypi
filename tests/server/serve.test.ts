import { spawn } from "node:child_process";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";

const root = resolve(import.meta.dirname, "../..");
const cli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
const serve = join(root, "scripts", "serve.ts");

describe("npm run serve", () => {
	// The wait and the test timeout are deliberately different numbers. This spawns a real `npm run serve`
	// child, so it is the one suite member that depends on a process starting: on a cold or loaded machine
	// that can take longer than a few seconds, and when it does the failure has to read "here is what it
	// printed" rather than "timed out" — which is what a matching pair of numbers produced (5000 ms each).
	it("prints a connect URL and answers a prompt over it", { timeout: 30_000 }, async () => {
		const child = spawn(process.execPath, [cli, serve, "--port", "0", "--token", "let-me-in"], {
			cwd: root,
			stdio: ["ignore", "pipe", "inherit"],
		});
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
		try {
			for (let attempt = 0; attempt < 400 && !output.includes("flypi: connect"); attempt++) {
				await new Promise((resolveWait) => setTimeout(resolveWait, 50));
			}
			const url = /flypi: connect\s+(\S+)/.exec(output)?.[1];
			expect(url, output).toContain("?token=let-me-in");

			// The printed URL is the whole setup: no config file to consult.
			const socket = new WebSocket(url!);
			try {
				// Every wait here is bounded, for the same reason the child's stop is: an unbounded await that
				// is still pending when the test times out skips the cleanup below, the child keeps the worker's
				// stdout pipe open, and the run answers nothing for an hour. (Observed: a cold machine, 19:39.)
				// The message listener goes on before the open wait, not after it: the server sends `hello` in
				// the turn the handshake completes, and `await` resumes its continuation only after that turn, so
				// attaching after the open can miss the frame with nothing listening. That reads as "no hello
				// frame arrived" on a loaded machine and passes on an idle one (seen 2026-10-16 under
				// `--coverage`). The no-op catch keeps a socket error from becoming an unhandled rejection when
				// the open wait fails first.
				const hello = once(socket, "message");
				hello.catch(() => {});
				await withDeadline(once(socket, "open"), 10_000, `the socket to ${url} did not open`);
				const [frame] = await withDeadline(hello, 10_000, "no hello frame arrived");
				expect(JSON.parse(String(frame)).type).toBe("hello");
			} finally {
				socket.terminate();
			}
		} finally {
			child.kill("SIGTERM");
			// Bounded on purpose. `once(child, "exit")` never settles if the child ignores SIGTERM, and the
			// open stdout pipe keeps the worker alive with it — the shape a failing test takes then is a suite
			// that runs for ten minutes and answers nothing, not a failure anyone can read.
			const exited = await Promise.race([
				once(child, "exit").then(() => true),
				new Promise((resolveWait) => setTimeout(() => resolveWait(false), 5_000)),
			]);
			expect(exited, `the child would not stop on SIGTERM; it printed:\n${output}`).toBe(true);
			expect(child.exitCode).toBe(0);
		}
	});
});

/** A promise that has to settle inside `ms`, or the failure names the wait that did not. */
function withDeadline<T>(promise: Promise<T>, ms: number, why: string): Promise<T> {
	return Promise.race([promise, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`${why} (after ${ms}ms)`)), ms))]);
}
