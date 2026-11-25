import { PGlite } from "@electric-sql/pglite";
import { beforeEach, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database, WithDb } from "../../worker/db.ts";
import { activityApi } from "./api.ts";
import { MAX_BODY_BYTES, parseDate } from "./apple-health.ts";
import debug from "./debug.ts";

const pg = new PGlite();
const migrationsDir = join(import.meta.dirname, "migrations");
const migrations = await Promise.all((await readdir(migrationsDir)).toSorted().map((name) => readFile(join(migrationsDir, name), "utf-8")));
await pg.exec(`create schema activity; set search_path to activity; ${migrations.join(";\n")}; set search_path to public;`);
const client: Database = {
	query: async (text: string, values?: unknown[]) => {
		const result = await pg.query(text, values);
		return { ...result, rowCount: result.affectedRows ?? result.rows.length };
	},
} as never;
const db: WithDb = (work) => work(client);

const sample = async (name: string): Promise<string> => readFile(join(import.meta.dirname, "samples", `hae-${name}.json`), "utf-8");
const TOKEN = "apple-health-token-5c2e";
const env = { BOT_TOKEN_APPLE_HEALTH: TOKEN, BOT_TOKEN_NUTRITION: "nutrition-token" } as Env;
const api = activityApi(async () => Response.json({}));
const ctx = {} as ExecutionContext;

function post(body: string, authorization: string | null = `Bearer ${TOKEN}`, path = "/apple-health", aggregation = "Default"): Promise<Response> {
	const headers: Record<string, string> = { "content-type": "application/json", "automation-name": "Tools sleep", "session-id": "session-1", "automation-aggregation": aggregation };
	if (authorization !== null) headers["authorization"] = authorization;
	return Promise.resolve(api(new Request(`https://tools.mattpalmer.io/api/tools/activity${path}`, { method: "POST", headers, body }), { env, ctx, path, db, caller: { kind: "local" } }));
}

async function get(path: string): Promise<Response> {
	return api(new Request(`https://tools.mattpalmer.io/api/tools/activity${path}`), { env, ctx, path: path.split("?")[0] ?? path, db, caller: { kind: "bot", bot: "coach" } });
}

const rows = async (sql: string) => (await pg.query<Record<string, unknown>>(sql)).rows;

beforeEach(async () => {
	await pg.exec(
		"delete from activity.apple_health_sleep; delete from activity.apple_health_samples; delete from activity.apple_health_workouts; delete from activity.apple_health_pushes; delete from activity.withings_workouts;",
	);
});

test("only the Apple Health token may push, and other bots' tokens are refused", async () => {
	const body = await sample("metrics");
	expect((await post(body, null)).status).toBe(401);
	expect((await post(body, "Bearer nutrition-token")).status).toBe(403);
	expect((await post(body, `Bearer ${TOKEN}x`)).status).toBe(401);
	expect(await rows("select * from activity.apple_health_sleep")).toEqual([]);
});

test("a metrics push stores sleep stages and samples by source, and drops what Withings wrote", async () => {
	const response = await post(await sample("metrics"));
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({
		received: { sleep: 16, samples: 6, workouts: 0 },
		changed: { sleep: 16, samples: 6, workouts: 0 },
		skipped: { withings: 2, invalid: 1, unlisted: 0 },
		metrics: ["heart_rate", "heart_rate_variability", "respiratory_rate", "resting_heart_rate", "sleep_analysis"],
		unlisted: [],
		days: 0,
		warnings: [],
	});
	const sources = await rows("select source, count(*)::int as n from activity.apple_health_sleep group by source order by source");
	expect(sources).toEqual([
		{ source: "Eight Sleep", n: 13 },
		{ source: "Matt’s Apple Watch", n: 3 },
	]);
	const bed = await rows("select stage, started_at::text as started, ended_at::text as ended, utc_offset_min from activity.apple_health_sleep where stage = 'in_bed'");
	expect(bed).toEqual([{ stage: "in_bed", started: "2026-11-21 06:48:00+00", ended: "2026-11-21 14:52:00+00", utc_offset_min: -480 }]);
	const samples = await rows("select metric, source, qty::float8 as qty, min::float8 as min, avg::float8 as avg, max::float8 as max, units from activity.apple_health_samples order by metric, measured_at");
	expect(samples).toEqual([
		{ metric: "heart_rate", source: "Matt’s Apple Watch", qty: null, min: 49, avg: 53, max: 58, units: "count/min" },
		{ metric: "heart_rate_variability", source: "Matt’s Apple Watch", qty: 48.2, min: null, avg: null, max: null, units: "ms" },
		{ metric: "heart_rate_variability", source: "Matt’s Apple Watch", qty: 61.7, min: null, avg: null, max: null, units: "ms" },
		{ metric: "heart_rate_variability", source: "Eight Sleep", qty: 57, min: null, avg: null, max: null, units: "ms" },
		{ metric: "respiratory_rate", source: "Eight Sleep", qty: 14.6, min: null, avg: null, max: null, units: "count/min" },
		{ metric: "resting_heart_rate", source: "Matt’s Apple Watch", qty: 52, min: null, avg: null, max: null, units: "count/min" },
	]);
});

