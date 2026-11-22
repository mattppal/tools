import type { Database } from "../../worker/db.ts";
import { TIME_ZONE } from "./weights.ts";
import type { Feed, IntradaySample } from "./withings.ts";

type Row = Record<string, unknown>;
type Series = Record<string, unknown>;

export const BUCKET_S = 300;

export const MEASURE_TYPES: Record<number, string> = {
	1: "weight_kg",
	4: "height_m",
	5: "fat_free_mass_kg",
	6: "fat_ratio_pct",
	8: "fat_mass_kg",
	9: "diastolic_mmhg",
	10: "systolic_mmhg",
	11: "heart_pulse_bpm",
	12: "temperature_c",
	54: "spo2_pct",
	71: "body_temperature_c",
	73: "skin_temperature_c",
	76: "muscle_mass_kg",
	77: "hydration_kg",
	88: "bone_mass_kg",
	91: "pulse_wave_velocity_ms",
	123: "vo2max",
	130: "afib_result",
	135: "qrs_ms",
	136: "pr_ms",
	137: "qt_ms",
	138: "qtc_ms",
	155: "vascular_age",
	167: "nerve_health_score",
	168: "extracellular_water_kg",
	169: "intracellular_water_kg",
	170: "visceral_fat",
	174: "fat_mass_segments",
	175: "muscle_mass_segments",
	196: "electrodermal_activity",
	226: "basal_metabolic_rate_kcal",
};

export const WORKOUT_CATEGORIES: Record<number, string> = {
	1: "walk",
	2: "run",
	3: "hiking",
	4: "skating",
	5: "bmx",
	6: "bicycling",
	7: "swimming",
	8: "surfing",
	9: "kitesurfing",
	10: "windsurfing",
	11: "bodyboard",
	12: "tennis",
	13: "table tennis",
	14: "squash",
	15: "badminton",
	16: "lift weights",
	17: "fitness",
	18: "elliptical",
	19: "pilates",
	20: "basket-ball",
	21: "soccer",
	22: "football",
	23: "rugby",
	24: "volley-ball",
	25: "waterpolo",
	26: "horse riding",
	27: "golf",
	28: "yoga",
	29: "dancing",
	30: "boxing",
	31: "fencing",
	32: "wrestling",
	33: "martial arts",
	34: "skiing",
	35: "snowboarding",
	36: "other",
	128: "no activity",
	187: "rowing",
	188: "zumba",
	191: "baseball",
	192: "handball",
	193: "hockey",
	194: "ice hockey",
	195: "climbing",
	196: "ice skating",
	272: "multi-sport",
	306: "indoor walk",
	307: "indoor running",
	308: "indoor cycling",
	455: "standup paddleboarding",
	456: "padel",
	457: "gaming",
	490: "beach volleyball",
	491: "stair stepper",
	492: "skateboarding",
	493: "parkour",
	494: "kayaking",
	495: "canoeing",
	496: "sailing",
	497: "fishing",
	498: "trail running",
	499: "snowshoeing",
	500: "paintball",
	501: "archery",
	502: "scuba diving",
	503: "baseball training",
	504: "biathlon",
	505: "bocce",
	506: "pétanque",
	507: "paragliding",
	508: "frisbee",
	509: "skydiving",
	510: "pickleball",
	511: "cornhole",
	512: "dodgeball",
	513: "ultimate",
	514: "teqball",
	515: "pushing a wheelchair (running pace)",
	516: "pushing a wheelchair (walking pace)",
	517: "athletics",
	518: "track cycling",
	519: "pentathlon",
	520: "sport shooting",
	521: "triathlon",
	522: "diving",
	523: "mountain biking",
	524: "gravel biking",
	525: "e-biking",
	526: "e-mountain biking",
	527: "handcycling",
	528: "velomobile",
	529: "backcountry skiing",
	530: "nordic skiing",
	531: "roller skiing",
	532: "racquetball",
	534: "hip hop",
	535: "muaythai",
	536: "taekwondo",
	537: "judo",
	538: "trampoline",
	539: "standing frame",
	540: "seated strength",
	541: "seated cardio",
	542: "walk with walker",
	543: "walk with cane",
	544: "breaking",
	545: "chores",
	546: "crossfit",
	547: "spinclass",
	548: "cricket",
	549: "flamenco dancing",
	550: "hiit",
	551: "meditation",
	552: "stretching",
	553: "yard work gardening",
	554: "cleaning",
	555: "public speaking",
	556: "spikeball",
	557: "lacrosse",
	558: "baby wearing",
	559: "dog walking",
	560: "breathing exercises",
	561: "balance drills",
	562: "pushing a stroller",
	563: "toddler wearing",
	564: "bowling",
	565: "lasertag",
	566: "nordic walking",
	567: "sumo wrestling",
	568: "cooking",
	569: "match day",
	570: "jump rope",
	571: "calisthenics",
	572: "barre",
	573: "aqua aerobics",
	574: "gymnastics",
	575: "aerobics",
	576: "cheerleading",
	577: "tai chi",
	578: "qigong",
	579: "sauna",
	580: "cold plunge",
	581: "karate",
	582: "kickboxing",
	583: "netball",
	584: "softball",
	585: "futsal",
	586: "darts",
	587: "billiards",
	588: "mountaineering",
	589: "bouldering",
	590: "disc golf",
	591: "wakeboarding",
	592: "water skiing",
	593: "hunting",
	594: "rucking",
	595: "indoor rowing",
	596: "resistance band training",
	597: "australian rules football",
};

