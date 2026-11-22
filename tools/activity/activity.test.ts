import { PGlite } from "@electric-sql/pglite";
import { beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database, WithDb } from "../../worker/db.ts";
import { activityApi } from "./api.ts";
import { addDays, today } from "./dates.ts";
import { dailyHealth, dayStart, downsample, intradayDay, linkWorkouts, listMeasures, listSleep, listWorkouts, refreshWorkoutLinks } from "./health.ts";
import { signState, unseal, verifyState } from "./secrets.ts";
import { listDays, readConnection } from "./store.ts";
import { BACKFILL_FLOOR, CALLS_PER_RUN, syncWithings } from "./sync.ts";
import { type DailyWeight, readWeighins, saveWeighins, type TrendRow, type TrendSummary, toWeighins, trend, weightReport } from "./weights.ts";
import { CALLBACK_URL, type Fetch } from "./withings.ts";

const pg = new PGlite();
const migrationsDir = join(import.meta.dirname, "migrations");
const migrations = await Promise.all((await readdir(migrationsDir)).toSorted().map((name) => readFile(join(migrationsDir, name), "utf-8")));
const nutritionDir = join(import.meta.dirname, "..", "nutrition", "migrations");
const nutritionMigrations = await Promise.all((await readdir(nutritionDir)).toSorted().map((name) => readFile(join(nutritionDir, name), "utf-8")));
await pg.exec(`create schema activity; set search_path to activity; ${migrations.join(";\n")}; set search_path to public;`);
const workoutsDir = join(import.meta.dirname, "..", "workouts", "migrations");
const workoutsMigrations = await Promise.all((await readdir(workoutsDir)).toSorted().map((name) => readFile(join(workoutsDir, name), "utf-8")));
await pg.exec(`create schema workouts; set search_path to workouts; ${workoutsMigrations.join(";\n")}; set search_path to public;`);
await pg.exec(`create schema nutrition; set search_path to nutrition; ${nutritionMigrations.join(";\n")}; set search_path to public;`);
const client: Database = {
	query: async (text: string, values?: unknown[]) => {
		const result = await pg.query(text, values);
		return { ...result, rowCount: result.affectedRows ?? result.rows.length };
	},
} as never;
const db: WithDb = (work) => work(client);

const creds = { clientId: "client-id", clientSecret: "client-secret" };
const env = { WITHINGS_CLIENT_ID: creds.clientId, WITHINGS_CLIENT_SECRET: creds.clientSecret } as Env;

type Call = { url: string; form: URLSearchParams; authorization: string | null };
let calls: Call[] = [];
let tokenCount = 0;
let activityFor: (form: URLSearchParams) => unknown = () => ({ activities: [], more: false, offset: 0 });
let failActivity = false;
let measFor: (form: URLSearchParams) => unknown = () => ({ measuregrps: [], more: false, offset: 0, updatetime: 1_800_000_000 });
let feedFor: (form: URLSearchParams) => unknown = (form) => (form.get("action") === "getmeas" ? { measuregrps: [], more: false, offset: 0, updatetime: 1_800_000_000 } : { series: [], more: false, offset: 0 });
let intradayFor: (form: URLSearchParams) => unknown = () => ({ series: [] });

const fakeWithings: Fetch = async (url, init) => {
	const form = new URLSearchParams(String(init?.body ?? ""));
	calls.push({ url, form, authorization: new Headers(init?.headers).get("authorization") });
	if (url.endsWith("/v2/oauth2")) {
		tokenCount++;
		return Response.json({ status: 0, body: { userid: 42, access_token: `access-${tokenCount}`, refresh_token: `refresh-${tokenCount}`, expires_in: 10800, scope: "user.info,user.metrics,user.activity" } });
	}
	if (failActivity) return Response.json({ status: 401, error: "invalid_token" });
	if (form.get("action") === "getmeas" && form.has("meastypes")) return Response.json({ status: 0, body: measFor(form) });
	if (form.get("action") === "getintradayactivity") return Response.json({ status: 0, body: intradayFor(form) });
	if (form.get("action") !== "getactivity") {
		const body = feedFor(form);
		return Response.json(body === null ? { status: 503, error: "Invalid Params" } : { status: 0, body });
	}
	return Response.json({ status: 0, body: activityFor(form) });
};

