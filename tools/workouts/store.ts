import type { Database } from "../../worker/db.ts";
import { queueForLiaison } from "../liaison/webhook.ts";
import type { ExerciseRow, SessionRow, SetRow } from "./log.ts";
import type { ProgramDay } from "./program.ts";

export type DeliveryState = { deliveryId: string; attempts: number; deliveredAt: string | null; nextAttemptAt: string | null; lastStatus: number | null; lastError: string | null };

export type SessionSummary = {
	id: string;
	blockId: string;
	weekId: string;
	dayId: string;
	title: string;
	date: string;
	status: "open" | "finished";
	test: boolean;
	finishedAt: string | null;
	delivery: DeliveryState | null;
};

export type SessionDetail = SessionSummary & { notes: string | null; exercises: ExerciseRow[] };

type SummaryRow = {
	id: string;
	block_id: string;
	week_id: string;
	day_id: string;
	day_title: string;
	session_date: string;
	status: "open" | "finished";
	test: boolean;
	notes: string | null;
	finished_at: Date | null;
	delivery_id: string | null;
	attempts: number | null;
	delivered_at: Date | null;
	next_attempt_at: Date | null;
	last_status: number | null;
	last_error: string | null;
};

const SUMMARY = `select s.id, s.block_id, s.week_id, s.day_id, s.day_title, to_char(s.session_date, 'YYYY-MM-DD') as session_date, s.status, s.test, s.notes, s.finished_at,
	d.delivery_id, d.attempts, d.delivered_at, d.next_attempt_at, d.last_status, d.last_error
	from workouts.sessions s left join workouts.deliveries d on d.session_id = s.id`;

function iso(value: Date | null): string | null {
	return value === null ? null : value.toISOString();
}

function summary(row: SummaryRow): SessionSummary {
	return {
		id: row.id,
		blockId: row.block_id,
		weekId: row.week_id,
		dayId: row.day_id,
		title: row.day_title,
		date: row.session_date,
		status: row.status,
		test: row.test,
		finishedAt: iso(row.finished_at),
		delivery:
			row.delivery_id === null
				? null
				: {
						deliveryId: row.delivery_id,
						attempts: row.attempts ?? 0,
						deliveredAt: iso(row.delivered_at),
						nextAttemptAt: iso(row.next_attempt_at),
						lastStatus: row.last_status,
						lastError: row.last_error,
					},
	};
}

export async function listSessions(db: Database, limit = 100): Promise<SessionSummary[]> {
	const { rows } = await db.query<SummaryRow>(`${SUMMARY} order by s.session_date desc, s.created_at desc limit $1`, [limit]);
	return rows.map(summary);
}

export async function getSession(db: Database, id: string): Promise<SessionDetail | null> {
	const { rows } = await db.query<SummaryRow>(`${SUMMARY} where s.id = $1`, [id]);
	const row = rows[0];
	if (row === undefined) return null;
	const exercises = await db.query<Omit<ExerciseRow, "sets">>("select position, exercise_id, name, prescribed, status, notes from workouts.exercises where session_id = $1 order by position", [id]);
	const sets = await db.query<SetRow & { position: number }>(
		"select position, set_index, weight::text as weight, unit, reps, rir, as_written, notes from workouts.sets where session_id = $1 order by position, set_index",
		[id],
	);
	return {
		...summary(row),
		notes: row.notes,
		exercises: exercises.rows.map((exercise) => ({
			...exercise,
			sets: sets.rows.filter((set) => set.position === exercise.position).map(({ position: _position, ...set }) => set),
		})),
	};
}

export function sessionRow(detail: SessionDetail): SessionRow {
	return {
		id: detail.id,
		block_id: detail.blockId,
		week_id: detail.weekId,
		day_id: detail.dayId,
		day_title: detail.title,
		session_date: detail.date,
		notes: detail.notes,
		test: detail.test,
		exercises: detail.exercises,
	};
}