test("pushing the same export again changes nothing, and an edited segment changes one row", async () => {
	const body = await sample("metrics");
	await post(body);
	const again = (await (await post(body)).json()) as { changed: Record<string, number> };
	expect(again.changed).toEqual({ sleep: 0, samples: 0, workouts: 0 });
	const edited = body.replace('"end": "2026-11-21 06:30:00 -0800",\n\t\t\t\t\t\t"startDate": "2026-11-21 06:22:00 -0800",\n\t\t\t\t\t\t"endDate": "2026-11-21 06:30:00 -0800"', '"end": "2026-11-21 06:35:00 -0800",\n\t\t\t\t\t\t"startDate": "2026-11-21 06:22:00 -0800",\n\t\t\t\t\t\t"endDate": "2026-11-21 06:35:00 -0800"');
	expect(edited).not.toBe(body);
	const after = (await (await post(edited)).json()) as { changed: Record<string, number> };
	expect(after.changed).toEqual({ sleep: 1, samples: 0, workouts: 0 });
	expect(await rows("select count(*)::int as n from activity.apple_health_sleep")).toEqual([{ n: 16 }]);
});

test("a workouts push keeps Apple Watch workouts in metric units without the route, skips Withings', and flags overlap with a Withings workout", async () => {
	const response = await post(await sample("workouts"));
	expect(await response.json()).toEqual({
		received: { sleep: 0, samples: 0, workouts: 1 },
		changed: { sleep: 0, samples: 0, workouts: 1 },
		skipped: { withings: 1, invalid: 0, unlisted: 0 },
		metrics: [],
		unlisted: [],
		days: 0,
		warnings: [],
	});
	const [stored] = await rows("select data from activity.apple_health_workouts");
	expect(Object.keys(stored?.["data"] as object)).not.toContain("route");
	expect(Object.keys(stored?.["data"] as object)).toContain("heartRateData");
	await pg.query(
		`insert into activity.withings_workouts (id, category, local_date, started_at, ended_at, duration_s, data) values (901, 2, '2026-11-21', '2026-11-21T15:31:00Z', '2026-11-21T16:04:00Z', 1980, '{}')`,
	);
	const list = (await (await get("/apple-health/workouts?from=2026-11-21&to=2026-11-21")).json()) as { workouts: unknown[] };
	expect(list.workouts).toEqual([
		{
			id: "6E2B7C1A-4F0D-4B57-9C3E-2A8F51D0B7E4",
			date: "2026-11-21",
			name: "Outdoor Run",
			source: "Matt’s Apple Watch",
			startedAt: "2026-11-21T15:30:00.000Z",
			endedAt: "2026-11-21T16:05:10.000Z",
			durationS: 2110,
			activeKcal: 402.6,
			totalKcal: 471.3,
			distanceM: 5825.8,
			elevationM: 29.9,
			hr: { avg: 148, min: 96, max: 171 },
			location: "Outdoor",
			withingsId: "901",
		},
	]);
});