type Modality = "run" | "walk" | "bike" | "swim" | "row" | "elliptical";

const CATEGORY_MODALITY: Record<number, Modality> = {
	1: "walk",
	3: "walk",
	306: "walk",
	566: "walk",
	594: "walk",
	2: "run",
	307: "run",
	498: "run",
	6: "bike",
	308: "bike",
	518: "bike",
	523: "bike",
	524: "bike",
	525: "bike",
	526: "bike",
	547: "bike",
	7: "swim",
	187: "row",
	595: "row",
	18: "elliptical",
};

const MODALITY_WORDS: [Modality, RegExp][] = [
	["run", /\b(run|running|jog|jogging|track|sprints?)\b/i],
	["walk", /\b(walk|walking|hike|hiking|ruck|rucking)\b/i],
	["bike", /\b(bike|biking|cycling|cycle|spin)\b|air-bike/i],
	["swim", /\bswim/i],
	["row", /\b(row|rower|rowing|erg)\b/i],
	["elliptical", /\belliptical\b/i],
];

const MATCH_WINDOW_S = 3 * 3600;

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const int = (value: unknown): number | null => {
	const n = num(value);
	return n === null ? null : Math.round(n);
};
const str = (value: unknown): string | null => (value === null || value === undefined || value === "" ? null : String(value));
const data = (item: Series): Series => (typeof item["data"] === "object" && item["data"] !== null ? (item["data"] as Series) : {});
const isoOrNull = (value: unknown): string | null => (value instanceof Date ? value.toISOString() : str(value));
const numOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

function offsetMs(ms: number, timeZone: string): number {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
			.formatToParts(new Date(ms))
			.map((part) => [part.type, Number(part.value)]),
	);
	return Date.UTC(parts["year"] ?? 0, (parts["month"] ?? 1) - 1, parts["day"] ?? 1, parts["hour"] ?? 0, parts["minute"] ?? 0, parts["second"] ?? 0) - ms;
}

export function dayStart(day: string, timeZone = TIME_ZONE): number {
	const midnight = Date.parse(`${day}T00:00:00Z`);
	const first = midnight - offsetMs(midnight, timeZone);
	return (midnight - offsetMs(first, timeZone)) / 1000;
}

export type FeedState = { lastupdate: number | null; pending: number | null; offset: number };
export type IntradayState = { cursor: string | null; empty: number; recentAt: string | null };
export type StreamRow<S> = { state: S; syncedAt: string | null; doneAt: string | null };

export async function readStream<S>(client: Database, name: Feed | "intraday", initial: S): Promise<StreamRow<S>> {
	const row = (await client.query<Row>("select state, synced_at, done_at from activity.withings_streams where name = $1", [name])).rows[0];
	if (row === undefined) return { state: initial, syncedAt: null, doneAt: null };
	return { state: { ...initial, ...(row["state"] as S) }, syncedAt: isoOrNull(row["synced_at"]), doneAt: isoOrNull(row["done_at"]) };
}

