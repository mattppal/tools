import type { Database } from "../../worker/db.ts";
import type { SleepStage } from "./apple-health.ts";
import { type HealthDay, offsetMs } from "./health.ts";
import { TIME_ZONE } from "./weights.ts";

export type Segment = { source: string; stage: SleepStage; start: number; end: number; offsetMin: number };
export type Sample = { metric: string; source: string; at: number; offsetMin: number; value: number };
export type WithingsNight = {
	start: number;
	end: number;
	timezone: string | null;
	asleepS: number | null;
	inBedS: number | null;
	lightS: number | null;
	deepS: number | null;
	remS: number | null;
	awakeS: number | null;
	hrMin: number | null;
	rrAvg: number | null;
};

export type TimelineStage = "awake" | "rem" | "light" | "deep" | "asleep";
export type StageSpan = { stage: TimelineStage; startS: number; endS: number };

export type Night = {
	date: string;
	source: string;
	bedtime: string;
	wake: string;
	inBedFrom: string;
	inBedTo: string;
	asleepS: number;
	inBedS: number;
	lightS: number | null;
	deepS: number | null;
	remS: number | null;
	awakeS: number | null;
	timeline: StageSpan[];
	restingHr: number | null;
	hrv: number | null;
	respiratoryRate: number | null;
	alsoFrom: string[];
};

type Candidate = Omit<Night, "restingHr" | "hrv" | "respiratoryRate" | "alsoFrom"> & {
	bedStart: number;
	bedEnd: number;
	sleepStart: number;
	sleepEnd: number;
	restingHr: number | null;
	respiratoryRate: number | null;
};

const GAP_MS = 2 * 3600_000;
const PARTIAL_EDGE_MS = 90 * 60_000;
const PARTIAL_LONGER_S = 60 * 60;
const VITALS_AFTER_MS = 3600_000;
const ASLEEP = new Set<SleepStage>(["asleep", "core", "deep", "rem", "unspecified"]);
const TIMELINE: Partial<Record<SleepStage, TimelineStage>> = { awake: "awake", rem: "rem", core: "light", deep: "deep", asleep: "asleep", unspecified: "asleep" };
const WITHINGS = "Withings";

const localIso = (ms: number, offsetMin: number) => new Date(ms + offsetMin * 60_000).toISOString();
const clock = (ms: number, offsetMin: number) => localIso(ms, offsetMin).slice(11, 16);
const seconds = (ms: number) => Math.round(ms / 1000);
const mean = (values: number[]) => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);

export function sourceRank(source: string): number {
	if (/eight ?sleep/i.test(source)) return 0;
	return source === WITHINGS ? 2 : 1;
}

function partialEightSleep(eight: Candidate, watch: Candidate): boolean {
	const missed = Math.max(eight.bedStart - watch.sleepStart, watch.sleepEnd - eight.bedEnd);
	return missed >= PARTIAL_EDGE_MS && watch.asleepS - eight.asleepS >= PARTIAL_LONGER_S;
}

function pick(list: readonly Candidate[]): Candidate[] {
	const ranked = list.toSorted((a, b) => sourceRank(a.source) - sourceRank(b.source) || b.asleepS - a.asleepS);
	const [first] = ranked;
	const watch = ranked.find((candidate) => /apple watch/i.test(candidate.source));
	if (first === undefined || watch === undefined || sourceRank(first.source) !== 0 || !partialEightSleep(first, watch)) return ranked;
	return [watch, ...ranked.filter((candidate) => candidate !== watch)];
}

function sessions(segments: readonly Segment[]): Segment[][] {
	const bySource = new Map<string, Segment[]>();
	for (const segment of segments) bySource.set(segment.source, [...(bySource.get(segment.source) ?? []), segment]);
	const result: Segment[][] = [];
	for (const list of bySource.values()) {
		let current: Segment[] = [];
		let end = -Infinity;
		for (const segment of list.toSorted((a, b) => a.start - b.start)) {
			if (current.length > 0 && segment.start - end > GAP_MS) {
				result.push(current);
				current = [];
				end = -Infinity;
			}
			current.push(segment);
			end = Math.max(end, segment.end);
		}
		if (current.length > 0) result.push(current);
	}
	return result;
}