test("summarized sleep is dropped with a warning, and the rest of the push still lands", async () => {
	const response = await post(await sample("summarized-sleep"));
	expect(response.status).toBe(200);
	const counts = (await response.json()) as { received: unknown; skipped: unknown; warnings: string[] };
	expect(counts.received).toEqual({ sleep: 0, samples: 0, workouts: 0 });
	expect(counts.skipped).toEqual({ withings: 0, invalid: 0, unlisted: 1 });
	expect(counts.warnings).toEqual([expect.stringContaining("Deselect Sleep Analysis")]);
	expect(await rows("select * from activity.apple_health_samples")).toEqual([]);
	expect(await rows("select * from activity.apple_health_sleep")).toEqual([]);
	const debugRows = await debug({ env: {} as Env, db });
	expect(debugRows.find((row) => row.label === "Apple Health: Tools sleep")?.value).toContain("Deselect Sleep Analysis");
});

test("a body that isn't Health Auto Export JSON is a 422", async () => {
	for (const body of ["not json", "{}", '{"data":{"metrics":[{"name":"step_count","data":[{"qty":1']) {
		const response = await post(body);
		expect(response.status).toBe(422);
	}
});

test("Settings shows each automation's last push", async () => {
	await post(await sample("metrics"));
	const debugRows = await debug({ env: {} as Env, db });
	expect(debugRows.find((row) => row.label === "Apple Health: Tools sleep")?.value).toMatch(
		/^Last push \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\. 16 sleep segments, 6 samples from 5 metrics, 0 workouts; 22 new or changed\. Skipped 2 from Withings, 1 unreadable, 0 from metrics tools doesn't keep\.$/,
	);
});

test("a pushed night reads back as Eight Sleep's, with its own HRV and breathing and the watch's resting HR", async () => {
	await post(await sample("metrics"));
	const { nights } = (await (await get("/nights?from=2026-11-20&to=2026-11-21")).json()) as { nights: Record<string, unknown>[] };
	expect(nights).toHaveLength(1);
	const { timeline, ...night } = nights[0] ?? {};
	expect(night).toEqual({
		date: "2026-11-21",
		source: "Eight Sleep",
		bedtime: "23:02",
		wake: "06:22",
		inBedFrom: "22:48",
		inBedTo: "06:52",
		asleepS: 25_980,
		inBedS: 29_040,
		lightS: 16_080,
		deepS: 3540,
		remS: 6360,
		awakeS: 900,
		restingHr: 52,
		hrv: 57,
		respiratoryRate: 14.6,
		alsoFrom: ["Matt’s Apple Watch"],
	});
	expect((timeline as unknown[]).slice(0, 3)).toEqual([
		{ stage: "light", startS: 840, endS: 4320 },
		{ stage: "deep", startS: 4320, endS: 6180 },
		{ stage: "light", startS: 6180, endS: 9240 },
	]);
});

test("dates keep the phone's offset and local date", () => {
	expect(parseDate("2026-11-21 06:12:44 -0800")).toEqual({ iso: "2026-11-21T06:12:44-08:00", ms: Date.parse("2026-11-21T14:12:44Z"), offsetMin: -480, localDate: "2026-11-21" });
	expect(parseDate("2026-03-08 03:30:00 -0700")?.offsetMin).toBe(-420);
	expect(parseDate("2026-11-21 06:12:44 +0530")?.ms).toBe(Date.parse("2026-11-21T00:42:44Z"));
	expect(parseDate("2026-11-21T06:12:44")).toBeNull();
	expect(parseDate(1_800_000_000)).toBeNull();
});