export async function saveStream(client: Database, name: Feed | "intraday", state: object, synced: boolean, done = false): Promise<void> {
	await client.query(
		`insert into activity.withings_streams (name, state, synced_at, done_at) values ($1, $2, case when $3 then now() end, case when $4 then now() end)
		on conflict (name) do update set state = excluded.state,
			synced_at = case when $3 then now() else activity.withings_streams.synced_at end,
			done_at = case when $4 then coalesce(activity.withings_streams.done_at, now()) else activity.withings_streams.done_at end`,
		[name, JSON.stringify(state), synced, done],
	);
}

export async function resetStreams(client: Database): Promise<void> {
	await client.query("delete from activity.withings_streams");
}

async function upsert(client: Database, sql: string, rows: object[]): Promise<number> {
	if (rows.length === 0) return 0;
	const { rowCount } = await client.query(sql, [JSON.stringify(rows)]);
	return rowCount ?? 0;
}

export function measureRows(groups: readonly Series[]): object[] {
	const rows = new Map<string, object>();
	for (const group of groups) {
		const grpid = int(group["grpid"]);
		const date = int(group["date"]);
		if (grpid === null || date === null || !Array.isArray(group["measures"])) continue;
		for (const measure of group["measures"] as Series[]) {
			const type = int(measure["type"]);
			const value = int(measure["value"]);
			const unit = int(measure["unit"]);
			if (type === null || value === null || unit === null) continue;
			rows.set(`${grpid}/${type}`, {
				grpid,
				type,
				measured_ts: date,
				value,
				unit,
				attrib: int(group["attrib"]) ?? 0,
				category: int(group["category"]) ?? 1,
				model: str(group["model"]),
				device_hash: str(group["hash_deviceid"]) ?? str(group["deviceid"]),
			});
		}
	}
	return [...rows.values()];
}

export function saveMeasures(client: Database, groups: readonly Series[]): Promise<number> {
	return upsert(
		client,
		`insert into activity.withings_measures (grpid, type, measured_at, value, attrib, category, model, device_hash)
		select r.grpid, r.type, to_timestamp(r.measured_ts), round(r.value::numeric * power(10::numeric, r.unit), greatest(-r.unit, 0)), r.attrib, r.category, r.model, r.device_hash
		from jsonb_to_recordset($1::jsonb) as r (grpid bigint, type integer, measured_ts bigint, value bigint, unit integer, attrib integer, category integer, model text, device_hash text)
		on conflict (grpid, type) do update set measured_at = excluded.measured_at, value = excluded.value, attrib = excluded.attrib, category = excluded.category,
			model = excluded.model, device_hash = excluded.device_hash, updated_at = now()
		where (activity.withings_measures.measured_at, activity.withings_measures.value, activity.withings_measures.attrib, activity.withings_measures.model)
			is distinct from (excluded.measured_at, excluded.value, excluded.attrib, excluded.model)`,
		measureRows(groups),
	);
}

export function workoutRows(series: readonly Series[]): object[] {
	return series.flatMap((item) => {
		const id = int(item["id"]);
		const start = int(item["startdate"]);
		const end = int(item["enddate"]);
		const date = str(item["date"]);
		if (id === null || start === null || end === null || date === null) return [];
		const d = data(item);
		return [
			{
				id,
				category: int(item["category"]) ?? 36,
				local_date: date,
				started_ts: start,
				ended_ts: end,
				timezone: str(item["timezone"]),
				duration_s: Math.max(0, end - start),
				distance_m: num(d["distance"]) ?? num(d["manual_distance"]),
				calories: num(d["calories"]) ?? num(d["manual_calories"]),
				steps: int(d["steps"]),
				elevation_m: num(d["elevation"]),
				hr_avg: int(d["hr_average"]),
				hr_min: int(d["hr_min"]),
				hr_max: int(d["hr_max"]),
				hr_zone_0_s: int(d["hr_zone_0"]),
				hr_zone_1_s: int(d["hr_zone_1"]),
				hr_zone_2_s: int(d["hr_zone_2"]),
				hr_zone_3_s: int(d["hr_zone_3"]),
				pool_laps: int(d["pool_laps"]),
				intensity: int(d["intensity"]),
				attrib: int(item["attrib"]),
				model: str(item["model"]),
				device_id: str(item["deviceid"]),
				data: item,
				modified_ts: int(item["modified"]),
			},
		];
	});
}

