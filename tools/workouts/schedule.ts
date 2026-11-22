import { addDays, parseProgram, programDays, weekIds, type Program, type ProgramDay } from "./program.ts";
import type { MirroredFile } from "./sync.ts";

export type DayState = "logged" | "finished" | "open" | "todo";

export type LoggedExercise = { name: string; summary: string };

export type ScheduleDay = ProgramDay & { blockId: string; state: DayState; sessionId: string | null; repoFile: string | null; logged: LoggedExercise[] | null };

export type WeekRef = { key: string; blockId: string; blockName: string; weekId: string; start: string; end: string };

export type ScheduleWeek = WeekRef & { days: ScheduleDay[] };

export type AppSession = { id: string; blockId: string; weekId: string; dayId: string; status: "open" | "finished"; test: boolean };

export type RepoSession = { path: string; blockId: string | null; weekId: string; dayId: string; date: string; exercises: LoggedExercise[] };

export type TrainingLog = { programs: Program[]; repoSessions: RepoSession[] };

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SESSION_FILE = /(\d{4}-\d{2}-\d{2})-.*-w(\d+)-d(\d+)\.json$/;

function setSummary(set: unknown): string | null {
	if (!isRecord(set)) return null;
	if (set.notes === "skipped" && set.reps === 0) return null;
	const head = [set.weight, set.reps].filter((part) => typeof part === "number").join(" × ");
	const rir = typeof set.rir === "number" ? `@${set.rir}` : null;
	const text = [head === "" ? null : head, rir].filter((part) => part !== null).join(" ");
	return text === "" ? null : text;
}

function loggedExercises(content: Json): LoggedExercise[] {
	const exercises = Array.isArray(content.exercises) ? content.exercises.filter(isRecord) : [];
	return exercises.map((exercise) => {
		const name = isRecord(exercise.exercise) && typeof exercise.exercise.name === "string" ? exercise.exercise.name : typeof exercise.id === "string" ? exercise.id : "Exercise";
		const sets = (Array.isArray(exercise.sets) ? exercise.sets : []).map(setSummary).filter((set) => set !== null);
		return { name, summary: exercise.status === "skipped" || sets.length === 0 ? "Skipped" : sets.join(", ") };
	});
}

export function parseRepoSession(file: MirroredFile): RepoSession | null {
	if (!isRecord(file.content)) return null;
	const content = file.content;
	const match = SESSION_FILE.exec(file.path);
	const weekId = typeof content.weekId === "string" ? content.weekId : match ? `w${match[2]}` : null;
	const dayId = typeof content.dayId === "string" ? content.dayId : match ? `day-${match[3]}` : null;
	const date = typeof content.date === "string" ? content.date.slice(0, 10) : (match?.[1] ?? null);
	if (weekId === null || dayId === null || date === null) return null;
	return { path: file.path, blockId: typeof content.blockId === "string" ? content.blockId : null, weekId, dayId, date, exercises: loggedExercises(content) };
}

export function trainingLogFrom(programs: MirroredFile[], sessions: MirroredFile[]): TrainingLog {
	return {
		programs: programs.map((file) => parseProgram(file.content)).filter((program) => program !== null),
		repoSessions: sessions.map(parseRepoSession).filter((session) => session !== null),
	};
}

function sessionBlock(session: RepoSession, programs: Program[]): string | null {
	if (session.blockId !== null && programs.some((program) => program.id === session.blockId)) return session.blockId;
	return programs.find((program) => program.starts <= session.date && session.date <= program.ends)?.id ?? null;
}

function calendarStart(program: Program, weekId: string): string | null {
	const calendar = program.raw.calendar;
	if (!isRecord(calendar) || !isRecord(calendar.weeks)) return null;
	const start = calendar.weeks[weekId];
	return typeof start === "string" ? start : null;
}

export function weekRefs(programs: Program[]): WeekRef[] {
	return programs
		.flatMap((program) =>
			weekIds(program).flatMap((weekId) => {
				const start = calendarStart(program, weekId);
				return start === null ? [] : [{ key: `${program.id}/${weekId}`, blockId: program.id, blockName: program.name, weekId, start, end: addDays(start, 6) }];
			}),
		)
		.toSorted((a, b) => a.start.localeCompare(b.start) || a.key.localeCompare(b.key));
}

export function currentWeek(weeks: WeekRef[], today: string): WeekRef | null {
	return weeks.findLast((week) => week.start <= today) ?? weeks[0] ?? null;
}

export function buildWeek(log: TrainingLog, app: AppSession[], ref: WeekRef): ScheduleWeek {
	const program = log.programs.find((candidate) => candidate.id === ref.blockId);
	const mine = app.filter((session) => !session.test && session.blockId === ref.blockId);
	const days = program === undefined ? [] : programDays(program, ref.weekId);
	return {
		...ref,
		days: days.map((day) => {
			const repo = log.repoSessions.find((session) => session.weekId === day.weekId && session.dayId === day.dayId && sessionBlock(session, log.programs) === ref.blockId) ?? null;
			const session = mine.find((candidate) => candidate.weekId === day.weekId && candidate.dayId === day.dayId) ?? null;
			const state: DayState = repo !== null ? "logged" : session?.status === "finished" ? "finished" : session !== null ? "open" : "todo";
			return { ...day, blockId: ref.blockId, state, sessionId: session?.id ?? null, repoFile: repo?.path ?? null, logged: repo?.exercises ?? null };
		}),
	};
}

export function nextDay(log: TrainingLog, app: AppSession[], weeks: WeekRef[], today: string): ScheduleDay | null {
	const current = currentWeek(weeks, today);
	const from = current === null ? 0 : weeks.indexOf(current);
	for (const ref of weeks.slice(Math.max(from, 0))) {
		const day = buildWeek(log, app, ref).days.find((candidate) => candidate.state === "open" || candidate.state === "todo");
		if (day !== undefined) return day;
	}
	return null;
}

export function findDay(log: TrainingLog, blockId: string, weekId: string, dayId: string): { program: Program; day: ProgramDay } | null {
	const program = log.programs.find((candidate) => candidate.id === blockId);
	const day = program === undefined ? undefined : programDays(program, weekId).find((candidate) => candidate.dayId === dayId);
	return program === undefined || day === undefined ? null : { program, day };
}

export function pacificToday(now: Date = new Date()): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
