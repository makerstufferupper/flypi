/**
 * The process-wide event bus (src/agent/bus.ts), measured by whether an event crosses the boundary between
 * pi's loader and flypi.
 *
 * Every row here proves *sharedness*, not existence: a bus that exists and a bus every session shares look the
 * same to anything that only asks for an object. The boundary matters because an extension only ever has the
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
 * The namespaces are insurance, not the thing that keeps the rows apart. Measured with both rows on identical
 * channels, all three rows still pass: row 1 finishes its assertions and disposes before row 2 starts, and
 * `dispose()` removes that probe's subscription from the shared bus (`AgentSession.dispose()` →
 * `runner.invalidate()`, core/agent-session.js:1022, core/extensions/loader.js:144-153). What stops a row hearing
 * another is the ordering plus that teardown, not the channel name — so the rows stay independent only as long as
 * they do not overlap; never make them concurrent.
 *
 * Both emits are outside a handler: the first runs from the extension's *own* bus subscription, the second
 * from a timer with nothing in flight at all. Neither is a lifecycle event pi would have delivered, which is
 * the case that a per-session bus answers badly.
 */
function busProbe(namespace: string, marker: string): string {
	return `
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.events.on("flypi:test/${namespace}/ping", (data) => {
		pi.events.emit("flypi:test/${namespace}/pong", { from: "${marker}", echo: data });
	});
	setTimeout(() => pi.events.emit("flypi:test/${namespace}/loaded", { from: "${marker}" }), 10);
}
`;
}

/** Install it the way a user would: a file in the agent dir, which pi discovers on its own. */
function installProbe(root: string, namespace: string, marker: string): void {
	mkdirSync(join(root, ".flypi", "agent", "extensions"), { recursive: true });
	writeFileSync(join(root, ".flypi", "agent", "extensions", "bus-probe.ts"), busProbe(namespace, marker));
}

/** Everything the process bus says on one channel from now on. */
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
		installProbe(root, "single", "one");
		// Both listeners exist before the session does: the point is that the extension's bus is this object,
		// not that the session happens to be around when the event arrives.
		const loaded = listen("flypi:test/single/loaded");
		const pong = listen("flypi:test/single/pong");
		const stub = await createStubModel({ authPath: flypiPaths(root).authPath });
		const created = await createFlypiSession({ root, modelRuntime: stub.modelRuntime, model: stub.model });
		try {
			// The timer emit: nothing pi emitted, so nothing else would have put a message on this bus.
			const loadedWait = await until('"flypi:test/single/loaded" event', () => loaded.events.length > 0);
			expect(loaded.events, loadedWait).toEqual([{ from: "one" }]);
			// And back the other way: flypi emits, the extension's subscription callback answers. One bus, both
			// directions; a loader with a bus of its own answers to nobody.
			flypiEventBus().emit("flypi:test/single/ping", { n: 1 });
			const pongWait = await until('"flypi:test/single/pong" reply', () => pong.events.length > 0);
			expect(pong.events, pongWait).toEqual([{ from: "one", echo: { n: 1 } }]);
		} finally {
			loaded.stop();
			pong.stop();
			created.session.dispose();
		}
	});

	// Two `DefaultResourceLoader`s, two sessions, one emit that answers both: this is the row that says the bus is
	// one per *process* rather than one per session. It dies if `flypiEventBus()` handed out a fresh bus per
	// call, and it dies if the loader made one of its own; it survives any single shared object, which is why
	// the memoisation itself is not what is pinned here.
	it("reaches a handler registered by each of two sessions in one process", async () => {
		const rootA = createTempFlypiRoot();
		const rootB = createTempFlypiRoot();
		installProbe(rootA, "pair", "first");
		installProbe(rootB, "pair", "second");
		const loaded = listen("flypi:test/pair/loaded");
		const pong = listen("flypi:test/pair/pong");
		const stub = await createStubModel({ authPath: flypiPaths(rootA).authPath });
		const first = await createFlypiSession({ root: rootA, modelRuntime: stub.modelRuntime, model: stub.model });
		const second = await createFlypiSession({ root: rootB, modelRuntime: stub.modelRuntime, model: stub.model });
		try {
			const loadedWait = await until('two "flypi:test/pair/loaded" events', () => loaded.events.length >= 2);
			expect(loaded.events.map((event) => event.from).sort(), loadedWait).toEqual(["first", "second"]);
			flypiEventBus().emit("flypi:test/pair/ping", { n: 2 });
			const pongWait = await until('two "flypi:test/pair/pong" replies', () => pong.events.length >= 2);
			expect(pong.events.map((event) => event.from).sort(), pongWait).toEqual(["first", "second"]);
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
});
