import { describe, expect, it } from "vitest";
import { EventLog } from "../../src/server/event-log.ts";

describe("EventLog: the resume replay choke point", () => {
	it("numbers events from 1 and replays exactly what the client missed", () => {
		const log = new EventLog<string>();
		for (const event of ["a", "b", "c", "d"]) log.push(event);

		expect(log.replayAfter(0).events.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
		expect(log.replayAfter(2).events.map((entry) => entry.event)).toEqual(["c", "d"]);
		expect(log.replayAfter(4).events).toEqual([]);
		expect(log.lastSeq).toBe(4);
	});

	it("reports no gap when everything after the requested seq is still held", () => {
		const log = new EventLog<string>();
		log.push("a");
		log.push("b");
		expect(log.replayAfter(1)).toEqual({ events: [{ seq: 2, at: expect.any(Number), event: "b" }], gap: false });
		expect(log.evictedThroughSeq).toBe(0);
	});

	it("reports a gap when older events were already evicted", () => {
		const log = new EventLog<string>(2);
		for (const event of ["a", "b", "c"]) log.push(event);

		expect(log.evictedThroughSeq).toBe(1);
		expect(log.replayAfter(0)).toEqual({
			events: [
				{ seq: 2, at: expect.any(Number), event: "b" },
				{ seq: 3, at: expect.any(Number), event: "c" },
			],
			gap: true,
		});
		// The evicted event is gone, but asking for it is still not a hole in what we return.
		expect(log.replayAfter(1).gap).toBe(false);
	});

	// The stamp is the backend's, and a replay hands the same one back — that is what lets a client that
	// attaches late measure the response's real window instead of the burst the replay arrived in.
	it("stamps each event once, with the clock it is given, and replays that stamp", () => {
		let clock = 1_000;
		const log = new EventLog<string>(10, () => clock);
		log.push("a");
		clock = 2_500;
		log.push("b");

		expect(log.replayAfter(0).events.map((entry) => entry.at)).toEqual([1_000, 2_500]);
		clock = 9_999;
		expect(log.replayAfter(0).events.map((entry) => entry.at)).toEqual([1_000, 2_500]);
	});

	it("an empty log replays nothing and claims no gap", () => {
		const log = new EventLog<string>();
		expect(log.replayAfter(0)).toEqual({ events: [], gap: false });
		expect(log.lastSeq).toBe(0);
		expect(log.evictedThroughSeq).toBe(0);
	});
});
