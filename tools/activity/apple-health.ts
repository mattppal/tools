import type { Database } from "../../worker/db.ts";
import { type HaeEvent, HaeScanner } from "./hae-scanner.ts";

type Item = Record<string, unknown>;

export const SLEEP_STAGES = { "In Bed": "in_bed", Asleep: "asleep", Awake: "awake", Core: "core", Deep: "deep", REM: "rem", Unspecified: "unspecified" } as const;
export type SleepStage = (typeof SLEEP_STAGES)[keyof typeof SLEEP_STAGES];

const UNKNOWN_SOURCE = "Apple Health";
const WITHINGS_SOURCE = /withings|health ?mate/i;
const CHUNK = 2000;
export const MAX_BODY_BYTES = 95 * 1024 * 1024;
const MAX_PENDING_CHARS = 8_000_000;
const DAY_METRICS = new Set(["step_count", "walking_running_distance", "active_energy", "basal_energy_burned"]);
export const KEPT_METRICS = new Set([
	...DAY_METRICS,
	"heart_rate",
	"resting_heart_rate",
	"heart_rate_variability",
	"respiratory_rate",
	"vo2_max",
	"blood_oxygen_saturation",
	"apple_sleeping_wrist_temperature",
	"dietary_energy",
	"protein",
	"carbohydrates",
	"total_fat",
]);
const BASE_KEYS = new Set(["date", "start", "end", "startDate", "endDate", "qty", "Min", "Avg", "Max", "source"]);
export const TOO_LARGE = "This request is too large for one Worker call. Turn on Batch Requests in Health Auto Export, or upload a shorter date range.";
const HOURLY = /hour/i;
const SUMMARIZED_SLEEP = "Sleep arrived summarized, so it was dropped. Deselect Sleep Analysis in the Health metrics automation, and send sleep from the Sleep automation with Summarize Data off.";
const DATE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)? ?([+-])(\d{2}):?(\d{2})$/;
const METRES: Record<string, number> = { m: 1, km: 1000, mi: 1609.344, yd: 0.9144, ft: 0.3048 };
const KCAL: Record<string, number> = { kcal: 1, Cal: 1, kJ: 0.239006 };
const BPM: Record<string, number> = { "count/min": 1, bpm: 1 };

export type Instant = { iso: string; ms: number; offsetMin: number; localDate: string };

type SleepRow = { source: string; stage: SleepStage; started: string; ended: string; offset_min: number };
type SampleRow = {
	metric: string;
	source: string;
	measured: string;
	ended: string | null;
	offset_min: number;
	units: string | null;
	qty: number | null;
	min: number | null;
	avg: number | null;
	max: number | null;
	extra: Item | null;
};
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

type Tally = { sleep: number; samples: number; workouts: number };
export type Skipped = { withings: number; invalid: number; unlisted?: number };
export type IngestCounts = { received: Tally; changed: Tally; skipped: Skipped; metrics?: string[]; unlisted?: string[]; days?: number; warnings?: string[] };
export type IngestResult = { ok: true; counts: IngestCounts } | { ok: false; status: 413 | 422; error: string };

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

function sampleRow(metric: string, units: string | null, source: string, item: Item, hourly: boolean): SampleRow | null {
	const at = parseDate(item["date"] ?? item["start"] ?? item["startDate"]);
	if (at === null) return null;
	const end = parseDate(item["end"] ?? item["endDate"]);
	const extras = Object.entries(item).filter(([key]) => !BASE_KEYS.has(key));
	const row = { qty: num(item["qty"]), min: num(item["Min"]), avg: num(item["Avg"]), max: num(item["Max"]) };
	if (extras.length === 0 && Object.values(row).every((value) => value === null)) return null;
	return {
		metric,
		source,
		measured: at.iso,
		ended: hourly ? new Date(at.ms + 3600_000).toISOString() : end === null || end.ms === at.ms ? null : end.iso,
		offset_min: at.offsetMin,
		units,
		...row,
		extra: extras.length === 0 ? null : Object.fromEntries(extras),
	};
}

