/**
 * The browser's side of docs/protocol.md, with no framework in it — the UI is state, the socket is
 * plumbing, and keeping them apart is what lets a test drive the whole app by feeding it frames.
 *
 * The UI talks to the same origin in both modes: in dev the Vite proxy forwards `/ws` and
 * `/__flypi.json` to the agent server, in prod the agent server serves both (docs/architecture.md).
 */
import type { ClientCommand, ServerFrame } from "../../src/server/protocol.ts";

export interface FlypiConfig {
	protocolVersion: number;
	token: string;
	wsPath: string;
}

/** What the app needs from a transport; `FakeTransport` in the tests implements the same thing. */
export interface Transport {
	send(command: ClientCommand): void;
	/** Frames and connection changes, in order. Returns an unsubscribe function. */
	on(handler: (frame: ServerFrame | { type: "connected" } | { type: "disconnected" }) => void): () => void;
}

export async function fetchConfig(): Promise<FlypiConfig> {
	const response = await fetch("/__flypi.json");
	if (!response.ok) throw new Error(`flypi: /__flypi.json returned ${response.status} — is the agent server running?`);
	return (await response.json()) as FlypiConfig;
}

/**
 * One socket, reconnecting forever. After a reconnect the caller re-attaches to its conversation
 * with `resume` — flypi never reloads from disk to heal a UI connection (docs/protocol.md).
 */
export class Socket implements Transport {
	#config: FlypiConfig;
	#socket: WebSocket | undefined;
	#handlers = new Set<(frame: ServerFrame | { type: "connected" } | { type: "disconnected" }) => void>();
	#queue: string[] = [];
	#closed = false;

	constructor(config: FlypiConfig) {
		this.#config = config;
	}

	on(handler: (frame: ServerFrame | { type: "connected" } | { type: "disconnected" }) => void): () => void {
		this.#handlers.add(handler);
		return () => this.#handlers.delete(handler);
	}

	send(command: ClientCommand): void {
		const frame = JSON.stringify(command);
		if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(frame);
		// A command sent while the socket was down is not dropped: it goes first when it returns.
		else this.#queue.push(frame);
	}

	connect(): void {
		const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${this.#config.wsPath}?token=${encodeURIComponent(this.#config.token)}`;
		const socket = new WebSocket(url);
		this.#socket = socket;
		socket.addEventListener("open", () => {
			for (const frame of this.#queue.splice(0)) socket.send(frame);
			for (const handler of this.#handlers) handler({ type: "connected" });
		});
		socket.addEventListener("message", (event: MessageEvent) => {
			let frame: unknown;
			try {
				frame = JSON.parse(String(event.data));
			} catch {
				return;
			}
			if (frame && typeof frame === "object" && "type" in frame) {
				for (const handler of this.#handlers) handler(frame as ServerFrame);
			}
		});
		socket.addEventListener("close", () => {
			for (const handler of this.#handlers) handler({ type: "disconnected" });
			if (this.#closed) return;
			// The token is per run: a crash, a `flypi restart`, or an update the daemon installed while idle
			// all mint a new one, and dialling the old one is a 4401 forever. So the config is re-read from the
			// same origin the page got it from first; if the server is still coming back, the old one is the
			// best guess and the next close tries again.
			setTimeout(() => {
				void fetchConfig()
					.then((config) => (this.#config = config))
					.catch(() => {})
					.finally(() => this.connect());
			}, 500);
		});
	}

	close(): void {
		this.#closed = true;
		this.#socket?.close();
	}
}
