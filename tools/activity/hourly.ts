export type Reading = { metric: string; source: string; measured: string; ended: string | null; offset_min: number; units: string | null; qty: number | null };
export type HourRow = { metric: string; source: string; measured: string; ended: string | null; offset_min: number; units: string | null; values: number[] };

const HOUR_MS = 3600_000;

type Group<R extends Reading> = { first: number; reading: R; values: number[] };
type Bucket<R extends Reading> = { stream: string; hour: number; seen: Uint8Array; groups: Map<string, Group<R>> };
type Stream<R extends Reading> = { first: number; last: number; edges: Map<number, Map<string, R>> };

export class HourCompactor<R extends Reading> {
	private buckets = new Map<string, Bucket<R>>();
	private streams = new Map<string, Stream<R>>();

	static fits(reading: Reading): boolean {
		return reading.qty !== null && reading.offset_min % 60 === 0;
	}

	add(reading: R, ms: number): void {
		const hour = Math.floor(ms / HOUR_MS) * HOUR_MS;
		const key = `${reading.metric}/${reading.source}`;
		const stream = this.streams.get(key) ?? { first: hour, last: hour, edges: new Map<number, Map<string, R>>() };
		this.streams.set(key, stream);
		if (hour < stream.first) {
			if (stream.first !== stream.last) stream.edges.delete(stream.first);
			stream.first = hour;
		}
		if (hour > stream.last) {
			if (stream.first !== stream.last) stream.edges.delete(stream.last);
			stream.last = hour;
		}
		if (hour === stream.first || hour === stream.last) {
			const edge = stream.edges.get(hour) ?? new Map<string, R>();
			stream.edges.set(hour, edge.set(reading.measured, reading));
		}
		const bucketKey = `${key}/${hour}`;
		const bucket = this.buckets.get(bucketKey) ?? { stream: key, hour, seen: new Uint8Array(450), groups: new Map<string, Group<R>>() };
		this.buckets.set(bucketKey, bucket);
		const second = Math.floor((ms - hour) / 1000);
		const bit = 1 << (second & 7);
		if (((bucket.seen[second >> 3] ?? 0) & bit) !== 0) return;
		bucket.seen[second >> 3] = (bucket.seen[second >> 3] ?? 0) | bit;
		const localDate = reading.measured.slice(0, 10);
		const group = bucket.groups.get(localDate) ?? { first: ms, reading, values: [] };
		bucket.groups.set(localDate, group);
		group.values.push(reading.qty ?? 0);
		if (ms < group.first) {
			group.first = ms;
			group.reading = reading;
		}
	}

	drain(): { hours: HourRow[]; raw: R[] } {
		const hours: HourRow[] = [];
		const raw: R[] = [];
		for (const stream of this.streams.values()) for (const edge of stream.edges.values()) raw.push(...edge.values());
		for (const bucket of this.buckets.values()) {
			const stream = this.streams.get(bucket.stream);
			if (stream === undefined || bucket.hour === stream.first || bucket.hour === stream.last) continue;
			const groups = [...bucket.groups.values()];
			for (const { reading, values } of groups) {
				const whole = groups.length === 1;
				hours.push({
					metric: reading.metric,
					source: reading.source,
					measured: whole ? new Date(bucket.hour).toISOString() : reading.measured,
					ended: whole ? new Date(bucket.hour + HOUR_MS).toISOString() : reading.ended,
					offset_min: reading.offset_min,
					units: reading.units,
					values,
				});
			}
		}
		this.buckets.clear();
		this.streams.clear();
		return { hours, raw };
	}
}
