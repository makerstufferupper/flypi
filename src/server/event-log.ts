/**
 * Per-conversation event log (docs/architecture.md Phase 1: "per-session ring buffer of
 * recent events + `resume` replay on reconnect").
 *
 * `seq` is assigned here and nowhere else, so replayed frames and live frames share one
 * numbering and the client can dedupe on it. When the ring overwrites old events the gap is
 * reported rather than hidden: a client that asks for something evicted is told, not fed a
 * transcript that quietly starts later.
 *
 * `at` is stamped here too, for the same reason: this process is the only one that sees an event
 * **when it happens**. A replay hands the same stamp back, so a client that attaches later still
 * measures the response's real window instead of the burst it arrived in (src/shared/metrics.ts).
 */
export interface BufferedEvent<T> {
	seq: number;
	/** When this process saw the event, in epoch milliseconds. */
	at: number;
	event: T;
}

export class EventLog<T> {
	private readonly events: BufferedEvent<T>[] = [];
	private nextSeq = 1;

	constructor(
		private readonly capacity: number = 5000,
		private readonly now: () => number = Date.now,
	) {}

	push(event: T): BufferedEvent<T> {
		const buffered: BufferedEvent<T> = { seq: this.nextSeq++, at: this.now(), event };
		this.events.push(buffered);
		if (this.events.length > this.capacity) this.events.shift();
		return buffered;
	}

	get lastSeq(): number {
		return this.nextSeq - 1;
	}

	/** Highest seq already dropped from the ring (0 when nothing has been dropped). */
	get evictedThroughSeq(): number {
		return this.events[0] ? this.events[0].seq - 1 : this.lastSeq;
	}

	/** Every event after `afterSeq`, plus whether older events were already evicted. */
	replayAfter(afterSeq: number): { events: BufferedEvent<T>[]; gap: boolean } {
		const first = this.events[0];
		const gap = afterSeq + 1 < (first?.seq ?? this.nextSeq);
		return { events: this.events.filter((entry) => entry.seq > afterSeq), gap };
	}
}
