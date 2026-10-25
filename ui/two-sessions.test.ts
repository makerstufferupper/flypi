/**
 * The page over a real socket, to a real server, on a stubbed model — the only level at which the session
 * bugs of docs/testing.md are visible: `ui/app.test.ts` drives a fake transport, so it can say which command
 * the page sends but not what the server does with the session behind it.
 *
 * Two of them here. Moving between sessions must not cut a turn short: a sidebar row used to rebind the
 * conversation on screen, and rebinding disposes the session behind it, so a row clicked mid-turn lost the
 * answer — the session file kept the prompt and nothing else, and coming back to it showed a blank chat. And
 * a restart must not print `unknown conversation <uuid>` on the chat: the registry is in-memory, so a fresh
 * process has forgotten every conversation the page is holding, and the page recovers from that by itself.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tick } from "svelte";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import App from "./App.svelte";
import { Socket, type Transport } from "./lib/client.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for a condition, or fail the wait rather than the assertion that follows it. */
async function until(check: () => boolean, ms = 30_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check() && Date.now() < deadline) await sleep(200);
}

interface LiveServer {
	child: ChildProcess;
	port: string;
	token: string;
}

/** A real server process on the stub model. A second call with the same `root` is a restart. */
async function startServer(options: { root?: string; port?: string } = {}): Promise<LiveServer> {
	const args = ["tsx", "tests/helpers/live-server.ts"];
	if (options.root) args.push("--root", options.root);
	if (options.port) args.push("--port", options.port);
	// Detached, so the whole process group can be killed: `npx` puts the real server in a child of its own,
	// and killing only `npx` would leave a process holding the port the restart has to bind.
	const child = spawn("npx", args, { detached: true });
	let out = "";
	child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
	child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
	const ready = await (async () => {
		const deadline = Date.now() + 40_000;
		while (!out.includes("READY") && Date.now() < deadline) await sleep(200);
		return out.split("\n").find((line) => line.startsWith("READY"));
	})();
	if (!ready) throw new Error(`server did not start: ${out}`);
	const [, port, token] = ready.split(" ") as [string, string, string, string];
	return { child, port, token };
}

/** Stop a server for real — the whole group, not just the `npx` wrapper. */
function stop(server: LiveServer | undefined): void {
	if (!server?.child.pid) return;
	try {
		process.kill(-server.child.pid, "SIGKILL");
	} catch {
		// Already gone.
	}
}

/**
 * `/__flypi.json` over `node:http`, not `fetch`: happy-dom's fetch enforces the same-origin policy, so the
 * absolute URL a reconnecting socket needs is refused with a CORS error and the new token never arrives.
 */
function getJson(port: string, path: string): Promise<Response> {
	return new Promise((resolve, reject) => {
		get({ host: "127.0.0.1", port: Number(port), path }, (response) => {
			let body = "";
			response.on("data", (chunk: Buffer) => (body += chunk.toString()));
			response.on("end", () =>
				resolve({ ok: (response.statusCode ?? 500) < 400, status: response.statusCode, json: async () => JSON.parse(body) } as Response),
			);
		}).on("error", reject);
	});
}

/** Mount the real page against a real socket, with only the `/healthz` poll stubbed out. */
function mountPage(port: string, token: string): Socket {
	vi.stubGlobal("location", {
		protocol: "http:",
		host: `127.0.0.1:${port}`,
		hostname: "127.0.0.1",
		port,
		pathname: "/",
		search: "",
		hash: "",
		href: `http://127.0.0.1:${port}/`,
		origin: `http://127.0.0.1:${port}`,
	});
	vi.stubGlobal("fetch", async (input: RequestInfo | URL) => (String(input).startsWith("/__flypi.json") ? getJson(port, "/__flypi.json") : ({ json: async () => ({}) } as Response)));
	const socket = new Socket({ protocolVersion: 1, token, wsPath: "/ws" });
	socket.connect();
	render(App as Parameters<typeof render>[0], { props: { transport: socket as Transport } });
	return socket;
}

