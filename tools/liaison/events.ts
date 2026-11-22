import type { DayClosedSummary } from "../nutrition/store.ts";
import type { WorkoutLog } from "../workouts/log.ts";

export type FullRecord = { method: "GET"; path: string };

export type DayClosedData = DayClosedSummary & { full: FullRecord };

export type SessionFinishedData = {
	sessionId: string;
	day: string;
	date: string;
	name: string;
	kind: string;
	blockId: string;
	weekId: string;
	dayId: string;
	exercises: { total: number; completed: number; skipped: number };
	sets: number;
	full: FullRecord;
};

const TEXT_CHARS = 80;

function clip(text: string): string {
	const chars = Array.from(text);
	return chars.length <= TEXT_CHARS ? text : `${chars.slice(0, TEXT_CHARS - 1).join("")}…`;
}

export function dayClosedData(summary: DayClosedSummary): DayClosedData {
	return { ...summary, full: { method: "GET", path: `/api/tools/nutrition/day?date=${summary.date}` } };
}

export function sessionFinishedData(sessionId: string, log: WorkoutLog): SessionFinishedData {
	const completed = log.exercises.filter((exercise) => exercise.status === "completed");
	return {
		sessionId,
		day: log.date.slice(0, 10),
		date: clip(log.date),
		name: clip(log.name),
		kind: clip(log.kind),
		blockId: clip(log.blockId),
		weekId: clip(log.weekId),
		dayId: clip(log.dayId),
		exercises: { total: log.exercises.length, completed: completed.length, skipped: log.exercises.length - completed.length },
		sets: completed.reduce((total, exercise) => total + exercise.sets.filter((set) => set.type === "working").length, 0),
		full: { method: "GET", path: `/api/tools/workouts/sessions/${sessionId}` },
	};
}
