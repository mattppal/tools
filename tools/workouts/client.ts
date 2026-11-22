import type { SetRow } from "./log.ts";
import type { PrescribedExercise } from "./program.ts";
import type { Schedule } from "./schedule.ts";
import type { SessionDetail, SessionSummary } from "./store.ts";

export type { PrescribedExercise, Schedule, SessionDetail, SessionSummary, SetRow };

export type ProgramResponse = { schedule: Schedule; webhookReady: boolean };

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
	program: () => call<ProgramResponse>("/program"),
	sessions: () => call<{ sessions: SessionSummary[] }>("/sessions"),
	session: (id: string) => call<{ session: SessionDetail }>(`/sessions/${id}`),
	start: (weekId: string, dayId: string) => call<{ session: SessionDetail }>("/sessions", { method: "POST", body: JSON.stringify({ weekId, dayId }) }),
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