const api = activityApi(fakeWithings);
const ctx = {} as ExecutionContext;
const hit = (path: string, init?: RequestInit) => api(new Request(`https://tools.mattpalmer.io/api/withings${path}`, init), { env, ctx, path: `/withings${path.split("?")[0]}`, db });

async function connect(): Promise<void> {
	const state = await signState(creds.clientSecret);
	const response = await hit(`/callback?code=abc&state=${encodeURIComponent(state)}`, { headers: { cookie: `withings_state=${state}` } });
	expect(response.status).toBe(302);
	expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
}

beforeEach(async () => {
	await pg.exec(
		"delete from activity.days; delete from activity.withings; delete from activity.withings_weighins; delete from nutrition.weigh_ins; delete from activity.withings_streams; delete from activity.withings_measures; delete from activity.withings_workout_links; delete from activity.withings_workouts; delete from activity.withings_sleep; delete from activity.withings_intraday; delete from workouts.repo_files; delete from workouts.history_sessions;",
	);
	feedFor = (form) => (form.get("action") === "getmeas" ? { measuregrps: [], more: false, offset: 0, updatetime: 1_800_000_000 } : { series: [], more: false, offset: 0 });
	intradayFor = () => ({ series: [] });
	measFor = () => ({ measuregrps: [], more: false, offset: 0, updatetime: 1_800_000_000 });
	calls = [];
	tokenCount = 0;
	failActivity = false;
	activityFor = () => ({ activities: [], more: false, offset: 0 });
});

test("the callback answers 200 to a bare ping", async () => {
	for (const method of ["GET", "HEAD", "POST"]) expect((await hit("/callback", { method })).status).toBe(200);
	expect(calls).toHaveLength(0);
});

test("connect redirects to Withings with the activity scope and a signed state", async () => {
	const response = await hit("/connect");
	expect(response.status).toBe(302);
	const location = new URL(response.headers.get("location") ?? "");
	expect(location.searchParams.get("scope")).toBe("user.info,user.metrics,user.activity");
	expect(location.searchParams.get("redirect_uri")).toBe(CALLBACK_URL);
	expect(await verifyState(creds.clientSecret, location.searchParams.get("state") ?? "")).toBe(true);
});

test("the callback rejects a forged or expired state", async () => {
	expect((await hit("/callback?code=abc&state=1.2.3", { headers: { cookie: "withings_state=1.2.3" } })).status).toBe(400);
	const old = await signState(creds.clientSecret, Date.now() - 60 * 60_000);
	expect((await hit(`/callback?code=abc&state=${encodeURIComponent(old)}`, { headers: { cookie: `withings_state=${old}` } })).status).toBe(400);
	expect(calls).toHaveLength(0);
});

test("connect binds its state to this browser with a short-lived callback-only cookie", async () => {
	const response = await hit("/connect");
	const state = new URL(response.headers.get("location") ?? "").searchParams.get("state");
	const cookie = response.headers.get("set-cookie") ?? "";
	expect(cookie).toStartWith(`withings_state=${state};`);
	for (const attribute of ["Path=/api/withings/callback", "Max-Age=900", "HttpOnly", "Secure", "SameSite=Lax"]) expect(cookie).toContain(attribute);
});

test("a valid state from another browser is refused, so nobody can connect their own Withings account here", async () => {
	const state = await signState(creds.clientSecret);
	const other = await signState(creds.clientSecret);
	for (const cookie of [null, "", `withings_state=${other}`, `withings_state=${state}x`]) {
		const response = await hit(`/callback?code=abc&state=${encodeURIComponent(state)}`, cookie === null ? {} : { headers: { cookie } });
		expect(response.status).toBe(400);
		expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
	}
	expect(calls).toHaveLength(0);
	expect(await readConnection(client)).toBeNull();
});

