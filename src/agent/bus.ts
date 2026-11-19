import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";

/** One host-side delivery: what a conversation emitted, and which conversation emitted it. */
export interface FlypiBusEvent {
	channel: string;
	data: unknown;
	conversationId: string;
}

/** flypi's handle on the process-wide bus. It is host-side; what a loader is handed is one of its `view`s. */
export interface FlypiEventBus {
	/** The object handed to one conversation's loader. pi sees an ordinary `EventBus`. */
	view(conversationId: string): EventBus;
	/** Deliver into exactly one conversation's extensions, and nowhere else. */
	emitTo(conversationId: string, channel: string, data: unknown): void;
	/** Every emit from every conversation. The id is the second argument so a listener that does not care stays one-argument. */
	on(channel: string, handler: (data: unknown, conversationId: string) => void): () => void;
}

/**
 * One bus for the process, one scope per conversation.
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
 * So flypi passes one bus to every loader it builds (`src/agent/runtime.ts`) — as `view(conversationId)`.
 *
 * Sharing it whole is what made it a **command channel across conversations**: channel names were the only
 * boundary and nothing attributed them, so one `emit` ran every loaded conversation's handler for that name.
 * `@tintinweb/pi-subagents` is that shape: RPC **servers** on fixed names
 * (`subagents:rpc:ping|spawn|stop|consume|steer`, answering on `subagents:rpc:spawn:reply:<requestId>` —
 * `dist/cross-extension-rpc.js:24-52,123-145`), whose spawn handler takes its session from `getCtx()`, the last
 * `session_start` context that instance saw (`dist/index.js:770-771,793`). One spawn request served by every
 * loaded conversation, N reply envelopes on one channel, and a handler free to act on the wrong conversation's
 * context.
 *
 * The view is what closes it, because every channel a conversation uses is namespaced by that conversation:
 * an emit made inside one runs **that conversation's** handlers only (`tests/agent/event-bus.test.ts` row 2,
 * which pins one handler invocation where the shared channel gave two), so inbound RPC is bound to the
 * conversation that made the request — the condition on declaring the package. Nothing is hidden from the host:
 * every emit reaches `on(channel, handler)`, and the handler's second argument names the conversation it came
 * from, which is the attribution T46.4's fleet store needs. `emitTo` is the reverse direction, the host speaking
 * into one conversation and no other. There is no broadcast verb, because the only one worth having is scoped.
 *
 * That a custom `{emit, on}` object is safe to hand pi was measured, not assumed. Outside `core/event-bus.js`
 * itself, the only code in pi's `dist/` that reads or writes the bus is the `pi.events` wrapper: one writer
 * (`extensions/loader.js:423`) and one reader (`:427`). `this.eventBus` is never compared against anything
 * (`resource-loader.js:248,511,530,538,883`), there is no second store of it, `clear()` has zero call sites in
 * `dist/`, and pi core itself put nothing on the bus across create → one full prompt turn → dispose with MCP
 * connected. `clear()` stays off this surface for its own reason too: it is `emitter.removeAllListeners()`
 * (`core/event-bus.js:20-22`), and over the shared object it would drop every conversation's extension
 * subscriptions at once — not a cleanup call anyone should make. What the view *must* do is return a real
 * unsubscribe from `on`: `runtime.trackEventBusSubscription` (`extensions/loader.js:154-156`) calls it blindly,
 * and a view returning `undefined` was measured to blow up later at `session.dispose()` rather than at subscribe.
 *
 * Three residuals, documented rather than handled:
 *
 * - `@tintinweb/pi-subagents` also claims `globalThis[Symbol.for("pi-subagents:manager")]` for whichever
 *   conversation starts first (`dist/index.js:694-697`) — one conversation's fleet manager wearing a
 *   process-wide name. **flypi must not read that symbol.** T46.4's fleet store goes through this handle,
 *   because this is where attribution exists and that is where it is lost.
 * - `pi.events` cannot be stopped from *importing* an extension pi discovered, and an `extensionsOverride`
 *   filter leaves its subscription live — `extensions/loader.js:425-431` subscribes at factory time. The view is
 *   what scopes such an extension, not the filter.
 * - The bus is a single Node `EventEmitter` (`core/event-bus.js:1-2`), which warns past 10 listeners for one
 *   event name (`EventEmitter.defaultMaxListeners`). flypi bounds conversations only by idle TTL
 *   (`src/server/session-registry.ts:375`, `evictIdle()`) and has no maximum count, so enough conversations
 *   listening on one shared channel name will print `MaxListenersExceededWarning` into the daemon log.
 *   Per-conversation views make that **less** likely than the shared bus did, since a channel name now carries
 *   one conversation's listeners instead of every conversation's. Nothing here calls `setMaxListeners` to
 *   silence what is left.
 */
let shared: FlypiEventBus | undefined;

/** The process-wide handle, created on first use so importing this module costs nothing. */
export function flypiEventBus(): FlypiEventBus {
	if (shared) return shared;
	// The one router. `c` keys carry a conversation's own channel to its own extensions, `h` keys carry every
	// emit to the host with the id attached. Only `emit`/`on` of `createEventBus` are used; its `clear()` is
	// unreachable from here, which is the point of the paragraph above.
	const router = createEventBus();
	const extensionKey = (conversationId: string, channel: string) => `c\0${conversationId}\0${channel}`;
	const hostKey = (channel: string) => `h\0${channel}`;
	const views = new Map<string, EventBus>();
	shared = {
		view(conversationId) {
			let view = views.get(conversationId);
			if (!view) {
				view = {
					emit: (channel, data) => {
						router.emit(extensionKey(conversationId, channel), data);
						router.emit(hostKey(channel), { channel, data, conversationId } satisfies FlypiBusEvent);
					},
					// pi keeps this unsubscribe and calls it at invalidate; `router.on` is what makes it real.
					on: (channel, handler) => router.on(extensionKey(conversationId, channel), handler),
				};
				views.set(conversationId, view);
			}
			return view;
		},
		emitTo(conversationId, channel, data) {
			// Not the `h` key: a host speaking to one conversation is not an event the others heard.
			router.emit(extensionKey(conversationId, channel), data);
		},
		on(channel, handler) {
			return router.on(hostKey(channel), (event) => {
				const { data, conversationId } = event as FlypiBusEvent;
				handler(data, conversationId);
			});
		},
	};
	return shared;
}
