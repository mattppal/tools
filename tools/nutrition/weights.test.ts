import { describe, expect, test } from "bun:test";
import { changeTone, inRange, nearestIndex, presetRange, previousRange, type SeriesRow, sortEntries, summarize, toneStrength, withChanges } from "./weights.ts";

const row = (date: string, value: number, rolling7d: number, source = "sheet"): SeriesRow => ({ date, value, rolling7d, rolling14d: rolling7d + 0.5, rolling28d: rolling7d + 1, source });

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
		expect(summarize(rows, "rolling28d")?.start).toBe(183.4);
		expect(summarize([], "rolling7d")).toBeNull();
	});

	test("tones a change by the phase goal, and neutral outside a cut or gain", () => {
		expect(changeTone(-0.4, "cut", 0.05)).toBe("good");
		expect(changeTone(0.4, "cut", 0.05)).toBe("bad");
		expect(changeTone(0.4, "gain", 0.05)).toBe("good");
		expect(changeTone(-0.4, "maintain", 0.05)).toBe("down");
		expect(changeTone(0.4, null, 0.05)).toBe("up");
		expect(changeTone(0.04, "cut", 0.05)).toBe("flat");
	});

	test("tint strength scales with the change and stays between 30% and full", () => {
		expect(toneStrength(-0.1, 2)).toBe(0.3);
		expect(toneStrength(1, 2)).toBe(0.5);
		expect(toneStrength(-5, 2)).toBe(1);
	});

	test("snaps to the nearest weigh-in, earlier on a tie", () => {
		const day = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000;
		expect(nearestIndex(rows, day("2025-12-01"))).toBe(0);
		expect(nearestIndex(rows, day("2026-01-05"))).toBe(1);
		expect(nearestIndex(rows, day("2026-01-06"))).toBe(2);
		expect(nearestIndex(rows, day("2026-01-11"))).toBe(2);
		expect(nearestIndex(rows, day("2026-03-01"))).toBe(3);
	});

	test("the previous period is the same length and ends the day before", () => {
		expect(previousRange({ from: "2026-03-01", to: "2026-03-30" })).toEqual({ from: "2026-01-30", to: "2026-02-28" });
	});

	test("sorts by column and breaks ties by date in the same direction", () => {
		const entries = withChanges(rows);
		expect(sortEntries(entries, { key: "date", descending: true }, "rolling7d")[0]?.date).toBe("2026-01-15");
		expect(sortEntries(entries, { key: "value", descending: true }, "rolling7d").map((entry) => entry.date)).toEqual(["2026-01-01", "2026-01-08", "2026-01-02", "2026-01-15"]);
		expect(sortEntries(entries, { key: "change", descending: false }, "rolling7d").map((entry) => entry.date)).toEqual(["2026-01-01", "2026-01-15", "2026-01-02", "2026-01-08"]);
	});
});