test("the callback never echoes Withings' error text back as markup", async () => {
	const response = await hit(`/callback?error=${encodeURIComponent("<script>alert(1)</script>")}`);
	expect(response.status).toBe(400);
	expect(response.headers.get("x-content-type-options")).toBe("nosniff");
	expect(await response.text()).not.toContain("<script>");
	expect(await (await hit("/callback?error=access_denied")).text()).toContain("access_denied");
});

test("the callback stores tokens encrypted", async () => {
	await connect();
	expect(calls[0]?.form.get("grant_type")).toBe("authorization_code");
	expect(calls[0]?.form.get("redirect_uri")).toBe(CALLBACK_URL);
	const raw = (await pg.query<{ access_token: string; refresh_token: string }>("select access_token, refresh_token from activity.withings")).rows[0];
	expect(raw?.refresh_token).not.toContain("refresh-1");
	expect(await unseal(creds.clientSecret, raw?.refresh_token ?? "")).toBe("refresh-1");
	expect((await readConnection(client))?.userid).toBe("42");
});

test("sync pulls the last week, then backfills to the floor in windows", async () => {
	await connect();
	activityFor = (form) => ({
		activities: [
			{ date: form.get("enddateymd"), steps: 8000, calories: 410.5, totalcalories: 2600, distance: 6200 },
			{ date: form.get("enddateymd"), steps: 120, calories: 5, deviceid: "phone" },
		],
		more: false,
		offset: 0,
	});
	const first = await syncWithings(client, creds, fakeWithings);
	expect(first).toMatchObject({ status: "synced", calls: CALLS_PER_RUN });
	const windows = calls.filter((call) => call.form.get("action") === "getactivity").map((call) => [call.form.get("startdateymd"), call.form.get("enddateymd")]);
	expect(windows).toHaveLength(2);
	expect(calls.every((call) => call.form.get("action") !== "getactivity" || call.authorization === "Bearer access-1")).toBe(true);

	let runs = 0;
	while ((await readConnection(client))?.backfillCursor !== null && runs++ < 100) await syncWithings(client, creds, fakeWithings);
	const connection = await readConnection(client);
	expect(connection?.backfillDoneAt).not.toBeNull();
	expect(calls.filter((call) => call.form.get("action") === "getactivity").at(-1)?.form.get("startdateymd")).toBe(BACKFILL_FLOOR);
	while ((await pg.query("select 1 from activity.withings_streams where name = 'intraday' and done_at is not null")).rows.length === 0 && runs++ < 300) await syncWithings(client, creds, fakeWithings);

	const [day] = await listDays(client, windows[0]?.[1] ?? "", windows[0]?.[1] ?? "");
	expect(day).toMatchObject({ source: "withings", steps: 8000, activeKcal: 410.5, totalKcal: 2600, distanceM: 6200 });
	expect(await syncWithings(client, creds, fakeWithings)).toMatchObject({ status: "synced", calls: 0 });
});

test("an expiring token is refreshed and the new refresh token replaces the old one", async () => {
	await connect();
	await pg.query("update activity.withings set access_expires_at = now() - interval '1 minute', backfill_cursor = null");
	await syncWithings(client, creds, fakeWithings);
	const refresh = calls.find((call) => call.form.get("grant_type") === "refresh_token");
	expect(refresh?.form.get("refresh_token")).toBe("refresh-1");
	const raw = (await pg.query<{ refresh_token: string }>("select refresh_token from activity.withings")).rows[0];
	expect(await unseal(creds.clientSecret, raw?.refresh_token ?? "")).toBe("refresh-2");
	expect(calls.find((call) => call.form.get("action") === "getactivity")?.authorization).toBe("Bearer access-2");
});

test("a rejected token is recorded with how to reconnect, and the claim is released", async () => {
	await connect();
	failActivity = true;
	const result = await syncWithings(client, creds, fakeWithings);
	expect(result.status).toBe("failed");
	const connection = await readConnection(client);
	expect(connection?.lastError).toContain("/api/withings/connect");
	expect((await pg.query("select 1 from activity.withings where claimed_until is null")).rows).toHaveLength(1);
});

