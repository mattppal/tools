import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Caller } from "../../worker/access.ts";
import type { Database, WithDb } from "../../worker/db.ts";
import api from "./api.ts";

const pg = new PGlite();
for (const slug of ["nutrition", "activity", "liaison"]) {
	const dir = join(import.meta.dirname, "..", slug, "migrations");
	const files = await Promise.all((await readdir(dir)).toSorted().map((name) => readFile(join(dir, name), "utf-8")));
	await pg.exec(`create schema ${slug}; set search_path to ${slug}; ${files.join(";\n")}; set search_path to public;`);
}
const maintain = await pg.query<{ id: number }>("insert into nutrition.phases (kind, start_date) values ('maintain', '2026-11-22') returning id");
await pg.query("insert into nutrition.phase_trackers (phase_id, weeks, current_kcal_target) values ($1, 12, 2750)", [maintain.rows[0]?.id]);
await pg.query("insert into nutrition.weigh_ins (measured_on, source, weight_lb) values ('2026-11-20', 'sheet', 181), ('2026-11-21', 'sheet', 179)");
const client = {
	query: async (text: string, values?: unknown[]) => {
		const result = await pg.query(text, values);
		return { ...result, rowCount: result.affectedRows ?? result.rows.length };
	},
} as unknown as Database;
const db: WithDb = (work) => work(client);

const TOKEN = "nutrition-bot-token";
const env = { BOT_TOKEN_NUTRITION: TOKEN, BOT_TOKEN_COACH: "coach-bot-token" } as Env;
const SMOKE: Caller = { kind: "bot", bot: "smoke" };
const HEADERS = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
const skill = await readFile(join(import.meta.dirname, "SKILL.md"), "utf-8");

type Day = { date: string; closed: boolean; entries: { clientKey: string | null; qty: number; source: string }[]; checkIn: { bodyweightLb: number | null } };
type CallResult = { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> };

async function post(body: unknown, headers: Record<string, string> = HEADERS, method = "POST", caller: Caller = { kind: "local" }): Promise<Response> {
	return await api(new Request("https://tools.test/api/tools/nutrition/mcp", { method, headers, body: method === "POST" ? JSON.stringify(body) : undefined }), {
		env,
		ctx: { waitUntil() {} } as never,
		path: "/mcp",
		db,
		caller,
	});
}

async function call(name: string, args: Record<string, unknown>, caller?: Caller): Promise<CallResult> {
	const headers = caller === undefined ? HEADERS : { "content-type": HEADERS["content-type"], accept: HEADERS.accept };
	const response = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, headers, "POST", caller);
	expect(response.status).toBe(200);
	return ((await response.json()) as { result: CallResult }).result;
}

async function day(date: string): Promise<Day> {
	return (await call("update_day", { date })).structuredContent as Day;
}

function documentedRequests(): { id: number; params: { name: string; arguments: Record<string, unknown> } }[] {
	return [...skill.matchAll(/```json\n([\s\S]*?)\n```/g)].map(([, json]) => JSON.parse(json ?? "")).filter((body) => body.method === "tools/call");
}

const yogurt = { food: "Greek yogurt", qty: 200, unit: "g", kcal: 118, protein_g: 20.6, carbs_g: 7.2, fat_g: 0.8 };

test("every documented request succeeds, in order", async () => {
	const requests = documentedRequests();
	expect(requests.length).toBeGreaterThanOrEqual(8);
	for (const request of requests) {
		const response = await post({ jsonrpc: "2.0", ...request });
		const body = (await response.json()) as { result: CallResult };
		expect({ id: request.id, status: response.status, error: body.result.isError ? body.result.content[0]?.text : null }).toEqual({ id: request.id, status: 200, error: null });
		expect(body.result.structuredContent).toBeObject();
	}
});

test("the skill names exactly the tools the server lists, and only get_phase_summary is read-only", async () => {
	const response = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
	const { tools } = ((await response.json()) as { result: { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] } }).result;
	const botSection = skill.slice(skill.indexOf("## Bot"), skill.indexOf("### Requests"));
	const documented = [...botSection.matchAll(/^\| `([a-z_]+)` \|/gm)].map(([, name]) => name);
	expect(documented.toSorted()).toEqual(tools.map((tool) => tool.name).toSorted());
	expect(skill).toContain("`baseline`, `elimination`, and `reintroduction` are read-only kinds");
	expect(tools.filter((tool) => tool.annotations?.readOnlyHint).map((tool) => tool.name)).toEqual(["get_phase_summary"]);
});

