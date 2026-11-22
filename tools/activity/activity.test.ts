import { PGlite } from "@electric-sql/pglite";
import { beforeEach, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database, WithDb } from "../../worker/db.ts";
import { activityApi } from "./api.ts";
import { signState, unseal, verifyState } from "./secrets.ts";
import { listDays, readConnection } from "./store.ts";
import { BACKFILL_FLOOR, syncWithings } from "./sync.ts";
import { CALLBACK_URL, type Fetch } from "./withings.ts";

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

const creds = { clientId: "client-id", clientSecret: "client-secret" };
const env = { WITHINGS_CLIENT_ID: creds.clientId, WITHINGS_CLIENT_SECRET: creds.clientSecret } as Env;

type Call = { url: string; form: URLSearchParams; authorization: string | null };
let calls: Call[] = [];
let tokenCount = 0;
let activityFor: (form: URLSearchParams) => unknown = () => ({ activities: [], more: false, offset: 0 });
let failActivity = false;

const fakeWithings: Fetch = async (url, init) => {
	const form = new URLSearchParams(String(init?.body ?? ""));
	calls.push({ url, form, authorization: new Headers(init?.headers).get("authorization") });
	if (url.endsWith("/v2/oauth2")) {
		tokenCount++;
		return Response.json({ status: 0, body: { userid: 42, access_token: `access-${tokenCount}`, refresh_token: `refresh-${tokenCount}`, expires_in: 10800, scope: "user.info,user.metrics,user.activity" } });
	}
	if (failActivity) return Response.json({ status: 401, error: "invalid_token" });
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
	await pg.exec("delete from activity.days; delete from activity.withings;");
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
	expect(windows).toHaveLength(3);
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