test("a second sync does not rewrite unchanged days", async () => {
	await connect();
	await pg.query("update activity.withings set backfill_cursor = null");
	activityFor = () => ({ activities: [{ date: "2026-11-20", steps: 5000 }], more: false, offset: 0 });
	expect(await syncWithings(client, creds, fakeWithings)).toMatchObject({ changed: 1 });
	await pg.query("update activity.withings set recent_synced_at = null");
	expect(await syncWithings(client, creds, fakeWithings)).toMatchObject({ changed: 0 });
});

const group = (at: string, kg: number, extra: Partial<{ attrib: number; category: number; grpid: number; fatRatio: number; fatKg: number }> = {}) => ({
	grpid: extra.grpid ?? Date.parse(at) / 1000,
	attrib: extra.attrib ?? 0,
	category: extra.category ?? 1,
	date: Date.parse(at) / 1000,
	measures: [
		{ value: Math.round(kg * 1000), type: 1, unit: -3 },
		...(extra.fatRatio === undefined ? [] : [{ value: Math.round(extra.fatRatio * 1000), type: 6, unit: -3 }]),
		...(extra.fatKg === undefined ? [] : [{ value: Math.round(extra.fatKg * 1000), type: 8, unit: -3 }]),
	],
});

const withingsWeights = async () =>
	(await pg.query<{ day: string; lb: string; grpid: string; fat: string | null }>("select measured_on::text as day, weight_lb::text as lb, grpid::text, fat_pct::text as fat from nutrition.weigh_ins where source = 'withings' order by 1")).rows;

test("the daily weigh-in is the first unambiguous one of the Pacific day, in lb to 2 dp", async () => {
	await connect();
	await pg.query("update activity.withings set backfill_cursor = null");
	measFor = () => ({
		measuregrps: [
			group("2026-11-20T15:10:00Z", 75.12, { fatRatio: 18.25 }),
			group("2026-11-20T23:00:00Z", 82.4),
			group("2026-11-21T07:30:00Z", 83, { fatKg: 16.6 }),
			group("2026-11-21T14:00:00Z", 70, { attrib: 1 }),
			group("2026-11-21T15:30:00Z", 81.5, { attrib: 2 }),
			group("2026-11-21T13:00:00Z", 90, { category: 2 }),
			group("2026-11-22T15:00:00Z", 71, { attrib: 1 }),
			group("2026-11-22T16:00:00Z", 72, { attrib: 1 }),
		],
		more: false,
		offset: 0,
		updatetime: 1_800_000_123,
	});
	await syncWithings(client, creds, fakeWithings);
	expect(await withingsWeights()).toEqual([
		{ day: "2026-11-20", lb: "165.61", grpid: String(Date.parse("2026-11-20T15:10:00Z") / 1000), fat: "18.25" },
		{ day: "2026-11-21", lb: "179.68", grpid: String(Date.parse("2026-11-21T15:30:00Z") / 1000), fat: null },
		{ day: "2026-11-22", lb: "156.53", grpid: String(Date.parse("2026-11-22T15:00:00Z") / 1000), fat: null },
	]);
	const report = await weightReport(client, "2026-11-20", "2026-11-22");
	expect(report.daily.map((row) => row.weighins_that_day)).toEqual([3, 2, 2]);
	expect((await readWeighins(client, "2026-11-20", "2026-11-20")).find((row) => row.weightKg === 83)).toMatchObject({ fatPct: 20, fatSource: "derived_from_fat_mass", date: "2026-11-20" });
	expect((await readConnection(client))?.measLastupdate).toBe(1_800_000_123);

	measFor = (form) => {
		expect(form.get("lastupdate")).toBe("1800000123");
		return { measuregrps: [group("2026-11-21T14:30:00Z", 81), group("2026-11-21T18:00:00Z", 85)], more: false, offset: 0, updatetime: 1_800_000_999 };
	};
	await pg.query("update activity.withings set weights_synced_at = null");
	await syncWithings(client, creds, fakeWithings);
	expect((await withingsWeights())[1]?.lb).toBe("178.57");
	expect((await pg.query("select 1 from nutrition.daily_weights where source = 'withings'")).rows).toHaveLength(3);
});

