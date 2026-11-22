import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database, WithDb } from "../../worker/db.ts";
import { deliverDue } from "../../worker/webhooks.ts";
import { parseSet } from "./api.ts";
import { pickBlock, repoSessions } from "./github.ts";
import { buildLog, checkLog, pacificMidnight } from "./log.ts";
import { formatLoad, formatVolume, parseProgram, programDays, weekOf, type Program } from "./program.ts";
import { buildSchedule, findDay } from "./schedule.ts";
import { createSession, finishSession, getSession, putSet, requeue, sessionRow, updateExercise } from "./store.ts";
import webhook from "./webhook.ts";

const BLOCK = {
	id: "build-block-c",
	name: "Block C",
	starts: "2026-10-26",
	ends: "2026-12-13",
	unit: "lb",
	calendar: {
		weekPattern: ["day-1", "cond-easy-cardio", "day-2", "rest", "day-3", "day-4", "rest"],
		weeks: { w1: "2026-10-26", w2: "2026-11-02", w3: "2026-11-09", w4: "2026-11-16", w5: "2026-11-23", w6: "2026-11-30", w7: "2026-12-07" },
		deloadWeek: "2026-12-07",
	},
	days: [
		{
			id: "day-1",
			title: "Legs",
			lifts: [
				{ id: "hip-abduction", name: "Hip Abduction", progression: "none", load: 145, sets: 2, repRange: [15, 20], targetRir: 3 },
				{ id: "hack-squat", name: "Hack Squat", wave: "loads.hack-squat", sets: 4, reps: 10, targetRir: 2 },
				{ id: "leg-ext", name: "Leg Extension", progression: "double_progression", sets: 3, deloadSets: 2, repRange: [12, 15], targetRir: 2 },
			],
		},
		{ id: "day-2", title: "Bench", lifts: [{ id: "pull-ups", name: "Weighted Pull-up", progression: "double_progression", sets: 3, repRange: [6, 8], targetRir: 2 }] },
		{ id: "day-3", title: "Deadlift", lifts: [{ id: "back-ext", name: "Back Extension", progression: "double_progression", setsByWeek: { w3: 2, w4: 3 }, sets: 3, repRange: [12, 15], targetRir: 2 }] },
		{ id: "day-4", title: "Upper", lifts: [{ id: "bench", name: "Bench Press", wave: "loads.bench", sets: 4, reps: 5, targetRir: 2 }] },
	],
	loads: {
		"hack-squat": { w3: { load: "find a weight at the target RIR in W3", sets: 4, reps: 10, targetRir: 2 }, w4: { weight: 115, sets: 4, reps: 10, targetRir: 2, notes: "plates per side" } },
		bench: { w4: { weight: 235, sets: 4, reps: 6, targetRir: 2.5 }, w5: { weight: 240, sets: 4, reps: 5, targetRir: 2 } },
	},
	accessoryStartLoads: { "leg-ext": 145, "pull-ups": "+42.5", "back-ext": 185 },
};

const program = parseProgram(BLOCK) as Program;