test("a retried add logs once, and a retried remove returns the day", async () => {
	const add = { date: "2099-02-01", add: [{ ...yogurt, client_key: "bot:retry:0" }] };
	await call("log_food", add);
	const retried = await call("log_food", add);
	expect((retried.structuredContent as Day).entries.map((entry) => entry.clientKey)).toEqual(["bot:retry:0"]);
	await call("log_food", { date: "2099-02-01", remove: ["bot:retry:0"] });
	const again = await call("log_food", { date: "2099-02-01", remove: ["bot:retry:0"] });
	expect(again.isError).toBeUndefined();
	expect((again.structuredContent as Day).entries).toEqual([]);
});

test("every day read returns each food's source as the bot wrote it", async () => {
	const source = "USDA FDC 170894 (Yogurt, Greek, plain, nonfat)";
	const logged = await call("log_food", { date: "2099-02-04", add: [{ ...yogurt, client_key: "bot:source:0", source }, { ...yogurt, client_key: "bot:source:1", source: "label estimate" }] });
	const phase = (await call("get_phase_summary", { date: "2099-02-04" })).structuredContent as { day: Day };
	for (const read of [logged.structuredContent as Day, await day("2099-02-04"), phase.day]) {
		expect(read.entries.map((entry) => entry.source)).toEqual([source, "label estimate"]);
	}
});

test("an argument name the tool does not know fails the call instead of being dropped", async () => {
	const cases: [string, Record<string, unknown>][] = [
		["update_day", { date: "2099-02-02", bodyweight: 180 }],
		["log_food", { date: "2099-02-02", added: [{ ...yogurt, client_key: "bot:typo:0" }] }],
		["log_food", { date: "2099-02-02", add: [{ ...yogurt, client_key: "bot:typo:1", calories: 118 }] }],
		["log_food", { date: "2099-02-02", edit: [{ client_key: "bot:typo:1", quantity: 1 }] }],
		["update_targets", { effective_from: "2099-02-02", kcal: { min: 1, max: 2, target: 1 }, protein_g: { min: 1, max: 2 }, fat_g: { min: 1, max: 2 }, carbs_g: { min: 1, max: 2 }, change: "x" }],
	];
	for (const [name, args] of cases) {
		const result = await call(name, args);
		expect({ name, isError: result.isError, text: result.content[0]?.text }).toMatchObject({ name, isError: true, text: expect.stringContaining("Unrecognized key") });
	}
	const after = await day("2099-02-02");
	expect({ entries: after.entries, bodyweight: after.checkIn.bodyweightLb }).toEqual({ entries: [], bodyweight: null });
});

test("a closed day rejects food with isError and the reason", async () => {
	await call("update_day", { date: "2099-02-03", closed: true });
	const result = await call("log_food", { date: "2099-02-03", add: [{ ...yogurt, client_key: "bot:closed:0" }] });
	expect({ isError: result.isError, text: result.content[0]?.text }).toEqual({ isError: true, text: "2099-02-03 is closed. Reopen it first." });
});

test("transport errors are HTTP statuses the bot can tell apart", async () => {
	const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
	const statuses = {
		noBearer: (await post(list, { "content-type": "application/json", accept: HEADERS.accept })).status,
		coachToken: (await post(list, { ...HEADERS, authorization: "Bearer coach-bot-token" })).status,
		get: (await post(undefined, HEADERS, "GET")).status,
		noAccept: (await post(list, { authorization: HEADERS.authorization, "content-type": "application/json" })).status,
		textBody: (await post(list, { ...HEADERS, "content-type": "text/plain" })).status,
	};
	expect(statuses).toEqual({ noBearer: 401, coachToken: 403, get: 405, noAccept: 406, textBody: 415 });
});

async function rowsOn(date: string): Promise<number> {
	const { rows } = await pg.query<{ n: number }>(
		"select (select count(*) from nutrition.days where day = $1) + (select count(*) from nutrition.food_entries where day = $1) + (select count(*) from nutrition.weigh_ins where measured_on = $1) as n",
		[date],
	);
	return Number(rows[0]?.n);
}

