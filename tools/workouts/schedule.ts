import { addDays, parseProgram, programDays, weekIds, type Program, type ProgramDay } from "./program.ts";
import type { MirroredFile } from "./sync.ts";

export type DayState = "logged" | "finished" | "open" | "todo";

export type LoggedExercise = { name: string; summary: string };

export type ScheduleDay = ProgramDay & {
	blockId: string;
	modality: string | null;
	planned: boolean;
	state: DayState;
	repoStatus: string | null;
	sessionId: string | null;
	repoFile: string | null;
	logged: LoggedExercise[] | null;
};

export type WeekRef = { key: string; blockId: string; blockName: string; weekId: string; start: string; end: string };

export type ScheduleWeek = WeekRef & { days: ScheduleDay[] };

export type AppSession = { id: string; blockId: string; weekId: string; dayId: string; status: "open" | "finished"; test: boolean };

export type RepoSession = {
	path: string;
	blockId: string | null;
	weekId: string | null;
	dayId: string | null;
	date: string;
	title: string;
	kind: string;
	modality: string | null;
	status: string | null;
	exercises: LoggedExercise[];
};

export type TrainingLog = { programs: Program[]; repoSessions: RepoSession[] };

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value : null;
}

const SESSION_DATE = /(\d{4}-\d{2}-\d{2})/;