export function saveWorkouts(client: Database, series: readonly Series[]): Promise<number> {
	return upsert(
		client,
		`insert into activity.withings_workouts (id, category, local_date, started_at, ended_at, timezone, duration_s, distance_m, calories, steps, elevation_m,
			hr_avg, hr_min, hr_max, hr_zone_0_s, hr_zone_1_s, hr_zone_2_s, hr_zone_3_s, pool_laps, intensity, attrib, model, device_id, data, modified_at)
		select r.id, r.category, r.local_date, to_timestamp(r.started_ts), to_timestamp(r.ended_ts), r.timezone, r.duration_s, r.distance_m, r.calories, r.steps, r.elevation_m,
			r.hr_avg, r.hr_min, r.hr_max, r.hr_zone_0_s, r.hr_zone_1_s, r.hr_zone_2_s, r.hr_zone_3_s, r.pool_laps, r.intensity, r.attrib, r.model, r.device_id, r.data,
			case when r.modified_ts is null then null else to_timestamp(r.modified_ts) end
		from jsonb_to_recordset($1::jsonb) as r (id bigint, category integer, local_date date, started_ts bigint, ended_ts bigint, timezone text, duration_s integer,
			distance_m numeric, calories numeric, steps integer, elevation_m numeric, hr_avg integer, hr_min integer, hr_max integer, hr_zone_0_s integer, hr_zone_1_s integer,
			hr_zone_2_s integer, hr_zone_3_s integer, pool_laps integer, intensity integer, attrib integer, model text, device_id text, data jsonb, modified_ts bigint)
		on conflict (id) do update set category = excluded.category, local_date = excluded.local_date, started_at = excluded.started_at, ended_at = excluded.ended_at,
			timezone = excluded.timezone, duration_s = excluded.duration_s, distance_m = excluded.distance_m, calories = excluded.calories, steps = excluded.steps,
			elevation_m = excluded.elevation_m, hr_avg = excluded.hr_avg, hr_min = excluded.hr_min, hr_max = excluded.hr_max, hr_zone_0_s = excluded.hr_zone_0_s,
			hr_zone_1_s = excluded.hr_zone_1_s, hr_zone_2_s = excluded.hr_zone_2_s, hr_zone_3_s = excluded.hr_zone_3_s, pool_laps = excluded.pool_laps,
			intensity = excluded.intensity, attrib = excluded.attrib, model = excluded.model, device_id = excluded.device_id, data = excluded.data,
			modified_at = excluded.modified_at, updated_at = now()
		where activity.withings_workouts.data is distinct from excluded.data`,
		workoutRows(series),
	);
}

export function sleepRows(series: readonly Series[]): object[] {
	return series.flatMap((item) => {
		const id = int(item["id"]);
		const start = int(item["startdate"]);
		const end = int(item["enddate"]);
		const date = str(item["date"]);
		if (id === null || start === null || end === null || date === null) return [];
		const d = data(item);
		return [
			{
				id,
				local_date: date,
				started_ts: start,
				ended_ts: end,
				timezone: str(item["timezone"]),
				model: str(item["model"]),
				model_id: int(item["model_id"]),
				device_hash: str(item["hash_deviceid"]),
				total_sleep_s: int(d["total_sleep_time"]),
				in_bed_s: int(d["total_timeinbed"]),
				light_s: int(d["lightsleepduration"]),
				deep_s: int(d["deepsleepduration"]),
				rem_s: int(d["remsleepduration"]),
				awake_s: int(d["wakeupduration"]),
				wakeup_count: int(d["wakeupcount"]),
				sleep_latency_s: int(d["sleep_latency"]) ?? int(d["durationtosleep"]),
				sleep_efficiency: num(d["sleep_efficiency"]),
				hr_avg: int(d["hr_average"]),
				hr_min: int(d["hr_min"]),
				hr_max: int(d["hr_max"]),
				rr_avg: int(d["rr_average"]),
				rr_min: int(d["rr_min"]),
				rr_max: int(d["rr_max"]),
				breathing_disturbances: int(d["breathing_disturbances_intensity"]),
				snoring_s: int(d["snoring"]),
				sleep_score: int(d["sleep_score"]),
				data: item,
				modified_ts: int(item["modified"]),
			},
		];
	});
}