type Metric = { name: string | null; units: string | null; ended: boolean; pending: string[] };

const SLEEP_SQL = `insert into activity.apple_health_sleep (source, stage, started_at, ended_at, utc_offset_min)
	select r.source, r.stage, r.started::timestamptz, r.ended::timestamptz, r.offset_min
	from jsonb_to_recordset($1::jsonb) as r (source text, stage text, started text, ended text, offset_min integer)
	on conflict (source, started_at, stage) do update set ended_at = excluded.ended_at, utc_offset_min = excluded.utc_offset_min, updated_at = now()
	where (activity.apple_health_sleep.ended_at, activity.apple_health_sleep.utc_offset_min) is distinct from (excluded.ended_at, excluded.utc_offset_min)`;

const SAMPLE_RECORDS = `jsonb_to_recordset($1::jsonb) as r (metric text, source text, measured text, ended text, offset_min integer, units text, qty numeric, min numeric,
		avg numeric, max numeric, extra jsonb)`;

const HOUR_SUMMARY = (measured: string, ended: string) => `(${ended} = ${measured} + interval '1 hour' and date_trunc('hour', ${measured}, 'UTC') = ${measured})`;

const SAMPLES_SQL = `insert into activity.apple_health_samples (metric, source, measured_at, ended_at, utc_offset_min, units, qty, min, avg, max, extra)
	select r.metric, r.source, r.measured::timestamptz, r.ended::timestamptz, r.offset_min, r.units, r.qty, r.min, r.avg, r.max, r.extra
	from ${SAMPLE_RECORDS}
	where ${HOUR_SUMMARY("r.measured::timestamptz", "r.ended::timestamptz")} or not exists (
		select 1 from activity.apple_health_samples s
		where s.metric = r.metric and s.source in (r.source, '${UNKNOWN_SOURCE}') and s.measured_at = date_trunc('hour', r.measured::timestamptz, 'UTC')
			and ${HOUR_SUMMARY("s.measured_at", "s.ended_at")})
	on conflict (metric, source, measured_at) do update set ended_at = excluded.ended_at, utc_offset_min = excluded.utc_offset_min, units = excluded.units,
		qty = excluded.qty, min = excluded.min, avg = excluded.avg, max = excluded.max, extra = excluded.extra, updated_at = now()
	where (activity.apple_health_samples.ended_at, activity.apple_health_samples.utc_offset_min, activity.apple_health_samples.units, activity.apple_health_samples.qty,
		activity.apple_health_samples.min, activity.apple_health_samples.avg, activity.apple_health_samples.max, activity.apple_health_samples.extra)
		is distinct from (excluded.ended_at, excluded.utc_offset_min, excluded.units, excluded.qty, excluded.min, excluded.avg, excluded.max, excluded.extra)`;

const SUPERSEDED_SQL = `delete from activity.apple_health_samples s
	using ${SAMPLE_RECORDS}
	where ${HOUR_SUMMARY("r.measured::timestamptz", "r.ended::timestamptz")}
		and s.metric = r.metric and s.source in (r.source, '${UNKNOWN_SOURCE}')
		and s.measured_at >= r.measured::timestamptz and s.measured_at < r.ended::timestamptz
		and not (s.source = r.source and s.measured_at = r.measured::timestamptz)`;