test("the smoke identity works only on test days and cleans up after itself", async () => {
	const listed = (await (await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { "content-type": HEADERS["content-type"], accept: HEADERS.accept }, "POST", SMOKE)).json()) as { result: { tools: { name: string }[] } };
	expect(listed.result.tools.map((tool) => tool.name).toSorted()).toEqual(["discard_test_day", "get_phase_summary", "log_food", "update_day", "update_phase", "update_targets"]);
	expect((await call("discard_test_day", { date: "2099-03-01" })).content[0]?.text).toContain("Tool discard_test_day not found");

	for (const [name, args] of [
		["update_day", {}],
		["update_day", { date: "2026-11-22", bodyweight_lb: 180 }],
		["log_food", { date: "2098-12-31", add: [yogurt] }],
		["get_phase_summary", {}],
	] as const) {
		const refused = await call(name, args, SMOKE);
		expect({ name, args, isError: refused.isError, text: refused.content[0]?.text }).toEqual({ name, args, isError: true, text: expect.stringContaining("The smoke identity only works on test days, 2099-01-01 or later") });
	}
	const targets = await call("update_targets", { effective_from: "2099-03-01", kcal: { min: 1, max: 2 }, protein_g: { min: 1, max: 2 }, fat_g: { min: 1, max: 2 }, carbs_g: { min: 1, max: 2 }, change: "smoke" }, SMOKE);
	expect(targets.content[0]?.text).toBe("The smoke identity can't call update_targets: it changes more than one test day.");
	expect((await call("update_phase", { weeks: 1 }, SMOKE)).content[0]?.text).toBe("The smoke identity can't call update_phase: it changes more than one test day.");
	expect(await rowsOn("2026-11-22")).toBe(0);
	expect((await pg.query("select 1 from nutrition.plan_versions where effective_from = '2099-03-01'")).rows).toEqual([]);

	await call("log_food", { date: "2099-03-01", add: [{ ...yogurt, client_key: "smoke:1" }] }, SMOKE);
	await call("update_day", { date: "2099-03-01", bodyweight_lb: 180, closed: true }, SMOKE);
	expect(await rowsOn("2099-03-01")).toBe(3);
	const discarded = await call("discard_test_day", { date: "2099-03-01" }, SMOKE);
	expect(discarded.structuredContent).toEqual({ date: "2099-03-01", liaisonDeliveries: 0, deliveries: 0, entries: 1, weighIns: 1, days: 1 });
	expect(await rowsOn("2099-03-01")).toBe(0);
	expect((await call("discard_test_day", { date: "2026-11-22" }, SMOKE)).content[0]?.text).toContain("only works on test days");
});

test("Matt's cut converts half a pound a week at the start weight, and a retry closes nothing", async () => {
	const cut = { kind: "cut", start_date: "2026-11-23", target_lb_per_week: -0.5, weeks: 12, current_kcal_target: 2450 };
	const retried = await call("update_phase", cut);
	const result = retried.structuredContent as { phase: { kind: string; settings: { targetRatePerWeek: number }; summary: { lbPerWeekAtStart: number } }; startWeightLb: number; closed: unknown; previous: unknown };
	expect(result).toMatchObject({ phase: { kind: "cut", settings: { targetRatePerWeek: -0.00278 }, summary: { lbPerWeekAtStart: -0.5 } }, startWeightLb: 180, closed: null, previous: {} });
	expect((await pg.query("select kind, end_date::text from nutrition.phases order by start_date")).rows).toEqual([
		{ kind: "maintain", end_date: "2026-11-22" },
		{ kind: "cut", end_date: null },
	]);
	const both = await call("update_phase", { target_rate_per_week: -0.005, target_lb_per_week: -1 });
	expect({ isError: both.isError, text: both.content[0]?.text }).toEqual({ isError: true, text: expect.stringContaining("not both") });
	const camel = await call("update_phase", { startDate: "2026-11-24" });
	expect(camel.content[0]?.text).toContain("Unrecognized key");
});

test("the tracker change log names the calling bot", async () => {
	await call("update_phase", { weeks: 14 });
	await call("update_targets", { effective_from: "2099-04-01", kcal: { min: 2300, max: 2500 }, protein_g: { min: 1, max: 2 }, fat_g: { min: 1, max: 2 }, carbs_g: { min: 1, max: 2 }, change: "Cut", current_kcal_target: 2400 });
	expect((await pg.query("select field, changed_by from nutrition.phase_tracker_changes order by id")).rows).toEqual([
		{ field: "weeks", changed_by: "nutrition" },
		{ field: "current_kcal_target", changed_by: "nutrition" },
	]);
});
