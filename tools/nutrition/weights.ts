import { addDays, dayNumber } from "./dates.ts";
import type { WeightRow } from "./types.ts";

export type Preset = "90d" | "1y" | "all";
export type DateRange = { from: string; to: string };
export type Average = "rolling7d" | "rolling14d";
export type SortKey = "date" | "weight" | "average" | "change";
export type Sort = { key: SortKey; descending: boolean };
export type WeightEntry = WeightRow & { change: number | null };
export type WeightSummary = { start: number; end: number; change: number; average: number; weeklyRate: number; days: number };

const PRESET_DAYS: Record<Preset, number | null> = { "90d": 90, "1y": 365, all: null };

export function withChanges(rows: WeightRow[]): WeightEntry[] {
	return rows.map((row, index) => {
		const previous = rows[index - 1];
		return { ...row, change: previous === undefined ? null : row.weight - previous.weight };
	});
}

export function presetRange(preset: Preset, rows: WeightRow[], today: string): DateRange {
	const last = rows.at(-1)?.date;
	const to = last !== undefined && last > today ? last : today;
	const days = PRESET_DAYS[preset];
	return { from: days === null ? (rows[0]?.date ?? to) : addDays(to, -days), to };
}

export function inRange<T extends WeightRow>(rows: T[], range: DateRange, source: string | null): T[] {
	return rows.filter((row) => row.date >= range.from && row.date <= range.to && (source === null || row.source === source));
}

export function summarize(rows: WeightRow[], average: Average): WeightSummary | null {
	const first = rows[0];
	const last = rows.at(-1);
	if (first === undefined || last === undefined) return null;
	const days = dayNumber(last.date) - dayNumber(first.date);
	const change = last[average] - first[average];
	return {
		start: first[average],
		end: last[average],
		change,
		average: rows.reduce((sum, row) => sum + row.weight, 0) / rows.length,
		weeklyRate: days === 0 ? 0 : (change / days) * 7,
		days,
	};
}

export function sortEntries(rows: WeightEntry[], sort: Sort, average: Average): WeightEntry[] {
	const value = (row: WeightEntry): number | string => {
		if (sort.key === "date") return row.date;
		if (sort.key === "weight") return row.weight;
		if (sort.key === "average") return row[average];
		return row.change ?? Number.NEGATIVE_INFINITY;
	};
	const direction = sort.descending ? -1 : 1;
	return [...rows].sort((a, b) => {
		const left = value(a);
		const right = value(b);
		if (left === right) return a.date < b.date ? -direction : direction;
		return left < right ? -direction : direction;
	});
}
