export const MACROS = ["kcal", "protein_g", "carbs_g", "fat_g"] as const;
export type Macro = (typeof MACROS)[number];

export type Range = { min: number; max: number };
export type Targets = Record<Macro, Range> & { effectiveFrom: string; notes: string; stepsTarget: number | null };
export type Totals = Record<Macro | "fiber_g", number>;
type MacroStatus = "under" | "in" | "over";
export type MacroProgress = Range & { total: number; status: MacroStatus };

export type SourceKind = "usda_fdc" | "open_food_facts" | "tracker_export" | "estimate";

export type FoodEntry = {
	id: number;
	food: string;
	qty: number;
	unit: string;
	kcal: number;
	protein_g: number;
	carbs_g: number;
	fat_g: number;
	fiber_g: number | null;
	sourceKind: SourceKind;
	sourceRef: string | null;
	sourceLabel: string;
	clientKey: string;
};

export type CheckIn = {
	bodyweightLb: number | null;
	steps: number | null;
	bloatScore: number | null;
	energy: number | null;
	sleep: number | null;
	stress: number | null;
	notes: string;
};

export type DayView = {
	date: string;
	closed: boolean;
	estimated: boolean;
	phase: string | null;
	entries: FoodEntry[];
	totals: Totals;
	targets: Targets | null;
	progress: Record<Macro, MacroProgress> | null;
	checkIn: CheckIn;
};

export const PARTIAL_DAY_SHARE = 0.5;

export type HistoryDay = { date: string; closed: boolean; entries: number; kcalTarget: number | null; partial: boolean; steps: number | null } & Record<Macro, number>;

export function isPartialDay(day: { closed: boolean; entries: number; kcal: number; kcalTarget: number | null }): boolean {
	return day.closed && day.entries > 0 && day.kcalTarget !== null && day.kcal < day.kcalTarget * PARTIAL_DAY_SHARE;
}

export type WeightRow = { date: string; weight: number; rolling7d: number; rolling14d: number; rolling28d: number; source: string };

export function macroProgress(totals: Totals, targets: Targets): Record<Macro, MacroProgress> {
	const progress = {} as Record<Macro, MacroProgress>;
	for (const macro of MACROS) {
		const { min, max } = targets[macro];
		const total = totals[macro];
		progress[macro] = { total, min, max, status: total < min ? "under" : total > max ? "over" : "in" };
	}
	return progress;
}