describe("program", () => {
	test("finds the week for a date and lays days on the week pattern", () => {
		expect(weekOf(program, "2026-11-22")).toBe("w4");
		expect(weekOf(program, "2026-11-23")).toBe("w5");
		expect(programDays(program, "w5").map((day) => [day.dayId, day.date])).toEqual([
			["day-1", "2026-11-23"],
			["day-2", "2026-11-25"],
			["day-3", "2026-11-27"],
			["day-4", "2026-11-28"],
		]);
	});

	test("shows repo values without computing loads", () => {
		const [abduction, hack, legExt] = findDay(program, "w4", "day-1")?.exercises ?? [];
		expect(abduction && [formatLoad(abduction), formatVolume(abduction)]).toEqual(["145 lb", "2 × 15–20 @3"]);
		expect(hack && [formatLoad(hack), formatVolume(hack), hack.notes]).toEqual(["115 lb", "4 × 10 @2", ["plates per side"]]);
		expect(legExt && [formatLoad(legExt), formatVolume(legExt)]).toEqual(["145 lb", "3 × 12–15 @2"]);
		const w3hack = findDay(program, "w3", "day-1")?.exercises[1];
		expect(w3hack?.load).toEqual({ kind: "text", text: "find a weight at the target RIR in W3" });
		expect(findDay(program, "w4", "day-4")?.exercises[0]?.targetRir).toBe(2.5);
		expect(findDay(program, "w4", "day-2")?.exercises[0]?.load).toEqual({ kind: "text", text: "+42.5" });
		expect(findDay(program, "w3", "day-3")?.exercises[0]?.sets).toBe(2);
		expect(findDay(program, "w7", "day-1")?.exercises[2]?.sets).toBe(2);
	});

	test("reads logged days from repo file names inside the block", () => {
		const names = ["2026-11-21-bc-w4-d4.json", "2026-11-21-bc-w4-d4.md", "2026-11-18-bc-w4-run.json", "2026-10-01-bb-w4-d1.json"];
		expect(repoSessions(names, program)).toEqual([{ file: "2026-11-21-bc-w4-d4.json", date: "2026-11-21", weekId: "w4", dayId: "day-4" }]);
	});

	test("picks the block that contains today", () => {
		const older = parseProgram({ ...BLOCK, id: "b", starts: "2026-09-01", ends: "2026-10-25" }) as Program;
		const blocks = new Map([
			["block-c.json", program],
			["block-b.json", older],
		]);
		expect(pickBlock(["block-c.json", "block-b.json"], "2026-11-22", blocks)?.id).toBe("build-block-c");
		expect(pickBlock(["block-c.json", "block-b.json"], "2026-10-01", blocks)?.id).toBe("b");
	});

	test("today's session is the first day not logged in the repo or the app", () => {
		const repo = repoSessions(["2026-11-16-bc-w4-d1.json", "2026-11-17-bc-w4-d2.json", "2026-11-19-bc-w4-d3.json", "2026-11-21-bc-w4-d4.json"], program);
		const schedule = buildSchedule(program, repo, [], "2026-11-22");
		expect(schedule.currentWeek).toBe("w4");
		expect([schedule.next?.weekId, schedule.next?.dayId]).toEqual(["w5", "day-1"]);
		const app = [{ id: "s1", blockId: "build-block-c", weekId: "w5", dayId: "day-1", status: "finished" as const, test: false }];
		expect(buildSchedule(program, repo, app, "2026-11-23").next?.dayId).toBe("day-2");
		const test = [{ ...app[0], test: true } as (typeof app)[number]];
		expect(buildSchedule(program, repo, test, "2026-11-23").next?.dayId).toBe("day-1");
	});
});

describe("parseSet", () => {
	test("keeps RIR whole and requires a unit with a weight", () => {
		expect(parseSet({ weight: 235, unit: "lb", reps: 6, rir: 2 })).toEqual({ weight: 235, unit: "lb", reps: 6, rir: 2, asWritten: false, notes: null });
		expect(() => parseSet({ rir: 2.5 })).toThrow("put half RIR in notes");
		expect(() => parseSet({ weight: 235 })).toThrow("unit");
		expect(parseSet({ reps: 8, notes: " ~2.5 RIR " })).toEqual({ weight: null, unit: null, reps: 8, rir: null, asWritten: false, notes: "~2.5 RIR" });
	});
});

test("dates are midnight Pacific with the right offset", () => {
	expect(pacificMidnight("2026-11-23")).toBe("2026-11-23T00:00:00-08:00");
	expect(pacificMidnight("2026-07-04")).toBe("2026-07-04T00:00:00-07:00");
});

const pg = new PGlite();
const migration = await readFile(join(import.meta.dirname, "migrations/0001-create-sessions.sql"), "utf-8");
await pg.exec(`create schema workouts; set search_path to workouts; ${migration}; set search_path to public;`);
const client = { query: (text: string, values?: unknown[]) => pg.query(text, values).then((result) => ({ ...result, rowCount: result.affectedRows ?? result.rows.length })) } as unknown as Database;
const db: WithDb = (work) => work(client);

const received: { authorization: string | null; delivery: string | null; body: { deliveryId: string; sessionId: string; test?: boolean; log: Record<string, unknown> } }[] = [];
const server = Bun.serve({
	port: 0,
	async fetch(request) {
		received.push({ authorization: request.headers.get("authorization"), delivery: request.headers.get("x-workouts-delivery"), body: await request.json() });
		return new Response(null, { status: 202 });
	},
});
afterAll(() => server.stop(true));
const KEY = "grok-routine-key_123";
const env = { COACH_WEBHOOK_URL: server.url.href, COACH_WEBHOOK_KEY: KEY } as Env;

