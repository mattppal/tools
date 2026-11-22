import type { RepoSession } from "./github.ts";
import { programDays, weekIds, weekOf, type Program, type ProgramDay } from "./program.ts";

export type DayState = "logged" | "finished" | "open" | "todo";

export type ScheduleDay = ProgramDay & { state: DayState; sessionId: string | null; repoFile: string | null };

export type ScheduleWeek = { weekId: string; days: ScheduleDay[] };

export type AppSession = { id: string; blockId: string; weekId: string; dayId: string; status: "open" | "finished"; test: boolean };

export type Schedule = {
	today: string;
	block: { id: string; name: string; starts: string; ends: string };
	currentWeek: string | null;
	weeks: ScheduleWeek[];
	next: ScheduleDay | null;
};

export function buildSchedule(program: Program, repo: RepoSession[], app: AppSession[], today: string): Schedule {
	const ids = weekIds(program);
	const current = weekOf(program, today) ?? ids[0] ?? null;
	const from = current === null ? 0 : ids.indexOf(current);
	const mine = app.filter((session) => !session.test && session.blockId === program.id);
	const day = (programDay: ProgramDay): ScheduleDay => {
		const repoFile = repo.find((session) => session.weekId === programDay.weekId && session.dayId === programDay.dayId)?.file ?? null;
		const session = mine.find((candidate) => candidate.weekId === programDay.weekId && candidate.dayId === programDay.dayId) ?? null;
		const state: DayState = repoFile !== null ? "logged" : session?.status === "finished" ? "finished" : session !== null ? "open" : "todo";
		return { ...programDay, state, sessionId: session?.id ?? null, repoFile };
	};
	const all = ids.slice(Math.max(from, 0)).map((weekId) => ({ weekId, days: programDays(program, weekId).map(day) }));
	const pending = all.flatMap((week) => week.days).find((candidate) => candidate.state === "open" || candidate.state === "todo");
	return {
		today,
		block: { id: program.id, name: program.name, starts: program.starts, ends: program.ends },
		currentWeek: current,
		weeks: all.slice(0, 2),
		next: pending ?? null,
	};
}

export function findDay(program: Program, weekId: string, dayId: string): ProgramDay | null {
	return programDays(program, weekId).find((candidate) => candidate.dayId === dayId) ?? null;
}

export function pacificToday(now: Date = new Date()): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