export function saveSleep(client: Database, series: readonly Series[]): Promise<number> {
	return upsert(
		client,
		`insert into activity.withings_sleep (id, local_date, started_at, ended_at, timezone, model, model_id, device_hash, total_sleep_s, in_bed_s, light_s, deep_s, rem_s,
			awake_s, wakeup_count, sleep_latency_s, sleep_efficiency, hr_avg, hr_min, hr_max, rr_avg, rr_min, rr_max, breathing_disturbances, snoring_s, sleep_score, data, modified_at)
		select r.id, r.local_date, to_timestamp(r.started_ts), to_timestamp(r.ended_ts), r.timezone, r.model, r.model_id, r.device_hash, r.total_sleep_s, r.in_bed_s,
			r.light_s, r.deep_s, r.rem_s, r.awake_s, r.wakeup_count, r.sleep_latency_s, r.sleep_efficiency, r.hr_avg, r.hr_min, r.hr_max, r.rr_avg, r.rr_min, r.rr_max,
			r.breathing_disturbances, r.snoring_s, r.sleep_score, r.data, case when r.modified_ts is null then null else to_timestamp(r.modified_ts) end
		from jsonb_to_recordset($1::jsonb) as r (id bigint, local_date date, started_ts bigint, ended_ts bigint, timezone text, model text, model_id integer, device_hash text,
			total_sleep_s integer, in_bed_s integer, light_s integer, deep_s integer, rem_s integer, awake_s integer, wakeup_count integer, sleep_latency_s integer,
			sleep_efficiency numeric, hr_avg integer, hr_min integer, hr_max integer, rr_avg integer, rr_min integer, rr_max integer, breathing_disturbances integer,
			snoring_s integer, sleep_score integer, data jsonb, modified_ts bigint)
		on conflict (id) do update set local_date = excluded.local_date, started_at = excluded.started_at, ended_at = excluded.ended_at, timezone = excluded.timezone,
			model = excluded.model, model_id = excluded.model_id, device_hash = excluded.device_hash, total_sleep_s = excluded.total_sleep_s, in_bed_s = excluded.in_bed_s,
			light_s = excluded.light_s, deep_s = excluded.deep_s, rem_s = excluded.rem_s, awake_s = excluded.awake_s, wakeup_count = excluded.wakeup_count,
			sleep_latency_s = excluded.sleep_latency_s, sleep_efficiency = excluded.sleep_efficiency, hr_avg = excluded.hr_avg, hr_min = excluded.hr_min,
			hr_max = excluded.hr_max, rr_avg = excluded.rr_avg, rr_min = excluded.rr_min, rr_max = excluded.rr_max, breathing_disturbances = excluded.breathing_disturbances,
			snoring_s = excluded.snoring_s, sleep_score = excluded.sleep_score, data = excluded.data, modified_at = excluded.modified_at, updated_at = now()
		where activity.withings_sleep.data is distinct from excluded.data`,
		sleepRows(series),
	);
}

export type Bucket = { m: number; steps?: number; kcal?: number; distance_m?: number; hr?: number; hr_min?: number; hr_max?: number; spo2?: number };

