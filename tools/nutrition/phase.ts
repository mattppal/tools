import { addDays, dayNumber } from "./dates.ts";

export type TrackerSettings = {
	kind: string;
	startDate: string;
	startWeightOverrideLb: number | null;
	targetRatePerWeek: number;
	weeks: number;
	toleranceLb: number;
	maxWeeklyKcalChange: number;
	minLoggedDays: number;
	currentKcalTarget: number;
};

export type WeightPoint = { date: string; rolling7d: number; rolling14d: number };
export type LoggedDay = { date: string; kcal: number };
export type Verdict = "on track" | "above plan" | "below plan" | "ahead" | "behind";

export type PhaseWeek = {
	week: number;
	weekStart: string;
	weekEnd: string;
	plannedWeight: number | null;
	started: boolean;
	actual7d: number | null;
	actual14d: number | null;
	weeklyChange: number | null;
	avgLoggedKcal: number | null;
	daysLogged: number;
	measuredTdee: number | null;
	vsPlan: number | null;
	verdict: Verdict | null;
	nextWeekKcal: number | null;
	kcalChange: number | null;
};

export type PhaseSummary = { startWeight: number | null; weeks: PhaseWeek[]; current: PhaseWeek | null };

const KCAL_PER_LB = 3500;
const TDEE_WINDOW_DAYS = 28;

function roundHalfAway(value: number, step = 1): number {
	return (Math.sign(value) * Math.round(Math.abs(value) / step)) * step;
}

function lastOnOrBefore(weights: readonly WeightPoint[], date: string): WeightPoint | undefined {
	let found: WeightPoint | undefined;
	for (const point of weights) {
		if (point.date > date) break;
		found = point;
	}
	return found;
}

function loggedBetween(days: readonly LoggedDay[], after: string, through: string): { count: number; mean: number | null } {
	const kcal = days.filter((day) => day.kcal > 0 && day.date > after && day.date <= through).map((day) => day.kcal);
	return { count: kcal.length, mean: kcal.length === 0 ? null : kcal.reduce((sum, value) => sum + value, 0) / kcal.length };
}

function measuredTdee(weights: readonly WeightPoint[], days: readonly LoggedDay[], end: string, minLoggedDays: number): number | null {
	const start = addDays(end, -TDEE_WINDOW_DAYS);
	const { count, mean } = loggedBetween(days, start, end);
	const last = lastOnOrBefore(weights, end);
	const first = lastOnOrBefore(weights, start);
	if (mean === null || last === undefined || first === undefined) return null;
	const span = dayNumber(last.date) - dayNumber(first.date);
	if (count < 2 * minLoggedDays || span < 14 || span > TDEE_WINDOW_DAYS) return null;
	return roundHalfAway(mean - ((last.rolling7d - first.rolling7d) * KCAL_PER_LB) / span);
}

function verdict(settings: TrackerSettings, vsPlan: number): Verdict {
	if (Math.abs(vsPlan) <= settings.toleranceLb) return "on track";
	if (settings.kind === "maintain" || settings.targetRatePerWeek === 0) return vsPlan > 0 ? "above plan" : "below plan";
	return vsPlan < 0 === settings.targetRatePerWeek < 0 ? "ahead" : "behind";
}

export function phaseSummary(settings: TrackerSettings, weights: readonly WeightPoint[], days: readonly LoggedDay[], today: string): PhaseSummary {
	const startWeight = settings.startWeightOverrideLb ?? lastOnOrBefore(weights, settings.startDate)?.rolling7d ?? null;
	const weeks: PhaseWeek[] = [];
	for (let week = 0; week < settings.weeks; week++) {
		const weekStart = addDays(settings.startDate, 7 * week);
		const weekEnd = addDays(weekStart, 6);
		const plannedWeight = startWeight === null ? null : startWeight * (1 + settings.targetRatePerWeek) ** week;
		const row: PhaseWeek = {
			week,
			weekStart,
			weekEnd,
			plannedWeight,
			started: weekStart <= today,
			actual7d: null,
			actual14d: null,
			weeklyChange: null,
			avgLoggedKcal: null,
			daysLogged: 0,
			measuredTdee: null,
			vsPlan: null,
			verdict: null,
			nextWeekKcal: null,
			kcalChange: null,
		};
		weeks.push(row);
		if (!row.started) continue;

		const measureOn = weekEnd < today ? weekEnd : today;
		const weight = lastOnOrBefore(weights, measureOn);
		row.actual7d = weight?.rolling7d ?? null;
		row.actual14d = weight?.rolling14d ?? null;
		const previous = week === 0 ? startWeight : (weeks[week - 1]?.actual7d ?? null);
		row.weeklyChange = row.actual7d === null || previous === null ? null : row.actual7d - previous;

		const logged = loggedBetween(days, addDays(weekStart, -1), measureOn);
		row.avgLoggedKcal = logged.mean;
		row.daysLogged = logged.count;
		row.measuredTdee = logged.count < settings.minLoggedDays ? null : measuredTdee(weights, days, measureOn, settings.minLoggedDays);

		if (row.actual7d !== null && plannedWeight !== null) {
			row.vsPlan = row.actual7d - plannedWeight;
			row.verdict = verdict(settings, row.vsPlan);
		}
		if (row.measuredTdee !== null && row.actual7d !== null) {
			const wanted = row.measuredTdee + (settings.targetRatePerWeek * row.actual7d * KCAL_PER_LB) / 7 - settings.currentKcalTarget;
			const capped = Math.max(-settings.maxWeeklyKcalChange, Math.min(settings.maxWeeklyKcalChange, wanted));
			row.nextWeekKcal = roundHalfAway(settings.currentKcalTarget + capped, 25);
			row.kcalChange = row.nextWeekKcal - settings.currentKcalTarget;
		}
	}
	return { startWeight, weeks, current: weeks.findLast((week) => week.started) ?? null };
}

export const MIN_EXPENDITURE_DAYS = 14;

export type Expenditure = { tdee: number | null; loggedDays: number };

export function rangeExpenditure(weights: readonly WeightPoint[], days: readonly LoggedDay[], from: string, to: string): Expenditure {
	const first = lastOnOrBefore(weights, from) ?? weights.find((point) => point.date >= from);
	const last = lastOnOrBefore(weights, to);
	if (first === undefined || last === undefined || last.date <= first.date) return { tdee: null, loggedDays: loggedBetween(days, addDays(from, -1), to).count };
	const { count, mean } = loggedBetween(days, first.date, last.date);
	const span = dayNumber(last.date) - dayNumber(first.date);
	if (mean === null || count < MIN_EXPENDITURE_DAYS || span < MIN_EXPENDITURE_DAYS) return { tdee: null, loggedDays: count };
	return { tdee: roundHalfAway(mean - ((last.rolling7d - first.rolling7d) * KCAL_PER_LB) / span), loggedDays: count };
}
