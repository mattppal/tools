import { expect, test } from "bun:test";
import { addDays, dayNumber, isoDate } from "./dates.ts";
import { phaseSummary, type TrackerSettings, type WeightPoint } from "./phase.ts";

const SHEET_EPOCH = dayNumber("1899-12-30");

const SHEET_WEIGHTS: [number, number][] = [
	[46285, 176.83], [46286, 177.49], [46287, 177.49], [46288, 176.14], [46289, 177.74], [46291, 178.65], [46292, 178.48], [46296, 177.11],
	[46297, 177.82], [46298, 179.32], [46299, 178.71], [46301, 179.13], [46302, 179.07], [46303, 180.01], [46304, 177.42], [46305, 179.8],
	[46306, 177.8], [46307, 179.54], [46308, 179.38], [46309, 179.78], [46310, 179.71], [46311, 179.14], [46312, 179.12], [46313, 180.53],
	[46314, 180.61], [46315, 182.1], [46316, 179.08], [46318, 180.7], [46319, 181.36], [46320, 179.33], [46321, 181.14], [46322, 180.53],
	[46323, 182.06], [46324, 180.95], [46325, 181.26], [46327, 177.64], [46328, 178.09], [46330, 179.26], [46332, 180.2], [46334, 178.03],
	[46336, 180.13], [46337, 180.22], [46340, 179.55], [46341, 179.3], [46347, 181.04], [46348, 180.6],
];

function rolling(raw: readonly { date: string; weight: number }[]): WeightPoint[] {
	const mean = (date: string, days: number) => {
		const window = raw.filter((point) => point.date > addDays(date, -days) && point.date <= date).map((point) => point.weight);
		return window.reduce((sum, value) => sum + value, 0) / window.length;
	};
	return raw.map(({ date }) => ({ date, rolling7d: mean(date, 7), rolling14d: mean(date, 14) }));
}

const SHEET_TRACKER: TrackerSettings = {
	kind: "maintain",
	startDate: "2026-11-22",
	startWeightOverrideLb: null,
	targetRatePerWeek: 0,
	weeks: 12,
	toleranceLb: 0.5,
	maxWeeklyKcalChange: 150,
	minLoggedDays: 5,
	currentKcalTarget: 2750,
};

test("matches the sheet's Phase tab on 2026-11-22", () => {
	const weights = rolling(SHEET_WEIGHTS.map(([serial, weight]) => ({ date: isoDate(SHEET_EPOCH + serial), weight })));
	const summary = phaseSummary(SHEET_TRACKER, weights, [{ date: "2026-11-22", kcal: 692, partial: false }], "2026-11-22");

	expect(summary.startWeight).toBeCloseTo(180.82, 2);
	expect(summary.weeks).toHaveLength(12);
	expect(summary.weeks.map((week) => week.weekStart).slice(0, 3)).toEqual(["2026-11-22", "2026-11-29", "2026-12-06"]);
	expect(summary.current).toMatchObject({ week: 0, weekEnd: "2026-11-28", avgLoggedKcal: 692, daysLogged: 1, measuredTdee: null, verdict: "on track", nextWeekKcal: null });
	expect(summary.current?.actual7d).toBeCloseTo(180.82, 2);
	expect(summary.current?.actual14d).toBeCloseTo(180.14, 2);
	expect(summary.current?.weeklyChange).toBeCloseTo(0, 6);
	expect(summary.weeks[1]).toMatchObject({ started: false, actual7d: null, verdict: null });
	expect(summary.weeks[1]?.plannedWeight).toBeCloseTo(180.82, 2);
});

function steadyCut(dropPerWeek: number) {
	const start = "2026-01-01";
	const raw = Array.from({ length: 50 }, (_, index) => ({ date: addDays(start, index), weight: 200 - (dropPerWeek / 7) * index }));
	const days = raw.map(({ date }) => ({ date, kcal: 2400, partial: false }));
	return { weights: rolling(raw), days };
}

const CUT: TrackerSettings = { ...SHEET_TRACKER, kind: "cut", startDate: "2026-01-29", targetRatePerWeek: -0.005, currentKcalTarget: 2400 };

test("measures TDEE from logged kcal and the 7-day trend over 28 days", () => {
	const { weights, days } = steadyCut(1);
	const week = phaseSummary(CUT, weights, days, "2026-02-04").current;
	expect(week?.daysLogged).toBe(7);
	expect(week?.measuredTdee).toBe(2900);
	const wanted = 2900 + (-0.005 * (week?.actual7d ?? 0) * 3500) / 7;
	expect(week?.nextWeekKcal).toBe(Math.round(Math.min(2550, Math.max(2250, wanted)) / 25) * 25);
	expect(week?.kcalChange).toBe((week?.nextWeekKcal ?? 0) - 2400);
});

test("caps the weekly kcal change", () => {
	const { weights, days } = steadyCut(3);
	const week = phaseSummary({ ...CUT, kind: "maintain", targetRatePerWeek: 0 }, weights, days, "2026-02-04").current;
	expect(week?.measuredTdee).toBe(3900);
	expect(week?.nextWeekKcal).toBe(2550);
	expect(week?.verdict).toBe("below plan");
});

test("needs the minimum logged days before measuring TDEE", () => {
	const { weights, days } = steadyCut(1);
	const sparse = days.filter((day) => day.date < "2026-01-29" || day.date > "2026-02-01");
	expect(phaseSummary(CUT, weights, sparse, "2026-02-04").current).toMatchObject({ daysLogged: 3, measuredTdee: null, nextWeekKcal: null });
});

test("partial days leave the kcal average and TDEE but are counted", () => {
	const { weights, days } = steadyCut(1);
	const marked = days.map((day) => (day.date === "2026-02-02" ? { ...day, kcal: 900, partial: true } : day));
	expect(phaseSummary(CUT, weights, marked, "2026-02-04").current).toMatchObject({ daysLogged: 6, partialDays: 1, avgLoggedKcal: 2400, measuredTdee: 2900 });
});

test("calls a cut ahead or behind against the planned weight", () => {
	const { weights, days } = steadyCut(3);
	expect(phaseSummary(CUT, weights, days, "2026-02-04").current?.verdict).toBe("ahead");
	expect(phaseSummary({ ...CUT, kind: "gain", targetRatePerWeek: 0.005 }, weights, days, "2026-02-04").current?.verdict).toBe("behind");
});
