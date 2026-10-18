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
		expect(log.replayAfter(1)).toEqual({ events: [{ seq: 2, event: "b" }], gap: false });
		expect(log.evictedThroughSeq).toBe(0);
	});

	it("reports a gap when older events were already evicted", () => {
		const log = new EventLog<string>(2);
		for (const event of ["a", "b", "c"]) log.push(event);

		expect(log.evictedThroughSeq).toBe(1);
		expect(log.replayAfter(0)).toEqual({ events: [{ seq: 2, event: "b" }, { seq: 3, event: "c" }], gap: true });
		// The evicted event is gone, but asking for it is still not a hole in what we return.
		expect(log.replayAfter(1).gap).toBe(false);
	});

	it("an empty log replays nothing and claims no gap", () => {
		const log = new EventLog<string>();
		expect(log.replayAfter(0)).toEqual({ events: [], gap: false });
		expect(log.lastSeq).toBe(0);
		expect(log.evictedThroughSeq).toBe(0);
	});
});
