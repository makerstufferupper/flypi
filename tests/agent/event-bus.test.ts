/**
 * The process-wide event bus (src/agent/bus.ts), measured by whether an event crosses the boundary between
 * pi's loader and flypi — and by whether it stops at the conversation it belongs to.
 *
 * Every row here proves *sharedness*, not existence: a bus that exists and a bus every session shares look the
 * same to anything that only asks for an object. Row 2 and the rows after it prove the other half, that the
 * sharing is scoped: one handle, one conversation's view per conversation, so an emit inside one conversation
 * cannot run another conversation's handler. The boundary matters because an extension only ever has the
 * bus it was handed — `pi.events` is the loader's object (core/extensions/loader.js:420) — so an extension that
 * emits with no pi event in flight is talking to whoever holds *that* bus. Absent the option,
 * `DefaultResourceLoader` mints one for itself (core/resource-loader.js:248) and there is no way to read it
 * back (`core/resource-loader.d.ts:129` keeps it private), which is the whole reason flypi passes one.
 *
 * The extension is a real file in `<agentDir>/extensions/`, the way a user or a package adds one, so pi
 * discovers it by itself (core/resource-loader.js) and flypi never declares it. If a future pi stops
 * discovering that directory, the fixture has to name itself in `settings.json`; the row would then test the
 * same crossing.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { flypiEventBus } from "../../src/agent/bus.ts";
import { flypiPaths } from "../../src/agent/paths.ts";
import { createFlypiSession } from "../../src/agent/runtime.ts";
import { createTempFlypiRoot } from "../helpers/flypi-root.ts";
import { createStubModel } from "../helpers/stub-model.ts";

/** An event on the channels below: the probe names itself, so a listener can tell the sessions apart. */
interface ProbeEvent {
	from: string;
	echo?: unknown;
}

/**
 * An extension flypi has never heard of, on channels namespaced per row.
 *
 * `caller` adds the client half of an RPC pair: the extension emits the ping itself instead of waiting for the
 * host to. Only the extension can — `pi.events` is the object the loader handed it
 * (core/extensions/loader.js:420-431) — and row 2 needs the request to *start* inside one conversation, because
 * a request from inside A is the one a shared channel let B answer too.
 *
 * The namespaces are insurance, not the only thing that keeps the rows apart: an extension's subscription lives
 * on its own conversation's scope (`c\0<id>\0<channel>`, src/agent/bus.ts), so a probe one row installed is
 * unreachable from another row's conversation, and the host-side listeners below are per row and stopped in each
 * `finally`. What still needs the rows sequential is that a row handing `createFlypiSession` a `conversationId`
 * keeps that scope for the life of its session: two rows overlapping on one id and one channel name would hear
 * each other again, so never make them concurrent. `dispose()` still drops a row's own subscriptions
 * (`AgentSession.dispose()` → `runner.invalidate()`, core/agent-session.js:1022, core/extensions/loader.js:144-153).
 *
 * Both emits are outside a handler: the first runs from the extension's *own* bus subscription, the second
 * from a timer with nothing in flight at all. Neither is a lifecycle event pi would have delivered, which is
 * the case that a per-session bus answers badly.
 */
function busProbe(namespace: string, marker: string, caller = false): string {
	const request = caller ? `\n\tsetTimeout(() => pi.events.emit("flypi:test/${namespace}/ping", { n: 2 }), 20);` : "";
	return `
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.events.on("flypi:test/${namespace}/ping", (data) => {
		pi.events.emit("flypi:test/${namespace}/pong", { from: "${marker}", echo: data });
	});
	setTimeout(() => pi.events.emit("flypi:test/${namespace}/loaded", { from: "${marker}" }), 10);${request}
}
`;
}

/** Install it the way a user would: a file in the agent dir, which pi discovers on its own. */
function installProbe(root: string, namespace: string, marker: string, caller = false): void {
	mkdirSync(join(root, ".flypi", "agent", "extensions"), { recursive: true });
	writeFileSync(join(root, ".flypi", "agent", "extensions", "bus-probe.ts"), busProbe(namespace, marker, caller));
}

/**
 * Everything the process bus says on one channel from now on, whichever conversation emitted it.
 *
 * It reads one argument on purpose: the handle passes the emitting conversation's id second, so a listener that
 * does not care about attribution keeps compiling. The row that needs it subscribes directly instead.
 */
