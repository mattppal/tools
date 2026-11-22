import { useEffect, useState } from "react";
import type { ToolSection } from "../../src/shell/tool-layout.tsx";
import { type DayView, type FoodEntry, MACROS, macroProgress, type SourceKind, type Totals } from "./types.ts";

export const API = "/api/tools/nutrition";

type Load<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: T };

function describe(error: unknown): string {
	if (error instanceof TypeError) return "Couldn't reach the server. Reload the page to sign in again.";
	return error instanceof Error ? error.message : String(error);
}

export async function request<T>(path: string, body?: unknown): Promise<T> {
	let response: Response;
	try {
		response = await fetch(`${API}${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	} catch (error) {
		throw new Error(describe(error));
	}
	const json: unknown = await response.json().catch(() => null);
	if (!response.ok) throw new Error((json as { error?: string } | null)?.error ?? `Request failed with ${response.status}`);
	return json as T;
}

export function useJson<T>(path: string): [Load<T>, (data: T) => void, () => void] {
	const [load, setLoad] = useState<Load<T>>({ status: "loading" });
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		let live = true;
		setLoad({ status: "loading" });
		request<T>(path).then(
			(data) => live && setLoad({ status: "ready", data }),
			(error: unknown) => live && setLoad({ status: "error", message: describe(error) }),
		);
		return () => {
			live = false;
		};
	}, [path, attempt]);
	return [load, (data) => setLoad({ status: "ready", data }), () => setAttempt((count) => count + 1)];
}

export const VIEWS: readonly ToolSection[] = [
	{ path: "/", label: "Today" },
	{ path: "/history", label: "History" },
	{ path: "/weight", label: "Weight" },
	{ path: "/phase", label: "Phase" },
];

const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export const whole = (value: number) => number.format(value);
export const tenths = (value: number) => decimal.format(value);

export function dayLabel(date: string, options: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" }): string {
	return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { ...options, timeZone: "UTC" });
}

export const SOURCE_TAGS: Record<SourceKind, string> = { usda_fdc: "USDA", open_food_facts: "OFF", tracker_export: "Export", estimate: "Estimate" };

export function withEntries(day: DayView, entries: FoodEntry[]): DayView {
	const totals: Totals = { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 };
	for (const entry of entries) {
		for (const macro of MACROS) totals[macro] += entry[macro];
		totals.fiber_g += entry.fiber_g ?? 0;
	}
	return { ...day, entries, totals, progress: day.targets === null ? null : macroProgress(totals, day.targets) };
}
