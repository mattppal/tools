import { PGlite } from "@electric-sql/pglite";
import { afterAll, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database, WithDb } from "../../worker/db.ts";
import { deliverDue } from "../../worker/webhooks.ts";
import { addTargets, changeFood, closeDayFromUi, getDay, getExpenditure, getHistory, getPhase, getSteps, Rejected, updateDay } from "./store.ts";
import { foodChanges } from "./schemas.ts";
import liaison from "../liaison/webhook.ts";
import webhook from "./webhook.ts";

const pg = new PGlite();
const migrationsDir = join(import.meta.dirname, "migrations");
const migrations = await Promise.all((await readdir(migrationsDir)).toSorted().map((name) => readFile(join(migrationsDir, name), "utf-8")));
const activityDir = join(import.meta.dirname, "..", "activity", "migrations");
const activityMigrations = await Promise.all((await readdir(activityDir)).toSorted().map((name) => readFile(join(activityDir, name), "utf-8")));
await pg.exec(`create schema nutrition; set search_path to nutrition; ${migrations.join(";\n")}; set search_path to public;`);
await pg.exec(`create schema activity; set search_path to activity; ${activityMigrations.join(";\n")}; set search_path to public;`);
const workoutsDir = join(import.meta.dirname, "..", "workouts", "migrations");
const workoutsMigrations = await Promise.all((await readdir(workoutsDir)).toSorted().map((name) => readFile(join(workoutsDir, name), "utf-8")));
await pg.exec(`create schema workouts; set search_path to workouts; ${workoutsMigrations.join(";\n")}; set search_path to public;`);
const liaisonMigration = await readFile(join(import.meta.dirname, "..", "liaison", "migrations", "0001-create-deliveries.sql"), "utf-8");
await pg.exec(`create schema liaison; set search_path to liaison; ${liaisonMigration} set search_path to public;`);
const client: Database = {
	query: async (text: string, values?: unknown[]) => {
		const result = await pg.query(text, values);
		return { ...result, rowCount: result.affectedRows ?? result.rows.length };
	},
} as never;
const db: WithDb = (work) => work(client);

const received: { authorization: string | null; delivery: string | null; body: Record<string, unknown> }[] = [];
const liaisonReceived: { authorization: string | null; delivery: string | null; body: Record<string, unknown> }[] = [];
const server = Bun.serve({
	port: 0,
	async fetch(request) {
		if (new URL(request.url).pathname === "/liaison") liaisonReceived.push({ authorization: request.headers.get("authorization"), delivery: request.headers.get("x-tools-delivery"), body: await request.json() });
		else received.push({ authorization: request.headers.get("authorization"), delivery: request.headers.get("x-nutrition-delivery"), body: await request.json() });
		return new Response(null, { status: 204 });
	},
});
afterAll(() => server.stop(true));

const KEY = "only-the-key 123";
const env = { NUTRITION_WEBHOOK_URL: server.url.href, NUTRITION_WEBHOOK_KEY: KEY, LIAISON_WEBHOOK_URL: new URL("/liaison", server.url).href, LIAISON_WEBHOOK_KEY: "liaison-key" } as Env;

const egg = { food: "Egg whites", qty: 200, unit: "g", kcal: 104, protein_g: 21.8, carbs_g: 1.5, fat_g: 0.4, source: "USDA FDC 172183 (Egg, white, raw)" };

await addTargets(
	client,
	{ effective_from: "2026-11-01", kcal: { min: 2650, max: 2850 }, protein_g: { min: 180, max: 220 }, fat_g: { min: 60, max: 90 }, carbs_g: { min: 250, max: 350 }, change: "Maintain", notes: "Plan" },
	"import",
);