const WORKOUTS_SQL = `insert into activity.apple_health_workouts (id, name, source, local_date, started_at, ended_at, duration_s, active_kcal, total_kcal, distance_m, elevation_m,
		hr_avg, hr_min, hr_max, location, data)
	select r.id, r.name, r.source, r.local_date, r.started::timestamptz, r.ended::timestamptz, r.duration_s, r.active_kcal, r.total_kcal, r.distance_m, r.elevation_m,
		r.hr_avg, r.hr_min, r.hr_max, r.location, r.data
	from jsonb_to_recordset($1::jsonb) as r (id text, name text, source text, local_date date, started text, ended text, duration_s integer, active_kcal numeric,
		total_kcal numeric, distance_m numeric, elevation_m numeric, hr_avg integer, hr_min integer, hr_max integer, location text, data jsonb)
	on conflict (id) do update set name = excluded.name, source = excluded.source, local_date = excluded.local_date, started_at = excluded.started_at,
		ended_at = excluded.ended_at, duration_s = excluded.duration_s, active_kcal = excluded.active_kcal, total_kcal = excluded.total_kcal,
		distance_m = excluded.distance_m, elevation_m = excluded.elevation_m, hr_avg = excluded.hr_avg, hr_min = excluded.hr_min, hr_max = excluded.hr_max,
		location = excluded.location, data = excluded.data, updated_at = now()
	where activity.apple_health_workouts.data is distinct from excluded.data`;

const DAYS_SQL = `with picked as (
		select value::date as day from unnest($1::text[]) as value
	), per_source as (
		select (s.measured_at at time zone 'UTC' + make_interval(mins => s.utc_offset_min))::date as day, s.metric, s.source,
			sum(s.qty * case s.units when 'km' then 1000 when 'mi' then 1609.344 when 'kJ' then 0.239006 else 1 end) as total
		from activity.apple_health_samples s
		where s.metric in ('step_count', 'walking_running_distance', 'active_energy', 'basal_energy_burned')
			and s.measured_at >= (select min(day) from picked) - interval '2 days' and s.measured_at < (select max(day) from picked) + interval '2 days'
		group by 1, 2, 3
	), steps as (
		select distinct on (p.day) p.day, p.source, p.total from per_source p join picked using (day) where p.metric = 'step_count' and p.total > 0
		order by p.day, p.total desc, p.source
	), energy as (
		select distinct on (a.day) a.day, a.total as active, b.total as basal
		from per_source a left join per_source b on b.day = a.day and b.source = a.source and b.metric = 'basal_energy_burned'
		where a.metric = 'active_energy' order by a.day, a.total desc, a.source
	)
	insert into activity.days (day, source, steps, active_kcal, total_kcal, distance_m, device, raw, updated_by)
	select st.day, 'apple_health', round(st.total)::integer, round(e.active, 1), round(e.active + e.basal, 1),
		(select round(d.total, 1) from per_source d where d.day = st.day and d.metric = 'walking_running_distance' and d.source = st.source),
		st.source,
		jsonb_build_object('steps', (select jsonb_object_agg(x.source, round(x.total)) from per_source x where x.day = st.day and x.metric = 'step_count')),
		'apple-health'
	from steps st left join energy e using (day)
	on conflict (day, source) do update set steps = excluded.steps, active_kcal = excluded.active_kcal, total_kcal = excluded.total_kcal, distance_m = excluded.distance_m,
		device = excluded.device, raw = excluded.raw, updated_by = excluded.updated_by, updated_at = now()
	where (activity.days.steps, activity.days.active_kcal, activity.days.total_kcal, activity.days.distance_m, activity.days.device, activity.days.raw)
		is distinct from (excluded.steps, excluded.active_kcal, excluded.total_kcal, excluded.distance_m, excluded.device, excluded.raw)`;

class TooLarge extends Error {}

const pendingChars = (metric: Metric): number => metric.pending.reduce((total, raw) => total + raw.length, 0);

class Ingest {
	private metrics = new Map<number, Metric>();
	private sleep = new Map<string, SleepRow>();
	private samples = new Map<string, SampleRow>();
	private workouts = new Map<string, WorkoutRow>();
	private pending = 0;
	private names = new Set<string>();
	private unlisted = new Set<string>();
	private dates = new Set<string>();
	private warnings = new Set<string>();
	readonly received: Tally = { sleep: 0, samples: 0, workouts: 0 };
	readonly changed: Tally = { sleep: 0, samples: 0, workouts: 0 };
	readonly skipped: Required<Skipped> = { withings: 0, invalid: 0, unlisted: 0 };

