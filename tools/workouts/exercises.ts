import type { Database } from "../../worker/db.ts";
import { RUN_KEYS } from "./history.ts";

export type ExerciseListEntry = { key: string; name: string; sessions: number; lastDate: string };
export type ExerciseList = { exercises: ExerciseListEntry[]; runs: { sessions: number; lastDate: string | null } };

export type HistorySet = { type: string | null; weight: number | null; unit: string | null; reps: number | null; rir: number | null; distance: number | null; distanceUnit: string | null; durationSeconds: number | null; notes: string | null };
export type TopSet = { weight: number; unit: string; reps: number | null };
export type ExerciseSession = {
	path: string;
	date: string;
	name: string;
	blockName: string | null;
	weekId: string | null;
	status: string | null;
	prescribed: string | null;
	sets: HistorySet[];
	top: TopSet | null;
	volume: number | null;
	topReps: number | null;
};
export type ExercisePr = { reps: number; weight: number; unit: string; date: string };
export type ExerciseHistory = { key: string; name: string; unit: string | null; sessions: ExerciseSession[]; prs: ExercisePr[] };

export type RunSession = {
	path: string;
	date: string;
	name: string;
	modality: string | null;
	status: string | null;
	distance: number | null;
	distanceUnit: string | null;
	miles: number | null;
	durationSeconds: number | null;
	paceSecondsPerMile: number | null;
	notes: string | null;
};
export type RunHistory = { sessions: RunSession[] };

const MILE = 1609.344;
const METERS: Record<string, number> = { m: 1, km: 1000, mi: MILE, yd: 0.9144 };
const RUNS = [...RUN_KEYS];

function num(value: string | number | null): number | null {
	return value === null ? null : Number(value);
}

function working(set: HistorySet): boolean {
	return set.type === null || set.type === "working";
}

function rangeText(min: unknown, max: unknown): string | null {
	if (typeof min === "number" && typeof max === "number") return min === max ? `${min}` : `${min}–${max}`;
	return typeof min === "number" ? `${min}+` : typeof max === "number" ? `≤${max}` : null;
}

export function prescribedText(prescribed: Record<string, unknown> | null): string | null {
	if (prescribed === null) return null;
	const reps = typeof prescribed.targetReps === "number" ? `${prescribed.targetReps}` : rangeText(prescribed.targetRepsMin, prescribed.targetRepsMax);
	const sets = typeof prescribed.targetSets === "number" ? `${prescribed.targetSets}` : null;
	const volume = sets !== null && reps !== null ? `${sets} × ${reps}` : (sets ?? reps);
	const rir = typeof prescribed.targetRIR === "number" ? `@${prescribed.targetRIR}` : null;
	const load = typeof prescribed.targetWeight === "number" ? `${prescribed.targetWeight} ${typeof prescribed.unit === "string" ? prescribed.unit : ""}`.trim() : typeof prescribed.load === "string" ? prescribed.load : null;
	const text = [[volume, rir].filter(Boolean).join(" "), load].filter((part) => part !== null && part !== "").join(" · ");
	return text === "" ? null : text;
}