export function downsample(series: Record<string, IntradaySample>, start: number): { buckets: Bucket[]; samples: number; models: string[] } {
	const sums = new Map<number, { steps: number; kcal: number; distance: number; hr: number[]; spo2: number[]; moved: boolean }>();
	const models = new Set<string>();
	let samples = 0;
	for (const [ts, sample] of Object.entries(series)) {
		const offset = Number(ts) - start;
		if (!Number.isFinite(offset) || offset < 0 || offset >= 25 * 3600) continue;
		samples++;
		if (sample.model !== undefined) models.add(String(sample.model));
		const index = Math.floor(offset / BUCKET_S);
		const bucket = sums.get(index) ?? { steps: 0, kcal: 0, distance: 0, hr: [], spo2: [], moved: false };
		if (num(sample.steps) !== null || num(sample.calories) !== null || num(sample.distance) !== null) bucket.moved = true;
		bucket.steps += num(sample.steps) ?? 0;
		bucket.kcal += num(sample.calories) ?? 0;
		bucket.distance += num(sample.distance) ?? 0;
		if (num(sample.heart_rate) !== null) bucket.hr.push(sample.heart_rate as number);
		if (num(sample.spo2_auto) !== null) bucket.spo2.push(sample.spo2_auto as number);
		sums.set(index, bucket);
	}
	const buckets = [...sums.entries()]
		.toSorted(([a], [b]) => a - b)
		.map(([index, sum]) => {
			const bucket: Bucket = { m: (index * BUCKET_S) / 60 };
			if (sum.moved) Object.assign(bucket, { steps: sum.steps, kcal: Math.round(sum.kcal * 100) / 100, distance_m: Math.round(sum.distance * 10) / 10 });
			if (sum.hr.length > 0) Object.assign(bucket, { hr: Math.round(sum.hr.reduce((a, b) => a + b, 0) / sum.hr.length), hr_min: Math.min(...sum.hr), hr_max: Math.max(...sum.hr) });
			if (sum.spo2.length > 0) bucket.spo2 = Math.round(sum.spo2.reduce((a, b) => a + b, 0) / sum.spo2.length);
			return bucket;
		});
	return { buckets, samples, models: [...models].toSorted() };
}

export async function saveIntraday(client: Database, day: string, series: Record<string, IntradaySample>): Promise<{ samples: number; changed: number }> {
	const { buckets, samples, models } = downsample(series, dayStart(day));
	if (samples === 0) return { samples, changed: 0 };
	const { rowCount } = await client.query(
		`insert into activity.withings_intraday (day, bucket_s, samples, buckets, models) values ($1, $2, $3, $4, $5)
		on conflict (day) do update set bucket_s = excluded.bucket_s, samples = excluded.samples, buckets = excluded.buckets, models = excluded.models, updated_at = now()
		where activity.withings_intraday.buckets is distinct from excluded.buckets`,
		[day, BUCKET_S, samples, JSON.stringify(buckets), models],
	);
	return { samples, changed: rowCount ?? 0 };
}

function modalityOfText(...texts: (string | null)[]): Modality | null {
	const found = new Set<Modality>();
	for (const text of texts) {
		if (text === null) continue;
		for (const [modality, words] of MODALITY_WORDS) if (words.test(text)) found.add(modality);
	}
	return found.size === 1 ? ([...found][0] as Modality) : null;
}

function sessionStart(value: string | null): number | null {
	if (value === null || !/T\d{2}:\d{2}/.test(value) || /T00:00(:00)?(\.0+)?([+-]\d{2}:?\d{2}|Z)?$/.test(value)) return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms / 1000 : null;
}

export type LinkCandidateSession = { path: string; day: string; modality: string | null; name: string; started: string | null; exercises: string };
export type LinkCandidateWorkout = { id: number; category: number; day: string; startedTs: number };
export type WorkoutLink = { workoutId: number; sessionPath: string | null; status: "matched" | "ambiguous"; candidates: string[] };

export function linkWorkouts(workouts: readonly LinkCandidateWorkout[], sessions: readonly LinkCandidateSession[]): WorkoutLink[] {
	const typed = sessions.map((session) => ({ ...session, kind: modalityOfText(session.modality, session.name, session.exercises), start: sessionStart(session.started) }));
	const byWorkout = new Map<number, string[]>();
	const bySession = new Map<string, number[]>();
	for (const workout of workouts) {
		const modality = CATEGORY_MODALITY[workout.category];
		if (modality === undefined) continue;
		const hits = typed
			.filter((session) => session.kind === modality && session.day === workout.day && (session.start === null || Math.abs(session.start - workout.startedTs) <= MATCH_WINDOW_S))
			.map((session) => session.path);
		if (hits.length === 0) continue;
		byWorkout.set(workout.id, hits);
		for (const path of hits) bySession.set(path, [...(bySession.get(path) ?? []), workout.id]);
	}
	return [...byWorkout.entries()].map(([workoutId, candidates]) => {
		const only = candidates.length === 1 ? (candidates[0] as string) : null;
		const matched = only !== null && bySession.get(only)?.length === 1;
		return { workoutId, sessionPath: matched ? only : null, status: matched ? "matched" : "ambiguous", candidates };
	});
}