	constructor(
		private client: Database,
		private hourly: boolean,
	) {}

	async take(events: HaeEvent[]): Promise<void> {
		for (const event of events) {
			if (event.type === "workout") this.workout(event.item);
			else await this.metricEvent(event);
			await this.flushWhenFull();
		}
	}

	private async flushWhenFull(): Promise<void> {
		if (this.sleep.size + this.samples.size + this.workouts.size >= CHUNK) await this.flush();
	}

	private async metricEvent(event: Exclude<HaeEvent, { type: "workout" }>): Promise<void> {
		const metric = this.metrics.get(event.metric) ?? { name: null, units: null, ended: false, pending: [] };
		this.metrics.set(event.metric, metric);
		switch (event.type) {
			case "sample":
				metric.pending.push(event.raw);
				this.pending += event.raw.length;
				break;
			case "field":
				metric[event.key] = event.value;
				break;
			case "metricEnd":
				metric.ended = true;
				break;
			default: {
				const unhandled: never = event;
				throw new Error(`Unknown event ${String(unhandled)}`);
			}
		}
		if (metric.name !== null && (metric.units !== null || metric.ended)) await this.drain(metric, metric.name);
		else if (metric.ended) {
			this.skipped.invalid += metric.pending.length;
			this.pending -= pendingChars(metric);
			metric.pending = [];
		}
		if (this.pending > MAX_PENDING_CHARS) throw new TooLarge(TOO_LARGE);
	}

	private async drain(metric: Metric, name: string): Promise<void> {
		if (!KEPT_METRICS.has(name) && name !== "sleep_analysis") {
			this.unlisted.add(name);
			this.skipped.unlisted += metric.pending.length;
			this.pending -= pendingChars(metric);
			metric.pending = [];
			return;
		}
		this.names.add(name);
		for (const raw of metric.pending) {
			const item: unknown = JSON.parse(raw);
			if (typeof item === "object" && item !== null && !Array.isArray(item)) this.item(name, metric.units, item as Item);
			else this.skipped.invalid++;
			await this.flushWhenFull();
		}
		this.pending -= pendingChars(metric);
		metric.pending = [];
	}

	private item(name: string, units: string | null, item: Item): void {
		const source = text(item["source"]) ?? UNKNOWN_SOURCE;
		if (WITHINGS_SOURCE.test(source)) {
			this.skipped.withings++;
			return;
		}
		if (name === "sleep_analysis" && item["value"] !== undefined) {
			const stage = SLEEP_STAGES[String(item["value"]) as keyof typeof SLEEP_STAGES];
			const start = parseDate(item["startDate"] ?? item["start"] ?? item["date"]);
			const end = parseDate(item["endDate"] ?? item["end"]);
			if (stage === undefined || start === null || end === null || end.ms < start.ms) {
				this.skipped.invalid++;
				return;
			}
			this.received.sleep++;
			this.sleep.set(`${source}/${start.ms}/${stage}`, { source, stage, started: start.iso, ended: end.iso, offset_min: end.offsetMin });
			return;
		}
		if (name === "sleep_analysis") {
			this.warnings.add(SUMMARIZED_SLEEP);
			this.skipped.unlisted++;
			return;
		}
		const row = sampleRow(name, units, source, item, this.hourly);
		if (row === null) {
			this.skipped.invalid++;
			return;
		}
		this.received.samples++;
		if (DAY_METRICS.has(name)) this.dates.add(row.measured.slice(0, 10));
		this.samples.set(`${name}/${source}/${row.measured}`, row);
	}