function appleCandidate(session: readonly Segment[]): Candidate | null {
	const sleeping = session.filter((segment) => ASLEEP.has(segment.stage));
	const first = sleeping[0];
	if (first === undefined) return null;
	const total = (stage: SleepStage) => seconds(session.filter((segment) => segment.stage === stage).reduce((sum, segment) => sum + segment.end - segment.start, 0));
	const bedStart = Math.min(...session.map((segment) => segment.start));
	const bedEnd = Math.max(...session.map((segment) => segment.end));
	const sleepStart = Math.min(...sleeping.map((segment) => segment.start));
	const sleepEnd = Math.max(...sleeping.map((segment) => segment.end));
	const offset = session.reduce((last, segment) => (segment.end > last.end ? segment : last)).offsetMin;
	const staged = session.some((segment) => segment.stage === "core" || segment.stage === "deep" || segment.stage === "rem");
	return {
		date: localIso(sleepEnd, offset).slice(0, 10),
		source: first.source,
		bedtime: clock(sleepStart, offset),
		wake: clock(sleepEnd, offset),
		inBedFrom: clock(bedStart, offset),
		inBedTo: clock(bedEnd, offset),
		asleepS: total("asleep") + total("unspecified") + total("core") + total("deep") + total("rem"),
		inBedS: seconds(bedEnd - bedStart),
		lightS: staged ? total("core") : null,
		deepS: staged ? total("deep") : null,
		remS: staged ? total("rem") : null,
		awakeS: total("awake"),
		timeline: session
			.flatMap((segment) => {
				const stage = TIMELINE[segment.stage];
				return stage === undefined ? [] : [{ stage, startS: seconds(segment.start - bedStart), endS: seconds(segment.end - bedStart) }];
			})
			.toSorted((a, b) => a.startS - b.startS),
		bedStart,
		bedEnd,
		sleepStart,
		sleepEnd,
		restingHr: null,
		respiratoryRate: null,
	};
}

function withingsCandidate(night: WithingsNight): Candidate {
	const offset = offsetMs(night.end, night.timezone ?? TIME_ZONE) / 60_000;
	return {
		date: localIso(night.end, offset).slice(0, 10),
		source: WITHINGS,
		bedtime: clock(night.start, offset),
		wake: clock(night.end, offset),
		inBedFrom: clock(night.start, offset),
		inBedTo: clock(night.end, offset),
		asleepS: night.asleepS ?? (night.lightS ?? 0) + (night.deepS ?? 0) + (night.remS ?? 0),
		inBedS: night.inBedS ?? seconds(night.end - night.start),
		lightS: night.lightS,
		deepS: night.deepS,
		remS: night.remS,
		awakeS: night.awakeS,
		timeline: [],
		bedStart: night.start,
		bedEnd: night.end,
		sleepStart: night.start,
		sleepEnd: night.end,
		restingHr: night.hrMin,
		respiratoryRate: night.rrAvg,
	};
}

function sourced(samples: readonly Sample[], source: string): Sample[] {
	const own = samples.filter((sample) => sample.source === source);
	return own.length > 0 ? own : [...samples];
}

export function buildNights(segments: readonly Segment[], samples: readonly Sample[], withings: readonly WithingsNight[]): Night[] {
	const byDate = new Map<string, Candidate[]>();
	const candidates = [...sessions(segments).flatMap((session) => appleCandidate(session) ?? []), ...withings.map(withingsCandidate)];
	for (const candidate of candidates) byDate.set(candidate.date, [...(byDate.get(candidate.date) ?? []), candidate]);
	return [...byDate.entries()]
		.toSorted(([a], [b]) => a.localeCompare(b))
		.flatMap(([date, list]) => {
			const ranked = pick(list);
			const chosen = ranked[0];
			if (chosen === undefined) return [];
			const { bedStart, bedEnd, sleepStart, sleepEnd, ...night } = chosen;
			const during = (metric: string) => samples.filter((sample) => sample.metric === metric && sample.at >= bedStart && sample.at <= bedEnd + VITALS_AFTER_MS);
			const resting = sourced(
				samples.filter((sample) => sample.metric === "resting_heart_rate" && localIso(sample.at, sample.offsetMin).slice(0, 10) === date),
				chosen.source,
			).toSorted((a, b) => b.at - a.at)[0];
			const hrv = mean(sourced(during("heart_rate_variability"), chosen.source).map((sample) => sample.value));
			const breathing = mean(sourced(during("respiratory_rate"), chosen.source).map((sample) => sample.value));
			return [
				{
					...night,
					restingHr: resting === undefined ? night.restingHr : Math.round(resting.value),
					hrv: hrv === null ? null : Math.round(hrv),
					respiratoryRate: breathing === null ? night.respiratoryRate : Math.round(breathing * 10) / 10,
					alsoFrom: [...new Set(ranked.slice(1).map((candidate) => candidate.source))].filter((source) => source !== chosen.source),
				},
			];
		});
}

