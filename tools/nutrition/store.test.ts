import { PGlite } from "@electric-sql/pglite";
import { afterAll, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database, WithDb } from "../../worker/db.ts";
import { deliverDue } from "../../worker/webhooks.ts";
import { addTargets, changeFood, closeDayFromUi, getDay, getHistory, getPhase, Rejected, updateDay } from "./store.ts";
import webhook from "./webhook.ts";

const pg = new PGlite();
const migrationsDir = join(import.meta.dirname, "migrations");
const migrations = await Promise.all((await readdir(migrationsDir)).toSorted().map((name) => readFile(join(migrationsDir, name), "utf-8")));
await pg.exec(`create schema nutrition; set search_path to nutrition; ${migrations.join(";\n")}; set search_path to public;`);
const client: Database = {
	query: async (text: string, values?: unknown[]) => {
		const result = await pg.query(text, values);
		return { ...result, rowCount: result.affectedRows ?? result.rows.length };
	},
} as never;
const db: WithDb = (work) => work(client);

const received: { authorization: string | null; delivery: string | null; body: Record<string, unknown> }[] = [];
const server = Bun.serve({
	port: 0,
	async fetch(request) {
		received.push({ authorization: request.headers.get("authorization"), delivery: request.headers.get("x-nutrition-delivery"), body: await request.json() });
		return new Response(null, { status: 204 });
	},
});
afterAll(() => server.stop(true));

const KEY = "only-the-key 123";
const env = { NUTRITION_WEBHOOK_URL: server.url.href, NUTRITION_WEBHOOK_KEY: KEY } as Env;

const egg = { food: "Egg whites", qty: 200, unit: "g", kcal: 104, protein_g: 21.8, carbs_g: 1.5, fat_g: 0.4, source: "USDA FDC 172183 (Egg, white, raw)" };

await addTargets(
	client,
	{ effective_from: "2026-11-01", kcal: { min: 2650, max: 2850 }, protein_g: { min: 180, max: 220 }, fat_g: { min: 60, max: 90 }, carbs_g: { min: 250, max: 350 }, change: "Maintain", notes: "Plan" },
	"import",
);

test("adds food once per client key and totals it against targets", async () => {
	await changeFood(client, "2026-11-20", { add: [{ ...egg, client_key: "a" }] }, "bot");
	const day = await changeFood(client, "2026-11-20", { add: [{ ...egg, client_key: "a" }, { ...egg, food: "Rice", kcal: 400, source: undefined, client_key: "b" }] }, "ui");
	expect(day.entries.map((entry) => [entry.food, entry.sourceKind, entry.sourceRef])).toEqual([
		["Egg whites", "usda_fdc", "172183"],
		["Rice", "estimate", null],
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
	expect(day.entries[0]).toMatchObject({ qty: 100, kcal: 52, sourceKind: "estimate", sourceRef: null, sourceLabel: "a guess" });
	await expect(changeFood(client, "2026-11-20", { remove: [999] }, "ui")).rejects.toBeInstanceOf(Rejected);
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
		event: "day.closed",
		deliveryId: first.deliveryId,
		date: "2026-11-20",
		totals: { kcal: 52 },
		targets: { kcal: { min: 2650, max: 2850 } },
		progress: { kcal: { total: 52, status: "under" } },
	});
	await expect(changeFood(client, "2026-11-20", { add: [{ ...egg, client_key: "c" }] }, "ui")).rejects.toThrow("is closed");
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

test("plan versions are never edited", async () => {
	const input = { effective_from: "2026-11-01", kcal: { min: 1, max: 2 }, protein_g: { min: 1, max: 2 }, fat_g: { min: 1, max: 2 }, carbs_g: { min: 1, max: 2 }, change: "x" };
	await expect(addTargets(client, input, "bot")).rejects.toBeInstanceOf(Rejected);
	const next = await addTargets(client, { ...input, effective_from: "2026-11-24" }, "bot");
	expect(next.notes).toBe("Plan");
});

test("summarizes the open phase", async () => {
	expect(await getPhase(client, "2026-11-22")).toBeNull();
	const { rows } = await pg.query<{ id: number }>("insert into nutrition.phases (kind, start_date) values ('maintain', '2026-11-22') returning id");
	await pg.query("insert into nutrition.phase_trackers (phase_id, weeks, current_kcal_target) values ($1, 12, 2750)", [rows[0]?.id]);
	const phase = await getPhase(client, "2026-11-22");
	expect(phase?.summary.startWeight).toBe(180.6);
	expect(phase?.summary.current).toMatchObject({ week: 0, verdict: "on track" });
});