function mainUnit(sets: HistorySet[]): string | null {
	const counts = new Map<string, number>();
	for (const set of sets) if (set.weight !== null && set.unit !== null) counts.set(set.unit, (counts.get(set.unit) ?? 0) + 1);
	return [...counts].toSorted((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

export function sessionStats(sets: HistorySet[], unit: string | null): Pick<ExerciseSession, "top" | "volume" | "topReps"> {
	const loaded = sets.filter((set) => working(set) && set.weight !== null && set.unit === unit && set.reps !== 0);
	const best = loaded.reduce<number | null>((max, set) => (set.weight !== null && (max === null || set.weight > max) ? set.weight : max), null);
	if (best === null || unit === null) return { top: null, volume: null, topReps: null };
	const atBest = loaded.filter((set) => set.weight === best && set.reps !== null).map((set) => set.reps ?? 0);
	const topReps = atBest.length === 0 ? null : Math.max(...atBest);
	const counted = loaded.filter((set) => set.reps !== null);
	return { top: { weight: best, unit, reps: topReps }, volume: counted.length === 0 ? null : counted.reduce((sum, set) => sum + (set.weight ?? 0) * (set.reps ?? 0), 0), topReps };
}

export async function exerciseList(db: Database): Promise<ExerciseList> {
	const exercises = await db.query<{ key: string; name: string; sessions: number; last_date: string }>(
		`select e.exercise_key key, (array_agg(e.name order by s.session_date desc))[1] name, count(distinct e.path)::int sessions, to_char(max(s.session_date), 'YYYY-MM-DD') last_date
		from workouts.history_exercises e join workouts.history_sessions s using (path)
		where s.kind = 'lift' and not (e.exercise_key = any($1))
		group by e.exercise_key order by count(distinct e.path) desc, max(s.session_date) desc, e.exercise_key`,
		[RUNS],
	);
	const runs = await db.query<{ sessions: number; last_date: string | null }>(
		"select count(distinct e.path)::int sessions, to_char(max(s.session_date), 'YYYY-MM-DD') last_date from workouts.history_exercises e join workouts.history_sessions s using (path) where e.exercise_key = any($1)",
		[RUNS],
	);
	return {
		exercises: exercises.rows.map((row) => ({ key: row.key, name: row.name, sessions: row.sessions, lastDate: row.last_date })),
		runs: { sessions: runs.rows[0]?.sessions ?? 0, lastDate: runs.rows[0]?.last_date ?? null },
	};
}

type SetQueryRow = {
	path: string;
	date: string;
	session_name: string;
	block_name: string | null;
	week_id: string | null;
	modality: string | null;
	exercise_name: string;
	exercise_status: string | null;
	position: number;
	prescribed: Record<string, unknown> | null;
	type: string | null;
	weight: string | null;
	unit: string | null;
	reps: string | null;
	rir: string | null;
	distance: string | null;
	distance_unit: string | null;
	duration_seconds: string | null;
	notes: string | null;
};

async function setRows(db: Database, keys: string[]): Promise<SetQueryRow[]> {
	const { rows } = await db.query<SetQueryRow>(
		`select s.path, to_char(s.session_date, 'YYYY-MM-DD') date, s.name session_name, b.name block_name, s.week_id, s.modality, e.name exercise_name, e.status exercise_status, e.position, e.prescribed,
			t.type, t.weight::text, t.unit, t.reps::text, t.rir::text, t.distance::text, t.distance_unit, t.duration_seconds::text, t.notes
		from workouts.history_exercises e
		join workouts.history_sessions s using (path)
		left join workouts.history_blocks b using (block_id)
		left join workouts.history_sets t on t.path = e.path and t.position = e.position
		where e.exercise_key = any($1)
		order by s.session_date desc, s.path, e.position, t.set_index`,
		[keys],
	);
	return rows;
}

function toSet(row: SetQueryRow): HistorySet | null {
	if (row.type === null && row.weight === null && row.reps === null && row.distance === null && row.duration_seconds === null && row.notes === null) return null;
	return { type: row.type, weight: num(row.weight), unit: row.unit, reps: num(row.reps), rir: num(row.rir), distance: num(row.distance), distanceUnit: row.distance_unit, durationSeconds: num(row.duration_seconds), notes: row.notes };
}

function bySession(rows: SetQueryRow[]): { first: SetQueryRow; sets: HistorySet[]; skipped: boolean; prescribed: Record<string, unknown> | null }[] {
	const groups = new Map<string, { first: SetQueryRow; sets: HistorySet[]; skipped: boolean; prescribed: Record<string, unknown> | null }>();
	for (const row of rows) {
		const group = groups.get(row.path) ?? { first: row, sets: [], skipped: true, prescribed: row.prescribed };
		groups.set(row.path, group);
		if (row.exercise_status !== "skipped") group.skipped = false;
		const set = toSet(row);
		if (set !== null) group.sets.push(set);
	}
	return [...groups.values()];
}

export async function exerciseHistory(db: Database, key: string): Promise<ExerciseHistory | null> {
	const rows = await setRows(db, [key]);
	if (rows.length === 0) return null;
	const groups = bySession(rows);
	const unit = mainUnit(groups.flatMap((group) => group.sets));
	const prs = await db.query<{ reps: number; weight: string; unit: string; record_date: string }>(
		"select reps, weight::text, unit, to_char(record_date, 'YYYY-MM-DD') record_date from workouts.history_prs where exercise_key = $1 order by reps, record_date",
		[key],
	);
	return {
		key,
		name: rows[0]?.exercise_name ?? key,
		unit,
		sessions: groups.map(({ first, sets, skipped, prescribed }) => ({
			path: first.path,
			date: first.date,
			name: first.session_name,
			blockName: first.block_name,
			weekId: first.week_id,
			status: skipped ? "skipped" : first.exercise_status,
			prescribed: prescribedText(prescribed),
			sets,
			...(skipped ? { top: null, volume: null, topReps: null } : sessionStats(sets, unit)),
		})),
		prs: prs.rows.map((row) => ({ reps: row.reps, weight: Number(row.weight), unit: row.unit, date: row.record_date })),
	};
}

function meters(set: HistorySet): number | null {
	if (set.distance === null) return null;
	const factor = METERS[set.distanceUnit ?? ""];
	return factor === undefined ? null : set.distance * factor;
}

export function runSet(sets: HistorySet[]): HistorySet | null {
	const measured = sets.filter((set) => set.distance !== null || set.durationSeconds !== null);
	const longest = measured.filter((set) => meters(set) !== null).toSorted((a, b) => (meters(b) ?? 0) - (meters(a) ?? 0))[0];
	return longest ?? measured.toSorted((a, b) => (b.durationSeconds ?? 0) - (a.durationSeconds ?? 0))[0] ?? null;
}

export async function runHistory(db: Database): Promise<RunHistory> {
	const groups = bySession(await setRows(db, RUNS));
	return {
		sessions: groups.map(({ first, sets, skipped }) => {
			const set = skipped || first.exercise_status === "skipped" ? null : runSet(sets);
			const distance = set === null ? null : meters(set);
			const miles = distance === null ? null : distance / MILE;
			const duration = set?.durationSeconds ?? null;
			return {
				path: first.path,
				date: first.date,
				name: first.session_name,
				modality: first.modality,
				status: skipped ? "skipped" : first.exercise_status,
				distance: set?.distance ?? null,
				distanceUnit: set?.distanceUnit ?? null,
				miles,
				durationSeconds: duration,
				paceSecondsPerMile: miles === null || duration === null || miles === 0 ? null : duration / miles,
				notes: set?.notes ?? null,
			};
		}),
	};
}
