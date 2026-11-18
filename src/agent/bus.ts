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
 * Sharing it does not leak subscriptions across a reload: nothing in pi calls `clear()` on a bus (no call site
 * in `dist/core/**`), an extension's own subscriptions are tracked and dropped when its runtime is invalidated
 * (`core/extensions/loader.js:144-152`), and a host-side subscription on this object is nobody's to unregister.
 * Two conversations do mean one channel space, so T46.4's fleet store has to attribute events by conversation.
 */
let shared: EventBusController | undefined;

/** The process-wide bus, created on first use so importing this module costs nothing. */
export function flypiEventBus(): EventBusController {
	if (!shared) shared = createEventBus();
	return shared;
}