/** The sidebar, the prompt box and the chat, as helpers shared by both tests. */
function page() {
	return {
		/** Every sidebar row, the one on screen too: that one is the name field, the others are buttons. */
		rows: () =>
			[...document.querySelectorAll(".sessions li")].map((li) => {
				const field = li.querySelector("input") as HTMLInputElement | null;
				return field ? field.value || field.placeholder : (li.querySelector("button.session")?.textContent ?? "").trim();
			}),
		openRow: (name: string) => {
			const button = [...document.querySelectorAll(".sessions button.session")].find((candidate) => (candidate.textContent ?? "").includes(name));
			if (!button) throw new Error(`no row for ${name}`);
			fireEvent.click(button);
		},
		/** What the chat says, whitespace collapsed: the transcript plus the answer on it. */
		chat: () => (document.querySelector(".messages")?.textContent ?? "").replace(/\s+/g, " "),
		alert: () => document.querySelector('[role="alert"]')?.textContent ?? null,
		say: async (text: string) => {
			const box = document.querySelector("textarea") as HTMLTextAreaElement;
			box.value = text;
			box.dispatchEvent(new Event("input", { bubbles: true }));
			await tick();
			fireEvent.submit(box.closest("form") as Element);
			await tick();
		},
	};
}

describe("two sessions on the real page", { timeout: 120_000 }, () => {
	it("keeps the answer of the session it leaves mid-turn, and comes back to it", async () => {
		const server = await startServer();
		const socket = mountPage(server.port, server.token);
		const ui = page();
		try {
			await sleep(1500);

			// Two sessions, each asked while the one before it is still answering.
			await ui.say("first session question");
			await sleep(400);
			fireEvent.click(document.querySelector('button[aria-label="New session"]') as Element);
			await sleep(800);
			await ui.say("second session question");
			await sleep(400);

			// Leave the second session mid-turn, and let both answers land where nobody is looking.
			ui.openRow("first session question");
			await sleep(4000);

			// Both rows are still there, so switching between them is possible at all.
			expect(ui.rows().length).toBe(2);
			// Each session's own file has its own answer — this is what a mid-turn rebind used to lose.
			expect(ui.chat()).toContain("answer number 1");
			expect(ui.chat()).not.toContain("answer number 2");

			// And coming back shows that session's answer, not the other one's.
			ui.openRow("second session question");
			await sleep(1500);
			expect(ui.chat()).toContain("second session question");
			expect(ui.chat()).toContain("answer number 2");
			expect(ui.chat()).not.toContain("first session question");
		} finally {
			cleanup();
			socket.close();
			stop(server);
			vi.unstubAllGlobals();
		}
	});

	it("comes back from a server restart without showing the user an error", async () => {
		const root = mkdtempSync(join(tmpdir(), "flypi-restart-"));
		const first = await startServer({ root });
		const socket = mountPage(first.port, first.token);
		const ui = page();
		let second: LiveServer | undefined;
		const dir = `${root}/.flypi/sessions`;
		const onDisk = () => readdirSync(dir).map((name) => readFileSync(`${dir}/${name}`, "utf8")).join("\n");
		try {
			await sleep(1500);
			await ui.say("a question before the restart");
			// A turn in flight is not on disk yet, and this test is about a conversation the process lost —
			// so wait for the answer to land before killing it.
			await until(() => onDisk().includes("answer number 1"));
			expect(onDisk()).toContain("answer number 1");
			expect(ui.chat()).toContain("answer number 1");

			// The daemon restarts: same state on disk, a fresh (empty) registry and a new token. The page is
			// still holding its conversation id, reconnects on its own, and resumes an id this process never had.
			stop(first);
			await sleep(1000);
			second = await startServer({ root, port: first.port });
			await until(() => ui.chat().includes("a question before the restart"), 20_000);

			// It recovered, and it said nothing about it: `unknown conversation <uuid>` is not something a user
			// can act on. What the chat says instead is the answer, from the session the page rebound to.
			expect(ui.alert()).toBeNull();
			expect(ui.chat()).toContain("a question before the restart");
			expect(ui.chat()).toContain("answer number 1");

			// And the page is alive: another turn lands on the conversation it recovered with.
			await ui.say("a question after the restart");
			await until(() => ui.chat().includes("a question after the restart"), 20_000);
			expect(ui.alert()).toBeNull();
		} finally {
			cleanup();
			socket.close();
			stop(first);
			stop(second);
			vi.unstubAllGlobals();
		}
	});
});