	private workout(item: Item): void {
		const source = workoutSource(item);
		if (WITHINGS_SOURCE.test(`${source.name} ${source.identifier ?? ""}`)) {
			this.skipped.withings++;
			return;
		}
		const workout = parseWorkout(item, source.name);
		if (workout === null) {
			this.skipped.invalid++;
			return;
		}
		this.received.workouts++;
		this.workouts.set(workout.id, workout);
	}

	async flush(): Promise<void> {
		this.changed.sleep += await this.write(SLEEP_SQL, this.sleep);
		if (this.hourly && this.samples.size > 0) {
			const records = JSON.stringify([...this.samples.values()]);
			const { rowCount } = await this.client.query(SAMPLES_SQL, [records]);
			await this.client.query(SUPERSEDED_SQL, [records]);
			this.samples.clear();
			this.changed.samples += rowCount ?? 0;
		} else this.changed.samples += await this.write(SAMPLES_SQL, this.samples);
		this.changed.workouts += await this.write(WORKOUTS_SQL, this.workouts);
	}

	private async write(sql: string, rows: Map<string, object>): Promise<number> {
		if (rows.size === 0) return 0;
		const { rowCount } = await this.client.query(sql, [JSON.stringify([...rows.values()])]);
		rows.clear();
		return rowCount ?? 0;
	}

	async finish(): Promise<IngestCounts> {
		for (const metric of this.metrics.values()) {
			if (metric.name !== null) await this.drain(metric, metric.name);
			else this.skipped.invalid += metric.pending.length;
		}
		this.metrics.clear();
		await this.flush();
		if (this.dates.size > 0) await this.client.query(DAYS_SQL, [[...this.dates].toSorted()]);
		return this.counts();
	}

	counts(error?: string): IngestCounts {
		return {
			received: this.received,
			changed: this.changed,
			skipped: this.skipped,
			metrics: [...this.names].toSorted(),
			unlisted: [...this.unlisted].toSorted(),
			days: this.dates.size,
			warnings: error === undefined ? [...this.warnings] : [error, ...this.warnings],
		};
	}
}

export type Push = { automation: string; sessionId: string | null; aggregation: string | null };

async function recordPush(client: Database, push: Push, counts: IngestCounts): Promise<void> {
	await client.query(
		`insert into activity.apple_health_pushes (automation, session_id, counts) values ($1, $2, $3)
		on conflict (automation) do update set received_at = now(), session_id = excluded.session_id, counts = excluded.counts`,
		[push.automation, push.sessionId, JSON.stringify(counts)],
	);
}

export async function ingestAppleHealth(
	client: Database,
	body: ReadableStream<Uint8Array>,
	push: Push,
): Promise<IngestResult> {
	const scanner = new HaeScanner();
	const ingest = new Ingest(client, HOURLY.test(push.aggregation ?? ""));
	const decoder = new TextDecoder();
	let bytes = 0;
	try {
		for await (const chunk of body) {
			bytes += chunk.byteLength;
			if (bytes > MAX_BODY_BYTES) throw new TooLarge(TOO_LARGE);
			await ingest.take(scanner.push(decoder.decode(chunk, { stream: true })));
		}
		await ingest.take(scanner.push(decoder.decode()));
	} catch (error) {
		if (!(error instanceof TooLarge) && !(error instanceof SyntaxError)) throw error;
		await ingest.flush();
		const message = error instanceof TooLarge ? error.message : `The body isn't valid JSON: ${error.message}`;
		await recordPush(client, push, ingest.counts(message));
		return { ok: false, status: error instanceof TooLarge ? 413 : 422, error: message };
	}
	const invalid = scanner.end();
	if (invalid !== null) {
		await ingest.flush();
		await recordPush(client, push, ingest.counts(invalid));
		return { ok: false, status: 422, error: invalid };
	}
	const counts = await ingest.finish();
	await recordPush(client, push, counts);
	return { ok: true, counts };
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
				and w.started_at > a.started_at - (select max(ended_at - started_at) from activity.withings_workouts)
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
