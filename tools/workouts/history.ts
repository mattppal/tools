import type { Database } from "../../worker/db.ts";
import { addDays, parseProgram } from "./program.ts";
import { monday, type WeekRef } from "./schedule.ts";
import type { MirroredFile } from "./sync.ts";

export const EXERCISE_ALIASES: Record<string, string> = {
	"back-extension": "back-ext",
	"rear-delt-fly": "rear-delt",
	"db-incline-press": "db-incline",
};

export const RUN_KEYS = new Set(["easy-jog", "outdoor-run"]);

type Json = Record<string, unknown>;

export type BlockRow = { block_id: string; name: string; goal: string | null; starts: string; ends: string | null; deload_start: string | null; source_path: string };
export type SessionRow = {
	path: string;
	session_key: string | null;
	session_date: string;
	block_id: string | null;
	week_id: string | null;
	day_id: string | null;
	kind: string;
	modality: string | null;
	status: string | null;
	name: string;
	duration_seconds: number | null;
	recovery: boolean;
};
export type ExerciseRow = { path: string; position: number; exercise_key: string; name: string; status: string | null; category: string | null; equipment: string | null; prescribed: Json | null };
export type SetRow = {
	path: string;
	position: number;
	set_index: number;
	type: string | null;
	weight: number | null;
	unit: string | null;
	reps: number | null;
	rir: number | null;
	rpe: number | null;
	distance: number | null;
	distance_unit: string | null;
	duration_seconds: number | null;
	notes: string | null;
};
export type PrRow = { exercise_key: string; reps: number; record_date: string; weight: number; unit: string; type: string | null; workout_key: string | null; notes: string | null };
export type HistoryRows = { blocks: BlockRow[]; sessions: SessionRow[]; exercises: ExerciseRow[]; sets: SetRow[]; prs: PrRow[] };

