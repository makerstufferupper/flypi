/**
 * The phone's layout state: the drawer, the sheet and the bar (docs/mobile.md Phase 10.1). What is asserted
 * here is the state the page owns — `<html data-nav>`, `<html data-sheet>`, `inert` on the page behind the
 * drawer, where focus goes, and which closes are dismissals — plus the two strings the bar reads. The
 * geometry is CSS and is measured in `.scratch/mockups` (`render.mjs`), not here: happy-dom has no layout.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import App from "./App.svelte";
import type { ClientCommand, ServerFrame, SessionSummary } from "../src/server/protocol.ts";
import type { Transport } from "./lib/client.ts";
import { sessionHint, sessionTitle } from "./lib/sessions.ts";

type Signal = ServerFrame | { type: "connected" } | { type: "disconnected" };

class FakeTransport implements Transport {
	sent: ClientCommand[] = [];
	#handlers = new Set<(signal: Signal) => void>();

	on(handler: (signal: Signal) => void): () => void {
		this.#handlers.add(handler);
		return () => this.#handlers.delete(handler);
	}

	send(command: ClientCommand): void {
		this.sent.push(command);
	}

	emit(signal: Signal): void {
		for (const handler of this.#handlers) handler(signal);
	}
}

const SESSION: SessionSummary = {
	path: "/tmp/mobile.jsonl",
	name: "mobile layout",
	modified: "2026-10-28T12:00:00.000Z",
	messageCount: 4,
	firstMessage: "make it usable on a phone",
};

const OTHER: SessionSummary = {
	path: "/tmp/other.jsonl",
	name: "the other one",
	modified: "2026-10-27T12:00:00.000Z",
	messageCount: 2,
	firstMessage: "another conversation",
};

let seq = 0;

/** Mount the page and answer the two things it asks on connect: a conversation and the session list. */
async function mount(sessions: SessionSummary[] = [SESSION, OTHER]): Promise<FakeTransport> {
	const transport = new FakeTransport();
	render(App as Parameters<typeof render>[0], { props: { transport } });
	transport.emit({ type: "connected" });
	await tick();
	const created = transport.sent.find((command) => command.type === "newSession");
	transport.emit({ type: "result", requestId: (created as { requestId: string }).requestId, conversationId: "c1", sessionPath: SESSION.path });
	await tick();
	answerSessions(transport, sessions);
	await tick();
	return transport;
}

/** The list is a request, so the request id is what the answer is addressed to. */
function answerSessions(transport: FakeTransport, sessions: SessionSummary[]): void {
	const asked = [...transport.sent].reverse().find((command) => command.type === "listSessions");
	transport.emit({ type: "result", requestId: (asked as { requestId: string }).requestId, sessions });
}

/** The frames the server sends for one finished tool call: the call, then its result. */
function call(id: string, name: string, args: unknown, output: string): AgentSessionEvent[] {
	return [
		{ type: "tool_execution_start", toolCallId: id, toolName: name, args } as AgentSessionEvent,
		{ type: "tool_execution_end", toolCallId: id, toolName: name, result: output, isError: false } as AgentSessionEvent,
	];
}

async function send(transport: FakeTransport, events: AgentSessionEvent[]): Promise<void> {
	for (const event of events) transport.emit({ type: "event", conversationId: "c1", seq: ++seq, event });
	await tick();
}

const navToggle = () => document.querySelector<HTMLButtonElement>('[data-role="nav-toggle"]')!;
const drawer = () => document.querySelector<HTMLElement>("#flypi-sidebar")!;
const main = () => document.querySelector<HTMLElement>(".main")!;
const handle = () => document.querySelector<HTMLButtonElement>(".sheet-handle")!;
const where = () => document.querySelector("[data-role='where']")?.textContent ?? "";
const navState = () => document.documentElement.dataset.nav;
const sheetState = () => document.documentElement.dataset.sheet;

async function openDrawer(): Promise<void> {
	fireEvent.click(navToggle());
	await tick();
}

afterEach(() => {
	cleanup();
	seq = 0;
	delete document.documentElement.dataset.nav;
	delete document.documentElement.dataset.sheet;
	localStorage.removeItem("flypi.sheetOpen");
	localStorage.removeItem("flypi.theme");
	history.replaceState(null, "", "/");
});

describe("the drawer", () => {
	it("opens from the bar: data-nav moves, the page behind is inert, and focus goes into the drawer", async () => {
		await mount();
		expect(navState()).toBe("closed");
		expect(main().hasAttribute("inert")).toBe(false);

		await openDrawer();

		expect(navState()).toBe("open");
		expect(main().hasAttribute("inert")).toBe(true);
		expect(navToggle().getAttribute("aria-expanded")).toBe("true");
		expect(document.activeElement).toBe(drawer());
	});

	it("closes on the scrim, and puts focus back on the button that opened it", async () => {
		await mount();
		await openDrawer();

		fireEvent.click(screen.getByLabelText("Close sessions"));
		await tick();

		expect(navState()).toBe("closed");
		expect(main().hasAttribute("inert")).toBe(false);
		console.log("ACTIVE:", document.activeElement?.tagName, (document.activeElement as HTMLElement)?.dataset?.role, (document.activeElement as HTMLElement)?.className, "navBtn:", navToggle().outerHTML.slice(0, 60));
		expect(document.activeElement).toBe(navToggle());
	});

	it("closes on Escape", async () => {
		await mount();
		await openDrawer();

		fireEvent.keyDown(window, { key: "Escape" });
		await tick();

		expect(navState()).toBe("closed");
		expect(document.activeElement).toBe(navToggle());
	});

	it("closes when a session row is picked — the row is the navigation", async () => {
		await mount();
		await openDrawer();

		const row = [...document.querySelectorAll<HTMLButtonElement>(".sessions button.session")].find((button) => button.textContent?.includes("the other one"));
		expect(row).toBeTruthy();
		fireEvent.click(row!);
		await tick();

		expect(navState()).toBe("closed");
	});

	it("closes when a title-row action changes the view, but not when the theme changes", async () => {
		await mount();
		await openDrawer();

		fireEvent.click(document.querySelector('[data-role="settings"]') as Element);
		await tick();
		expect(navState()).toBe("closed");

		await openDrawer();
		fireEvent.click(screen.getByLabelText("Switch to dark theme"));
		await tick();
		expect(navState()).toBe("open");
	});
});

