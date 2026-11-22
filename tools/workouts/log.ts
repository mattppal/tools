import validateWorkoutLog from "./openweight/workout-log-validator.js";
import type { PrescribedExercise } from "./program.ts";

export type SetRow = {
	set_index: number;
	weight: string | null;
	unit: "lb" | "kg" | null;
	reps: number | null;
	rir: number | null;
	as_written: boolean;
	notes: string | null;
};

export type ExerciseRow = {
	position: number;
	exercise_id: string;
	name: string;
	prescribed: PrescribedExercise;
	status: "planned" | "completed" | "skipped";
	notes: string | null;
	sets: SetRow[];
};

export type SessionRow = {
	id: string;
	block_id: string;
	week_id: string;
	day_id: string;
	day_title: string;
	session_date: string;
	notes: string | null;
	test: boolean;
	exercises: ExerciseRow[];
};

const SKIPPED_SET = { reps: 0, type: "working", notes: "skipped" };

export function pacificMidnight(date: string): string {
	const noon = new Date(`${date}T12:00:00Z`);
	const name = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", timeZoneName: "longOffset" }).formatToParts(noon).find((part) => part.type === "timeZoneName")?.value ?? "GMT-08:00";
	const offset = name === "GMT" ? "+00:00" : name.replace("GMT", "");
	return `${date}T00:00:00${offset}`;
}

function prescribedLog(exercise: PrescribedExercise): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (exercise.load?.kind === "number") {
		out.targetWeight = exercise.load.value;
		out.unit = exercise.unit;
	} else if (exercise.load?.kind === "text") out.targetLoad = exercise.load.text;
	if (exercise.reps?.kind === "exact") out.targetReps = exercise.reps.value;
	if (exercise.reps?.kind === "range") {
		out.targetRepsMin = exercise.reps.min;
		out.targetRepsMax = exercise.reps.max;
	}
	if (exercise.sets !== null) out.targetSets = exercise.sets;
	if (exercise.targetRir !== null) out.targetRIR = exercise.targetRir;
	return out;
}

function setLog(set: SetRow): Record<string, unknown> {
	const out: Record<string, unknown> = { type: "working" };
	if (set.weight !== null) {
		out.weight = Number(set.weight);
		out.unit = set.unit;
	}
	if (set.reps !== null) out.reps = set.reps;
	if (set.rir !== null) out.rir = set.rir;
	const notes = [set.as_written ? "as written" : null, set.notes].filter((note) => note !== null && note !== "").join("; ");
	if (notes !== "") out.notes = notes;
	return out;
}

function isLogged(set: SetRow): boolean {
	return set.weight !== null || set.reps !== null || set.rir !== null || (set.notes ?? "") !== "";
}

export function buildLog(session: SessionRow): Record<string, unknown> {
	const name = `${session.week_id.toUpperCase()} ${session.day_title}`;
	return {
		$schema: "https://openweight.org/schemas/workout-log.schema.json",
		date: pacificMidnight(session.session_date),
		name: session.test ? `TEST ${name}` : name,
		...(session.notes ? { notes: session.notes } : {}),
		blockId: session.block_id,
		weekId: session.week_id,
		dayId: session.day_id,
		status: "completed",
		kind: "lift",
		...(session.test ? { test: true } : {}),
		exercises: session.exercises.map((exercise) => {
			const sets = exercise.sets.filter(isLogged).toSorted((a, b) => a.set_index - b.set_index);
			const skipped = exercise.status === "skipped" || sets.length === 0;
			return {
				order: exercise.position + 1,
				id: exercise.exercise_id,
				status: skipped ? "skipped" : "completed",
				exercise: { name: exercise.name },
				prescribed: prescribedLog(exercise.prescribed),
				...(exercise.notes ? { notes: exercise.notes } : {}),
				sets: skipped ? [SKIPPED_SET] : sets.map(setLog),
			};
		}),
	};
}

export type LogProblem = { path: string; message: string };

export function checkLog(log: Record<string, unknown>): LogProblem[] {
	const problems: LogProblem[] = [];
	if (!validateWorkoutLog(log)) {
		for (const error of validateWorkoutLog.errors ?? []) problems.push({ path: error.instancePath || "/", message: error.message ?? "is invalid" });
	}
	const exercises = Array.isArray(log.exercises) ? log.exercises : [];
	exercises.forEach((exercise: { sets?: { weight?: unknown; unit?: unknown; rir?: unknown }[] }, index) => {
		const sets = exercise.sets ?? [];
		if (sets.length === 0) problems.push({ path: `/exercises/${index}/sets`, message: "needs at least one set" });
		sets.forEach((set, setIndex) => {
			if (set.weight !== undefined && set.unit === undefined) problems.push({ path: `/exercises/${index}/sets/${setIndex}`, message: "weight needs a unit" });
			if (set.rir !== undefined && !Number.isInteger(set.rir)) problems.push({ path: `/exercises/${index}/sets/${setIndex}/rir`, message: "RIR must be a whole number; put half RIR in notes" });
		});
	});
	return problems;
}
