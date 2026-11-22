import { z } from "zod";
import type { Database } from "../../worker/db.ts";

type Item = Record<string, unknown>;

export const SLEEP_STAGES = { "In Bed": "in_bed", Asleep: "asleep", Awake: "awake", Core: "core", Deep: "deep", REM: "rem", Unspecified: "unspecified" } as const;
export type SleepStage = (typeof SLEEP_STAGES)[keyof typeof SLEEP_STAGES];

const UNKNOWN_SOURCE = "Apple Health";
const WITHINGS_SOURCE = /withings|health ?mate/i;
const CHUNK = 1000;
const DATE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)? ?([+-])(\d{2}):?(\d{2})$/;
const METRES: Record<string, number> = { m: 1, km: 1000, mi: 1609.344, yd: 0.9144, ft: 0.3048 };
const KCAL: Record<string, number> = { kcal: 1, Cal: 1, kJ: 0.239006 };
const BPM: Record<string, number> = { "count/min": 1, bpm: 1 };

const PAYLOAD = z.object({
	data: z.object({
		metrics: z.array(z.object({ name: z.string(), units: z.string().optional(), data: z.array(z.record(z.string(), z.unknown())) })).default([]),
		workouts: z.array(z.record(z.string(), z.unknown())).default([]),
	}),
});

export type Instant = { iso: string; ms: number; offsetMin: number; localDate: string };

type SleepRow = { source: string; stage: SleepStage; started: string; ended: string; offset_min: number };
type SampleRow = { metric: string; source: string; measured: string; offset_min: number; units: string | null; qty: number | null; min: number | null; avg: number | null; max: number | null };
type WorkoutRow = {
	id: string;
	name: string;
	source: string;
	local_date: string;
	started: string;
	ended: string;
	duration_s: number;
	active_kcal: number | null;
	total_kcal: number | null;
	distance_m: number | null;
	elevation_m: number | null;
	hr_avg: number | null;
	hr_min: number | null;
	hr_max: number | null;
	location: string | null;
	data: Item;
};

export type Skipped = { withings: number; invalid: number };
export type Parsed = { sleep: SleepRow[]; samples: SampleRow[]; workouts: WorkoutRow[]; skipped: Skipped };
export type ParseResult = { ok: true; parsed: Parsed } | { ok: false; error: string };
export type IngestCounts = { received: { sleep: number; samples: number; workouts: number }; changed: { sleep: number; samples: number; workouts: number }; skipped: Skipped };

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
const round = (value: number | null): number | null => (value === null ? null : Math.round(value));

export function parseDate(value: unknown): Instant | null {
	if (typeof value !== "string") return null;
	const match = DATE.exec(value.trim());
	if (match === null) return null;
	const [, date = "", time = "", sign = "+", hours = "00", minutes = "00"] = match;
	const iso = `${date}T${time}${sign}${hours}:${minutes}`;
	const ms = Date.parse(iso);
	if (!Number.isFinite(ms)) return null;
	return { iso, ms, offsetMin: (sign === "-" ? -1 : 1) * (Number(hours) * 60 + Number(minutes)), localDate: date };
}

function quantity(value: unknown, scale: Record<string, number>): number | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const qty = num((value as Item)["qty"]);
	const units = text((value as Item)["units"]);
	const factor = units === null ? undefined : scale[units];
	return qty === null || factor === undefined ? null : Math.round(qty * factor * 10) / 10;
}

function workoutSource(item: Item): { name: string; identifier: string | null } {
	const source = item["source"];
	if (typeof source !== "object" || source === null) return { name: text(source) ?? UNKNOWN_SOURCE, identifier: null };
	return { name: text((source as Item)["name"]) ?? UNKNOWN_SOURCE, identifier: text((source as Item)["identifier"]) };
}

function parseWorkout(item: Item, source: string): WorkoutRow | null {
	const id = text(item["id"]);
	const start = parseDate(item["start"]);
	const end = parseDate(item["end"]);
	if (id === null || start === null || end === null || end.ms < start.ms) return null;
	const heartRate = typeof item["heartRate"] === "object" && item["heartRate"] !== null ? (item["heartRate"] as Item) : {};
	return {
		id,
		name: text(item["name"]) ?? "Workout",
		source,
		local_date: start.localDate,
		started: start.iso,
		ended: end.iso,
		duration_s: Math.round(num(item["duration"]) ?? (end.ms - start.ms) / 1000),
		active_kcal: quantity(item["activeEnergyBurned"] ?? item["activeEnergy"], KCAL),
		total_kcal: quantity(item["totalEnergy"], KCAL),
		distance_m: quantity(item["distance"], METRES),
		elevation_m: quantity(item["elevationUp"], METRES),
		hr_avg: round(quantity(heartRate["avg"] ?? item["avgHeartRate"], BPM)),
		hr_min: round(quantity(heartRate["min"], BPM)),
		hr_max: round(quantity(heartRate["max"] ?? item["maxHeartRate"], BPM)),
		location: text(item["location"]),
		data: Object.fromEntries(Object.entries(item).filter(([key]) => key !== "route")),
	};
}