export async function refreshWorkoutLinks(client: Database): Promise<number> {
	const present = (await client.query<Row>("select to_regclass('workouts.history_sessions') is not null and to_regclass('workouts.repo_files') is not null as ok")).rows[0];
	if (present?.["ok"] !== true) return 0;
	const sessions = (
		await client.query<Row>(
			`select s.path, s.session_date::text as day, s.modality, s.name, f.content->>'date' as started,
				coalesce((select string_agg(e.name, ' ') from workouts.history_exercises e where e.path = s.path), '') as exercises
			from workouts.history_sessions s left join workouts.repo_files f on f.path = s.path
			where s.kind = 'conditioning' and coalesce(s.status, 'completed') <> 'skipped'`,
		)
	).rows.map((row) => ({ path: String(row["path"]), day: String(row["day"]), modality: str(row["modality"]), name: String(row["name"]), started: str(row["started"]), exercises: String(row["exercises"]) }));
	const days = [...new Set(sessions.map((session) => session.day))];
	const workouts = (
		await client.query<Row>("select id, category, local_date::text as day, extract(epoch from started_at)::bigint as started from activity.withings_workouts where local_date = any($1::date[])", [days])
	).rows.map((row) => ({ id: Number(row["id"]), category: Number(row["category"]), day: String(row["day"]), startedTs: Number(row["started"]) }));
	const links = linkWorkouts(workouts, sessions);
	await client.query("delete from activity.withings_workout_links");
	if (links.length === 0) return 0;
	await client.query(
		`insert into activity.withings_workout_links (workout_id, session_path, status, candidates)
		select r.workout_id, r.session_path, r.status, array(select jsonb_array_elements_text(r.candidates))
		from jsonb_to_recordset($1::jsonb) as r (workout_id bigint, session_path text, status text, candidates jsonb)`,
		[JSON.stringify(links.map((link) => ({ workout_id: link.workoutId, session_path: link.sessionPath, status: link.status, candidates: link.candidates })))],
	);
	return links.length;
}

export type HealthDay = {
	date: string;
	steps: number | null;
	activeKcal: number | null;
	totalKcal: number | null;
	distanceM: number | null;
	dayHrAvg: number | null;
	dayHrMin: number | null;
	dayHrMax: number | null;
	restingHr: number | null;
	sleeps: number;
	sleepS: number | null;
	sleepScore: number | null;
	sleepHrAvg: number | null;
	sleepRrAvg: number | null;
	workouts: number;
	workoutKcal: number | null;
	workoutS: number | null;
};

export async function dailyHealth(client: Database, from: string, to: string): Promise<HealthDay[]> {
	const { rows } = await client.query<Row>("select *, day::text as date from activity.daily_health where day between $1 and $2 order by day", [from, to]);
	return rows.map((row) => ({
		date: String(row["date"]),
		steps: numOrNull(row["steps"]),
		activeKcal: numOrNull(row["active_kcal"]),
		totalKcal: numOrNull(row["total_kcal"]),
		distanceM: numOrNull(row["distance_m"]),
		dayHrAvg: numOrNull(row["day_hr_avg"]),
		dayHrMin: numOrNull(row["day_hr_min"]),
		dayHrMax: numOrNull(row["day_hr_max"]),
		restingHr: numOrNull(row["resting_hr"]),
		sleeps: Number(row["sleeps"] ?? 0),
		sleepS: numOrNull(row["sleep_s"]),
		sleepScore: numOrNull(row["sleep_score"]),
		sleepHrAvg: numOrNull(row["sleep_hr_avg"]),
		sleepRrAvg: numOrNull(row["sleep_rr_avg"]),
		workouts: Number(row["workouts"]),
		workoutKcal: numOrNull(row["workout_kcal"]),
		workoutS: numOrNull(row["workout_s"]),
	}));
}