function clock(seconds: number): string {
	const total = Math.round(seconds);
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const secs = String(total % 60).padStart(2, "0");
	return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}` : `${minutes}:${secs}`;
}

function setSummary(set: unknown): string | null {
	if (!isRecord(set)) return null;
	if (set.notes === "skipped" && set.reps === 0) return null;
	const head = [set.weight, set.reps].filter((part) => typeof part === "number").join(" × ");
	const rir = typeof set.rir === "number" ? `@${set.rir}` : null;
	const distance = typeof set.distance === "number" ? `${set.distance} ${str(set.distanceUnit) ?? ""}`.trim() : null;
	const duration = typeof set.durationSeconds === "number" ? clock(set.durationSeconds) : null;
	const text = [head === "" ? null : head, rir, distance, duration].filter((part) => part !== null).join(" ");
	return text === "" ? null : text;
}

function loggedExercises(content: Json): LoggedExercise[] {
	const exercises = Array.isArray(content.exercises) ? content.exercises.filter(isRecord) : [];
	return exercises.map((exercise) => {
		const name = isRecord(exercise.exercise) && typeof exercise.exercise.name === "string" ? exercise.exercise.name : typeof exercise.id === "string" ? exercise.id : "Exercise";
		const sets = (Array.isArray(exercise.sets) ? exercise.sets : []).map(setSummary).filter((set) => set !== null);
		return { name, summary: exercise.status === "skipped" ? "Skipped" : sets.length === 0 ? (exercise.status === "completed" ? "Done" : "Not recorded") : sets.join(", ") };
	});
}

export function parseRepoSession(file: MirroredFile): RepoSession | null {
	if (!isRecord(file.content)) return null;
	const content = file.content;
	const date = str(content.date)?.slice(0, 10) ?? SESSION_DATE.exec(file.path)?.[1] ?? null;
	if (date === null) return null;
	const dayId = str(content.dayId);
	return {
		path: file.path,
		blockId: str(content.blockId),
		weekId: str(content.weekId),
		dayId,
		date,
		title: str(content.name) ?? dayId ?? file.path.replace(/^sessions\/|\.(json|md)$/g, ""),
		kind: str(content.kind) ?? "lift",
		modality: str(content.modality),
		status: str(content.status),
		exercises: loggedExercises(content),
	};
}

export function trainingLogFrom(programs: MirroredFile[], sessions: MirroredFile[]): TrainingLog {
	return {
		programs: programs.map((file) => parseProgram(file.content)).filter((program) => program !== null),
		repoSessions: sessions.map(parseRepoSession).filter((session) => session !== null).toSorted((a, b) => a.date.localeCompare(b.date) || a.path.localeCompare(b.path)),
	};
}

function sessionBlock(session: RepoSession, programs: Program[]): string | null {
	if (session.blockId !== null) return session.blockId;
	return programs.filter((program) => program.starts <= session.date && (program.ends === null || session.date <= program.ends)).toSorted((a, b) => a.starts.localeCompare(b.starts)).at(-1)?.id ?? null;
}

function calendarStart(program: Program, weekId: string): string | null {
	const calendar = program.raw.calendar;
	if (!isRecord(calendar) || !isRecord(calendar.weeks)) return null;
	const start = calendar.weeks[weekId];
	return typeof start === "string" ? start : null;
}

export function monday(date: string): string {
	const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
	return addDays(date, -((weekday + 6) % 7));
}

function plannedWeeks(programs: Program[]): WeekRef[] {
	return programs.flatMap((program) =>
		weekIds(program).flatMap((weekId) => {
			const start = calendarStart(program, weekId);
			return start === null ? [] : [{ key: `${program.id}/${weekId}`, blockId: program.id, blockName: program.name, weekId, start, end: addDays(start, 6) }];
		}),
	);
}

function weekFor(session: RepoSession, blockId: string, planned: WeekRef[]): WeekRef | undefined {
	return planned.find((week) => week.blockId === blockId && session.weekId !== null && week.weekId === session.weekId) ?? planned.find((week) => week.blockId === blockId && week.start <= session.date && session.date <= week.end);
}

export function weekRefs(log: TrainingLog): WeekRef[] {
	const planned = plannedWeeks(log.programs);
	const derived = new Map<string, WeekRef & { weekIds: string[] }>();
	for (const session of log.repoSessions) {
		const blockId = sessionBlock(session, log.programs);
		if (blockId === null || weekFor(session, blockId, planned) !== undefined) continue;
		const start = monday(session.date);
		const key = `${blockId}/${start}`;
		const existing = derived.get(key);
		if (existing !== undefined) {
			if (session.weekId !== null && !existing.weekIds.includes(session.weekId)) existing.weekIds.push(session.weekId);
			continue;
		}
		const name = log.programs.find((program) => program.id === blockId)?.name ?? blockId;
		derived.set(key, { key, blockId, blockName: name, weekId: "", start, end: addDays(start, 6), weekIds: session.weekId === null ? [] : [session.weekId] });
	}
	const extra = [...derived.values()].map(({ weekIds: ids, ...week }) => ({ ...week, weekId: ids.length === 0 ? "unlabeled" : ids.join(" · ") }));
	return [...planned, ...extra].toSorted((a, b) => a.start.localeCompare(b.start) || a.key.localeCompare(b.key));
}

export function currentWeek(weeks: WeekRef[], today: string): WeekRef | null {
	return weeks.findLast((week) => week.start <= today) ?? weeks[0] ?? null;
}

function repoDay(session: RepoSession, ref: WeekRef): ScheduleDay {
	return {
		weekId: session.weekId ?? ref.weekId,
		dayId: session.dayId ?? session.path,
		kind: session.kind,
		title: session.title,
		date: session.date,
		plan: [],
		exercises: [],
		blockId: ref.blockId,
		modality: session.modality,
		planned: false,
		state: "logged",
		repoStatus: session.status,
		sessionId: null,
		repoFile: session.path,
		logged: session.exercises,
	};
}

export function buildWeek(log: TrainingLog, app: AppSession[], ref: WeekRef): ScheduleWeek {
	const program = log.programs.find((candidate) => candidate.id === ref.blockId);
	const mine = app.filter((session) => !session.test && session.blockId === ref.blockId);
	const planned = program === undefined ? [] : programDays(program, ref.weekId);
	const calendar = plannedWeeks(log.programs);
	const inWeek = log.repoSessions.filter((session) => {
		const blockId = sessionBlock(session, log.programs);
		if (blockId !== ref.blockId) return false;
		const week = weekFor(session, blockId, calendar);
		return week === undefined ? ref.start <= session.date && session.date <= ref.end : week.key === ref.key;
	});
	const used = new Set<string>();
	const days: ScheduleDay[] = planned.map((day) => {
		const repo = inWeek.find((session) => !used.has(session.path) && session.blockId === ref.blockId && session.weekId === day.weekId && session.dayId === day.dayId) ?? null;
		if (repo !== null) used.add(repo.path);
		const session = mine.find((candidate) => candidate.weekId === day.weekId && candidate.dayId === day.dayId) ?? null;
		const state: DayState = repo !== null ? "logged" : session?.status === "finished" ? "finished" : session !== null ? "open" : "todo";
		return { ...day, date: repo?.date ?? day.date, blockId: ref.blockId, modality: repo?.modality ?? null, planned: true, state, repoStatus: repo?.status ?? null, sessionId: session?.id ?? null, repoFile: repo?.path ?? null, logged: repo?.exercises ?? null };
	});
	for (const session of inWeek) if (!used.has(session.path)) days.push(repoDay(session, ref));
	return { ...ref, days: days.toSorted((a, b) => a.date.localeCompare(b.date)) };
}

export function nextDay(log: TrainingLog, app: AppSession[], weeks: WeekRef[], today: string): ScheduleDay | null {
	const current = currentWeek(weeks, today);
	const from = current === null ? 0 : weeks.indexOf(current);
	for (const ref of weeks.slice(Math.max(from, 0))) {
		const day = buildWeek(log, app, ref).days.find((candidate) => candidate.planned && (candidate.state === "open" || candidate.state === "todo") && (candidate.kind === "lift" || candidate.date >= today));
		if (day !== undefined) return day;
	}
	return null;
}

export function findDay(log: TrainingLog, blockId: string, weekId: string, dayId: string): { program: Program; day: ProgramDay } | null {
	const program = log.programs.find((candidate) => candidate.id === blockId);
	const day = program === undefined ? undefined : programDays(program, weekId).find((candidate) => candidate.dayId === dayId && candidate.kind === "lift");
	return program === undefined || day === undefined ? null : { program, day };
}

export function pacificToday(now: Date = new Date()): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