test("kept metrics are stored whatever their shape or key order, by source and time, with their other fields kept, and the rest are counted and dropped", async () => {
	const response = await post(await sample("all-metrics"));
	expect(await response.json()).toEqual({
		received: { sleep: 0, samples: 14, workouts: 0 },
		changed: { sleep: 0, samples: 14, workouts: 0 },
		skipped: { withings: 1, invalid: 0, unlisted: 7 },
		metrics: ["active_energy", "apple_sleeping_wrist_temperature", "basal_energy_burned", "heart_rate_variability", "step_count", "walking_running_distance"],
		unlisted: ["a_metric_from_ios_28", "blood_glucose", "blood_pressure", "handwashing", "sexual_activity"],
		days: 2,
		warnings: [],
	});
	const stored = await rows(
		"select metric, source, qty::float8 as qty, ended_at::text as ended, units, extra from activity.apple_health_samples where metric not in ('step_count', 'walking_running_distance', 'active_energy', 'basal_energy_burned') order by metric",
	);
	expect(stored).toEqual([
		{ metric: "apple_sleeping_wrist_temperature", source: "Matt’s Apple Watch", qty: -0.21, ended: null, units: "degC", extra: null },
		{ metric: "heart_rate_variability", source: "Matt’s Apple Watch", qty: 41.3, ended: null, units: "ms", extra: { heartbeats: [{ t: 0, bpm: 51 }, { t: 1.18, bpm: 50 }] } },
	]);
	const again = (await (await post(await sample("all-metrics"))).json()) as { changed: unknown };
	expect(again.changed).toEqual({ sleep: 0, samples: 0, workouts: 0 });
});

test("daily steps take the one Apple source with the most steps each local day, and each day keeps whichever of Withings and Apple has more", async () => {
	await post(await sample("all-metrics"));
	const days = await rows(
		"select day::text as day, steps, active_kcal::float8 as active, total_kcal::float8 as total, distance_m::float8 as distance, device, raw from activity.days where source = 'apple_health' order by day",
	);
	expect(days).toEqual([
		{ day: "2026-11-20", steps: 5580, active: 319.5, total: 2049.5, distance: 3800, device: "Matt’s iPhone", raw: { steps: { "Matt’s iPhone": 5580, "Matt’s Apple Watch": 5212 } } },
		{ day: "2026-11-21", steps: 2100, active: null, total: null, distance: null, device: "Matt’s Apple Watch", raw: { steps: { "Matt’s Apple Watch": 2100 } } },
	]);
	expect(await rows("select day::text as day, source, steps from activity.daily_activity order by day")).toEqual([
		{ day: "2026-11-20", source: "apple_health", steps: 5580 },
		{ day: "2026-11-21", source: "apple_health", steps: 2100 },
	]);
	await pg.query(
		"insert into activity.days (day, source, steps, active_kcal, updated_by) values ('2026-11-20', 'withings', 4100, 350, 'withings'), ('2026-11-21', 'withings', 0, 0, 'withings')",
	);
	expect(await rows("select day::text as day, source, steps from activity.daily_activity order by day")).toEqual([
		{ day: "2026-11-20", source: "apple_health", steps: 5580 },
		{ day: "2026-11-21", source: "apple_health", steps: 2100 },
	]);
	await pg.query("update activity.days set total_kcal = 2010, elevation_m = 12, moderate_s = 900 where source = 'withings' and day = '2026-11-20'");
	expect(
		await rows(
			"select day::text as day, source, steps, active_kcal::float8 as active, total_kcal::float8 as total, distance_m::float8 as distance, elevation_m::float8 as elevation, moderate_s from activity.daily_activity order by day",
		),
	).toEqual([
		{ day: "2026-11-20", source: "apple_health", steps: 5580, active: 350, total: 2010, distance: 3800, elevation: 12, moderate_s: 900 },
		{ day: "2026-11-21", source: "apple_health", steps: 2100, active: 0, total: null, distance: null, elevation: null, moderate_s: null },
	]);
	await pg.query("update activity.days set steps = 7100 where source = 'withings' and day = '2026-11-20'");
	expect(await rows("select day::text as day, source, steps from activity.daily_activity where day = '2026-11-20'")).toEqual([{ day: "2026-11-20", source: "withings", steps: 7100 }]);
	const later = JSON.stringify({
		data: { metrics: [{ name: "step_count", units: "count", data: [{ qty: 400, date: "2026-11-21 18:00:00 -0800", source: "Matt’s Apple Watch" }] }] },
	});
	await post(later);
	expect(await rows("select steps from activity.days where source = 'apple_health' and day = '2026-11-21'")).toEqual([{ steps: 2500 }]);
});