export type Workout = {
	id: number;
	date: string;
	category: number;
	activity: string;
	startedAt: string;
	endedAt: string;
	durationS: number;
	distanceM: number | null;
	calories: number | null;
	steps: number | null;
	elevationM: number | null;
	hr: { avg: number | null; min: number | null; max: number | null; zonesS: (number | null)[] };
	poolLaps: number | null;
	model: string | null;
	session: { path: string | null; status: "matched" | "ambiguous"; candidates: string[] } | null;
};

export async function listWorkouts(client: Database, from: string, to: string): Promise<Workout[]> {
	const { rows } = await client.query<Row>(
		`select w.*, w.local_date::text as date, l.session_path, l.status, l.candidates
		from activity.withings_workouts w left join activity.withings_workout_links l on l.workout_id = w.id
		where w.local_date between $1 and $2 order by w.started_at`,
		[from, to],
	);
	return rows.map((row) => ({
		id: Number(row["id"]),
		date: String(row["date"]),
		category: Number(row["category"]),
		activity: WORKOUT_CATEGORIES[Number(row["category"])] ?? `category ${row["category"]}`,
		startedAt: isoOrNull(row["started_at"]) ?? "",
		endedAt: isoOrNull(row["ended_at"]) ?? "",
		durationS: Number(row["duration_s"]),
		distanceM: numOrNull(row["distance_m"]),
		calories: numOrNull(row["calories"]),
		steps: numOrNull(row["steps"]),
		elevationM: numOrNull(row["elevation_m"]),
		hr: {
			avg: numOrNull(row["hr_avg"]),
			min: numOrNull(row["hr_min"]),
			max: numOrNull(row["hr_max"]),
			zonesS: [numOrNull(row["hr_zone_0_s"]), numOrNull(row["hr_zone_1_s"]), numOrNull(row["hr_zone_2_s"]), numOrNull(row["hr_zone_3_s"])],
		},
		poolLaps: numOrNull(row["pool_laps"]),
		model: str(row["model"]),
		session: row["status"] === null || row["status"] === undefined ? null : { path: str(row["session_path"]), status: row["status"] as "matched" | "ambiguous", candidates: (row["candidates"] as string[]) ?? [] },
	}));
}

export async function listSleep(client: Database, from: string, to: string): Promise<Row[]> {
	const { rows } = await client.query<Row>(
		`select id::text as id, local_date::text as date, started_at, ended_at, timezone, model, model_id, device_hash, total_sleep_s, in_bed_s, light_s, deep_s, rem_s, awake_s,
			wakeup_count, sleep_latency_s, sleep_efficiency::float8 as sleep_efficiency, hr_avg, hr_min, hr_max, rr_avg, rr_min, rr_max, breathing_disturbances, snoring_s, sleep_score
		from activity.withings_sleep where local_date between $1 and $2 order by started_at`,
		[from, to],
	);
	return rows;
}

export async function listMeasures(client: Database, from: string, to: string, types: readonly number[] = []): Promise<Row[]> {
	const { rows } = await client.query<Row>(
		`select grpid::text as grpid, type, measured_at, value::float8 as value, attrib, model from activity.withings_measures
		where (measured_at at time zone '${TIME_ZONE}')::date between $1 and $2 and (cardinality($3::int[]) = 0 or type = any($3::int[]))
		order by measured_at, type`,
		[from, to, types],
	);
	return rows.map((row) => ({ ...row, name: MEASURE_TYPES[Number(row["type"])] ?? `type ${row["type"]}` }));
}

export async function intradayDay(client: Database, day: string): Promise<{ date: string; bucketS: number; samples: number; models: string[]; buckets: Bucket[] } | null> {
	const row = (await client.query<Row>("select bucket_s, samples, models, buckets from activity.withings_intraday where day = $1", [day])).rows[0];
	if (row === undefined) return null;
	return { date: day, bucketS: Number(row["bucket_s"]), samples: Number(row["samples"]), models: (row["models"] as string[]) ?? [], buckets: row["buckets"] as Bucket[] };
}
