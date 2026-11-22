import { addDays, dayNumber } from "./dates.ts";

export type Preset = "90d" | "1y" | "all";
export type DateRange = { from: string; to: string };
export type Average = "rolling7d" | "rolling14d" | "rolling28d";
export type Sort = { key: string; descending: boolean };
export type SeriesRow = { date: string; value: number; source?: string } & Record<Average, number>;
export type SeriesEntry<T extends SeriesRow = SeriesRow> = T & { change: number | null };
export type WeightSummary = { start: number; end: number; change: number; average: number; weeklyRate: number; days: number };

const PRESET_DAYS: Record<Preset, number | null> = { "90d": 90, "1y": 365, all: null };

export function withChanges<T extends SeriesRow>(rows: T[]): SeriesEntry<T>[] {
	return rows.map((row, index) => {
		const previous = rows[index - 1];
		return { ...row, change: previous === undefined ? null : row.value - previous.value };
	});
}

export function presetRange(preset: Preset, rows: { date: string }[], today: string): DateRange {
	const last = rows.at(-1)?.date;
	const to = last !== undefined && last > today ? last : today;
	const days = PRESET_DAYS[preset];
	return { from: days === null ? (rows[0]?.date ?? to) : addDays(to, -days), to };
}

export function inRange<T extends { date: string; source?: string }>(rows: T[], range: DateRange, source: string | null): T[] {
	return rows.filter((row) => row.date >= range.from && row.date <= range.to && (source === null || row.source === source));
}

export function summarize(rows: SeriesRow[], average: Average): WeightSummary | null {
	const first = rows[0];
	const last = rows.at(-1);
	if (first === undefined || last === undefined) return null;
	const days = dayNumber(last.date) - dayNumber(first.date);
	const change = last[average] - first[average];
	return {
		start: first[average],
		end: last[average],
		change,
		average: rows.reduce((sum, row) => sum + row.value, 0) / rows.length,
		weeklyRate: days === 0 ? 0 : (change / days) * 7,
		days,
	};
}

export type Tone = "good" | "bad" | "down" | "up" | "flat";

export function changeTone(change: number, phaseKind: string | null, flatBelow: number): Tone {
	if (Math.abs(change) < flatBelow) return "flat";
	const loss = change < 0;
	if (phaseKind === "cut") return loss ? "good" : "bad";
	if (phaseKind === "gain") return loss ? "bad" : "good";
	return loss ? "down" : "up";
}

export function toneStrength(change: number, full: number): number {
	return Math.min(Math.max(Math.abs(change) / full, 0.3), 1);
}

export function nearestIndex<T extends { date: string }>(rows: T[], day: number, center: (row: T) => number = (row) => dayNumber(row.date)): number {
	let low = 0;
	let high = rows.length - 1;
	while (low < high) {
		const middle = (low + high) >> 1;
		const row = rows[middle];
		if (row !== undefined && center(row) < day) low = middle + 1;
		else high = middle;
	}
	const before = rows[low - 1];
	const at = rows[low];
	if (before !== undefined && at !== undefined && day - center(before) <= center(at) - day) return low - 1;
	return low;
}

export function sortRows<T extends { date: string }>(rows: T[], descending: boolean, value: (row: T) => number | string): T[] {
	const direction = descending ? -1 : 1;
	return [...rows].sort((a, b) => {
		const left = value(a);
		const right = value(b);
		if (left === right) return a.date < b.date ? -direction : direction;
		return left < right ? -direction : direction;
	});
}

export function previousRange(range: DateRange): DateRange {
	const days = dayNumber(range.to) - dayNumber(range.from) + 1;
	return { from: addDays(range.from, -days), to: addDays(range.from, -1) };
}
