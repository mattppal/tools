import { describe, expect, test } from "bun:test";
import type { WeightRow } from "./types.ts";
import { inRange, presetRange, sortEntries, summarize, withChanges } from "./weights.ts";

const row = (date: string, weight: number, rolling7d: number, source = "sheet"): WeightRow => ({ date, weight, rolling7d, rolling14d: rolling7d + 0.5, source });

const rows = [row("2026-01-01", 182, 182.4), row("2026-01-02", 181, 182), row("2026-01-08", 181.5, 181.2, "withings"), row("2026-01-15", 180, 180.6)];

describe("weights", () => {
	test("change is against the previous weigh-in", () => {
		expect(withChanges(rows).map((entry) => entry.change)).toEqual([null, -1, 0.5, -1.5]);
	});

	test("presets end today and all starts at the first weigh-in", () => {
		expect(presetRange("90d", rows, "2026-03-01")).toEqual({ from: "2025-12-01", to: "2026-03-01" });
		expect(presetRange("all", rows, "2026-03-01")).toEqual({ from: "2026-01-01", to: "2026-03-01" });
	});

	test("range and source filter together", () => {
		expect(inRange(rows, { from: "2026-01-02", to: "2026-01-08" }, null).map((entry) => entry.date)).toEqual(["2026-01-02", "2026-01-08"]);
		expect(inRange(rows, { from: "2026-01-01", to: "2026-01-31" }, "withings").map((entry) => entry.date)).toEqual(["2026-01-08"]);
	});

	test("summary uses the chosen average for start, end, and rate", () => {
		const summary = summarize(rows, "rolling7d");
		expect(summary?.start).toBe(182.4);
		expect(summary?.end).toBe(180.6);
		expect(summary?.change).toBeCloseTo(-1.8);
		expect(summary?.average).toBeCloseTo(181.125);
		expect(summary?.weeklyRate).toBeCloseTo(-0.9);
		expect(summarize([], "rolling7d")).toBeNull();
	});

	test("sorts by column and breaks ties by date in the same direction", () => {
		const entries = withChanges(rows);
		expect(sortEntries(entries, { key: "date", descending: true }, "rolling7d")[0]?.date).toBe("2026-01-15");
		expect(sortEntries(entries, { key: "weight", descending: true }, "rolling7d").map((entry) => entry.date)).toEqual(["2026-01-01", "2026-01-08", "2026-01-02", "2026-01-15"]);
		expect(sortEntries(entries, { key: "change", descending: false }, "rolling7d").map((entry) => entry.date)).toEqual(["2026-01-01", "2026-01-15", "2026-01-02", "2026-01-08"]);
	});
});