test("a body streamed one byte at a time stores the same rows as one chunk", async () => {
	const body = new TextEncoder().encode(await sample("all-metrics"));
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const byte of body) controller.enqueue(new Uint8Array([byte]));
			controller.close();
		},
	});
	const request = new Request("https://tools.mattpalmer.io/api/tools/activity/apple-health", {
		method: "POST",
		headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "automation-name": "Tools sleep" },
		body: stream,
	});
	const response = await api(request, { env, ctx, path: "/apple-health", db, caller: { kind: "local" } });
	expect(((await response.json()) as { received: unknown }).received).toEqual({ sleep: 0, samples: 14, workouts: 0 });
	expect(await rows("select count(*)::int as n from activity.apple_health_samples")).toEqual([{ n: 14 }]);
});

test("a body over the size limit is a 413 that says to batch, before anything is read", async () => {
	const response = await api(
		new Request("https://tools.mattpalmer.io/api/tools/activity/apple-health", {
			method: "POST",
			headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "content-length": String(MAX_BODY_BYTES + 1) },
			body: "{}",
		}),
		{ env, ctx, path: "/apple-health", db, caller: { kind: "local" } },
	);
	expect(response.status).toBe(413);
	expect(((await response.json()) as { error: string }).error).toContain("Batch Requests");
});