test("adds food once per client key and totals it against targets", async () => {
	await changeFood(client, "2026-11-20", { add: [{ ...egg, client_key: "a" }] }, "bot");
	const day = await changeFood(client, "2026-11-20", { add: [{ ...egg, client_key: "a" }, { ...egg, food: "Rice", kcal: 400, source: undefined, client_key: "b" }] }, "ui");
	expect(day.entries.map((entry) => [entry.food, entry.sourceKind, entry.sourceRef, entry.source])).toEqual([
		["Egg whites", "usda_fdc", "172183", "USDA FDC 172183 (Egg, white, raw)"],
		["Rice", "estimate", null, ""],
	]);
	expect(day.totals.kcal).toBe(504);
	expect(day.progress?.kcal).toEqual({ total: 504, min: 2650, max: 2850, status: "under" });
	expect(day.progress?.protein_g.total).toBe(43.6);
});

test("edits and removes entries on the day", async () => {
	const before = await getDay(client, "2026-11-20");
	const [first, second] = before.entries;
	const day = await changeFood(client, "2026-11-20", { edit: [{ id: first?.id ?? 0, qty: 100, kcal: 52, source: "a guess" }], remove: [second?.id ?? 0] }, "ui");
	expect(day.entries).toHaveLength(1);
	expect(day.entries[0]).toMatchObject({ qty: 100, kcal: 52, sourceKind: "estimate", sourceRef: null, sourceLabel: "a guess", source: "a guess", clientKey: "a" });
	expect((await changeFood(client, "2026-11-20", { remove: [second?.id ?? 0, 999, "never-added"] }, "ui")).entries).toHaveLength(1);
});

test("edits and removes by client key, and refuses an entry on another day", async () => {
	await changeFood(client, "2026-11-19", { add: [{ ...egg, client_key: "k1" }, { ...egg, client_key: "k2" }] }, "bot");
	const edited = await changeFood(client, "2026-11-19", { edit: [{ client_key: "k1", kcal: 90 }], remove: ["k2"] }, "bot");
	expect(edited.entries.map((entry) => [entry.clientKey, entry.kcal])).toEqual([["k1", 90]]);
	expect((await changeFood(client, "2026-11-19", { remove: ["k2"] }, "bot")).entries).toHaveLength(1);
	await expect(changeFood(client, "2026-11-18", { remove: ["k1"] }, "bot")).rejects.toThrow("Entry with client_key k1 is on 2026-11-19, not 2026-11-18.");
	await expect(changeFood(client, "2026-11-19", { edit: [{ client_key: "k2", kcal: 1 }] }, "bot")).rejects.toBeInstanceOf(Rejected);
	await pg.query("delete from nutrition.food_entries where day in ('2026-11-18', '2026-11-19')");
	await pg.query("delete from nutrition.days where day in ('2026-11-18', '2026-11-19')");
});

test("an edit names exactly one of id or client_key", () => {
	expect(foodChanges.safeParse({ edit: [{ kcal: 1 }] }).success).toBe(false);
	expect(foodChanges.safeParse({ edit: [{ id: 1, client_key: "a", kcal: 1 }] }).success).toBe(false);
	expect(foodChanges.safeParse({ edit: [{ client_key: "a", kcal: 1 }], remove: [1, "b"] }).success).toBe(true);
});