describe("the top bar", () => {
	it("names the session on screen, in the sidebar's own words", async () => {
		await mount();
		expect(where()).toBe("mobile layout");
	});

	it("falls back from the name to the first message to the path", () => {
		expect(sessionHint({ ...SESSION, name: "" })).toBe("make it usable on a phone");
		expect(sessionTitle({ ...SESSION, name: "", firstMessage: "" })).toBe("/tmp/mobile.jsonl");
		expect(sessionTitle({ ...SESSION, name: "", firstMessage: "", path: "/tmp/p.jsonl" })).toBe("/tmp/p.jsonl");
	});

	it("names the view when a full-screen view replaces the chat", async () => {
		await mount();
		for (const [role, label] of [["settings", "Settings"], ["secrets", "Secrets"], ["memory", "Memory"]]) {
			fireEvent.click(document.querySelector(`[data-role="${role}"]`) as Element);
			await tick();
			expect(where()).toBe(label);
		}
	});

	it("says a new session before a conversation arrives", async () => {
		const transport = new FakeTransport();
		render(App as Parameters<typeof render>[0], { props: { transport } });
		transport.emit({ type: "connected" });
		await tick();
		expect(where()).toBe("new session");
	});
});

describe("the activity sheet", () => {
	it("is opened by its handle, remembered, and closed again", async () => {
		await mount();
		expect(sheetState()).toBe("closed");
		expect(handle().getAttribute("aria-expanded")).toBe("false");
		expect(handle().getAttribute("aria-controls")).toBe("flypi-activity");

		fireEvent.click(handle());
		await tick();
		expect(sheetState()).toBe("open");
		expect(handle().getAttribute("aria-expanded")).toBe("true");
		expect(localStorage.getItem("flypi.sheetOpen")).toBe("1");

		fireEvent.click(handle());
		await tick();
		expect(sheetState()).toBe("closed");
		expect(localStorage.getItem("flypi.sheetOpen")).toBe("0");
	});

	it("opens open on a page that was left open", async () => {
		localStorage.setItem("flypi.sheetOpen", "1");
		await mount();
		expect(sheetState()).toBe("open");
	});

	it("says what is running and how much has happened", async () => {
		const transport = await mount();
		await send(transport, [
			{ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "npm test" } } as AgentSessionEvent,
			{
				type: "message_end",
				message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "npm test" } }] },
			} as unknown as AgentSessionEvent,
		]);
		expect(handle().textContent?.trim()).toBe("running bash · 1 entry");
	});

	it("says nothing yet, then the count", async () => {
		const transport = await mount();
		expect(handle().textContent?.trim()).toBe("Activity · nothing yet");

		await send(transport, [
			...call("t2", "read", { path: "ui/app.css" }, "…"),
			{
				type: "message_end",
				message: { role: "assistant", content: [{ type: "toolCall", id: "t2", name: "read", arguments: { path: "ui/app.css" } }] },
			} as unknown as AgentSessionEvent,
		]);
		expect(handle().textContent?.trim()).toBe("Activity · 1 entry");
	});

	it("counts more than one entry", async () => {
		const transport = await mount();
		await send(transport, [
			...call("t1", "read", { path: "a" }, "…"),
			...call("t2", "read", { path: "b" }, "…"),
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } },
						{ type: "toolCall", id: "t2", name: "read", arguments: { path: "b" } },
					],
				},
			} as unknown as AgentSessionEvent,
		]);
		expect(handle().textContent?.trim()).toBe("Activity · 2 entries");
	});

	it("says the round when nothing is running", async () => {
		const transport = await mount();
		await send(transport, [
			...call("g1", "goal", { action: "create", objective: "ship it", max_rounds: 16 }, "goal active"),
			{ type: "entry_appended", entry: { type: "custom_message", customType: "flypi-goal-round", content: "round 3 of 16", display: false, details: { goalId: "g1", round: 3 } } } as unknown as AgentSessionEvent,
		]);
		expect(handle().textContent?.trim()).toContain("Round 3/16");
	});

	it("keeps the goal, the checklist and the activity in the DOM while it is closed", async () => {
		const transport = await mount();
		await send(transport, [
			...call("g1", "goal", { action: "create", objective: "ship it", max_rounds: 16 }, "goal active"),
			...call("t1", "task_write", { tasks: [{ content: "one", status: "pending" }] }, "1 task"),
			...call("t2", "read", { path: "ui/app.css" }, "…"),
		]);
		expect(sheetState()).toBe("closed");
		// Only CSS hides them (ui/app.css): the panel is never unmounted, so nothing has to be re-fetched.
		expect(document.querySelector(".goal-block")).toBeTruthy();
		expect(document.querySelector("[data-role='tasks']")).toBeTruthy();
		expect(document.querySelector(".activity")).toBeTruthy();
		expect(document.querySelectorAll(".gutter")).toHaveLength(2);
	});
});