const EMPTY_DAY: Omit<HealthDay, "date"> = {
	steps: null,
	activeKcal: null,
	totalKcal: null,
	distanceM: null,
	dayHrAvg: null,
	dayHrMin: null,
	dayHrMax: null,
	restingHr: null,
	sleeps: 0,
	sleepS: null,
	sleepScore: null,
	sleepHrAvg: null,
	sleepRrAvg: null,
	workouts: 0,
	workoutKcal: null,
	workoutS: null,
};

export function withNights(days: readonly HealthDay[], nights: readonly Night[]): HealthDay[] {
	const byDate = new Map(days.map((day) => [day.date, day]));
	for (const night of nights) {
		if (night.source === WITHINGS) continue;
		const day = byDate.get(night.date) ?? { date: night.date, ...EMPTY_DAY };
		byDate.set(night.date, {
			...day,
			restingHr: night.restingHr ?? day.restingHr,
			sleeps: 1,
			sleepS: night.asleepS,
			sleepScore: null,
			sleepHrAvg: null,
			sleepRrAvg: night.respiratoryRate,
		});
	}
	return [...byDate.values()].toSorted((a, b) => a.date.localeCompare(b.date));
}

type Row = Record<string, unknown>;
const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

export async function listNights(client: Database, from: string, to: string): Promise<Night[]> {
	const window = [from, to];
	const segments = await client.query<Row>(
		`select source, stage, (extract(epoch from started_at) * 1000)::float8 as start, (extract(epoch from ended_at) * 1000)::float8 as end_ms, utc_offset_min
		from activity.apple_health_sleep where ended_at >= $1::date - 1 and started_at < $2::date + 2`,
		window,
	);
	const samples = await client.query<Row>(
		`select metric, source, (extract(epoch from measured_at) * 1000)::float8 as at, utc_offset_min, coalesce(qty, avg)::float8 as value
		from activity.apple_health_samples
		where metric in ('resting_heart_rate', 'heart_rate_variability', 'respiratory_rate') and measured_at >= $1::date - 1 and measured_at < $2::date + 2
			and coalesce(qty, avg) is not null`,
		window,
	);
	const withings = await client.query<Row>(
		`select (extract(epoch from started_at) * 1000)::float8 as start, (extract(epoch from ended_at) * 1000)::float8 as end_ms, timezone, total_sleep_s, in_bed_s,
			light_s, deep_s, rem_s, awake_s, hr_min, rr_avg
		from activity.withings_sleep where local_date between $1::date - 1 and $2::date + 1`,
		window,
	);
	const nights = buildNights(
		segments.rows.map((row) => ({ source: String(row["source"]), stage: row["stage"] as SleepStage, start: Number(row["start"]), end: Number(row["end_ms"]), offsetMin: Number(row["utc_offset_min"]) })),
		samples.rows.map((row) => ({ metric: String(row["metric"]), source: String(row["source"]), at: Number(row["at"]), offsetMin: Number(row["utc_offset_min"]), value: Number(row["value"]) })),
		withings.rows.map((row) => ({
			start: Number(row["start"]),
			end: Number(row["end_ms"]),
			timezone: row["timezone"] === null ? null : String(row["timezone"]),
			asleepS: num(row["total_sleep_s"]),
			inBedS: num(row["in_bed_s"]),
			lightS: num(row["light_s"]),
			deepS: num(row["deep_s"]),
			remS: num(row["rem_s"]),
			awakeS: num(row["awake_s"]),
			hrMin: num(row["hr_min"]),
			rrAvg: num(row["rr_avg"]),
		})),
	);
	return nights.filter((night) => night.date >= from && night.date <= to);
}