test("weight history pages resume from the saved offset and commit the first page's updatetime", async () => {
	await connect();
	await pg.query("update activity.withings set backfill_cursor = null");
	const pages = CALLS_PER_RUN + 1;
	measFor = (form) => {
		const page = Number(form.get("offset") ?? 0);
		return { measuregrps: [group(`2026-01-0${page + 1}T16:00:00Z`, 80)], more: page < pages - 1, offset: page < pages - 1 ? page + 1 : 0, updatetime: 1_700_000_000 + page };
	};
	await syncWithings(client, creds, fakeWithings);
	expect(await readConnection(client)).toMatchObject({ measOffset: CALLS_PER_RUN - 1, measLastupdate: null, measPendingLastupdate: 1_700_000_000 });
	await syncWithings(client, creds, fakeWithings);
	expect(await readConnection(client)).toMatchObject({ measOffset: 0, measLastupdate: 1_700_000_000, measPendingLastupdate: null });
	expect((await withingsWeights()).map((row) => row.day)).toEqual(Array.from({ length: pages }, (_, page) => `2026-01-0${page + 1}`));
});

test("the trend is an EMA that carries forward over missing days", () => {
	const { daily, summary } = trend(
		[
			{ date: "2026-01-01", weight_lb: 180 },
			{ date: "2026-01-02", weight_lb: 170 },
			{ date: "2026-01-04", weight_lb: 181 },
		],
		"2026-01-01",
		"2026-01-04",
	);
	expect(daily).toEqual([
		{ date: "2026-01-01", weight_lb: 180, trend_lb: 180 },
		{ date: "2026-01-02", weight_lb: 170, trend_lb: 179 },
		{ date: "2026-01-03", weight_lb: null, trend_lb: 179 },
		{ date: "2026-01-04", weight_lb: 181, trend_lb: 179.2 },
	]);
	expect(summary).toMatchObject({ start_trend: 180, end_trend: 179.2, delta_lb: -0.8, days: 3, weigh_in_days: 3 });
});

const SAMPLE = "/cursor/stores/bc-11b6c52a-db6e-4bf2-88ce-8bb6f9ba9671/docs/withings-parity/sample-30d.json";

type Sample = {
	window: { start_date: string; end_date: string };
	get_weights: { daily: unknown[]; weighins: { timestamp: number; grpid: number; attrib: number; weight_kg: number; fat_pct: number | null; fat_source: string | null }[] };
	trend_weight: { daily: unknown[]; summary: Record<string, unknown> };
};

test.skipIf(!existsSync(SAMPLE))("reproduces tinkabot's 30-day get_weights and trend_weight sample from its raw weigh-ins", async () => {
	const sample = (await Bun.file(SAMPLE).json()) as Sample;
	const groups = sample.get_weights.weighins.map((row) => ({
		grpid: row.grpid,
		attrib: row.attrib,
		category: 1,
		date: row.timestamp,
		measures: [
			{ value: Math.round(row.weight_kg * 1000), type: 1, unit: -3 },
			...(row.fat_pct === null || row.fat_source !== "fat_ratio" ? [] : [{ value: Math.round(row.fat_pct * 100), type: 6, unit: -2 }]),
		],
	}));
	await saveWeighins(client, toWeighins(groups));
	const { start_date: from, end_date: to } = sample.window;
	const report = await weightReport(client, from, to);
	expect(report.daily).toEqual(sample.get_weights.daily as DailyWeight[]);
	expect(report.trend.daily).toEqual(sample.trend_weight.daily as TrendRow[]);
	expect(report.trend.summary).toEqual(sample.trend_weight.summary as TrendSummary);
	const stored = (await pg.query<{ day: string; lb: string }>("select measured_on::text as day, weight_lb::text as lb from nutrition.weigh_ins where source = 'withings' and measured_on between $1 and $2 order by 1", [from, to])).rows;
	expect(stored.map((row) => [row.day, Number(row.lb)])).toEqual(report.daily.map((row) => [row.date, row.weight_lb]));
});

