import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database, WithDb } from "../../worker/db.ts";
import { deliverDue } from "../../worker/webhooks.ts";
import { parseSet } from "./api.ts";
import { buildLog, checkLog, pacificMidnight } from "./log.ts";
import { formatLoad, formatVolume, parseProgram, programDays, weekOf, type Program } from "./program.ts";
import { buildWeek, currentWeek, findDay as findIn, nextDay, parseRepoSession, trainingLogFrom, weekRefs } from "./schedule.ts";
import { BLOB_BATCH, readMirror, readSyncState, syncTrainingLog, type Fetcher, type MirroredFile } from "./sync.ts";
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
	conditioning: { id: "cond-easy-cardio", slot: "cond-easy-cardio", name: "Easy jog", durationMinutes: [30, 40], effort: "easy conversational", format: "steady easy jog, not intervals" },
};

const BLOCK_B = {
	id: "build-block-b",
	name: "Block B",
	starts: "2026-09-07",
	unit: "lb",
	calendar: { weekPattern: ["day-1", "cond-b-track-or-z2", "day-2", "rest", "day-3", "day-4", "rest"], week1Start: "2026-09-07" },
	days: [{ id: "day-1", title: "Squat", lifts: [] }],
};

const program = parseProgram(BLOCK) as Program;

function findDay(_program: Program, weekId: string, dayId: string) {
	return programDays(program, weekId).find((day) => day.dayId === dayId) ?? null;
}

function session(path: string, extra: Record<string, unknown> = {}) {
	return { path, content: { date: `${path.slice(9, 19)}T00:00:00-08:00`, exercises: [{ exercise: { name: "Bench Press" }, sets: [{ weight: 235, unit: "lb", reps: 6, rir: 2 }] }], ...extra } };
}