export function parsePayload(body: unknown): ParseResult {
	const payload = PAYLOAD.safeParse(body);
	if (!payload.success) return { ok: false, error: 'Expected Health Auto Export JSON, version 2: {"data":{"metrics":[...],"workouts":[...]}}' };
	const sleep = new Map<string, SleepRow>();
	const samples = new Map<string, SampleRow>();
	const workouts = new Map<string, WorkoutRow>();
	const skipped: Skipped = { withings: 0, invalid: 0 };
	for (const metric of payload.data.data.metrics) {
		for (const item of metric.data) {
			const source = text(item["source"]) ?? UNKNOWN_SOURCE;
			if (metric.name === "sleep_analysis") {
				if (item["value"] === undefined && (item["totalSleep"] !== undefined || item["sleepStart"] !== undefined)) {
					return { ok: false, error: "sleep_analysis arrived summarized. Turn Summarize Data off in the Health Auto Export automation so sleep arrives as stage segments." };
				}
				if (WITHINGS_SOURCE.test(source)) {
					skipped.withings++;
					continue;
				}
				const stage = SLEEP_STAGES[String(item["value"]) as keyof typeof SLEEP_STAGES];
				const start = parseDate(item["startDate"] ?? item["start"] ?? item["date"]);
				const end = parseDate(item["endDate"] ?? item["end"]);
				if (stage === undefined || start === null || end === null || end.ms < start.ms) {
					skipped.invalid++;
					continue;
				}
				sleep.set(`${source}/${start.ms}/${stage}`, { source, stage, started: start.iso, ended: end.iso, offset_min: end.offsetMin });
				continue;
			}
			if (WITHINGS_SOURCE.test(source)) {
				skipped.withings++;
				continue;
			}
			const at = parseDate(item["date"] ?? item["start"] ?? item["startDate"]);
			const row = { qty: num(item["qty"]), min: num(item["Min"]), avg: num(item["Avg"]), max: num(item["Max"]) };
			if (at === null || Object.values(row).every((value) => value === null)) {
				skipped.invalid++;
				continue;
			}
			samples.set(`${metric.name}/${source}/${at.ms}`, { metric: metric.name, source, measured: at.iso, offset_min: at.offsetMin, units: text(metric.units), ...row });
		}
	}
	for (const item of payload.data.data.workouts) {
		const source = workoutSource(item);
		if (WITHINGS_SOURCE.test(`${source.name} ${source.identifier ?? ""}`)) {
			skipped.withings++;
			continue;
		}
		const workout = parseWorkout(item, source.name);
		if (workout === null) skipped.invalid++;
		else workouts.set(workout.id, workout);
	}
	return { ok: true, parsed: { sleep: [...sleep.values()], samples: [...samples.values()], workouts: [...workouts.values()], skipped } };
}

async function upsert(client: Database, sql: string, rows: readonly object[]): Promise<number> {
	let changed = 0;
	for (let index = 0; index < rows.length; index += CHUNK) {
		const { rowCount } = await client.query(sql, [JSON.stringify(rows.slice(index, index + CHUNK))]);
		changed += rowCount ?? 0;
	}
	return changed;
}