function isRecord(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function num(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function validDate(date: string): boolean {
	const parsed = new Date(`${date}T00:00:00Z`);
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function day(value: unknown): string | null {
	const text = str(value);
	const date = text !== null && /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
	return date !== null && validDate(date) ? date : null;
}

export function exerciseKey(id: string | null, name: string): string {
	const key = id ?? name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
	return EXERCISE_ALIASES[key] ?? key;
}

function blockRows(programs: MirroredFile[]): BlockRow[] {
	const parsed = programs
		.map((file) => ({ file, program: parseProgram(file.content) }))
		.filter((entry) => entry.program !== null)
		.toSorted((a, b) => (a.program?.starts ?? "").localeCompare(b.program?.starts ?? ""));
	return parsed.map(({ file, program }, index) => {
		const raw = isRecord(file.content) ? file.content : {};
		const calendar = isRecord(raw.calendar) ? raw.calendar : {};
		const next = parsed[index + 1]?.program;
		return {
			block_id: program?.id ?? file.path,
			name: program?.name ?? file.path,
			goal: str(raw.goal),
			starts: program?.starts ?? "",
			ends: program?.ends ?? (next === undefined || next === null ? null : addDays(next.starts, -1)),
			deload_start: day(calendar.deloadWeek),
			source_path: file.path,
		};
	});
}

function blockFor(date: string, blockId: string | null, blocks: BlockRow[]): BlockRow | undefined {
	if (blockId !== null) return blocks.find((block) => block.block_id === blockId);
	return blocks.findLast((block) => block.starts <= date && (block.ends === null || date <= block.ends));
}

function setRow(path: string, position: number, index: number, set: Json): SetRow {
	return {
		path,
		position,
		set_index: index,
		type: str(set.type),
		weight: num(set.weight),
		unit: str(set.unit),
		reps: num(set.reps),
		rir: num(set.rir),
		rpe: num(set.rpe),
		distance: num(set.distance),
		distance_unit: str(set.distanceUnit),
		duration_seconds: num(set.durationSeconds),
		notes: str(set.notes),
	};
}

export function historyRows(programs: MirroredFile[], sessions: MirroredFile[], profile: unknown): HistoryRows {
	const blocks = blockRows(programs);
	const rows: HistoryRows = { blocks, sessions: [], exercises: [], sets: [], prs: [] };
	for (const file of sessions) {
		if (!isRecord(file.content)) continue;
		const content = file.content;
		const date = day(content.date) ?? day(/(\d{4}-\d{2}-\d{2})/.exec(file.path)?.[1]);
		if (date === null) continue;
		const blockId = str(content.blockId) ?? blockFor(date, null, blocks)?.block_id ?? null;
		const block = blockFor(date, blockId, blocks);
		const weekId = str(content.weekId);
		const dayId = str(content.dayId);
		const deloadWeek = block?.deload_start != null && block.deload_start <= date && date <= addDays(block.deload_start, 6);
		rows.sessions.push({
			path: file.path,
			session_key: str(content.id),
			session_date: date,
			block_id: blockId,
			week_id: weekId,
			day_id: dayId,
			kind: str(content.kind) ?? "lift",
			modality: str(content.modality),
			status: str(content.status),
			name: str(content.name) ?? file.path.replace(/^sessions\//, ""),
			duration_seconds: num(content.durationSeconds),
			recovery: weekId === "deload" || dayId === "recovery" || deloadWeek,
		});
		const exercises = Array.isArray(content.exercises) ? content.exercises.filter(isRecord) : [];
		exercises.forEach((exercise, position) => {
			const info = isRecord(exercise.exercise) ? exercise.exercise : {};
			const name = str(info.name) ?? str(exercise.id) ?? `Exercise ${position + 1}`;
			rows.exercises.push({
				path: file.path,
				position,
				exercise_key: exerciseKey(str(exercise.id), name),
				name,
				status: str(exercise.status),
				category: str(info.category),
				equipment: str(info.equipment),
				prescribed: isRecord(exercise.prescribed) ? exercise.prescribed : null,
			});
			const sets = Array.isArray(exercise.sets) ? exercise.sets.filter(isRecord) : [];
			sets.forEach((set, index) => rows.sets.push(setRow(file.path, position, index, set)));
		});
	}
	const records = isRecord(profile) && Array.isArray(profile.records) ? profile.records.filter(isRecord) : [];
	const seen = new Set<string>();
	for (const record of records) {
		const info = isRecord(record.exercise) ? record.exercise : {};
		const key = exerciseKey(str(record.id), str(info.name) ?? "lift");
		for (const max of Array.isArray(record.repMaxes) ? record.repMaxes.filter(isRecord) : []) {
			const reps = num(max.reps);
			const weight = num(max.weight);
			const date = day(max.date);
			if (reps === null || weight === null || date === null) continue;
			const id = `${key}/${reps}/${date}`;
			if (seen.has(id)) continue;
			seen.add(id);
			rows.prs.push({ exercise_key: key, reps, record_date: date, weight, unit: str(max.unit) ?? "lb", type: str(max.type), workout_key: str(max.workoutId), notes: str(max.notes) });
		}
	}
	return rows;
}

async function insertRows(db: Database, table: string, columns: Record<string, string>, rows: object[]): Promise<void> {
	if (rows.length === 0) return;
	const names = Object.keys(columns);
	const spec = names.map((name) => `${name} ${columns[name]}`).join(", ");
	await db.query(`insert into workouts.${table} (${names.join(", ")}) select ${names.join(", ")} from jsonb_to_recordset($1::jsonb) as r(${spec})`, [JSON.stringify(rows)]);
}

export async function rebuildHistory(db: Database): Promise<HistoryRows> {
	const { rows } = await db.query<{ path: string; kind: string; content: unknown }>("select path, kind, content from workouts.repo_files where content is not null order by path");
	const history = historyRows(
		rows.filter((row) => row.kind === "program"),
		rows.filter((row) => row.kind === "session"),
		rows.find((row) => row.kind === "profile")?.content ?? null,
	);
	for (const table of ["history_sets", "history_exercises", "history_sessions", "history_blocks", "history_prs"]) await db.query(`delete from workouts.${table}`);
	await insertRows(db, "history_blocks", { block_id: "text", name: "text", goal: "text", starts: "date", ends: "date", deload_start: "date", source_path: "text" }, history.blocks);
	await insertRows(
		db,
		"history_sessions",
		{ path: "text", session_key: "text", session_date: "date", block_id: "text", week_id: "text", day_id: "text", kind: "text", modality: "text", status: "text", name: "text", duration_seconds: "numeric", recovery: "boolean" },
		history.sessions,
	);
	await insertRows(db, "history_exercises", { path: "text", position: "integer", exercise_key: "text", name: "text", status: "text", category: "text", equipment: "text", prescribed: "jsonb" }, history.exercises);
	await insertRows(
		db,
		"history_sets",
		{ path: "text", position: "integer", set_index: "integer", type: "text", weight: "numeric", unit: "text", reps: "numeric", rir: "numeric", rpe: "numeric", distance: "numeric", distance_unit: "text", duration_seconds: "numeric", notes: "text" },
		history.sets,
	);
	await insertRows(db, "history_prs", { exercise_key: "text", reps: "integer", record_date: "date", weight: "numeric", unit: "text", type: "text", workout_key: "text", notes: "text" }, history.prs);
	return history;
}

export type TimelineWeek = WeekRef & { done: number; skipped: number; lift: number; conditioning: number; recovery: boolean; deload: boolean };
export type TimelineBlock = { blockId: string; name: string; goal: string | null; starts: string; ends: string; sessions: number; weeks: TimelineWeek[] };
export type TimelineMark = { key: string; blockName: string; weekId: string; start: string; end: string; weeks: number; logged: boolean };
export type HistoryTimeline = { today: string; currentWeek: string | null; blocks: TimelineBlock[]; lastRecovery: TimelineMark | null; nextDeload: TimelineMark | null };
export type TimelineSession = { block_id: string | null; session_date: string; kind: string; status: string | null; recovery: boolean };

const WEEK_MS = 7 * 86_400_000;

function weeksBetween(from: string, to: string): number {
	return Math.round(Math.abs(Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / WEEK_MS);
}

function mark(week: TimelineWeek, today: string): TimelineMark {
	return { key: week.key, blockName: week.blockName, weekId: week.weekId, start: week.start, end: week.end, weeks: weeksBetween(week.start, monday(today)), logged: week.recovery };
}

export function timeline(blocks: BlockRow[], sessions: TimelineSession[], weeks: WeekRef[], today: string): HistoryTimeline {
	const rows = blocks.map((block) => {
		const own = weeks.filter((week) => week.blockId === block.block_id);
		const timelineWeeks = own.map((week): TimelineWeek => {
			const inWeek = sessions.filter((session) => session.block_id === block.block_id && week.start <= session.session_date && session.session_date <= week.end);
			const done = inWeek.filter((session) => session.status !== "skipped" && session.kind !== "rest");
			return {
				...week,
				done: done.length,
				skipped: inWeek.length - done.length,
				lift: done.filter((session) => session.kind === "lift").length,
				conditioning: done.filter((session) => session.kind === "conditioning").length,
				recovery: inWeek.some((session) => session.recovery),
				deload: /\bdeload\b/i.test(week.weekId) || (block.deload_start !== null && week.start <= block.deload_start && block.deload_start <= week.end),
			};
		});
		return {
			blockId: block.block_id,
			name: block.name,
			goal: block.goal,
			starts: block.starts,
			ends: block.ends ?? own.at(-1)?.end ?? block.starts,
			sessions: sessions.filter((session) => session.block_id === block.block_id).length,
			weeks: timelineWeeks,
		};
	});
	const all = rows.flatMap((block) => block.weeks);
	const last = all.findLast((week) => (week.recovery || week.deload) && week.start <= today);
	const next = all.find((week) => week.deload && week.start > today);
	return {
		today,
		currentWeek: weeks.findLast((week) => week.start <= today)?.key ?? null,
		blocks: rows,
		lastRecovery: last === undefined ? null : mark(last, today),
		nextDeload: next === undefined ? null : mark(next, today),
	};
}

export async function historyTimeline(db: Database, weeks: WeekRef[], today: string): Promise<HistoryTimeline> {
	const blocks = await db.query<BlockRow>(
		"select block_id, name, goal, to_char(starts, 'YYYY-MM-DD') starts, to_char(ends, 'YYYY-MM-DD') ends, to_char(deload_start, 'YYYY-MM-DD') deload_start, source_path from workouts.history_blocks order by starts",
	);
	const sessions = await db.query<TimelineSession>("select block_id, to_char(session_date, 'YYYY-MM-DD') session_date, kind, status, recovery from workouts.history_sessions order by session_date");
	return timeline(blocks.rows, sessions.rows, weeks, today);
}

export type HistorySummary = {
	sessions: number;
	byKind: Record<string, number>;
	byBlock: { blockId: string | null; name: string | null; sessions: number }[];
	recoverySessions: number;
	exercises: { key: string; name: string; sessions: number; lastDate: string }[];
	prs: number;
};

export async function historySummary(db: Database): Promise<HistorySummary> {
	const kinds = await db.query<{ kind: string; n: number }>("select kind, count(*)::int n from workouts.history_sessions group by kind order by kind");
	const blocks = await db.query<{ block_id: string | null; name: string | null; n: number }>(
		"select s.block_id, b.name, count(*)::int n from workouts.history_sessions s left join workouts.history_blocks b using (block_id) group by s.block_id, b.name, b.starts order by b.starts nulls last",
	);
	const recovery = await db.query<{ n: number }>("select count(*)::int n from workouts.history_sessions where recovery");
	const exercises = await db.query<{ key: string; name: string; sessions: number; last_date: string }>(
		`select e.exercise_key key, (array_agg(e.name order by s.session_date desc))[1] name, count(distinct e.path)::int sessions, to_char(max(s.session_date), 'YYYY-MM-DD') last_date
		from workouts.history_exercises e join workouts.history_sessions s using (path) group by e.exercise_key order by max(s.session_date) desc, e.exercise_key`,
	);
	const prs = await db.query<{ n: number }>("select count(*)::int n from workouts.history_prs");
	return {
		sessions: kinds.rows.reduce((total, row) => total + row.n, 0),
		byKind: Object.fromEntries(kinds.rows.map((row) => [row.kind, row.n])),
		byBlock: blocks.rows.map((row) => ({ blockId: row.block_id, name: row.name, sessions: row.n })),
		recoverySessions: recovery.rows[0]?.n ?? 0,
		exercises: exercises.rows.map((row) => ({ key: row.key, name: row.name, sessions: row.sessions, lastDate: row.last_date })),
		prs: prs.rows[0]?.n ?? 0,
	};
}
