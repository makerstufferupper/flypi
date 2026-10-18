/**
 * Per-conversation event log (docs/architecture.md Phase 1: "per-session ring buffer of
 * recent events + `resume` replay on reconnect").
 *
 * `seq` is assigned here and nowhere else, so replayed frames and live frames share one
 * numbering and the client can dedupe on it. When the ring overwrites old events the gap is
 * reported rather than hidden: a client that asks for something evicted is told, not fed a
 * transcript that quietly starts later.
 */
export interface BufferedEvent<T> {
	seq: number;
	event: T;
}

export class EventLog<T> {
	private readonly events: BufferedEvent<T>[] = [];
	private nextSeq = 1;

	constructor(private readonly capacity: number = 5000) {}

	push(event: T): BufferedEvent<T> {
		const buffered: BufferedEvent<T> = { seq: this.nextSeq++, event };
		this.events.push(buffered);
		if (this.events.length > this.capacity) this.events.shift();
		return buffered;
	}

	get lastSeq(): number {
		return this.nextSeq - 1;
	}

	/** Start over. Opening another session replaces the transcript a client is looking at. */
	reset(): void {
		this.events.length = 0;
		this.nextSeq = 1;
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