const unix = (iso: string) => Date.parse(iso) / 1000;
const run = { id: 9001, category: 2, timezone: "America/Los_Angeles", model: 1059, attrib: 7, startdate: unix("2026-11-18T14:05:00Z"), enddate: unix("2026-11-18T14:50:00Z"), date: "2026-11-18", deviceid: "watch", modified: unix("2026-11-18T15:00:00Z"), data: { calories: 412.5, distance: 7012.4, steps: 6900, elevation: 31, hr_average: 141, hr_min: 98, hr_max: 171, hr_zone_0: 60, hr_zone_1: 900, hr_zone_2: 1500, hr_zone_3: 240, pause_duration: 0 } };
const night = { id: 5001, timezone: "America/Los_Angeles", model: 16, model_id: 93, hash_deviceid: "dev-hash", startdate: unix("2026-11-18T06:40:00Z"), enddate: unix("2026-11-18T14:10:00Z"), date: "2026-11-18", modified: unix("2026-11-18T15:00:00Z"), data: { total_sleep_time: 25200, total_timeinbed: 27000, lightsleepduration: 13000, deepsleepduration: 5200, remsleepduration: 7000, wakeupduration: 1800, wakeupcount: 2, hr_average: 55, hr_min: 47, hr_max: 70, rr_average: 14, sleep_score: 82 } };

test("workouts, sleep, body measures, and daily HR land in their tables, and a re-sync writes nothing", async () => {
	await connect();
	await pg.query("update activity.withings set backfill_cursor = null");
	activityFor = () => ({ activities: [{ date: "2026-11-18", steps: 11000, hr_average: 72, hr_min: 49, hr_max: 171, hr_zone_2: 1500 }], more: false, offset: 0 });
	feedFor = (form) => {
		if (form.get("action") === "getworkouts") return { series: [run], more: false, offset: 0 };
		if (form.get("action") === "getsummary") return { series: [night], more: false, offset: 0 };
		return { measuregrps: [{ grpid: 77, attrib: 0, date: unix("2026-11-18T15:30:00Z"), category: 1, model: "Body Scan", measures: [{ value: 342, type: 76, unit: -1 }, { value: 128, type: 10, unit: 0 }, { value: 9612, type: 54, unit: -2 }] }], more: false, offset: 0, updatetime: 1_800_000_500 };
	};
	await syncWithings(client, creds, fakeWithings);
	const measuresCall = calls.find((call) => call.form.get("action") === "getmeas" && !call.form.has("meastypes"));
	expect(measuresCall?.form.get("category")).toBe("1");

	const [workout] = await listWorkouts(client, "2026-11-18", "2026-11-18");
	expect(workout).toMatchObject({ id: 9001, activity: "run", durationS: 2700, distanceM: 7012.4, calories: 412.5, hr: { avg: 141, min: 98, max: 171, zonesS: [60, 900, 1500, 240] }, model: "1059", session: null });
	expect((await listSleep(client, "2026-11-18", "2026-11-18"))[0]).toMatchObject({ model: "16", model_id: 93, device_hash: "dev-hash", total_sleep_s: 25200, deep_s: 5200, hr_min: 47, sleep_score: 82 });
	expect((await listMeasures(client, "2026-11-18", "2026-11-18")).map((row) => [row["name"], row["value"]])).toEqual([
		["systolic_mmhg", 128],
		["spo2_pct", 96.12],
		["muscle_mass_kg", 34.2],
	]);
	expect((await dailyHealth(client, "2026-11-18", "2026-11-18"))[0]).toMatchObject({ steps: 11000, dayHrAvg: 72, dayHrMin: 49, restingHr: 47, sleeps: 1, sleepS: 25200, sleepScore: 82, workouts: 1, workoutKcal: 412.5, workoutS: 2700 });
	expect((await pg.query<{ state: { lastupdate: number } }>("select state from activity.withings_streams where name = 'measures'")).rows[0]?.state.lastupdate).toBe(1_800_000_500);

	await pg.exec("update activity.withings set recent_synced_at = null, weights_synced_at = null; update activity.withings_streams set synced_at = null, state = state || '{\"recentAt\": null}'");
	calls = [];
	const again = await syncWithings(client, creds, fakeWithings);
	expect(calls.filter((call) => call.form.get("action") === "getworkouts")[0]?.form.get("lastupdate")).not.toBe("0");
	expect(again).toMatchObject({ status: "synced", changed: 0 });
});

