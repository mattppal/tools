import { useEffect, useState } from "react";
import { Button } from "../../src/kit/button.tsx";
import { navigate, usePath, useSearchParam } from "../../src/router.tsx";
import type { ToolSection } from "../../src/shell/tool-layout.tsx";
import styles from "./goals.module.css";
import { type Checkin, type Goal, type Overview, STATUS_LABELS } from "./types.ts";

const API = "/api/tools/goals";

export const VIEWS: readonly ToolSection[] = [
	{ path: "/", label: "Year" },
	{ path: "/quarters", label: "Quarters" },
	{ path: "/themes", label: "Themes" },
];

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

export function useOverview(): [Load<Overview>, (goal: Goal) => void, () => void] {
	const [load, setLoad] = useState<Load<Overview>>({ status: "loading" });
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		let live = true;
		setLoad({ status: "loading" });
		request<Overview>("/overview").then(
			(data) => live && setLoad({ status: "ready", data }),
			(error: unknown) => live && setLoad({ status: "error", message: describe(error) }),
		);
		return () => {
			live = false;
		};
	}, [attempt]);
	const replace = (goal: Goal) => setLoad((current) => (current.status === "ready" ? { status: "ready", data: { ...current.data, goals: current.data.goals.map((item) => (item.id === goal.id ? goal : item)) } } : current));
	return [load, replace, () => setAttempt((count) => count + 1)];
}

const thisYear = () => Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric" }).format(new Date()));

export function yearsOf(overview: Overview): number[] {
	return [...new Set([...overview.years.map((year) => year.year), ...overview.goals.map((goal) => goal.year)])].toSorted((a, b) => b - a);
}

export function useYear(overview: Overview): number {
	const asked = Number(useSearchParam("year"));
	const years = yearsOf(overview);
	if (years.includes(asked)) return asked;
	const now = thisYear();
	return years.includes(now) ? now : (years[0] ?? now);
}

export function YearSwitcher({ overview, year }: { overview: Overview; year: number }) {
	const path = usePath();
	const years = yearsOf(overview);
	if (years.length < 2) return null;
	return (
		<div className={styles.years} role="group" aria-label="Year">
			{years.map((option) => (
				<Button key={option} size="sm" variant="quiet" aria-pressed={option === year} onClick={() => navigate(`${path}?year=${option}`, { replace: true })}>
					{option}
				</Button>
			))}
		</div>
	);
}

export function LoadState({ load, retry }: { load: Exclude<Load<unknown>, { status: "ready" }>; retry: () => void }) {
	if (load.status === "loading") return <div className={styles.loading} aria-busy="true" aria-label="Loading goals" />;
	return (
		<div className={styles.empty}>
			<p>{load.message}</p>
			<Button onClick={retry}>Try again</Button>
		</div>
	);
}

export function dayLabel(date: string): string {
	return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function targetText(goal: Goal): string | null {
	const parts = [goal.target, goal.metric].filter((part): part is string => part !== null && part.trim() !== "");
	return parts.length === 0 ? null : parts.join(" ");
}

export function goalMeta(goal: Goal, { area }: { area?: string } = {}): string {
	const target = targetText(goal);
	return [STATUS_LABELS[goal.status], area, goal.quarter === null ? null : `Q${goal.quarter}`, target === null ? null : `Target ${target}`].filter((part) => part != null).join(" · ");
}

export function checkinText(checkin: Checkin | null): string {
	if (checkin === null) return "No check-ins yet";
	return [dayLabel(checkin.date), checkin.progress === null ? null : `${Math.round(checkin.progress)}%`, checkin.note].filter((part) => part !== null).join(" · ");
}