test("closing from the UI queues one delivery that sends the key as a Bearer token", async () => {
	const first = await closeDayFromUi(client, "2026-11-20");
	const again = await closeDayFromUi(client, "2026-11-20");
	expect(first.day.closed).toBe(true);
	expect(first.deliveryId).not.toBeNull();
	expect(again.deliveryId).toBeNull();
	expect(await deliverDue(db, webhook, env, [first.deliveryId ?? ""])).toBe(1);
	expect(received).toHaveLength(1);
	expect(received[0]?.authorization).toBe(`Bearer ${KEY}`);
	expect(received[0]?.delivery).toBe(first.deliveryId);
	expect(received[0]?.body).toMatchObject({
		app: "nutrition",
		event: "day.closed",
		data: {
			event: "day.closed",
			deliveryId: first.deliveryId,
			date: "2026-11-20",
			totals: { kcal: 52 },
			targets: { kcal: { min: 2650, max: 2850 } },
			progress: { kcal: { total: 52, status: "under" } },
		},
	});
	expect(Object.keys(received[0]?.body as object)).toEqual(["app", "event", "data"]);
	expect(received[0]?.body).not.toHaveProperty("data.test");
	await expect(changeFood(client, "2026-11-20", { add: [{ ...egg, client_key: "c" }] }, "ui")).rejects.toThrow("is closed");

	expect(await deliverDue(db, liaison, env, [first.deliveryId ?? ""])).toBe(1);
	const relayed = liaisonReceived[0];
	expect(relayed?.authorization).toBe("Bearer liaison-key");
	expect(relayed?.delivery).toBe(first.deliveryId);
	expect(Object.keys(relayed?.body ?? {}).toSorted()).toEqual(["app", "data", "deliveryId", "event"]);
	const { event: _event, deliveryId: _deliveryId, ...legacyData } = (received[0]?.body["data"] ?? {}) as Record<string, unknown>;
	expect(relayed?.body).toEqual({ app: "nutrition", event: "day.closed", deliveryId: first.deliveryId, data: legacyData });
	expect(relayed?.body["data"]).toMatchObject({ totals: { kcal: 52 }, targets: { kcal: { min: 2650, max: 2850 } } });
});

test("a day no plan covers still sends totals, with targets null", async () => {
	const closed = await closeDayFromUi(client, "2026-10-01");
	liaisonReceived.length = 0;
	expect(await deliverDue(db, liaison, env, [closed.deliveryId ?? ""])).toBe(1);
	const data = liaisonReceived[0]?.body["data"] as Record<string, unknown>;
	expect(data).toHaveProperty("totals");
	expect(data["targets"]).toBeNull();
	expect(data["progress"]).toBeNull();
	await pg.exec("delete from liaison.deliveries where ref = '2026-10-01'; delete from nutrition.deliveries where day = '2026-10-01'; delete from nutrition.days where day = '2026-10-01'");
});

test("a test close sends test: true inside data", async () => {
	const closed = await closeDayFromUi(client, "2099-01-01", true);
	received.length = 0;
	expect(await deliverDue(db, webhook, env, [closed.deliveryId ?? ""])).toBe(1);
	expect(received[0]?.body).toMatchObject({ app: "nutrition", event: "day.closed", data: { date: "2099-01-01", test: true } });
	liaisonReceived.length = 0;
	expect(await deliverDue(db, liaison, env, [closed.deliveryId ?? ""])).toBe(1);
	expect(liaisonReceived[0]?.body).toMatchObject({ app: "nutrition", event: "day.closed", deliveryId: closed.deliveryId, test: true, data: { date: "2099-01-01" } });
	expect(liaisonReceived[0]?.body).not.toHaveProperty("data.test");
	await pg.exec("delete from liaison.deliveries where ref = '2099-01-01'; delete from nutrition.deliveries where day = '2099-01-01'; delete from nutrition.days where day = '2099-01-01'");
});

test("closing through the bot queues no delivery", async () => {
	const day = await updateDay(client, "2026-11-21", { closed: true, bodyweight_lb: 180.6, energy: 7 });
	expect(day).toMatchObject({ closed: true, checkIn: { bodyweightLb: 180.6, energy: 7 } });
	expect((await pg.query("select 1 from nutrition.deliveries where day = '2026-11-21'")).rows).toHaveLength(0);
});

test("reading a day writes nothing", async () => {
	expect((await updateDay(client, "2026-11-25", {})).entries).toEqual([]);
	expect((await getHistory(client)).map((day) => day.date)).toEqual(["2026-11-21", "2026-11-20"]);
});