function listen(channel: string): { events: ProbeEvent[]; stop(): void } {
	const events: ProbeEvent[] = [];
	const stop = flypiEventBus().on(channel, (data) => {
		events.push(data as ProbeEvent);
	});
	return { events, stop };
}

/** Every wait below gives up after this, and the assertion that reports it names it. */
const busWaitMs = 3000;

/**
 * Wait for the bus to say what it was going to say, and return the message to report with if it stayed silent.
 * pi runs a handler inside an async wrapper (`core/event-bus.js`), so delivery is not synchronous even though
 * nothing here awaits anything. On the timeout this returns normally and the `expect` below reports what did
 * arrive — an empty list, which is the answer a loader with a bus of its own gives — rather than a timeout
 * standing in for it. The returned message is what keeps those two distinguishable in the log: without it a slow
 * machine's red reads as a bare `expected [] to deeply equal …`, the same line a wrong payload produces.
 */
async function until(label: string, ready: () => boolean, timeoutMs = busWaitMs): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (!ready() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
	return `no ${label} within ${timeoutMs}ms`;
}

describe("one event bus per process", () => {
	it("carries what an agent-dir extension emits outside a handler to a subscriber that predates the session", async () => {
		const root = createTempFlypiRoot();
		// Named, because the host has to say which conversation the ping is for and the session has to agree.
		const single = "bus-single";
		installProbe(root, "single", "one");
		// Both listeners exist before the session does: the point is that the extension's bus is this object,
		// not that the session happens to be around when the event arrives.
		const loaded = listen("flypi:test/single/loaded");
		const pong = listen("flypi:test/single/pong");
		const stub = await createStubModel({ authPath: flypiPaths(root).authPath });
		const created = await createFlypiSession({ root, modelRuntime: stub.modelRuntime, model: stub.model, conversationId: single });
		try {
			// The timer emit: nothing pi emitted, so nothing else would have put a message on this bus.
			const loadedWait = await until('"flypi:test/single/loaded" event', () => loaded.events.length > 0);
			expect(loaded.events, loadedWait).toEqual([{ from: "one" }]);
			// And back the other way: flypi emits into that conversation, the extension's subscription callback
			// answers. One bus, both directions; a loader with a bus of its own answers to nobody.
			flypiEventBus().emitTo(single, "flypi:test/single/ping", { n: 1 });
			const pongWait = await until('"flypi:test/single/pong" reply', () => pong.events.length > 0);
			expect(pong.events, pongWait).toEqual([{ from: "one", echo: { n: 1 } }]);
		} finally {
			loaded.stop();
			pong.stop();
			created.session.dispose();
		}
	});

	// The row that keeps a plugin's RPC server from answering in someone else's session. Both conversations load a
	// server on one fixed channel name — `subagents:rpc:spawn`, answered on `subagents:rpc:spawn:reply:<id>` — and
	// conversation A's own extension makes the request, the way its client does. A's emit runs A's handler, so
	// exactly one reply comes back and it is A's. Before the view it ran both, which is two answers on one reply
	// channel and a spawn served against B's context. It still says the bus is one per *process* rather than one
	// per session: two loaders, one host listener, both conversations' `loaded` emits on it.
	it("runs only the emitting conversation's handler when two conversations subscribe to one channel", async () => {
		const rootA = createTempFlypiRoot();
		const rootB = createTempFlypiRoot();
		installProbe(rootA, "pair", "first", true);
		installProbe(rootB, "pair", "second");
		const loaded = listen("flypi:test/pair/loaded");
		const pong = listen("flypi:test/pair/pong");
		const stub = await createStubModel({ authPath: flypiPaths(rootA).authPath });
		const first = await createFlypiSession({ root: rootA, modelRuntime: stub.modelRuntime, model: stub.model, conversationId: "bus-pair-a" });
		const second = await createFlypiSession({ root: rootB, modelRuntime: stub.modelRuntime, model: stub.model, conversationId: "bus-pair-b" });
		try {
			// Scoping the extension-facing channels leaves the host seeing every conversation's emit — that is what
			// the attribution below depends on — so this half of the row does not move.
			const loadedWait = await until('two "flypi:test/pair/loaded" events', () => loaded.events.length >= 2);
			expect(loaded.events.map((event) => event.from).sort(), loadedWait).toEqual(["first", "second"]);
			const pongWait = await until('"flypi:test/pair/pong" reply', () => pong.events.length > 0);
			// B's server had this whole wait to answer as well, which is what it did on a shared channel; both
			// handlers ran inside one synchronous emit, so 50ms is the whole of the difference, not a race window.
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(pong.events.map((event) => event.from), pongWait).toEqual(["first"]);
		} finally {
			loaded.stop();
			pong.stop();
			first.session.dispose();
			second.session.dispose();
		}
	});

	// Nearly free on its own: a module-scope `createEventBus()` passes this row exactly as the memoised function
	// does, so it pins only "one object per process", not "the loader was handed it". The two rows above are the
	// ones that answer that.
	it("is one bus object for the whole process", () => {
		expect(flypiEventBus()).toBe(flypiEventBus());
	});

	// `emitTo` is the host speaking to exactly one conversation, which is what an RPC client on the host side
	// needs and what a broadcast must never become again. The row above shows an emit from inside a conversation
	// stays there; this shows the same about an emit from outside it.
	it("delivers an emitTo to one conversation and never to the other", async () => {
		const rootA = createTempFlypiRoot();
		const rootB = createTempFlypiRoot();
		installProbe(rootA, "one-way", "first");
		installProbe(rootB, "one-way", "second");
		const pong = listen("flypi:test/one-way/pong");
		const stub = await createStubModel({ authPath: flypiPaths(rootA).authPath });
		const first = await createFlypiSession({ root: rootA, modelRuntime: stub.modelRuntime, model: stub.model, conversationId: "bus-one-way-a" });
		const second = await createFlypiSession({ root: rootB, modelRuntime: stub.modelRuntime, model: stub.model, conversationId: "bus-one-way-b" });
		try {
			flypiEventBus().emitTo("bus-one-way-a", "flypi:test/one-way/ping", { n: 3 });
			const pongWait = await until('"flypi:test/one-way/pong" reply', () => pong.events.length > 0);
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(pong.events.map((event) => event.from), pongWait).toEqual(["first"]);
		} finally {
			pong.stop();
			first.session.dispose();
			second.session.dispose();
		}
	});

	// The attribution T46.4's fleet store needs: a host listener has to know which conversation an emit came from,
	// without the one-argument listeners above changing shape. Subscribed directly rather than through `listen`,
	// which drops the second argument.
	it("tells a host listener which conversation emitted", async () => {
		const rootA = createTempFlypiRoot();
		const rootB = createTempFlypiRoot();
		installProbe(rootA, "attributed", "first");
		installProbe(rootB, "attributed", "second");
		const seen: Array<{ from: string; conversationId: string }> = [];
		const stop = flypiEventBus().on("flypi:test/attributed/loaded", (data, conversationId) => {
			seen.push({ from: (data as ProbeEvent).from, conversationId });
		});
		const stub = await createStubModel({ authPath: flypiPaths(rootA).authPath });
		const first = await createFlypiSession({ root: rootA, modelRuntime: stub.modelRuntime, model: stub.model, conversationId: "bus-attr-a" });
		const second = await createFlypiSession({ root: rootB, modelRuntime: stub.modelRuntime, model: stub.model, conversationId: "bus-attr-b" });
		try {
			const wait = await until('two attributed "flypi:test/attributed/loaded" events', () => seen.length >= 2);
			expect(seen.sort((a, b) => a.from.localeCompare(b.from)), wait).toEqual([
				{ conversationId: "bus-attr-a", from: "first" },
				{ conversationId: "bus-attr-b", from: "second" },
			]);
		} finally {
			stop();
			first.session.dispose();
			second.session.dispose();
		}
	});

	// Nearly free like row 3: it pins that the view is one per conversation and memoised per id, not that the
	// loader was handed it — the rows above answer that. A view per conversation is the scoping; a fresh object
	// per call would scope too, and would make `bus.view(id) === bus.view(id)` the thing a caller could not rely on.
	it("hands one conversation a stable view and every conversation a different one", () => {
		const bus = flypiEventBus();
		expect(bus.view("bus-view-a")).toBe(bus.view("bus-view-a"));
		expect(bus.view("bus-view-a")).not.toBe(bus.view("bus-view-b"));
	});
});
