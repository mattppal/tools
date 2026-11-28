import { PGlite } from "@electric-sql/pglite";
import { afterAll, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database, WithDb } from "../../worker/db.ts";
import { deliverDue } from "../../worker/webhooks.ts";
import { addTargets, changeFood, closeDayFromUi, getDay, getExpenditure, getHistory, getPhase, getSteps, Rejected, setPhase, updateDay } from "./store.ts";
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
	expect(relayed?.body).toEqual({ app: "nutrition", event: "day.closed", deliveryId: first.deliveryId, data: { ...legacyData, full: { method: "GET", path: "/api/tools/nutrition/day?date=2026-11-20" } } });
	expect(relayed?.body["data"]).toMatchObject({ totals: { kcal: 52 }, targets: { kcal: { min: 2650, max: 2850 } } });
	expect((await getDay(client, "2026-11-20")).closedAt).toBe((relayed?.body["data"] as { closedAt: string }).closedAt);
	expect(await getDay(client, "2098-06-01")).toMatchObject({ date: "2098-06-01", closed: false, closedAt: null, entries: [] });
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

test("a day marked partial on an open or closed day can be cleared, and keeps its weigh-in", async () => {
	await changeFood(client, "2026-11-17", { add: [{ ...egg, kcal: 2700, client_key: "p1" }] }, "bot");
	expect(await updateDay(client, "2026-11-17", { partial: true, bodyweight_lb: 181 })).toMatchObject({ closed: false, partial: true });
	await updateDay(client, "2026-11-17", { closed: true });
	expect(await getDay(client, "2026-11-17")).toMatchObject({ closed: true, partial: true, checkIn: { bodyweightLb: 181 } });
	expect((await getHistory(client)).find((day) => day.date === "2026-11-17")).toMatchObject({ kcal: 2700, partial: true });
	expect((await updateDay(client, "2026-11-17", { partial: false })).partial).toBe(false);
	expect((await getHistory(client)).find((day) => day.date === "2026-11-17")?.partial).toBe(false);
	await pg.exec("delete from nutrition.food_entries where day = '2026-11-17'; delete from nutrition.weigh_ins where measured_on = '2026-11-17'; delete from nutrition.days where day = '2026-11-17'");
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

test("a phase switch needs a start weight to turn pounds into a rate", async () => {
	await expect(setPhase(client, { kind: "cut", start_date: "2026-11-30", target_lb_per_week: -0.5 }, "nutrition")).rejects.toThrow(
		"No weigh-in in the 7 days ending 2026-11-30 and no start_weight_override_lb",
	);
	await expect(setPhase(client, { kind: "cut", start_date: "2026-11-23" }, "nutrition")).rejects.toThrow("needs target_rate_per_week or target_lb_per_week");
	await expect(setPhase(client, { kind: "cut", target_rate_per_week: -0.005 }, "nutrition")).rejects.toThrow("needs start_date");
	await expect(setPhase(client, { kind: "cut", start_date: "2026-11-22", target_rate_per_week: -0.005 }, "nutrition")).rejects.toThrow("after the open maintain phase's start");
	await expect(setPhase(client, { kind: "cut", start_date: "2026-11-23", target_lb_per_week: -10 }, "nutrition")).rejects.toThrow("over the 0.02 limit");
	await expect(setPhase(client, { kind: "gain", start_date: "2026-11-23", target_rate_per_week: -0.005 }, "nutrition")).rejects.toThrow("A gain's rate is positive");
	await expect(setPhase(client, { target_rate_per_week: 0.001 }, "nutrition")).rejects.toThrow("A maintain phase's rate is 0");
	expect((await pg.query("select kind from nutrition.phases")).rows).toEqual([{ kind: "maintain" }]);
});

test("a future cut closes maintain the day before, and maintain shows until the cut starts", async () => {
	const update = await setPhase(client, { kind: "cut", start_date: "2026-11-23", target_lb_per_week: -0.5, weeks: 12, current_kcal_target: 2450 }, "nutrition");
	expect(update).toMatchObject({
		phase: { kind: "cut", startDate: "2026-11-23", settings: { targetRatePerWeek: -0.00277, weeks: 12, currentKcalTarget: 2450, startWeightOverrideLb: null, toleranceLb: 0.5 }, summary: { lbPerWeekAtStart: -0.5 } },
		startWeightLb: 180.6,
		closed: { kind: "maintain", startDate: "2026-11-22", endDate: "2026-11-22" },
		previous: { kind: "maintain", startDate: "2026-11-22", targetRatePerWeek: 0, currentKcalTarget: 2750 },
	});
	expect(await getPhase(client, "2026-11-22")).toMatchObject({ kind: "maintain", upcoming: { kind: "cut", startDate: "2026-11-23" } });
	expect(await getPhase(client, "2026-11-23")).toMatchObject({ kind: "cut", upcoming: null });
	expect((await getDay(client, "2026-11-22")).phase).toBe("maintain");

	const retried = await setPhase(client, { kind: "cut", start_date: "2026-11-23", target_lb_per_week: -0.5, weeks: 12, current_kcal_target: 2450 }, "nutrition");
	expect(retried).toMatchObject({ closed: null, previous: {}, phase: { settings: update.phase.settings } });
	expect((await pg.query("select count(*)::int as n from nutrition.phases")).rows).toEqual([{ n: 2 }]);
	expect((await pg.query("select count(*)::int as n from nutrition.phase_tracker_changes")).rows).toEqual([{ n: 0 }]);
});

test("same-kind edits stay in place and log each changed field", async () => {
	await expect(setPhase(client, { start_date: "2026-11-22" }, "nutrition")).rejects.toThrow("after 2026-11-22, when the previous phase ended");
	const edit = await setPhase(client, { weeks: 16, tolerance_lb: 0.5, start_weight_override_lb: 182 }, "nutrition");
	expect(edit).toMatchObject({ closed: null, previous: { weeks: 12, startWeightOverrideLb: null }, startWeightLb: 182, phase: { settings: { weeks: 16, targetRatePerWeek: -0.00277 } } });
	expect(Object.keys(edit.previous).toSorted()).toEqual(["startWeightOverrideLb", "weeks"]);
	await addTargets(
		client,
		{ effective_from: "2026-11-23", kcal: { min: 2350, max: 2550 }, protein_g: { min: 180, max: 220 }, fat_g: { min: 60, max: 90 }, carbs_g: { min: 200, max: 300 }, change: "Cut", current_kcal_target: 2400 },
		"bot",
		"nutrition",
	);
	expect((await pg.query("select field, old_value, new_value, changed_by from nutrition.phase_tracker_changes order by id")).rows).toEqual([
		{ field: "start_weight_override_lb", old_value: null, new_value: "182", changed_by: "nutrition" },
		{ field: "weeks", old_value: "12", new_value: "16", changed_by: "nutrition" },
		{ field: "current_kcal_target", old_value: "2450", new_value: "2400", changed_by: "nutrition" },
	]);
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

test("expenditure adds Apple workouts without a Withings twin, fills a twin's missing kcal, and reads Apple intake", async () => {
	await pg.query(
		"insert into activity.withings_workouts (id, category, local_date, started_at, ended_at, duration_s, data) values (9003, 6, '2026-12-13', '2026-12-13T15:00:00Z', '2026-12-13T16:00:00Z', 3600, '{}')",
	);
	await pg.query(
		`insert into activity.apple_health_workouts (id, name, source, local_date, started_at, ended_at, duration_s, active_kcal, distance_m, data) values
		('a-run', 'Outdoor Run', 'Watch', '2026-12-10', '2026-12-10T15:01:00Z', '2026-12-10T15:40:00Z', 2340, 480, 5000, '{}'),
		('a-bike', 'Outdoor Cycling', 'Watch', '2026-12-13', '2026-12-13T15:02:00Z', '2026-12-13T16:00:00Z', 3480, 400, 20000, '{}'),
		('a-row', 'Rowing', 'ErgData', '2026-12-14', '2026-12-14T15:00:00Z', '2026-12-14T15:20:00Z', 1200, 200, 4000, '{}')`,
	);
	await pg.query(
		"insert into activity.apple_health_samples (metric, source, measured_at, utc_offset_min, units, qty) values ('dietary_energy', 'Cronometer', '2026-12-15T13:00:00Z', -480, 'kcal', 1500), ('dietary_energy', 'Cronometer', '2026-12-15T20:00:00Z', -480, 'kcal', 1000)",
	);
	const spent = await getExpenditure(client, "2026-12-10", "2026-12-15");
	const kg = 180 / 2.20462;
	const on = (date: string) => spent.days.find((day) => day.date === date);
	expect(on("2026-12-10")?.sessions).toEqual([{ name: "run", kcal: Math.round(500 - 5000 * 0.000576 * kg), source: "watch" }]);
	expect(on("2026-12-13")?.sessions).toEqual([{ name: "bicycling", kcal: 400, source: "watch" }]);
	expect(on("2026-12-14")?.sessions).toEqual([{ name: "rowing", kcal: 200, source: "watch" }]);
	expect(on("2026-12-15")?.intake).toBe(2500);
	expect(spent.loggedDays).toBe(1);
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

test("a marked day leaves expenditure intake, isn't filled from Apple, and is counted", async () => {
	await updateDay(client, "2026-12-15", { partial: true });
	await changeFood(client, "2026-12-14", { add: [{ ...egg, kcal: 2600, client_key: "p2" }] }, "bot");
	await updateDay(client, "2026-12-14", { closed: true });
	const on = (spent: Awaited<ReturnType<typeof getExpenditure>>, date: string) => spent.days.find((day) => day.date === date)?.intake;
	const before = await getExpenditure(client, "2026-12-10", "2026-12-15");
	expect([on(before, "2026-12-14"), on(before, "2026-12-15"), before.loggedDays, before.partialDays]).toEqual([2600, null, 1, 0]);
	await updateDay(client, "2026-12-14", { partial: true });
	const after = await getExpenditure(client, "2026-12-10", "2026-12-15");
	expect([on(after, "2026-12-14"), after.loggedDays, after.partialDays]).toEqual([null, 0, 1]);
});