test("a closed day under half its kcal target is partial", async () => {
	const history = await getHistory(client);
	expect(history.find((day) => day.date === "2026-11-20")).toMatchObject({ kcal: 52, kcalTarget: 2750, kcalRange: { min: 2650, max: 2850 }, partial: true });
	expect(history.find((day) => day.date === "2026-11-21")).toMatchObject({ entries: 0, partial: false });
});

test("plan versions are never edited", async () => {
	const input = { effective_from: "2026-11-01", kcal: { min: 1, max: 2 }, protein_g: { min: 1, max: 2 }, fat_g: { min: 1, max: 2 }, carbs_g: { min: 1, max: 2 }, change: "x" };
	await expect(addTargets(client, input, "bot")).rejects.toBeInstanceOf(Rejected);
	const next = await addTargets(client, { ...input, effective_from: "2026-11-24" }, "bot");
	expect(next).toMatchObject({ notes: "Plan", stepsTarget: null });
});

test("a steps target carries forward until a version changes it", async () => {
	const input = { kcal: { min: 2650, max: 2850 }, protein_g: { min: 180, max: 220 }, fat_g: { min: 60, max: 90 }, carbs_g: { min: 250, max: 350 }, change: "Steps" };
	expect((await addTargets(client, { ...input, effective_from: "2026-12-01", steps_target: 10000 }, "bot")).stepsTarget).toBe(10000);
	expect((await addTargets(client, { ...input, effective_from: "2026-12-02" }, "bot")).stepsTarget).toBe(10000);
	expect((await addTargets(client, { ...input, effective_from: "2026-12-03", steps_target: null }, "bot")).stepsTarget).toBeNull();
	expect((await getDay(client, "2026-12-01")).targets?.stepsTarget).toBe(10000);
});

test("summarizes the open phase", async () => {
	expect(await getPhase(client, "2026-11-22")).toBeNull();
	const { rows } = await pg.query<{ id: number }>("insert into nutrition.phases (kind, start_date) values ('maintain', '2026-11-22') returning id");
	await pg.query("insert into nutrition.phase_trackers (phase_id, weeks, current_kcal_target) values ($1, 12, 2750)", [rows[0]?.id]);
	const phase = await getPhase(client, "2026-11-22");
	expect(phase?.summary.startWeight).toBe(180.6);
	expect(phase?.summary.current).toMatchObject({ week: 0, verdict: "on track" });
});

test("steps come from activity when Withings has the day", async () => {
	await updateDay(client, "2026-11-25", { steps: 4000 });
	expect((await getDay(client, "2026-11-25")).checkIn.steps).toBe(4000);
	await pg.query("insert into activity.days (day, source, steps, updated_by) values ('2026-11-25', 'withings', 11234, 'test'), ('2026-11-26', 'withings', 9000, 'test')");
	expect((await getDay(client, "2026-11-25")).checkIn.steps).toBe(11234);
	expect((await getDay(client, "2026-11-26")).checkIn).toMatchObject({ steps: 9000, notes: "" });
});

test("history shows each day's steps, nothing when there are none", async () => {
	const history = await getHistory(client);
	expect(history.find((day) => day.date === "2026-11-25")?.steps).toBe(11234);
	expect(history.find((day) => day.date === "2026-11-20")?.steps).toBeNull();
});

test("expenditure needs weigh-ins and averages steps over the range", async () => {
	const spent = await getExpenditure(client, "2027-01-01", "2027-01-31");
	expect(spent).toMatchObject({ tdee: null, measured: null, days: [], avgSteps: null });
	expect(await getExpenditure(client, "2026-11-01", "2026-11-30")).toMatchObject({ minDays: 14, avgSteps: Math.round((11234 + 9000) / 2), stepDays: 2 });
});