describe("program", () => {
	test("finds the week for a date and lays days on the week pattern", () => {
		expect(weekOf(program, "2026-11-22")).toBe("w4");
		expect(weekOf(program, "2026-11-23")).toBe("w5");
		expect(programDays(program, "w5").map((day) => [day.dayId, day.kind, day.date])).toEqual([
			["day-1", "lift", "2026-11-23"],
			["cond-easy-cardio", "conditioning", "2026-11-24"],
			["day-2", "lift", "2026-11-25"],
			["day-3", "lift", "2026-11-27"],
			["day-4", "lift", "2026-11-28"],
		]);
		expect(programDays(program, "w5")[1]).toMatchObject({ title: "Easy jog", plan: ["30–40 min", "easy conversational", "steady easy jog, not intervals"], exercises: [] });
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

	test("matches repo sessions by blockId, or by file name and date", () => {
		const log = trainingLogFrom([{ path: "program/block-c.json", content: BLOCK }], [
			session("sessions/2026-11-21-bc-w4-d4.json", { blockId: "build-block-c", weekId: "w4", dayId: "day-4" }),
			session("sessions/2026-11-16-bc-w4-d1.json"),
			session("sessions/2026-11-18-bc-w4-run.json"),
			session("sessions/2026-10-01-bb-w4-d2.json"),
		]);
		const w4 = weekRefs(log).find((week) => week.weekId === "w4");
		if (w4 === undefined) throw new Error("missing w4");
		const days = buildWeek(log, [], w4).days;
		expect(days.map((day) => [day.dayId, day.state, day.repoFile])).toEqual([
			["day-1", "logged", "sessions/2026-11-16-bc-w4-d1.json"],
			["cond-easy-cardio", "todo", null],
			["day-2", "todo", null],
			["day-3", "todo", null],
			["day-4", "logged", "sessions/2026-11-21-bc-w4-d4.json"],
		]);
		expect(days[4]?.logged).toEqual([{ name: "Bench Press", summary: "235 × 6 @2" }]);
	});

	test("shows runs on their planned slot and logged days the plan doesn't list", () => {
		const jog = { date: "2026-11-09T00:00:00-08:00", name: "C W3 Easy jog", blockId: "build-block-c", weekId: "w3", dayId: "cond-easy-cardio", kind: "conditioning", status: "completed", exercises: [{ status: "completed", exercise: { name: "Easy jog" }, sets: [{ distance: 5, distanceUnit: "mi" }] }] };
		const bike = { date: "2026-11-12T06:59:00-08:00", name: "Air bike", blockId: "build-block-c", weekId: "w3", dayId: "cond-extra", kind: "conditioning", status: "completed", exercises: [{ status: "completed", exercise: { name: "Air Bike" }, sets: [{ durationSeconds: 1801 }] }, { status: "completed", exercise: { name: "Mobility" }, sets: [{}] }] };
		const run = { date: "2026-11-18T00:00:00-08:00", name: "C W4 Easy jog (skipped, rain)", blockId: "build-block-c", weekId: "w4", dayId: "cond-easy-cardio", kind: "conditioning", status: "skipped", exercises: [{ status: "skipped", exercise: { name: "Easy jog" }, sets: [{ notes: "not done" }] }] };
		const log = trainingLogFrom([{ path: "program/block-c.json", content: BLOCK }], [
			{ path: "sessions/2026-11-09-bc-w3-jog.json", content: jog },
			{ path: "sessions/2026-11-12-bc-w3-bike.json", content: bike },
			{ path: "sessions/2026-11-18-bc-w4-run.json", content: run },
		]);
		const weeks = weekRefs(log);
		const w3 = buildWeek(log, [], weeks.find((week) => week.key === "build-block-c/w3") as (typeof weeks)[number]).days;
		expect(w3.map((day) => [day.dayId, day.date, day.planned, day.state])).toEqual([
			["day-1", "2026-11-09", true, "todo"],
			["cond-easy-cardio", "2026-11-09", true, "logged"],
			["day-2", "2026-11-11", true, "todo"],
			["cond-extra", "2026-11-12", false, "logged"],
			["day-3", "2026-11-13", true, "todo"],
			["day-4", "2026-11-14", true, "todo"],
		]);
		expect(w3[1]?.logged).toEqual([{ name: "Easy jog", summary: "5 mi" }]);
		expect(w3[3]?.logged).toEqual([{ name: "Air Bike", summary: "30:01" }, { name: "Mobility", summary: "Done" }]);
		const w4 = buildWeek(log, [], weeks.find((week) => week.key === "build-block-c/w4") as (typeof weeks)[number]).days;
		expect(w4[1]).toMatchObject({ dayId: "cond-easy-cardio", state: "logged", repoStatus: "skipped", logged: [{ name: "Easy jog", summary: "Skipped" }] });
		expect(findDay(program, "w4", "cond-easy-cardio")?.kind).toBe("conditioning");
		expect(findIn(log, "build-block-c", "w4", "cond-easy-cardio")).toBeNull();
	});

	test("builds past weeks from logged sessions when a block has no calendar", () => {
		const lift = (date: string, weekId: string, dayId: string, name: string, kind = "lift") => ({ date: `${date}T07:30:00-07:00`, name, blockId: "build-block-b", weekId, dayId, kind, status: "completed", exercises: [] });
		const log = trainingLogFrom(
			[{ path: "program/block-b.json", content: BLOCK_B }, { path: "program/block-c.json", content: BLOCK }],
			[
				{ path: "sessions/2026-09-08-bw1d1.json", content: lift("2026-09-08", "w1", "day-1", "B W1 Squat") },
				{ path: "sessions/2026-10-13-bw-d2.json", content: lift("2026-10-13", "hold", "day-2", "B Bench") },
				{ path: "sessions/2026-10-12-bw-d1.json", content: lift("2026-10-12", "rebuild", "day-1", "B Squat") },
				{ path: "sessions/2026-10-22-deload.json", content: lift("2026-10-22", "deload", "recovery", "Deload recovery session") },
			],
		);
		const weeks = weekRefs(log);
		expect(weeks.slice(0, 3).map((week) => [week.key, week.blockName, week.weekId, week.start])).toEqual([
			["build-block-b/2026-09-07", "Block B", "w1", "2026-09-07"],
			["build-block-b/2026-10-12", "Block B", "rebuild · hold", "2026-10-12"],
			["build-block-b/2026-10-19", "Block B", "deload", "2026-10-19"],
		]);
		expect(weeks[3]?.key).toBe("build-block-c/w1");
		const deload = buildWeek(log, [], weeks[2] as (typeof weeks)[number]).days;
		expect(deload).toMatchObject([{ dayId: "recovery", title: "Deload recovery session", planned: false, state: "logged" }]);
		expect(buildWeek(log, [], weeks[1] as (typeof weeks)[number]).days.map((day) => day.title)).toEqual(["B Squat", "B Bench"]);
	});

	test("lists every week across blocks and finds the current one", () => {
		const older = { ...BLOCK, id: "build-block-b", name: "Block B", starts: "2026-09-14", ends: "2026-10-25", calendar: { ...BLOCK.calendar, weeks: { w1: "2026-09-14", w6: "2026-10-19" } } };
		const weeks = weekRefs(trainingLogFrom([{ path: "program/block-b.json", content: older }, { path: "program/block-c.json", content: BLOCK }], []));
		expect(weeks.map((week) => week.key).slice(0, 3)).toEqual(["build-block-b/w1", "build-block-b/w6", "build-block-c/w1"]);
		expect(weeks.at(-1)).toMatchObject({ key: "build-block-c/w7", start: "2026-12-07", end: "2026-12-13" });
		expect(currentWeek(weeks, "2026-11-22")?.key).toBe("build-block-c/w4");
		expect(currentWeek(weeks, "2026-10-20")?.key).toBe("build-block-b/w6");
	});

	test("today's session is the first day not logged in the repo or the app", () => {
		const log = trainingLogFrom([{ path: "program/block-c.json", content: BLOCK }], ["d1", "d2", "d3", "d4"].map((day, index) => session(`sessions/2026-11-${16 + index}-bc-w4-${day}.json`)));
		const weeks = weekRefs(log);
		expect(nextDay(log, [], weeks, "2026-11-22")).toMatchObject({ blockId: "build-block-c", weekId: "w5", dayId: "day-1" });
		const monday = [{ id: "s0", blockId: "build-block-c", weekId: "w5", dayId: "day-1", status: "finished" as const, test: false }];
		expect(nextDay(log, monday, weeks, "2026-11-24")).toMatchObject({ dayId: "cond-easy-cardio", kind: "conditioning", title: "Easy jog" });
		const app = [{ id: "s1", blockId: "build-block-c", weekId: "w5", dayId: "day-1", status: "finished" as const, test: false }];
		expect(nextDay(log, app, weeks, "2026-11-23")?.dayId).toBe("cond-easy-cardio");
		expect(nextDay(log, [{ ...app[0], test: true } as (typeof app)[number]], weeks, "2026-11-23")?.dayId).toBe("day-1");
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
const migrationsDir = join(import.meta.dirname, "migrations");
const migrations = await Promise.all((await readdir(migrationsDir)).toSorted().map((name) => readFile(join(migrationsDir, name), "utf-8")));
await pg.exec(`create schema workouts; set search_path to workouts; ${migrations.join(";\n")}; set search_path to public;`);
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
	test("logs literally, finishes once, and delivers with the key as a Bearer token", async () => {
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
		expect(received[0]?.authorization).toBe(`Bearer ${KEY}`);
		expect(received[0]?.delivery).toBe(deliveryId);
		expect(received[0]?.body).toMatchObject({ deliveryId, sessionId: id });

		expect(await requeue(client, id)).toBe(deliveryId);
		expect(await deliverDue(db, webhook, env, [deliveryId])).toBe(1);
		expect(received.map((delivery) => [delivery.delivery, delivery.body.deliveryId, delivery.authorization])).toEqual([
			[deliveryId, deliveryId, `Bearer ${KEY}`],
			[deliveryId, deliveryId, `Bearer ${KEY}`],
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
		const day = findDay(program, "w5", "day-1");
		if (day === null) throw new Error("missing day");
		const id = await createSession(client, program.id, day, "2026-11-23", true);
		const deliveryId = await finishSession(client, id, (delivery) => ({ event: "session.finished", deliveryId: delivery, sessionId: id }));
		expect(await deliverDue(db, webhook, { COACH_WEBHOOK_URL: server.url.href } as Env, [deliveryId])).toBe(0);
		expect(await deliverDue(db, webhook, { COACH_WEBHOOK_KEY: KEY } as Env, [deliveryId])).toBe(0);
		expect(received).toHaveLength(0);
		expect((await getSession(client, id))?.delivery).toMatchObject({ deliveryId, attempts: 0 });
		expect(await deliverDue(db, webhook, env, [deliveryId])).toBe(1);
		expect(received.map((delivery) => delivery.delivery)).toEqual([deliveryId]);
	});
});

describe("training-log sync", () => {
	type Repo = { head: string; files: Record<string, { sha: string; content: string }> };
	const repo: Repo = { head: "a".repeat(40), files: {} };
	const calls: string[] = [];
	const fetcher: Fetcher = async (url, init) => {
		const path = url.replace("https://api.github.com/repos/mattppal/training-log", "");
		const headers = new Headers(init.headers);
		calls.push(path);
		expect(headers.get("authorization")).toBe("Bearer test-token");
		if (path === "/commits/main") {
			const etag = `"${repo.head}"`;
			if (headers.get("if-none-match") === etag) return new Response(null, { status: 304 });
			return new Response(repo.head, { headers: { etag } });
		}
		if (path.startsWith("/git/trees/")) {
			const tree = [
				{ path: "program", type: "tree", sha: "t0" },
				{ path: "README.md", type: "blob", sha: "r0" },
				{ path: "sessions/2026-11-21-bc-w4-d4.md", type: "blob", sha: "m0" },
				...Object.entries(repo.files).map(([file, blob]) => ({ path: file, type: "blob", sha: blob.sha })),
			];
			return Response.json({ sha: repo.head, tree, truncated: false });
		}
		const sha = path.replace("/git/blobs/", "");
		const blob = sha === "m0" ? { content: "---\nkind: lift\n---\n" } : Object.values(repo.files).find((file) => file.sha === sha);
		return blob === undefined ? new Response(null, { status: 404 }) : Response.json({ sha, encoding: "base64", content: Buffer.from(blob.content).toString("base64") });
	};
	const syncEnv = { TRAINING_LOG_TOKEN: "test-token" } as Env;

	beforeEach(async () => {
		calls.length = 0;
		await pg.exec("delete from workouts.repo_files; update workouts.repo_sync set head_sha = null, head_etag = null, synced_at = null, checked_at = null, last_error = null;");
		repo.head = "a".repeat(40);
		repo.files = {
			"program/block-c.json": { sha: "p1", content: JSON.stringify(BLOCK) },
			"sessions/2026-11-21-bc-w4-d4.json": { sha: "s1", content: JSON.stringify({ date: "2026-11-21T00:00:00-08:00", blockId: "build-block-c", weekId: "w4", dayId: "day-4", exercises: [] }) },
		};
	});

	test("mirrors program and session JSON, then costs one conditional request while HEAD is unchanged", async () => {
		expect(await syncTrainingLog(client, syncEnv, { fetcher })).toEqual({ status: "synced", headSha: repo.head, changed: 2, removed: 0 });
		const mirror = await readMirror(client);
		expect(mirror.programs.map((file) => file.path)).toEqual(["program/block-c.json"]);
		expect(mirror.sessions.map((file) => file.path)).toEqual(["sessions/2026-11-21-bc-w4-d4.json"]);
		expect((await readSyncState(client)).headSha).toBe(repo.head);

		calls.length = 0;
		expect(await syncTrainingLog(client, syncEnv, { fetcher })).toEqual({ status: "unchanged", headSha: repo.head });
		expect(calls).toEqual(["/commits/main"]);
	});

	test("fetches only blobs whose SHA changed and drops removed files", async () => {
		await syncTrainingLog(client, syncEnv, { fetcher });
		repo.head = "b".repeat(40);
		repo.files["sessions/2026-11-21-bc-w4-d4.json"] = { sha: "s2", content: JSON.stringify({ date: "2026-11-21T00:00:00-08:00", exercises: [] }) };
		repo.files["sessions/2026-11-23-bc-w5-d1.json"] = { sha: "s3", content: "{ not json" };
		calls.length = 0;
		expect(await syncTrainingLog(client, syncEnv, { fetcher })).toEqual({ status: "synced", headSha: repo.head, changed: 2, removed: 0 });
		expect(calls.filter((call) => call.startsWith("/git/blobs/")).toSorted()).toEqual(["/git/blobs/s2", "/git/blobs/s3"]);
		const broken = await pg.query<{ parse_error: string | null }>("select parse_error from workouts.repo_files where path = 'sessions/2026-11-23-bc-w5-d1.json'");
		expect(broken.rows[0]?.parse_error).not.toBeNull();

		delete repo.files["sessions/2026-11-21-bc-w4-d4.json"];
		repo.head = "c".repeat(40);
		expect(await syncTrainingLog(client, syncEnv, { fetcher })).toEqual({ status: "synced", headSha: repo.head, changed: 1, removed: 1 });
		expect((await readMirror(client)).sessions.map((file) => file.path)).toEqual(["sessions/2026-11-21-bc-w4-d4.md"]);
	});

	test("syncs a large tree over several runs and records HEAD only when complete", async () => {
		for (let index = 0; index < BLOB_BATCH + 5; index++) repo.files[`sessions/2026-01-${String(index).padStart(2, "0")}-x.json`] = { sha: `x${index}`, content: "{}" };
		const first = await syncTrainingLog(client, syncEnv, { fetcher });
		expect(first).toMatchObject({ status: "partial", changed: BLOB_BATCH, remaining: 7 });
		expect((await readSyncState(client)).headSha).toBeNull();
		expect(await syncTrainingLog(client, syncEnv, { fetcher })).toEqual({ status: "synced", headSha: repo.head, changed: 7, removed: 0 });
		expect((await pg.query("select 1 from workouts.repo_files")).rows).toHaveLength(BLOB_BATCH + 7);
	});

	test("mirrors a markdown session only when it has no JSON twin", async () => {
		repo.files["sessions/2026-08-14-w1-rest.md"] = { sha: "n1", content: "---\nid: 2026-08-14-w1-rest\ndate: 2026-08-14\nblockId: maintain-recover-block-a\nweekId: w1\ndayId: cond-a-pool\nstatus: skipped\nkind: rest\n---\n\n# W1 Cond A — cut\n\nPool cancelled. Sauna + steps only.\n" };
		await syncTrainingLog(client, syncEnv, { fetcher });
		expect(calls).not.toContain("/git/blobs/m0");
		const note = (await readMirror(client)).sessions.find((file) => file.path.endsWith(".md"));
		expect(note?.content).toEqual({ id: "2026-08-14-w1-rest", date: "2026-08-14", blockId: "maintain-recover-block-a", weekId: "w1", dayId: "cond-a-pool", status: "skipped", kind: "rest", name: "W1 Cond A — cut", notes: "Pool cancelled. Sauna + steps only.", exercises: [], format: "markdown" });
		expect(parseRepoSession(note as MirroredFile)).toMatchObject({ kind: "rest", status: "skipped", title: "W1 Cond A — cut", date: "2026-08-14" });
	});

	test("records a failure without touching the mirror", async () => {
		await syncTrainingLog(client, syncEnv, { fetcher });
		expect(await syncTrainingLog(client, {} as Env, { fetcher, force: true })).toEqual({ status: "failed", error: "TRAINING_LOG_TOKEN is not set" });
		expect((await readSyncState(client)).lastError).toBe("TRAINING_LOG_TOKEN is not set");
		expect((await readMirror(client)).programs).toHaveLength(1);
	});
});
