import { PGlite } from "@electric-sql/pglite";
import { beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database, WithDb } from "../../worker/db.ts";
import { activityApi } from "./api.ts";
import { signState, unseal, verifyState } from "./secrets.ts";
import { listDays, readConnection } from "./store.ts";
import { BACKFILL_FLOOR, syncWithings } from "./sync.ts";
import { type DailyWeight, readWeighins, saveWeighins, type TrendRow, type TrendSummary, toWeighins, trend, weightReport } from "./weights.ts";
import { CALLBACK_URL, type Fetch } from "./withings.ts";

const pg = new PGlite();
const migrationsDir = join(import.meta.dirname, "migrations");
const migrations = await Promise.all((await readdir(migrationsDir)).toSorted().map((name) => readFile(join(migrationsDir, name), "utf-8")));
const nutritionDir = join(import.meta.dirname, "..", "nutrition", "migrations");
const nutritionMigrations = await Promise.all((await readdir(nutritionDir)).toSorted().map((name) => readFile(join(nutritionDir, name), "utf-8")));
await pg.exec(`create schema activity; set search_path to activity; ${migrations.join(";\n")}; set search_path to public;`);
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

const fakeWithings: Fetch = async (url, init) => {
	const form = new URLSearchParams(String(init?.body ?? ""));
	calls.push({ url, form, authorization: new Headers(init?.headers).get("authorization") });
	if (url.endsWith("/v2/oauth2")) {
		tokenCount++;
		return Response.json({ status: 0, body: { userid: 42, access_token: `access-${tokenCount}`, refresh_token: `refresh-${tokenCount}`, expires_in: 10800, scope: "user.info,user.metrics,user.activity" } });
	}
	if (failActivity) return Response.json({ status: 401, error: "invalid_token" });
	if (form.get("action") === "getmeas") return Response.json({ status: 0, body: measFor(form) });
	return Response.json({ status: 0, body: activityFor(form) });
};

const api = activityApi(fakeWithings);
const ctx = {} as ExecutionContext;
const hit = (path: string, init?: RequestInit) => api(new Request(`https://tools.mattpalmer.io/api/withings${path}`, init), { env, ctx, path: `/withings${path.split("?")[0]}`, db });

async function connect(): Promise<void> {
	const state = await signState(creds.clientSecret);
	const response = await hit(`/callback?code=abc&state=${encodeURIComponent(state)}`);
	expect(response.status).toBe(302);
}

beforeEach(async () => {
	await pg.exec("delete from activity.days; delete from activity.withings; delete from activity.withings_weighins; delete from nutrition.weigh_ins;");
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
	expect((await hit("/callback?code=abc&state=1.2.3")).status).toBe(400);
	const old = await signState(creds.clientSecret, Date.now() - 60 * 60_000);
	expect((await hit(`/callback?code=abc&state=${encodeURIComponent(old)}`)).status).toBe(400);
	expect(calls).toHaveLength(0);
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
	expect(first).toMatchObject({ status: "synced", calls: 3 });
	const windows = calls.filter((call) => call.form.get("action") === "getactivity").map((call) => [call.form.get("startdateymd"), call.form.get("enddateymd")]);
	expect(windows).toHaveLength(2);
	expect(calls.every((call) => call.form.get("action") !== "getactivity" || call.authorization === "Bearer access-1")).toBe(true);

	let runs = 0;
	while ((await readConnection(client))?.backfillCursor !== null && runs++ < 100) await syncWithings(client, creds, fakeWithings);
	const connection = await readConnection(client);
	expect(connection?.backfillDoneAt).not.toBeNull();
	expect(calls.at(-1)?.form.get("startdateymd")).toBe(BACKFILL_FLOOR);

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
	measFor = (form) =>
		form.get("offset") === null
			? { measuregrps: [group("2026-01-01T16:00:00Z", 80)], more: true, offset: 1, updatetime: 1_700_000_000 }
			: form.get("offset") === "1"
				? { measuregrps: [group("2026-01-02T16:00:00Z", 80)], more: true, offset: 2, updatetime: 1_700_000_050 }
				: { measuregrps: [group("2026-01-03T16:00:00Z", 80)], more: false, offset: 0, updatetime: 1_700_000_090 };
	await syncWithings(client, creds, fakeWithings);
	expect(await readConnection(client)).toMatchObject({ measOffset: 2, measLastupdate: null, measPendingLastupdate: 1_700_000_000 });
	await syncWithings(client, creds, fakeWithings);
	expect(await readConnection(client)).toMatchObject({ measOffset: 0, measLastupdate: 1_700_000_000, measPendingLastupdate: null });
	expect((await withingsWeights()).map((row) => row.day)).toEqual(["2026-01-01", "2026-01-02", "2026-01-03"]);
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
