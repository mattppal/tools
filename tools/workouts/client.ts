import type { SetRow } from "./log.ts";
import type { ExerciseHistory, ExerciseList, ExerciseSession, HistorySet, RunHistory, RunSession } from "./exercises.ts";
import type { HistoryTimeline, TimelineBlock, TimelineMark, TimelineWeek } from "./history.ts";
import type { PrescribedExercise } from "./program.ts";
import type { ScheduleDay, ScheduleWeek, WeekRef } from "./schedule.ts";
import type { SessionDetail, SessionSummary } from "./store.ts";
import type { SyncState } from "./sync.ts";

export type { ExerciseHistory, ExerciseList, ExerciseSession, HistorySet, RunHistory, RunSession };
export type { HistoryTimeline, TimelineBlock, TimelineMark, TimelineWeek };
export type { PrescribedExercise, ScheduleDay, ScheduleWeek, SessionDetail, SessionSummary, SetRow, SyncState, WeekRef };

export type ProgramResponse = { today: string; weeks: WeekRef[]; currentWeek: string | null; week: ScheduleWeek | null; next: ScheduleDay | null; sync: SyncState; webhookReady: boolean };

export class ApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code: string | null,
	) {
		super(message);
	}
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
	let response: Response;
	try {
		response = await fetch(`/api/tools/workouts${path}`, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
	} catch {
		throw new ApiError("You're offline. Changes will save when you reconnect.", 0, "offline");
	}
	const body: unknown = await response.json().catch(() => null);
	if (!response.ok) {
		const error = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : `Request failed (${response.status})`;
		const code = typeof body === "object" && body !== null && "code" in body && typeof body.code === "string" ? body.code : null;
		throw new ApiError(error, response.status, code);
	}
	return body as T;
}

export type SetDraft = { weight: number | null; unit: "lb" | "kg" | null; reps: number | null; rir: number | null; asWritten: boolean; notes: string | null };

export const api = {
	program: (week?: string) => call<ProgramResponse>(week === undefined ? "/program" : `/program?week=${encodeURIComponent(week)}`),
	sessions: () => call<{ sessions: SessionSummary[] }>("/sessions"),
	timeline: () => call<HistoryTimeline>("/history/timeline"),
	exercises: () => call<ExerciseList>("/history/exercises"),
	exerciseHistory: (key: string) => call<ExerciseHistory>(`/history/exercises/${encodeURIComponent(key)}`),
	runs: () => call<RunHistory>("/history/runs"),
	session: (id: string) => call<{ session: SessionDetail }>(`/sessions/${id}`),
	start: (blockId: string, weekId: string, dayId: string) => call<{ session: SessionDetail }>("/sessions", { method: "POST", body: JSON.stringify({ blockId, weekId, dayId }) }),
	putSet: (id: string, position: number, index: number, set: SetDraft) => call<{ ok: true }>(`/sessions/${id}/sets/${position}/${index}`, { method: "PUT", body: JSON.stringify(set) }),
	deleteSet: (id: string, position: number, index: number) => call<{ ok: true }>(`/sessions/${id}/sets/${position}/${index}`, { method: "DELETE" }),
	exercise: (id: string, position: number, patch: { status?: "planned" | "skipped"; notes?: string | null }) =>
		call<{ session: SessionDetail }>(`/sessions/${id}/exercises/${position}`, { method: "PATCH", body: JSON.stringify(patch) }),
	notes: (id: string, notes: string | null) => call<{ session: SessionDetail }>(`/sessions/${id}`, { method: "PATCH", body: JSON.stringify({ notes }) }),
	finish: (id: string) => call<{ session: SessionDetail }>(`/sessions/${id}/finish`, { method: "POST" }),
	redeliver: (id: string) => call<{ session: SessionDetail }>(`/sessions/${id}/redeliver`, { method: "POST" }),
	discard: (id: string) => call<{ ok: true }>(`/sessions/${id}`, { method: "DELETE" }),
};

const DAY = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

export function formatDate(date: string): string {
	return DAY.format(new Date(`${date}T00:00:00Z`));
}

const MODALITIES: Record<string, string> = { pool: "Pool", track: "Track", z2: "Zone 2", other: "Other" };

export function modalityWords(modality: string): string {
	return MODALITIES[modality] ?? modality;
}

const SHORT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export function formatRange(start: string, end: string): string {
	return `${SHORT.format(new Date(`${start}T00:00:00Z`))} – ${SHORT.format(new Date(`${end}T00:00:00Z`))}`;
}

export function formatAgo(iso: string, now: number = Date.now()): string {
	const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

export function asWrittenValues(exercise: PrescribedExercise): SetDraft | null {
	const weight = exercise.load?.kind === "number" ? exercise.load.value : null;
	const reps = exercise.reps?.kind === "exact" ? exercise.reps.value : null;
	const rir = exercise.targetRir !== null && Number.isInteger(exercise.targetRir) ? exercise.targetRir : null;
	if (weight === null && reps === null && rir === null) return null;
	return { weight, unit: weight === null ? null : exercise.unit, reps, rir, asWritten: true, notes: null };
}

export function describeSet(set: Pick<SetDraft, "weight" | "unit" | "reps" | "rir">): string {
	const parts = [set.weight === null ? null : `${set.weight}`, set.reps === null ? null : `${set.reps}`].filter((part) => part !== null);
	const head = parts.join(" × ");
	return set.rir === null ? head : `${head}${head === "" ? "" : " "}@${set.rir}`;
}