test("a failing feed is recorded and does not stop the other feeds", async () => {
	await connect();
	await pg.query("update activity.withings set backfill_cursor = null");
	feedFor = (form) => (form.get("action") === "getworkouts" ? { series: [run], more: false, offset: 0 } : form.get("action") === "getsummary" ? null : { measuregrps: [], more: false, offset: 0, updatetime: 1 });
	const result = await syncWithings(client, creds, fakeWithings);
	expect(result.status).toBe("synced");
	expect((await listWorkouts(client, "2026-11-18", "2026-11-18")).length).toBe(1);
	expect((await readConnection(client))?.lastError).toContain("sleep: Withings getsummary");
	const sleep = (await pg.query<{ synced: boolean }>("select synced_at is not null as synced from activity.withings_streams where name = 'sleep'")).rows[0];
	expect(sleep?.synced).toBe(true);
});

test("intraday days are bucketed to 5 minutes from local midnight and backfill stops after a long empty run", async () => {
	expect(dayStart("2026-11-22")).toBe(unix("2026-11-22T08:00:00Z"));
	expect(dayStart("2026-07-01")).toBe(unix("2026-07-01T07:00:00Z"));
	expect(dayStart("2026-03-08")).toBe(unix("2026-03-08T08:00:00Z"));
	const start = dayStart("2026-11-18");
	const { buckets, samples, models } = downsample(
		{
			[start + 60]: { steps: 40, calories: 2.5, heart_rate: 80, model: "ScanWatch" },
			[start + 240]: { steps: 60, heart_rate: 90 },
			[start + 310]: { heart_rate: 70 },
			[start - 10]: { steps: 999 },
		},
		start,
	);
	expect(samples).toBe(3);
	expect(models).toEqual(["ScanWatch"]);
	expect(buckets).toEqual([
		{ m: 0, steps: 100, kcal: 2.5, distance_m: 0, hr: 85, hr_min: 80, hr_max: 90 },
		{ m: 5, hr: 70, hr_min: 70, hr_max: 70 },
	]);

	await connect();
	await pg.query("update activity.withings set backfill_cursor = null");
	intradayFor = (form) => {
		const from = Number(form.get("startdate"));
		return { series: from >= dayStart(addDays(today(), -21)) ? { [from + 30]: { steps: 12, heart_rate: 61 } } : {} };
	};
	for (let runs = 0; runs < 100; runs++) await syncWithings(client, creds, fakeWithings);
	const stream = (await pg.query<{ done: boolean }>("select done_at is not null as done from activity.withings_streams where name = 'intraday'")).rows[0];
	expect(stream?.done).toBe(true);
	expect((await pg.query("select 1 from activity.withings_intraday")).rows).toHaveLength(22);
	expect(await intradayDay(client, addDays(today(), -21))).toMatchObject({ bucketS: 300, samples: 1, buckets: [{ m: 0, steps: 12, hr: 61 }] });
	const pulls = calls.filter((call) => call.form.get("action") === "getintradayactivity");
	expect(Number(pulls.at(-1)?.form.get("startdate"))).toBe(dayStart(addDays(today(), -141)));
});

const session = (path: string, day: string, extra: Partial<{ modality: string; name: string; started: string; exercises: string }> = {}) => ({
	path,
	day,
	modality: extra.modality ?? null,
	name: extra.name ?? "Session",
	started: extra.started ?? `${day}T00:00:00-08:00`,
	exercises: extra.exercises ?? "",
});

