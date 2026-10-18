/**
 * The socket plumbing, with no browser and no server: a fake WebSocket that records what was dialled
 * and lets the test fire events. What this guards is the part that cannot be re-created by the
 * FakeTransport the app tests use — the token URL, reconnecting, and never dropping a command.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchConfig, Socket, type FlypiConfig } from "./client.ts";

const config: FlypiConfig = { protocolVersion: 1, token: "t 1", wsPath: "/ws" };

class FakeSocket {
	static readonly instances: FakeSocket[] = [];
	static readonly OPEN = 1;
	static readonly CLOSED = 3;
	readyState = 0;
	sent: string[] = [];
	url: string;
	#listeners = new Map<string, ((event: unknown) => void)[]>();

	constructor(url: string) {
		this.url = url;
		FakeSocket.instances.push(this);
	}

	addEventListener(type: string, handler: (event: unknown) => void): void {
		this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), handler]);
	}

	fire(type: string, event: unknown = {}): void {
		for (const handler of this.#listeners.get(type) ?? []) handler(event);
	}

	send(frame: string): void {
		this.sent.push(frame);
	}

	close(): void {
		this.readyState = FakeSocket.CLOSED;
		this.fire("close");
	}

	open(): void {
		this.readyState = FakeSocket.OPEN;
		this.fire("open");
	}
}

beforeEach(() => {
	vi.stubGlobal("WebSocket", FakeSocket);
	FakeSocket.instances.length = 0;
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

const last = () => FakeSocket.instances[FakeSocket.instances.length - 1]!;

describe("fetchConfig", () => {
	it("reads what the server says about itself", async () => {
		vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => config }));
		expect(await fetchConfig()).toEqual(config);
	});

	it("names the thing to check when the server is not there", async () => {
		vi.stubGlobal("fetch", async () => ({ ok: false, status: 404 }));
		await expect(fetchConfig()).rejects.toThrow(/__flypi.json returned 404/);
	});
});

describe("Socket", () => {
	it("dials the same origin with the token, escaped", () => {
		const socket = new Socket(config);
		socket.connect();
		// Same origin the page came from — that is what makes the dev proxy and the prod server identical.
		expect(last().url).toBe(`ws://${location.host}/ws?token=t%201`);
	});

	it("sends while open, queues while down, and sends the queue first when the socket comes back", () => {
		vi.useFakeTimers();
		const socket = new Socket(config);
		socket.connect();
		last().open();
		socket.send({ type: "abort", conversationId: "c1" });
		expect(JSON.parse(last().sent[0]!)).toEqual({ type: "abort", conversationId: "c1" });

		last().close();
		socket.send({ type: "listSessions" });
		socket.send({ type: "debug", conversationId: "c1" });
		const reopened = last();
		reopened.open();
		expect(reopened.sent.slice(1).map((frame) => JSON.parse(frame).type)).toEqual(["listSessions", "debug"]);
	});

	it("passes frames to its handlers, and ignores what is not a frame", () => {
		const socket = new Socket(config);
		const seen: unknown[] = [];
		const unsubscribe = socket.on((frame) => seen.push(frame));
		socket.connect();
		last().fire("message", { data: '{"type":"hello","protocolVersion":1}' });
		last().fire("message", { data: "{not json" });
		last().fire("message", { data: '{"noType":true}' });
		expect(seen).toEqual([{ type: "hello", protocolVersion: 1 }]);

		unsubscribe();
		last().fire("message", { data: '{"type":"hello","protocolVersion":1}' });
		expect(seen).toHaveLength(1);
	});

	it("says when the line went down, then reconnects by itself", async () => {
		vi.useFakeTimers();
		// The reconnect re-reads the token first (below), so the test says what the server answers with.
		vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => config }));
		const socket = new Socket(config);
		const seen: string[] = [];
		socket.on((frame) => seen.push(frame.type));
		socket.connect();
		last().open();
		last().close();
		expect(seen).toEqual(["connected", "disconnected"]);
		expect(FakeSocket.instances).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(500);
		expect(FakeSocket.instances).toHaveLength(2);
	});

	it("re-reads the token before reconnecting, which is what a restart does not lock the page out with", async () => {
		// The token is per run — a crash, `flypi restart`, or an update the daemon installed while idle all
		// mint a new one — so dialling the one from page load is a 4401 forever.
		vi.useFakeTimers();
		vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ ...config, token: "t 2" }) }));
		const socket = new Socket(config);
		socket.connect();
		last().open();
		last().close();
		await vi.advanceTimersByTimeAsync(500);
		expect(last().url).toBe(`ws://${location.host}/ws?token=t%202`);
	});

	it("reconnects on the old token when the server has not answered yet", async () => {
		// The daemon is still coming back: the config it will answer with is not readable yet, and the old
		// token is the best guess — the next close asks again.
		vi.useFakeTimers();
		vi.stubGlobal("fetch", async () => {
			throw new TypeError("fetch failed");
		});
		const socket = new Socket(config);
		socket.connect();
		last().open();
		last().close();
		await vi.advanceTimersByTimeAsync(500);
		expect(last().url).toBe(`ws://${location.host}/ws?token=t%201`);
	});

	it("stays down when it is asked to", () => {
		vi.useFakeTimers();
		const socket = new Socket(config);
		socket.connect();
		last().open();
		socket.close();
		vi.advanceTimersByTime(5_000);
		expect(FakeSocket.instances).toHaveLength(1);
	});
});