export async function saveAppleHealth(client: Database, parsed: Parsed, push: { automation: string; sessionId: string | null }): Promise<IngestCounts> {
	const sleep = await upsert(
		client,
		`insert into activity.apple_health_sleep (source, stage, started_at, ended_at, utc_offset_min)
		select r.source, r.stage, r.started::timestamptz, r.ended::timestamptz, r.offset_min
		from jsonb_to_recordset($1::jsonb) as r (source text, stage text, started text, ended text, offset_min integer)
		on conflict (source, started_at, stage) do update set ended_at = excluded.ended_at, utc_offset_min = excluded.utc_offset_min, updated_at = now()
		where (activity.apple_health_sleep.ended_at, activity.apple_health_sleep.utc_offset_min) is distinct from (excluded.ended_at, excluded.utc_offset_min)`,
		parsed.sleep,
	);
	const samples = await upsert(
		client,
		`insert into activity.apple_health_samples (metric, source, measured_at, utc_offset_min, units, qty, min, avg, max)
		select r.metric, r.source, r.measured::timestamptz, r.offset_min, r.units, r.qty, r.min, r.avg, r.max
		from jsonb_to_recordset($1::jsonb) as r (metric text, source text, measured text, offset_min integer, units text, qty numeric, min numeric, avg numeric, max numeric)
		on conflict (metric, source, measured_at) do update set utc_offset_min = excluded.utc_offset_min, units = excluded.units, qty = excluded.qty, min = excluded.min,
			avg = excluded.avg, max = excluded.max, updated_at = now()
		where (activity.apple_health_samples.utc_offset_min, activity.apple_health_samples.units, activity.apple_health_samples.qty, activity.apple_health_samples.min,
			activity.apple_health_samples.avg, activity.apple_health_samples.max) is distinct from (excluded.utc_offset_min, excluded.units, excluded.qty, excluded.min, excluded.avg, excluded.max)`,
		parsed.samples,
	);
	const workouts = await upsert(
		client,
		`insert into activity.apple_health_workouts (id, name, source, local_date, started_at, ended_at, duration_s, active_kcal, total_kcal, distance_m, elevation_m,
			hr_avg, hr_min, hr_max, location, data)
		select r.id, r.name, r.source, r.local_date, r.started::timestamptz, r.ended::timestamptz, r.duration_s, r.active_kcal, r.total_kcal, r.distance_m, r.elevation_m,
			r.hr_avg, r.hr_min, r.hr_max, r.location, r.data
		from jsonb_to_recordset($1::jsonb) as r (id text, name text, source text, local_date date, started text, ended text, duration_s integer, active_kcal numeric,
			total_kcal numeric, distance_m numeric, elevation_m numeric, hr_avg integer, hr_min integer, hr_max integer, location text, data jsonb)
		on conflict (id) do update set name = excluded.name, source = excluded.source, local_date = excluded.local_date, started_at = excluded.started_at,
			ended_at = excluded.ended_at, duration_s = excluded.duration_s, active_kcal = excluded.active_kcal, total_kcal = excluded.total_kcal,
			distance_m = excluded.distance_m, elevation_m = excluded.elevation_m, hr_avg = excluded.hr_avg, hr_min = excluded.hr_min, hr_max = excluded.hr_max,
			location = excluded.location, data = excluded.data, updated_at = now()
		where activity.apple_health_workouts.data is distinct from excluded.data`,
		parsed.workouts,
	);
	const counts: IngestCounts = {
		received: { sleep: parsed.sleep.length, samples: parsed.samples.length, workouts: parsed.workouts.length },
		changed: { sleep, samples, workouts },
		skipped: parsed.skipped,
	};
	await client.query(
		`insert into activity.apple_health_pushes (automation, session_id, counts) values ($1, $2, $3)
		on conflict (automation) do update set received_at = now(), session_id = excluded.session_id, counts = excluded.counts`,
		[push.automation, push.sessionId, JSON.stringify(counts)],
	);
	return counts;
}

export type AppleWorkout = {
	id: string;
	date: string;
	name: string;
	source: string;
	startedAt: string;
	endedAt: string;
	durationS: number;
	activeKcal: number | null;
	totalKcal: number | null;
	distanceM: number | null;
	elevationM: number | null;
	hr: { avg: number | null; min: number | null; max: number | null };
	location: string | null;
	withingsId: string | null;
};

const numOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));

export async function listAppleWorkouts(client: Database, from: string, to: string): Promise<AppleWorkout[]> {
	const { rows } = await client.query<Item>(
		`select a.*, a.local_date::text as date,
			(select w.id::text from activity.withings_workouts w where w.started_at < a.ended_at and w.ended_at > a.started_at
				order by abs(extract(epoch from w.started_at - a.started_at)) limit 1) as withings_id
		from activity.apple_health_workouts a where a.local_date between $1 and $2 order by a.started_at`,
		[from, to],
	);
	return rows.map((row) => ({
		id: String(row["id"]),
		date: String(row["date"]),
		name: String(row["name"]),
		source: String(row["source"]),
		startedAt: iso(row["started_at"]),
		endedAt: iso(row["ended_at"]),
		durationS: Number(row["duration_s"]),
		activeKcal: numOrNull(row["active_kcal"]),
		totalKcal: numOrNull(row["total_kcal"]),
		distanceM: numOrNull(row["distance_m"]),
		elevationM: numOrNull(row["elevation_m"]),
		hr: { avg: numOrNull(row["hr_avg"]), min: numOrNull(row["hr_min"]), max: numOrNull(row["hr_max"]) },
		location: text(row["location"]),
		withingsId: text(row["withings_id"]),
	}));
}

export type ApplePush = { automation: string; receivedAt: string; counts: IngestCounts };

export async function listPushes(client: Database): Promise<ApplePush[]> {
	const { rows } = await client.query<Item>("select automation, received_at, counts from activity.apple_health_pushes order by received_at desc");
	return rows.map((row) => ({ automation: String(row["automation"]), receivedAt: iso(row["received_at"]), counts: row["counts"] as IngestCounts }));
}
