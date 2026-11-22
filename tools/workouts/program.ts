export type Unit = "lb" | "kg";

export type Load = { kind: "number"; value: number } | { kind: "text"; text: string };

export type Reps = { kind: "exact"; value: number } | { kind: "range"; min: number; max: number };

export type PrescribedExercise = {
	position: number;
	id: string;
	name: string;
	kind: string;
	load: Load | null;
	unit: Unit;
	sets: number | null;
	reps: Reps | null;
	targetRir: number | null;
	deload: boolean;
	notes: string[];
	programNotes: string | null;
	source: string;
};

export type ProgramDay = {
	weekId: string;
	dayId: string;
	kind: string;
	title: string;
	date: string;
	plan: string[];
	exercises: PrescribedExercise[];
};

type Json = Record<string, unknown>;

export type Program = {
	id: string;
	name: string;
	starts: string;
	ends: string | null;
	unit: Unit;
	raw: Json;
};

const DAY_MS = 86_400_000;

function isRecord(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value : null;
}

function num(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asUnit(value: unknown, fallback: Unit): Unit {
	return value === "kg" || value === "lb" ? value : fallback;
}

export function addDays(date: string, days: number): string {
	return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function parseProgram(raw: unknown): Program | null {
	if (!isRecord(raw)) return null;
	const id = text(raw.id);
	const starts = text(raw.starts) ?? (isRecord(raw.calendar) ? text(raw.calendar.week1Start) : null);
	if (id === null || starts === null) return null;
	return { id, name: text(raw.name) ?? id, starts, ends: text(raw.ends), unit: asUnit(raw.unit, "lb"), raw };
}

function weekStarts(program: Program): [string, string][] {
	const calendar = program.raw.calendar;
	if (!isRecord(calendar) || !isRecord(calendar.weeks)) return [];
	return Object.entries(calendar.weeks)
		.filter((entry): entry is [string, string] => typeof entry[1] === "string")
		.toSorted((a, b) => a[1].localeCompare(b[1]));
}

export function weekOf(program: Program, date: string): string | null {
	let current: string | null = null;
	for (const [weekId, start] of weekStarts(program)) if (start <= date) current = weekId;
	return current;
}

function weekPattern(program: Program): string[] {
	const calendar = program.raw.calendar;
	if (!isRecord(calendar) || !Array.isArray(calendar.weekPattern)) return [];
	return calendar.weekPattern.filter((slot): slot is string => typeof slot === "string");
}

function liftingDays(program: Program): Json[] {
	return Array.isArray(program.raw.days) ? program.raw.days.filter(isRecord) : [];
}

function repsOf(lift: Json, slot: Json | null): Reps | null {
	const exact = num(slot?.reps) ?? num(lift.reps);
	if (slot !== null && exact !== null) return { kind: "exact", value: exact };
	const range = lift.repRange;
	if (Array.isArray(range) && range.length === 2) {
		const [min, max] = range;
		if (typeof min === "number" && typeof max === "number") return { kind: "range", min, max };
	}
	return exact === null ? null : { kind: "exact", value: exact };
}

function loadOf(value: unknown): Load | null {
	const number = num(value);
	if (number !== null) return { kind: "number", value: number };
	const words = text(value);
	return words === null ? null : { kind: "text", text: words };
}

function notesOf(...values: unknown[]): string[] {
	return values.map(text).filter((note) => note !== null);
}

function waveSlot(program: Program, wave: string, weekId: string): { key: string; slot: Json | null } {
	const key = wave.replace(/^loads\./, "");
	const loads = program.raw.loads;
	const entry = isRecord(loads) ? loads[key] : undefined;
	const slot = isRecord(entry) ? entry[weekId] : undefined;
	return { key, slot: isRecord(slot) ? slot : null };
}

function isDeloadWeek(program: Program, weekId: string): boolean {
	const calendar = program.raw.calendar;
	const start = weekStarts(program).find(([id]) => id === weekId)?.[1];
	return isRecord(calendar) && start !== undefined && calendar.deloadWeek === start;
}

function setsFor(program: Program, lift: Json, weekId: string): number | null {
	const byWeek = lift.setsByWeek;
	const deloadSets = isDeloadWeek(program, weekId) ? num(lift.deloadSets) : null;
	return (isRecord(byWeek) ? num(byWeek[weekId]) : null) ?? deloadSets ?? num(lift.sets);
}

export function resolveLift(program: Program, lift: Json, weekId: string, position: number): PrescribedExercise {
	const id = text(lift.id) ?? `lift-${position}`;
	const base = {
		position,
		id,
		name: text(lift.name) ?? id,
		kind: text(lift.kind) ?? "lift",
		unit: program.unit,
		targetRir: num(lift.targetRir),
		deload: false,
		programNotes: text(lift.notes),
	};
	const wave = text(lift.wave);
	if (wave !== null) {
		const { key, slot } = waveSlot(program, wave, weekId);
		if (slot === null) {
			return { ...base, load: loadOf(lift.load), sets: setsFor(program, lift, weekId), reps: repsOf(lift, null), notes: [], source: `loads.${key}` };
		}
		return {
			...base,
			load: loadOf(slot.weight) ?? loadOf(slot.load),
			unit: asUnit(slot.unit, program.unit),
			sets: num(slot.sets) ?? setsFor(program, lift, weekId),
			reps: repsOf(lift, slot),
			targetRir: num(slot.targetRir) ?? (slot.deload === true ? null : base.targetRir),
			deload: slot.deload === true,
			notes: notesOf(slot.notes, slot.note),
			source: `loads.${key}.${weekId}`,
		};
	}
	if (lift.progression === "double_progression") {
		const starts = program.raw.accessoryStartLoads;
		return {
			...base,
			load: isRecord(starts) ? loadOf(starts[id]) : null,
			sets: setsFor(program, lift, weekId),
			deload: isDeloadWeek(program, weekId),
			reps: repsOf(lift, null),
			notes: [],
			source: `accessoryStartLoads.${id}`,
		};
	}
	return { ...base, load: loadOf(lift.load), sets: setsFor(program, lift, weekId), reps: repsOf(lift, null), notes: [], source: `days.${id}` };
}

function conditioningSlots(program: Program): Map<string, Json> {
	const raw = program.raw.conditioning;
	const entries = Array.isArray(raw) ? raw.filter(isRecord) : isRecord(raw) ? [raw] : [];
	return new Map(entries.flatMap((entry) => [text(entry.slot), text(entry.id)].filter((slot) => slot !== null).map((slot) => [slot, entry] as const)));
}

function conditioningPlan(entry: Json): string[] {
	const minutes = entry.durationMinutes;
	const duration = Array.isArray(minutes) && minutes.length === 2 ? `${minutes[0]}–${minutes[1]} min` : num(minutes) === null ? null : `${minutes} min`;
	return [duration, text(entry.effort), text(entry.format)].filter((line) => line !== null);
}

export function programDays(program: Program, weekId: string): ProgramDay[] {
	const start = weekStarts(program).find(([id]) => id === weekId)?.[1];
	if (start === undefined) return [];
	const days = new Map(liftingDays(program).map((day) => [text(day.id) ?? "", day]));
	const conditioning = conditioningSlots(program);
	const out: ProgramDay[] = [];
	weekPattern(program).forEach((slot, index) => {
		const date = addDays(start, index);
		const cardio = conditioning.get(slot);
		if (cardio !== undefined) {
			out.push({ weekId, dayId: slot, kind: "conditioning", title: text(cardio.name) ?? slot, date, plan: conditioningPlan(cardio), exercises: [] });
			return;
		}
		const day = days.get(slot);
		if (day === undefined) return;
		const lifts = Array.isArray(day.lifts) ? day.lifts.filter(isRecord) : [];
		out.push({
			weekId,
			dayId: slot,
			kind: "lift",
			title: text(day.title) ?? slot,
			date,
			plan: [],
			exercises: lifts.map((lift, position) => resolveLift(program, lift, weekId, position)),
		});
	});
	return out;
}

export function weekIds(program: Program): string[] {
	return weekStarts(program).map(([id]) => id);
}

export function formatLoad(exercise: PrescribedExercise): string | null {
	if (exercise.load === null) return null;
	return exercise.load.kind === "number" ? `${exercise.load.value} ${exercise.unit}` : exercise.load.text;
}

export function formatVolume(exercise: PrescribedExercise): string {
	const reps = exercise.reps === null ? null : exercise.reps.kind === "exact" ? `${exercise.reps.value}` : `${exercise.reps.min}–${exercise.reps.max}`;
	const volume = exercise.sets !== null && reps !== null ? `${exercise.sets} × ${reps}` : (reps ?? (exercise.sets === null ? null : `${exercise.sets} sets`));
	const rir = exercise.targetRir === null ? null : `@${exercise.targetRir}`;
	return [volume, rir].filter((part) => part !== null).join(" ");
}
