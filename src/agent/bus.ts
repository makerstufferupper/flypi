import { createEventBus, type EventBusController } from "@earendil-works/pi-coding-agent";

/**
 * The one bus every session in this process shares.
 *
 * A bus per session would not do. `DefaultResourceLoader` mints one when the option is absent
 * (`core/resource-loader.js:248`, `options.eventBus ?? createEventBus()`) and hands it to every extension it
 * loads, and an extension only ever hears the bus it was handed: `pi.events` is that object
 * (`core/extensions/loader.js:420-431`), so an emit from **outside a handler** — a `pi.events.on` callback of
 * its own, a `setInterval` reporting state, anything with no pi event in flight — goes to that one session's bus
 * and to nothing else. flypi's daemon is one process holding several open conversations
 * (`src/server/session-registry.ts`), so a plugin flypi has no code for has no single place to talk to and
 * nothing host-side can listen: `pi.events` is documented as the way extensions talk to each other
 * (`docs/extensions.md:186`) and is "the shared event bus for extension communication"
 * (`core/extensions/types.d.ts:1405`), neither of which is true while the sharing stops at the session.
 * So flypi passes this bus to every loader it builds (`src/agent/runtime.ts`).
 *
 * Sharing it does not leak subscriptions across a reload: an extension's own subscriptions are tracked and dropped
 * when its runtime is invalidated (`core/extensions/loader.js:144-152`, which `AgentSession.dispose()` reaches at
 * `core/agent-session.js:1022`), and a host-side subscription on this object is nobody's to unregister.
 * `EventBusController.clear()` does exist (`core/event-bus.d.ts:6`) and nothing in pi calls it (zero call sites in
 * `dist/`); it is `emitter.removeAllListeners()` (`core/event-bus.js:20-22`) — over this object it would drop
 * every session's extension subscriptions at once, so it is not a cleanup call anyone should make here.
 *
 * What sharing does create is a **command channel across conversations**. Channel names are the only boundary and
 * nothing namespaces them per conversation, so one `emit` runs every loaded conversation's handler for that name:
 * two conversations in one process, one emit, two handler invocations — row 2 of `tests/agent/event-bus.test.ts`
 * measures exactly that with two real `AgentSession`s. A plugin that registers an RPC **server** on a fixed
 * channel name is therefore a server for all of them at once, carrying the context of whichever conversation last
 * started. `@tintinweb/pi-subagents` is that shape: it emits fixed names (`subagents:completed`, `subagents:steered`,
 * `subagents:disposed`, `subagents:created` — its `dist/index.js:521,620,1101,1134,1400`) and its `pi.events`
 * subscriptions are RPC endpoints on `subagents:rpc:ping|spawn|stop|consume|steer` that answer on
 * `subagents:rpc:spawn:reply:<requestId>` (its `dist/cross-extension-rpc.js:24-40`, registered at `:45-52` and
 * `:123-145`), where the spawn handler takes its session from `getCtx()` — the last `session_start` context that
 * instance saw (its `dist/index.js:770-771,793`). In flypi's one-process many-conversation daemon that is one spawn
 * request served by every loaded conversation, N reply envelopes on one channel, and a handler free to act on the
 * wrong conversation's context.
 *
 * This is live the moment a package is declared — **it is T46.2's blocker, not a reporting concern**. It is inert
 * today only because nothing subscribes: outside `core/event-bus.js` itself, the only code in pi's `dist/` that
 * reads or writes the bus is the `pi.events` wrapper above (`core/extensions/loader.js:423,427`), and flypi has no
 * bus code beyond passing this object. Declaring that package needs per-conversation channel attribution and
 * inbound RPC bound to one conversation, first. T46.4's fleet store has to attribute events by conversation as
 * well; that is the reporting half of the same sharing, and it is subordinate to clearing the command channel.
 *
 * One smaller edge, documented rather than handled: the bus is a single Node `EventEmitter`
 * (`core/event-bus.js:1-2`), which warns past 10 listeners for one event name (`EventEmitter.defaultMaxListeners`).
 * flypi bounds conversations only by idle TTL (`src/server/session-registry.ts:375`, `evictIdle()`) and has no
 * maximum count, so enough conversations listening on one shared channel name will print
 * `MaxListenersExceededWarning` into the daemon log. Nothing here calls `setMaxListeners` to silence it.
 */
let shared: EventBusController | undefined;

/** The process-wide bus, created on first use so importing this module costs nothing. */
export function flypiEventBus(): EventBusController {
	if (!shared) shared = createEventBus();
	return shared;
}