const perSecond = (metric: string, units: string, from: string, seconds: number, qty: number) => ({
	name: metric,
	units,
	data: Array.from({ length: seconds }, (_, index) => {
		const at = new Date(Date.parse(from) + index * 1000 - 8 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
		return { date: `${at} -0800`, qty };
	}),
});

const dailySteps = async () =>
	rows(`select (measured_at at time zone 'UTC' + make_interval(mins => utc_offset_min))::date::text as day, metric, round(sum(qty), 6)::float8 as total
		from activity.apple_health_samples group by 1, 2 order by 1, 2`);

test("per-second steps and distance compact into hourly rows with the same daily totals, and hourly summaries replace leftovers", async () => {
	const seconds = { data: { metrics: [perSecond("step_count", "count", "2026-11-21T07:59:30Z", 90, 0.25), perSecond("walking_running_distance", "km", "2026-11-21T23:59:50Z", 20, 0.001)] } };
	expect(await (await post(JSON.stringify(seconds))).json()).toMatchObject({ received: { samples: 110 }, changed: { samples: 110 } });
	const before = await dailySteps();
	expect(before).toEqual([
		{ day: "2026-11-20", metric: "step_count", total: 7.5 },
		{ day: "2026-11-21", metric: "step_count", total: 15 },
		{ day: "2026-11-21", metric: "walking_running_distance", total: 0.02 },
	]);
	const daysBefore = await rows("select day::text, source, steps from activity.days order by day, source");

	await pg.exec(`set search_path to activity; ${await readFile(join(migrationsDir, "0006-hourly-step-distance.sql"), "utf-8")}; set search_path to public;`);
	expect(await dailySteps()).toEqual(before);
	expect(await rows("select metric, measured_at::text, ended_at::text, round(qty, 6)::float8 as qty from activity.apple_health_samples order by metric, measured_at")).toEqual([
		{ metric: "step_count", measured_at: "2026-11-21 07:00:00+00", ended_at: "2026-11-21 08:00:00+00", qty: 7.5 },
		{ metric: "step_count", measured_at: "2026-11-21 08:00:00+00", ended_at: "2026-11-21 09:00:00+00", qty: 15 },
		{ metric: "walking_running_distance", measured_at: "2026-11-21 23:00:00+00", ended_at: "2026-11-22 00:00:00+00", qty: 0.01 },
		{ metric: "walking_running_distance", measured_at: "2026-11-22 00:00:00+00", ended_at: "2026-11-22 01:00:00+00", qty: 0.01 },
	]);
	expect(await rows("select day::text, source, steps from activity.days order by day, source")).toEqual(daysBefore);

	await post(JSON.stringify(seconds));
	expect(await rows("select count(*)::int as n from activity.apple_health_samples")).toEqual([{ n: 4 }]);

	const hourly = { data: { metrics: [{ name: "step_count", units: "count", data: [{ date: "2026-11-21 00:00:00 -0800", qty: 40 }] }] } };
	await post(JSON.stringify({ data: { metrics: [perSecond("step_count", "count", "2026-11-21T08:10:00Z", 5, 1)] } }));
	expect(await (await post(JSON.stringify(hourly), `Bearer ${TOKEN}`, "/apple-health", "hours")).json()).toMatchObject({ changed: { samples: 1 } });
	expect(await rows("select measured_at::text, ended_at::text, qty::float8 from activity.apple_health_samples where metric = 'step_count' order by measured_at")).toEqual([
		{ measured_at: "2026-11-21 07:00:00+00", ended_at: "2026-11-21 08:00:00+00", qty: 7.5 },
		{ measured_at: "2026-11-21 08:00:00+00", ended_at: "2026-11-21 09:00:00+00", qty: 40 },
	]);
	expect(await rows("select day::text, steps from activity.days where source = 'apple_health' order by day")).toEqual([
		{ day: "2026-11-20", steps: 8 },
		{ day: "2026-11-21", steps: 40 },
	]);
});

type Tick = { metric: string; units: string; source?: string; at: number; offsetH: number; qty: number };

const stamp = (at: number, offsetH: number) => {
	const local = new Date(at + offsetH * 3600_000).toISOString().slice(0, 19).replace("T", " ");
	const sign = offsetH < 0 ? "-" : "+";
	return `${local} ${sign}${String(Math.abs(offsetH)).padStart(2, "0")}00`;
};

const pushTicks = (ticks: Tick[]) => {
	const metrics = new Map<string, { name: string; units: string; data: Record<string, unknown>[] }>();
	for (const tick of ticks) {
		const metric = metrics.get(tick.metric) ?? { name: tick.metric, units: tick.units, data: [] };
		metrics.set(tick.metric, metric);
		metric.data.push({ date: stamp(tick.at, tick.offsetH), qty: tick.qty, ...(tick.source === undefined ? {} : { source: tick.source }) });
	}
	return post(JSON.stringify({ data: { metrics: [...metrics.values()] } }));
};

const START = Date.parse("2026-11-21T05:00:00Z");
const day = (): Tick[] =>
	Array.from({ length: 6 * 3600 }, (_, s) => s).flatMap((s): Tick[] => {
		const at = START + s * 1000;
		const ticks: Tick[] = [];
		if (s % 3 === 0) ticks.push({ metric: "step_count", units: "count", at, offsetH: -8, qty: 0.37 + (s % 7) / 10 });
		if (s % 5 === 0) ticks.push({ metric: "walking_running_distance", units: "km", at, offsetH: -8, qty: 0.000731 });
		if (s % 4 === 0) ticks.push({ metric: "active_energy", units: "kJ", at, offsetH: -8, qty: 0.0913 });
		if (s % 6 === 0) ticks.push({ metric: "basal_energy_burned", units: "kcal", at, offsetH: -8, qty: 0.0187 });
		if (s % 300 === 0) ticks.push({ metric: "step_count", units: "count", source: "Matt’s iPhone", at, offsetH: -8, qty: 31 });
		return ticks;
	});

const totals = async () =>
	rows(`select (measured_at at time zone 'UTC' + make_interval(mins => utc_offset_min))::date::text as day, metric, source, sum(qty)::text as total
		from activity.apple_health_samples group by 1, 2, 3 order by 1, 2, 3`);
const daysRows = async () => rows("select day::text, steps, active_kcal::text, total_kcal::text, distance_m::text, device, raw from activity.days order by day");
const resetSamples = () => pg.exec("delete from activity.apple_health_samples; delete from activity.days;");

async function hourByHour(ticks: Tick[]): Promise<void> {
	const hours = [...new Set(ticks.map((tick) => Math.floor(tick.at / 3600_000)))].toSorted((a, b) => a - b);
	for (const hour of hours) await pushTicks(ticks.filter((tick) => Math.floor(tick.at / 3600_000) === hour));
}

test("a per-second push writes one row per interior hour with the same daily totals and days as raw rows, and changes nothing when sent again", async () => {
	const ticks = day();
	await resetSamples();
	await hourByHour(ticks);
	const rawTotals = await totals();
	const rawDays = await daysRows();
	const rawRows = (await rows("select count(*)::int as n from activity.apple_health_samples"))[0]?.["n"];
	expect(rawRows).toBe(ticks.length);
	await resetSamples();

	const response = (await (await pushTicks(ticks)).json()) as { received: { samples: number }; changed: { samples: number } };
	expect(response.received.samples).toBe(ticks.length);
	expect(response.changed.samples).toBe(ticks.length);
	expect(await totals()).toEqual(rawTotals);
	expect(await daysRows()).toEqual(rawDays);
	expect(rawDays.map((row) => row["day"])).toEqual(["2026-11-20", "2026-11-21"]);
	const stored = await rows("select metric, source, count(*)::int as n, count(*) filter (where extra ? 'seconds')::int as hours from activity.apple_health_samples group by 1, 2 order by 1, 2");
	expect(stored).toEqual([
		{ metric: "active_energy", source: "Apple Health", n: 900 + 900 + 4, hours: 4 },
		{ metric: "basal_energy_burned", source: "Apple Health", n: 600 + 600 + 4, hours: 4 },
		{ metric: "step_count", source: "Apple Health", n: 1200 + 1200 + 4, hours: 4 },
		{ metric: "step_count", source: "Matt’s iPhone", n: 12 + 12 + 4, hours: 4 },
		{ metric: "walking_running_distance", source: "Apple Health", n: 720 + 720 + 4, hours: 4 },
	]);
	expect(await rows("select measured_at::text, ended_at::text, extra from activity.apple_health_samples where extra is not null and metric = 'step_count' and source = 'Apple Health' order by measured_at limit 1")).toEqual([
		{ measured_at: "2026-11-21 06:00:00+00", ended_at: "2026-11-21 07:00:00+00", extra: { seconds: 1200 } },
	]);

	const again = (await (await pushTicks(ticks)).json()) as { changed: { samples: number } };
	expect(again.changed.samples).toBe(0);
	expect(await totals()).toEqual(rawTotals);
});

test("an hour first sent in part and later inside a full push is counted once, and a later partial push for it adds nothing twice", async () => {
	const ticks = day();
	await resetSamples();
	await hourByHour(ticks);
	const rawTotals = await totals();
	const rawDays = await daysRows();
	await resetSamples();

	const third = START + 2 * 3600_000;
	await pushTicks(ticks.filter((tick) => tick.at >= third && tick.at < third + 1800_000));
	await pushTicks(ticks);
	expect(await totals()).toEqual(rawTotals);
	expect(await daysRows()).toEqual(rawDays);
	await pushTicks(ticks.filter((tick) => tick.at >= third + 900_000 && tick.at < third + 2700_000));
	expect(await totals()).toEqual(rawTotals);
	expect(await daysRows()).toEqual(rawDays);
});

test("Health Auto Export's own hourly summaries win over hours the Worker summed, in either order", async () => {
	const ticks = day();
	const hour = "2026-11-21 00:00:00 -0800";
	const summary = { data: { metrics: [{ name: "step_count", units: "count", data: [{ date: hour, qty: 999 }] }] } };
	const steps = "select source, qty::float8 as qty, extra from activity.apple_health_samples where metric = 'step_count' and source = 'Apple Health' and measured_at >= '2026-11-21T08:00:00Z' and measured_at < '2026-11-21T09:00:00Z' order by source, measured_at";

	await pushTicks(ticks);
	await post(JSON.stringify(summary), `Bearer ${TOKEN}`, "/apple-health", "hours");
	const after = await rows(steps);
	expect(after).toEqual([{ source: "Apple Health", qty: 999, extra: null }]);

	await pushTicks(ticks);
	expect(await rows(steps)).toEqual(after);

	await resetSamples();
	await post(JSON.stringify(summary), `Bearer ${TOKEN}`, "/apple-health", "hours");
	await pushTicks(ticks);
	expect(await rows(steps)).toEqual(after);
});

test("an hour whose readings change time zone across local midnight keeps each part on its own day", async () => {
	const at = (minute: number) => Date.parse("2026-11-21T07:00:00Z") + minute * 60_000;
	await resetSamples();
	const ticks: Tick[] = [
		...[0, 10, 20].map((minute) => ({ metric: "step_count", units: "count", at: at(minute) - 3600_000, offsetH: -8, qty: 5 })),
		...[0, 10, 20].map((minute) => ({ metric: "step_count", units: "count", at: at(minute), offsetH: -8, qty: 7 })),
		...[40, 50].map((minute) => ({ metric: "step_count", units: "count", at: at(minute), offsetH: -7, qty: 11 })),
		...[0, 10].map((minute) => ({ metric: "step_count", units: "count", at: at(minute) + 3600_000, offsetH: -7, qty: 3 })),
	];
	await hourByHour(ticks);
	const rawTotals = await totals();
	await resetSamples();
	await pushTicks(ticks);
	expect(await totals()).toEqual(rawTotals);
	expect(rawTotals.map((row) => row["day"])).toEqual(["2026-11-20", "2026-11-21"]);
});

test("0008 deletes the metrics tools doesn't keep and compacts per-second energy into hourly rows with the same totals", async () => {
	await pg.query(
		`insert into activity.apple_health_samples (metric, source, measured_at, ended_at, utc_offset_min, units, qty, min, avg, max) values
			('flights_climbed', 'Apple Health', '2026-11-21T08:00:00Z', null, -480, 'count', 1, null, null, null),
			('sexual_activity', 'Health', '2026-11-21T08:00:00Z', null, -480, 'count', null, null, null, null),
			('heart_rate', 'Matt’s Apple Watch', '2026-11-21T08:00:00Z', '2026-11-21T09:00:00Z', -480, 'count/min', null, 50, 60, 90),
			('dietary_energy', 'Cronometer', '2020-01-10T20:00:00Z', null, -480, 'kcal', 650, null, null, null),
			('active_energy', 'Apple Health', '2026-11-21T08:00:10Z', null, -480, 'kcal', 0.5, null, null, null),
			('active_energy', 'Apple Health', '2026-11-21T08:59:59Z', null, -480, 'kcal', 0.25, null, null, null),
			('basal_energy_burned', 'Apple Health', '2026-11-21T09:30:00Z', null, -480, 'kcal', 1.5, null, null, null),
			('basal_energy_burned', 'Apple Health', '2026-11-21T10:00:00Z', '2026-11-21T11:00:00Z', -480, 'kcal', 80, null, null, null)`,
	);
	await pg.exec(`set search_path to activity; ${await readFile(join(migrationsDir, "0008-apple-health-kept-metrics.sql"), "utf-8")}; set search_path to public;`);
	expect(await rows("select metric, source, measured_at::text, ended_at::text, qty::float8 as qty from activity.apple_health_samples order by metric, measured_at")).toEqual([
		{ metric: "active_energy", source: "Apple Health", measured_at: "2026-11-21 08:00:00+00", ended_at: "2026-11-21 09:00:00+00", qty: 0.75 },
		{ metric: "basal_energy_burned", source: "Apple Health", measured_at: "2026-11-21 09:00:00+00", ended_at: "2026-11-21 10:00:00+00", qty: 1.5 },
		{ metric: "basal_energy_burned", source: "Apple Health", measured_at: "2026-11-21 10:00:00+00", ended_at: "2026-11-21 11:00:00+00", qty: 80 },
		{ metric: "dietary_energy", source: "Cronometer", measured_at: "2020-01-10 20:00:00+00", ended_at: null, qty: 650 },
		{ metric: "heart_rate", source: "Matt’s Apple Watch", measured_at: "2026-11-21 08:00:00+00", ended_at: "2026-11-21 09:00:00+00", qty: null },
	]);
});