export async function createSession(db: Database, blockId: string, day: ProgramDay, date: string, test: boolean): Promise<string> {
	await db.query("begin");
	try {
		const inserted = await db.query<{ id: string }>(
			`insert into workouts.sessions (block_id, week_id, day_id, day_title, session_date, test) values ($1, $2, $3, $4, $5, $6)
			on conflict (block_id, week_id, day_id) where not test do nothing returning id`,
			[blockId, day.weekId, day.dayId, day.title, date, test],
		);
		const id = inserted.rows[0]?.id;
		if (id === undefined) {
			await db.query("rollback");
			const existing = await db.query<{ id: string }>("select id from workouts.sessions where block_id = $1 and week_id = $2 and day_id = $3 and not test", [blockId, day.weekId, day.dayId]);
			const found = existing.rows[0]?.id;
			if (found === undefined) throw new Error("Session insert conflicted but no session exists");
			return found;
		}
		for (const exercise of day.exercises) {
			await db.query("insert into workouts.exercises (session_id, position, exercise_id, name, prescribed) values ($1, $2, $3, $4, $5)", [id, exercise.position, exercise.id, exercise.name, JSON.stringify(exercise)]);
		}
		await db.query("commit");
		return id;
	} catch (error) {
		await db.query("rollback");
		throw error;
	}
}

export type SetInput = { weight: number | null; unit: "lb" | "kg" | null; reps: number | null; rir: number | null; asWritten: boolean; notes: string | null };

export async function putSet(db: Database, id: string, position: number, index: number, set: SetInput): Promise<void> {
	await db.query(
		`insert into workouts.sets (session_id, position, set_index, weight, unit, reps, rir, as_written, notes) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		on conflict (session_id, position, set_index) do update set weight = excluded.weight, unit = excluded.unit, reps = excluded.reps, rir = excluded.rir, as_written = excluded.as_written, notes = excluded.notes, updated_at = now()`,
		[id, position, index, set.weight, set.unit, set.reps, set.rir, set.asWritten, set.notes],
	);
	await db.query("update workouts.exercises set status = 'completed' where session_id = $1 and position = $2 and status = 'planned'", [id, position]);
	await db.query("update workouts.sessions set updated_at = now() where id = $1", [id]);
}

export async function deleteSet(db: Database, id: string, position: number, index: number): Promise<void> {
	await db.query("delete from workouts.sets where session_id = $1 and position = $2 and set_index = $3", [id, position, index]);
}

export async function updateExercise(db: Database, id: string, position: number, patch: { status?: "planned" | "completed" | "skipped"; notes?: string | null }): Promise<void> {
	if (patch.status !== undefined) await db.query("update workouts.exercises set status = $3 where session_id = $1 and position = $2", [id, position, patch.status]);
	if (patch.notes !== undefined) await db.query("update workouts.exercises set notes = $3 where session_id = $1 and position = $2", [id, position, patch.notes]);
}

export async function updateSessionNotes(db: Database, id: string, notes: string | null): Promise<void> {
	await db.query("update workouts.sessions set notes = $2, updated_at = now() where id = $1", [id, notes]);
}

export async function finishSession(db: Database, id: string, test: boolean, data: { sessionId: string; log: unknown }): Promise<string> {
	const deliveryId = crypto.randomUUID();
	await db.query("begin");
	try {
		const finished = await db.query("update workouts.sessions set status = 'finished', finished_at = now(), updated_at = now() where id = $1 and status = 'open'", [id]);
		if (finished.rowCount === 0) {
			await db.query("rollback");
			const existing = await db.query<{ delivery_id: string }>("select delivery_id from workouts.deliveries where session_id = $1", [id]);
			const found = existing.rows[0]?.delivery_id;
			if (found === undefined) throw new Error("Session is finished but has no delivery");
			return found;
		}
		const payload = { event: "session.finished", deliveryId, sessionId: data.sessionId, ...(test ? { test: true } : {}), log: data.log };
		await db.query("insert into workouts.deliveries (session_id, delivery_id, payload) values ($1, $2, $3)", [id, deliveryId, JSON.stringify(payload)]);
		await queueForLiaison(db, { app: "workouts", event: "session.finished", ref: id, test, data }, deliveryId);
		await db.query("commit");
		return deliveryId;
	} catch (error) {
		await db.query("rollback");
		throw error;
	}
}

export async function requeue(db: Database, id: string): Promise<string | null> {
	const { rows } = await db.query<{ delivery_id: string }>("update workouts.deliveries set next_attempt_at = now() + interval '1 minute', delivered_at = null where session_id = $1 returning delivery_id", [id]);
	await db.query("update liaison.deliveries set next_attempt_at = now() + interval '1 minute', delivered_at = null where app = 'workouts' and ref = $1", [id]);
	return rows[0]?.delivery_id ?? null;
}

export async function deleteOpenSession(db: Database, id: string): Promise<boolean> {
	const result = await db.query("delete from workouts.sessions where id = $1 and (status = 'open' or test)", [id]);
	if ((result.rowCount ?? 0) === 0) return false;
	await db.query("delete from liaison.deliveries where app = 'workouts' and ref = $1", [id]);
	return true;
}