beforeEach(async () => {
	received.length = 0;
	await pg.exec("delete from workouts.sessions");
});

describe("session lifecycle", () => {
	test("logs literally, finishes once, and delivers with the key as the whole Authorization header", async () => {
		const day = findDay(program, "w5", "day-1");
		if (day === null) throw new Error("missing day");
		const id = await createSession(client, program.id, day, "2026-11-23", false);
		expect(await createSession(client, program.id, day, "2026-11-23", false)).toBe(id);
		await putSet(client, id, 0, 0, { weight: 145, unit: "lb", reps: 20, rir: 3, asWritten: true, notes: null });
		await putSet(client, id, 0, 1, { weight: 155, unit: "lb", reps: 18, rir: 2, asWritten: false, notes: "~2.5 RIR" });
		await updateExercise(client, id, 2, { status: "skipped", notes: "knee" });

		const session = await getSession(client, id);
		if (session === null) throw new Error("missing session");
		const log = buildLog(sessionRow(session));
		expect(checkLog(log)).toEqual([]);
		expect(log).toMatchObject({ date: "2026-11-23T00:00:00-08:00", blockId: "build-block-c", weekId: "w5", dayId: "day-1", name: "W5 Legs" });
		const [abduction, hack, legExt] = log.exercises as Record<string, unknown>[];
		expect(abduction).toMatchObject({
			id: "hip-abduction",
			status: "completed",
			prescribed: { targetWeight: 145, unit: "lb", targetRepsMin: 15, targetRepsMax: 20, targetSets: 2, targetRIR: 3 },
			sets: [
				{ weight: 145, unit: "lb", reps: 20, rir: 3, type: "working", notes: "as written" },
				{ weight: 155, unit: "lb", reps: 18, rir: 2, type: "working", notes: "~2.5 RIR" },
			],
		});
		expect(hack).toMatchObject({ id: "hack-squat", status: "skipped", sets: [{ reps: 0, type: "working", notes: "skipped" }] });
		expect(legExt).toMatchObject({ id: "leg-ext", status: "skipped", notes: "knee", sets: [{ reps: 0, type: "working", notes: "skipped" }] });

		const deliveryId = await finishSession(client, id, (delivery) => ({ event: "session.finished", deliveryId: delivery, sessionId: id, log }));
		expect(await finishSession(client, id, () => ({}))).toBe(deliveryId);
		expect(await deliverDue(db, webhook, env, [deliveryId])).toBe(1);
		expect(received).toHaveLength(1);
		expect(received[0]?.authorization).toBe(KEY);
		expect(received[0]?.delivery).toBe(deliveryId);
		expect(received[0]?.body).toMatchObject({ deliveryId, sessionId: id });

		expect(await requeue(client, id)).toBe(deliveryId);
		expect(await deliverDue(db, webhook, env, [deliveryId])).toBe(1);
		expect(received.map((delivery) => [delivery.delivery, delivery.body.deliveryId, delivery.authorization])).toEqual([
			[deliveryId, deliveryId, KEY],
			[deliveryId, deliveryId, KEY],
		]);
		expect((await getSession(client, id))?.delivery).toMatchObject({ deliveryId, attempts: 2, lastStatus: 202 });
	});

	test("test sessions never take a real day's slot", async () => {
		const day = findDay(program, "w5", "day-1");
		if (day === null) throw new Error("missing day");
		const real = await createSession(client, program.id, day, "2026-11-23", false);
		const first = await createSession(client, program.id, day, "2026-11-23", true);
		const second = await createSession(client, program.id, day, "2026-11-23", true);
		expect(new Set([real, first, second]).size).toBe(3);
		const session = await getSession(client, first);
		if (session === null) throw new Error("missing session");
		expect(buildLog(sessionRow(session))).toMatchObject({ name: "TEST W5 Legs", test: true });
	});

	test("deliveries wait while the URL or key is unset", async () => {
		expect(webhook.target({ COACH_WEBHOOK_URL: "https://x" } as Env)).toBeNull();
		expect(webhook.target({ COACH_WEBHOOK_KEY: "k" } as Env)).toBeNull();
		expect(webhook.target(env)).toEqual({ url: server.url.href, authorization: KEY, deliveryHeader: "X-Workouts-Delivery" });
	});
});
