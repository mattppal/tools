import { describe, expect, test } from "bun:test";
import { bucketDays, bucketEnd, bucketStart, parseGrouping, snapRange } from "./groups.ts";

const day = (date: string, value: number, target: number | null = null) => ({ date, value, target });

describe("step groups", () => {
	test("weeks start on Monday and months on the first", () => {
		expect(bucketStart("2026-11-22", "week")).toBe("2026-11-16");
		expect(bucketStart("2026-11-16", "week")).toBe("2026-11-16");
		expect(bucketStart("2026-11-23", "week")).toBe("2026-11-23");
		expect(bucketStart("2026-11-22", "month")).toBe("2026-11-01");
		expect(bucketEnd("2026-11-16", "week")).toBe("2026-11-22");
		expect(bucketEnd("2024-02-01", "month")).toBe("2024-02-29");
		expect(bucketEnd("2026-12-01", "month")).toBe("2026-12-31");
	});

	test("a range snaps out to whole buckets", () => {
		expect(snapRange({ from: "2026-11-04", to: "2026-11-19" }, "week")).toEqual({ from: "2026-11-02", to: "2026-11-22" });
		expect(snapRange({ from: "2026-08-24", to: "2026-11-22" }, "month")).toEqual({ from: "2026-08-01", to: "2026-11-30" });
	});

	test("averages over days with data and counts them", () => {
		const buckets = bucketDays([day("2026-11-09", 10_000, 10_000), day("2026-11-11", 6_000, 10_000), day("2026-11-16", 9_000), day("2026-11-17", 12_000)], "week", "2026-11-22");
		expect(buckets.map(({ date, end, length, value, days, total, met, targeted }) => ({ date, end, length, value, days, total, met, targeted }))).toEqual([
			{ date: "2026-11-09", end: "2026-11-15", length: 7, value: 8_000, days: 2, total: 16_000, met: 1, targeted: 2 },
			{ date: "2026-11-16", end: "2026-11-22", length: 7, value: 10_500, days: 2, total: 21_000, met: 0, targeted: 0 },
		]);
		expect(buckets.map((bucket) => bucket.change)).toEqual([null, 2_500]);
	});

	test("only the bucket that holds today is partial", () => {
		const rows = [day("2026-10-31", 5_000), day("2026-11-02", 7_000), day("2026-11-22", 9_000)];
		expect(bucketDays(rows, "month", "2026-11-22").map((bucket) => [bucket.date, bucket.partial])).toEqual([
			["2026-10-01", false],
			["2026-11-01", true],
		]);
		expect(bucketDays(rows, "week", "2026-11-23").map((bucket) => [bucket.date, bucket.partial])).toEqual([
			["2026-10-26", false],
			["2026-11-02", false],
			["2026-11-16", false],
		]);
	});

	test("an unknown group in the URL falls back to days", () => {
		expect(parseGrouping("week")).toBe("week");
		expect(parseGrouping("month")).toBe("month");
		expect(parseGrouping("year")).toBe("day");
		expect(parseGrouping(null)).toBe("day");
	});
});
