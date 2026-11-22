import { PGlite } from "@electric-sql/pglite";
import { beforeEach, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database, WithDb } from "../../worker/db.ts";
import { activityApi } from "./api.ts";
import { parseDate } from "./apple-health.ts";
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
	return Promise.resolve(api(new Request(`https://tools.mattpalmer.io/api/tools/activity${path}`, { method: "POST", headers, body }), { env, ctx, path, db }));
}

async function get(path: string): Promise<Response> {
	return api(new Request(`https://tools.mattpalmer.io/api/tools/activity${path}`), { env, ctx, path: path.split("?")[0] ?? path, db });
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
	expect((await post(body, "Bearer nutrition-token")).status).toBe(401);
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
	expect(await response.json()).toEqual({ received: { sleep: 0, samples: 0, workouts: 1 }, changed: { sleep: 0, samples: 0, workouts: 1 }, skipped: { withings: 1, invalid: 0 } });
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

test("summarized sleep is refused with the setting to change, and nothing is written", async () => {
	const response = await post(await sample("summarized-sleep"));
	expect(response.status).toBe(422);
	expect(((await response.json()) as { error: string }).error).toContain("Turn Summarize Data off");
	expect(await rows("select * from activity.apple_health_pushes")).toEqual([]);
});

test("a body that isn't Health Auto Export JSON is a 422", async () => {
	for (const body of ["not json", "{}", '{"data":{"metrics":"x"}}']) {
		const response = await post(body);
		expect(response.status).toBe(422);
	}
});

test("Settings shows each automation's last push", async () => {
	await post(await sample("metrics"));
	const debugRows = await debug({ env: {} as Env, db });
	expect(debugRows.find((row) => row.label === "Apple Health: Tools sleep")?.value).toMatch(
		/^Last push \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\. 16 sleep segments, 6 samples, 0 workouts; 22 new or changed\. Skipped 2 from Withings, 1 unreadable\.$/,
	);
});

test("dates keep the phone's offset and local date", () => {
	expect(parseDate("2026-11-21 06:12:44 -0800")).toEqual({ iso: "2026-11-21T06:12:44-08:00", ms: Date.parse("2026-11-21T14:12:44Z"), offsetMin: -480, localDate: "2026-11-21" });
	expect(parseDate("2026-03-08 03:30:00 -0700")?.offsetMin).toBe(-420);
	expect(parseDate("2026-11-21 06:12:44 +0530")?.ms).toBe(Date.parse("2026-11-21T00:42:44Z"));
	expect(parseDate("2026-11-21T06:12:44")).toBeNull();
	expect(parseDate(1_800_000_000)).toBeNull();
});
