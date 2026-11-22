import { addDays, dayNumber } from "./dates.ts";
import type { DateRange } from "./weights.ts";

export type Grouping = "day" | "week" | "month";
export type Bucketing = Exclude<Grouping, "day">;

export const GROUPINGS: readonly Grouping[] = ["day", "week", "month"];

export type DayValue = { date: string; value: number; target: number | null };

export type Bucket = {
	date: string;
	end: string;
	length: number;
	value: number;
	days: number;
	total: number;
	targeted: number;
	met: number;
	partial: boolean;
	change: number | null;
};

export function parseGrouping(value: string | null): Grouping {
	return GROUPINGS.find((grouping) => grouping === value) ?? "day";
}

export function bucketStart(date: string, bucketing: Bucketing): string {
	switch (bucketing) {
		case "week":
			return addDays(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));
		case "month":
			return `${date.slice(0, 7)}-01`;
		default: {
			const unknown: never = bucketing;
			throw new Error(`Unknown bucketing ${String(unknown)}`);
		}
	}
}

export function bucketEnd(start: string, bucketing: Bucketing): string {
	switch (bucketing) {
		case "week":
			return addDays(start, 6);
		case "month": {
			const [year = 0, month = 1] = start.split("-").map(Number);
			return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
		}
		default: {
			const unknown: never = bucketing;
			throw new Error(`Unknown bucketing ${String(unknown)}`);
		}
	}
}

export function snapRange(range: DateRange, bucketing: Bucketing): DateRange {
	return { from: bucketStart(range.from, bucketing), to: bucketEnd(bucketStart(range.to, bucketing), bucketing) };
}

export function bucketDays(rows: DayValue[], bucketing: Bucketing, today: string): Bucket[] {
	const buckets: Bucket[] = [];
	for (const row of rows) {
		const start = bucketStart(row.date, bucketing);
		let bucket = buckets.at(-1);
		if (bucket?.date !== start) {
			const end = bucketEnd(start, bucketing);
			bucket = { date: start, end, length: dayNumber(end) - dayNumber(start) + 1, value: 0, days: 0, total: 0, targeted: 0, met: 0, partial: end >= today, change: null };
			buckets.push(bucket);
		}
		bucket.days += 1;
		bucket.total += row.value;
		bucket.value = bucket.total / bucket.days;
		if (row.target !== null) {
			bucket.targeted += 1;
			if (row.value >= row.target) bucket.met += 1;
		}
	}
	return buckets.map((bucket, index) => {
		const previous = buckets[index - 1];
		return { ...bucket, change: previous === undefined ? null : bucket.value - previous.value };
	});
}
