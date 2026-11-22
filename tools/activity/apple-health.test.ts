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

function post(body: string, authorization: string | null = `Bearer ${TOKEN}`, path = "/apple-health"): Promise<Response> {
	const headers: Record<string, string> = { "content-type": "application/json", "automation-name": "Tools sleep", "session-id": "session-1" };
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
		skipped: { withings: 2, invalid: 1 },
		metrics: ["heart_rate", "heart_rate_variability", "respiratory_rate", "resting_heart_rate", "sleep_analysis"],
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
		skipped: { withings: 1, invalid: 0 },
		metrics: [],
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

test("summarized sleep is kept as a sample with a warning, and the rest of the push still lands", async () => {
	const response = await post(await sample("summarized-sleep"));
	expect(response.status).toBe(200);
	const counts = (await response.json()) as { received: unknown; warnings: string[] };
	expect(counts.received).toEqual({ sleep: 0, samples: 1, workouts: 0 });
	expect(counts.warnings).toEqual([expect.stringContaining("Turn Summarize Data off")]);
	const [stored] = await rows("select metric, qty, extra from activity.apple_health_samples");
	expect(stored).toMatchObject({ metric: "sleep_analysis", qty: null, extra: expect.objectContaining({ totalSleep: 7.5 }) });
	expect(await rows("select * from activity.apple_health_sleep")).toEqual([]);
	const debugRows = await debug({ env: {} as Env, db });
	expect(debugRows.find((row) => row.label === "Apple Health: Tools sleep")?.value).toContain("Turn Summarize Data off");
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
		/^Last push \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\. 16 sleep segments, 6 samples from 5 metrics, 0 workouts; 22 new or changed\. Skipped 2 from Withings, 1 unreadable\.$/,
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

test("every metric is stored whatever its shape or key order, by source and time, with its other fields kept", async () => {
	const response = await post(await sample("all-metrics"));
	expect(await response.json()).toEqual({
		received: { sleep: 0, samples: 19, workouts: 0 },
		changed: { sleep: 0, samples: 19, workouts: 0 },
		skipped: { withings: 2, invalid: 1 },
		metrics: [
			"a_metric_from_ios_28",
			"active_energy",
			"apple_sleeping_wrist_temperature",
			"basal_energy_burned",
			"blood_glucose",
			"blood_pressure",
			"handwashing",
			"heart_rate_variability",
			"sexual_activity",
			"step_count",
			"walking_running_distance",
		],
		days: 2,
		warnings: [],
	});
	const stored = await rows(
		"select metric, source, qty::float8 as qty, ended_at::text as ended, units, extra from activity.apple_health_samples where metric not in ('step_count', 'walking_running_distance', 'active_energy', 'basal_energy_burned') order by metric",
	);
	expect(stored).toEqual([
		{ metric: "a_metric_from_ios_28", source: "Matt’s iPhone", qty: 3, ended: null, units: "count", extra: null },
		{ metric: "apple_sleeping_wrist_temperature", source: "Matt’s Apple Watch", qty: -0.21, ended: null, units: "degC", extra: null },
		{ metric: "blood_glucose", source: 'Lingo "CGM"', qty: 92, ended: null, units: "mg/dL", extra: { mealTime: "Before Meal" } },
		{ metric: "blood_pressure", source: "Health", qty: null, ended: null, units: "mmHg", extra: { systolic: 121, diastolic: 79 } },
		{ metric: "handwashing", source: "Matt’s Apple Watch", qty: 25, ended: "2026-11-21 20:00:25+00", units: "s", extra: { value: "Completed" } },
		{ metric: "heart_rate_variability", source: "Matt’s Apple Watch", qty: 41.3, ended: null, units: "ms", extra: { heartbeats: [{ t: 0, bpm: 51 }, { t: 1.18, bpm: 50 }] } },
		{ metric: "sexual_activity", source: "Health", qty: null, ended: null, units: "count", extra: { "Protection Used": 1, Unspecified: 0, "Protection Not Used": 0 } },
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
	expect(((await response.json()) as { received: unknown }).received).toEqual({ sleep: 0, samples: 19, workouts: 0 });
	expect(await rows("select count(*)::int as n from activity.apple_health_samples")).toEqual([{ n: 19 }]);
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