test("a Withings workout links to a conditioning session only when the match is one to one", () => {
	const workouts = [
		{ id: 1, category: 2, day: "2026-11-09", startedTs: unix("2026-11-09T15:00:00Z") },
		{ id: 2, category: 6, day: "2026-11-12", startedTs: unix("2026-11-12T15:05:00Z") },
		{ id: 3, category: 2, day: "2026-11-14", startedTs: unix("2026-11-14T15:00:00Z") },
		{ id: 4, category: 2, day: "2026-11-14", startedTs: unix("2026-11-14T23:00:00Z") },
		{ id: 5, category: 2, day: "2026-11-16", startedTs: unix("2026-11-16T15:00:00Z") },
		{ id: 6, category: 6, day: "2026-11-17", startedTs: unix("2026-11-17T23:00:00Z") },
		{ id: 7, category: 16, day: "2026-11-09", startedTs: unix("2026-11-09T18:00:00Z") },
	];
	const sessions = [
		session("sessions/2026-11-09-jog.json", "2026-11-09", { modality: "z2", name: "C W3 Easy jog" }),
		session("sessions/2026-11-12-bike.json", "2026-11-12", { name: "Air bike", started: "2026-11-12T06:59:00-08:00", exercises: "Air Bike Mobility" }),
		session("sessions/2026-11-14-run.json", "2026-11-14", { name: "Easy run" }),
		session("sessions/2026-11-16-z2.json", "2026-11-16", { modality: "z2", name: "Zone 2" }),
		session("sessions/2026-11-17-bike.json", "2026-11-17", { modality: "air-bike", name: "Air bike", started: "2026-11-17T06:00:00-08:00" }),
	];
	expect(linkWorkouts(workouts, sessions)).toEqual([
		{ workoutId: 1, sessionPath: "sessions/2026-11-09-jog.json", status: "matched", candidates: ["sessions/2026-11-09-jog.json"] },
		{ workoutId: 2, sessionPath: "sessions/2026-11-12-bike.json", status: "matched", candidates: ["sessions/2026-11-12-bike.json"] },
		{ workoutId: 3, sessionPath: null, status: "ambiguous", candidates: ["sessions/2026-11-14-run.json"] },
		{ workoutId: 4, sessionPath: null, status: "ambiguous", candidates: ["sessions/2026-11-14-run.json"] },
	]);
});

test("workout links are rebuilt from the training log and shown on the workout", async () => {
	await saveWorkoutsFromRun();
	await pg.query(
		`insert into workouts.history_sessions (path, session_date, kind, modality, status, name) values
			('sessions/2026-11-18-run.json', '2026-11-18', 'conditioning', 'z2', 'completed', 'Easy run'),
			('sessions/2026-11-18-skip.json', '2026-11-18', 'conditioning', null, 'skipped', 'Easy run (skipped)')`,
	);
	await pg.query("insert into workouts.repo_files (path, kind, content, sha) values ('sessions/2026-11-18-run.json', 'session', $1, 'x')", [JSON.stringify({ date: "2026-11-18T06:10:00-08:00" })]);
	expect(await refreshWorkoutLinks(client)).toBe(1);
	expect((await listWorkouts(client, "2026-11-18", "2026-11-18"))[0]?.session).toEqual({ path: "sessions/2026-11-18-run.json", status: "matched", candidates: ["sessions/2026-11-18-run.json"] });
	const response = await api(new Request("https://tools.mattpalmer.io/api/tools/activity/workouts?from=2026-11-18&to=2026-11-18"), { env, ctx, path: "/workouts", db });
	expect(((await response.json()) as { workouts: { session: { path: string } }[] }).workouts[0]?.session.path).toBe("sessions/2026-11-18-run.json");
});

async function saveWorkoutsFromRun(): Promise<void> {
	await connect();
	await pg.query("update activity.withings set backfill_cursor = null");
	feedFor = (form) => (form.get("action") === "getworkouts" ? { series: [run], more: false, offset: 0 } : form.get("action") === "getsummary" ? { series: [], more: false, offset: 0 } : { measuregrps: [], more: false, offset: 0, updatetime: 1 });
	await syncWithings(client, creds, fakeWithings);
}