test("expenditure estimates each day from weight, profile, watch workouts, and logged lifts", async () => {
	await pg.query("insert into nutrition.weigh_ins (measured_on, source, weight_lb) select d::date, 'sheet', 180 from generate_series('2026-12-01'::date, '2026-12-20'::date, interval '1 day') d");
	await pg.query(
		`insert into activity.withings_workouts (id, category, local_date, started_at, ended_at, duration_s, steps, data) values
		(9001, 2, '2026-12-10', '2026-12-10T15:00:00Z', '2026-12-10T15:40:00Z', 2400, 5000, '{"data":{"manual_calories":500}}'),
		(9002, 6, '2026-12-11', '2026-12-11T15:00:00Z', '2026-12-11T20:00:00Z', 18000, null, '{"data":{"manual_calories":2000}}')`,
	);
	await pg.query("insert into activity.withings_measures (grpid, type, measured_at, value, attrib, category) values (77, 4, '2026-01-01T12:00:00Z', 1.8, 0, 1)");
	await pg.query("insert into workouts.history_sessions (path, session_date, kind, status, name) values ('h/2026-12-12.json', '2026-12-12', 'lift', 'completed', 'Squat day')");
	await pg.query("insert into workouts.history_exercises (path, position, exercise_key, name, status) values ('h/2026-12-12.json', 0, 'squat', 'Squat', 'completed'), ('h/2026-12-12.json', 1, 'curl', 'Curl', 'skipped')");
	await pg.query(
		"insert into workouts.history_sets (path, position, set_index, type, reps) values ('h/2026-12-12.json', 0, 0, 'warmup', 5), ('h/2026-12-12.json', 0, 1, 'working', 5), ('h/2026-12-12.json', 0, 2, null, 5), ('h/2026-12-12.json', 1, 0, 'working', 10)",
	);
	const unknownAge = await getExpenditure(client, "2026-12-10", "2026-12-12");
	await pg.query("insert into nutrition.profile (birth_date) values ('1990-03-14')");
	const spent = await getExpenditure(client, "2026-12-10", "2026-12-12");
	expect(spent).toMatchObject({ basis: "estimated", loggedDays: 0, measured: null });
	expect(spent.days.map((day) => day.date)).toEqual(["2026-12-10", "2026-12-11", "2026-12-12"]);
	const kg = 180 / 2.20462;
	expect(spent.days[0]?.bmr).toBe(Math.round(10 * kg + 6.25 * 180 - 5 * 36 + 5));
	expect((spent.days[0]?.bmr ?? 0) - (unknownAge.days[0]?.bmr ?? 0)).toBe(-5);
	expect(spent.days[0]?.sessions).toEqual([{ name: "run", kcal: Math.round(500 - 5000 * 0.000576 * kg), source: "watch" }]);
	expect(spent.days[1]?.sessions).toEqual([]);
	expect(spent.days[2]?.sessions).toEqual([{ name: "Squat day", kcal: Math.round(2 * 0.12 * kg), source: "estimate" }]);
	await pg.query("alter table nutrition.profile rename to profile_pending");
	expect((await getExpenditure(client, "2026-12-10", "2026-12-12")).days[0]?.bmr).toBe(unknownAge.days[0]?.bmr);
	await pg.query("alter table nutrition.profile_pending rename to profile");
});

test("steps list days with steps, calendar-window averages, and the target in effect", async () => {
	await pg.query("insert into activity.days (day, source, steps, updated_by) values ('2026-12-10', 'withings', 0, 'test')");
	const steps = await getSteps(client);
	expect(steps.map((day) => [day.date, day.steps, day.target])).toEqual([
		["2026-11-25", 11234, null],
		["2026-11-26", 9000, null],
	]);
	expect(steps[1]?.rolling7d).toBe(10117);
	await pg.query("insert into activity.days (day, source, steps, updated_by) values ('2026-12-01', 'withings', 8000, 'test')");
	const later = (await getSteps(client)).at(-1);
	expect(later).toMatchObject({ date: "2026-12-01", target: 10000 });
	expect(later?.rolling7d).toBeCloseTo((11234 + 9000 + 8000) / 3);
});
