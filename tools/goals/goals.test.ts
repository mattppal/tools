import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AccessIdentity } from "../../worker/access.ts";
import type { Database, WithDb } from "../../worker/db.ts";
import api from "./api.ts";
import type { Checkin, Goal, Overview, YearView } from "./types.ts";

const pg = new PGlite();
const dir = join(import.meta.dirname, "migrations");
const files = await Promise.all((await readdir(dir)).toSorted().map((name) => readFile(join(dir, name), "utf-8")));
await pg.exec(`create schema goals; set search_path to goals; ${files.join(";\n")}; set search_path to public;`);
const client = {
	query: async (text: string, values?: unknown[]) => {
		const result = await pg.query(text, values);
		return { ...result, rowCount: result.affectedRows ?? result.rows.length };
	},
} as unknown as Database;
const db: WithDb = (work) => work(client);

const GTD: AccessIdentity = { kind: "serviceToken", name: "gtd-bot" };
const MATT: AccessIdentity = { kind: "email", email: "mattppalmer@gmail.com" };
const env = { BOT_TOKEN_NUTRITION: "nutrition-token" } as Env;
const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const skill = await readFile(join(import.meta.dirname, "SKILL.md"), "utf-8");

type CallResult = { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> };

async function send(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; access?: AccessIdentity } = {}): Promise<Response> {
	const { method = "POST", body, headers = HEADERS, access = GTD } = init;
	return await api(new Request(`https://tools.test/api/tools/goals${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), {
		env,
		ctx: { waitUntil() {} } as never,
		path,
		db,
		access,
	});
}

async function call(name: string, args: Record<string, unknown>): Promise<CallResult> {
	const response = await send("/mcp", { body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } });
	expect(response.status).toBe(200);
	return ((await response.json()) as { result: CallResult }).result;
}

async function ok<T>(name: string, args: Record<string, unknown>): Promise<T> {
	const result = await call(name, args);
	expect({ name, error: result.isError ? result.content[0]?.text : null }).toEqual({ name, error: null });
	return result.structuredContent as T;
}

const goalCount = async () => Number((await pg.query<{ n: number }>("select count(*)::int as n from goals.goals")).rows[0]?.n);

function documentedRequests(): { id: number; params: { name: string; arguments: Record<string, unknown> } }[] {
	return [...skill.matchAll(/```json\n([\s\S]*?)\n```/g)].map(([, json]) => JSON.parse(json ?? "")).filter((body) => body.method === "tools/call");
}

test("every documented request succeeds, in order", async () => {
	const requests = documentedRequests();
	expect(requests.length).toBeGreaterThanOrEqual(8);
	let goalId = "";
	for (const request of requests) {
		const body = JSON.parse(JSON.stringify(request).replaceAll("<goal id>", goalId));
		const response = await send("/mcp", { body: { jsonrpc: "2.0", ...body } });
		const { result } = (await response.json()) as { result: CallResult };
		expect({ id: request.id, status: response.status, error: result.isError ? result.content[0]?.text : null }).toEqual({ id: request.id, status: 200, error: null });
		expect(result.structuredContent).toBeObject();
		if (request.params.name === "upsert_goal") goalId = (result.structuredContent as { goal: Goal }).goal.id;
	}
	const year = await ok<YearView>("get_year", { year: 2099 });
	const squat = year.goals.find((goal) => goal.title === "Squat 315 x 3");
	expect({ northStar: year.northStar, titles: year.goals.map((goal) => goal.title), squat: { status: squat?.status, todoist: squat?.todoistTaskIds, latest: squat?.latestCheckin?.note } }).toEqual({
		northStar: "Strong, calm, and shipping every week",
		titles: ["Squat 315 x 3", "Ship 50 videos", "Ship 12 videos"],
		squat: { status: "active", todoist: ["7012345678"], latest: "Matt confirmed this is the focus" },
	});
});

test("the skill names exactly the tools the server lists, and only the reads are read-only", async () => {
	const response = await send("/mcp", { body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
	const { tools } = ((await response.json()) as { result: { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] } }).result;
	const botSection = skill.slice(skill.indexOf("## Bot"), skill.indexOf("### Requests"));
	const documented = [...botSection.matchAll(/^\| `([a-z_]+)` \|/gm)].map(([, name]) => name);
	expect(documented.toSorted()).toEqual(tools.map((tool) => tool.name).toSorted());
	expect(tools.filter((tool) => tool.annotations?.readOnlyHint).map((tool) => tool.name)).toEqual(["list_goals", "get_year"]);
});

test("outputs are camelCase", async () => {
	const { goal } = await ok<{ goal: Goal }>("upsert_goal", { year: 2098, horizon: "year", area: "inner", title: "Meditate daily", source_url: "https://example.com/plan" });
	const { checkin } = await ok<{ checkin: Checkin }>("add_checkin", { goal_id: goal.id, note: "Ten days in a row", date: "2098-01-10" });
	const { goals } = await ok<{ goals: Goal[] }>("list_goals", { year: 2098 });
	expect(Object.keys(goals[0] ?? {}).toSorted()).toEqual(
		["area", "createdAt", "description", "horizon", "id", "latestCheckin", "metric", "parentId", "quarter", "sourceUrl", "status", "target", "title", "todoistProjectId", "todoistTaskIds", "updatedAt", "year"].toSorted(),
	);
	expect(Object.keys(checkin).toSorted()).toEqual(["createdAt", "date", "goalId", "id", "note", "progress", "source", "statusAtCheckin"]);
	expect(goals[0]?.sourceUrl).toBe("https://example.com/plan");
});

test("bulk_import twice changes nothing the second time", async () => {
	const args = {
		years: [{ year: 2097, north_star: "Steady" }],
		goals: [
			{ year: 2097, horizon: "quarter", quarter: 2, area: "finance", title: "Save 10k by June", parent_title: "Save 40k" },
			{ year: 2097, horizon: "year", area: "finance", title: "Save 40k", status: "achieved" },
		],
	};
	const first = await ok<{ created: number; updated: number; unchanged: number; goals: { title: string; result: string }[] }>("bulk_import", args);
	expect({ created: first.created, order: first.goals.map((goal) => goal.title) }).toEqual({ created: 2, order: ["Save 10k by June", "Save 40k"] });
	const second = await ok<{ created: number; updated: number; unchanged: number }>("bulk_import", { ...args, goals: args.goals.map((goal) => ({ ...goal, title: goal.title.toUpperCase(), parent_title: goal.parent_title?.toLowerCase() })) });
	expect(second).toMatchObject({ created: 0, updated: 2, unchanged: 0 });
	const third = await ok<{ created: number; updated: number; unchanged: number }>("bulk_import", { ...args, goals: args.goals.map((goal) => ({ ...goal, title: goal.title.toUpperCase(), parent_title: goal.parent_title?.toLowerCase() })) });
	expect(third).toMatchObject({ created: 0, updated: 0, unchanged: 2 });
	const year = await ok<YearView>("get_year", { year: 2097 });
	const parent = year.goals.find((goal) => goal.horizon === "year");
	expect({ count: year.goals.length, parentStatus: parent?.status, child: year.goals.find((goal) => goal.horizon === "quarter")?.parentId }).toEqual({ count: 2, parentStatus: "achieved", child: parent?.id ?? "" });
});

test("a bulk_import with one bad goal writes nothing and names the goal", async () => {
	const before = await goalCount();
	const result = await call("bulk_import", {
		years: [{ year: 2096, north_star: "Never written" }],
		goals: [
			{ year: 2096, horizon: "year", area: "career", title: "Lead a team" },
			{ year: 2096, horizon: "quarter", quarter: 1, area: "career", title: "Hire two", parent_title: "No such goal" },
		],
	});
	expect({ isError: result.isError, text: result.content[0]?.text }).toEqual({ isError: true, text: 'goals[1]: no year goal titled "No such goal" in 2096' });
	expect(await goalCount()).toBe(before);
	expect((await ok<YearView>("get_year", { year: 2096 })).northStar).toBe("");
});

test("status is never inferred: new goals are unknown and check-ins keep the status", async () => {
	const { goal, created } = await ok<{ goal: Goal; created: boolean }>("upsert_goal", { year: 2095, horizon: "year", area: "systems", title: "Weekly review every Sunday" });
	expect({ created, status: goal.status }).toEqual({ created: true, status: "unknown" });
	const done = await ok<{ goal: Goal; checkin: Checkin }>("add_checkin", { goal_id: goal.id, note: "Every Sunday this year", progress: 100 });
	expect({ status: done.goal.status, atCheckin: done.checkin.statusAtCheckin, source: done.checkin.source, progress: done.checkin.progress }).toEqual({ status: "unknown", atCheckin: "unknown", source: "gtd-bot", progress: 100 });
	const set = await ok<{ goal: Goal; checkin: Checkin }>("set_status", { id: goal.id, status: "achieved", note: "Matt: done" });
	expect({ status: set.goal.status, atCheckin: set.checkin.statusAtCheckin, progress: set.checkin.progress, latest: set.goal.latestCheckin?.id }).toEqual({ status: "achieved", atCheckin: "achieved", progress: null, latest: set.checkin.id });
	const renamed = await ok<{ goal: Goal; created: boolean }>("upsert_goal", { year: 2095, horizon: "year", area: "systems", title: "weekly review every sunday", description: "Sunday evening" });
	expect({ created: renamed.created, id: renamed.goal.id, status: renamed.goal.status, title: renamed.goal.title }).toEqual({ created: false, id: goal.id, status: "achieved", title: "weekly review every sunday" });
});

test("the latest check-in is the newest date, not the newest write", async () => {
	const { goal } = await ok<{ goal: Goal }>("upsert_goal", { year: 2094, horizon: "quarter", quarter: 3, area: "relationships", title: "Call parents weekly" });
	await ok("add_checkin", { goal_id: goal.id, note: "September", date: "2094-09-28" });
	await ok("add_checkin", { goal_id: goal.id, note: "Backfilled July", date: "2094-07-05" });
	expect((await ok<YearView>("get_year", { year: 2094 })).goals[0]?.latestCheckin?.note).toBe("September");
});

test("an argument name the tool doesn't know fails the call and writes nothing", async () => {
	const before = await goalCount();
	const cases: [string, Record<string, unknown>, string][] = [
		["set_status", { id: "0b6f8f62-5d4e-4f7e-9a59-3f1d2c7e8a10", status: "achieved", note: "x", progres: 100 }, 'Unrecognized key: "progres"'],
		["bulk_import", { goals: [{ year: 2093, horizon: "year", area: "content", title: "x", progress: 10 }] }, 'Unrecognized key: "progress" at goals[0]'],
		["upsert_goal", { year: 2093, horizon: "year", area: "content", title: "x", status: "active" }, 'Unrecognized key: "status"'],
		["upsert_goal", { year: 2093, horizon: "year", area: "content", title: "x", createdAt: "2093-01-01" }, 'Unrecognized key: "createdAt"'],
		["set_status", { id: "0b6f8f62-5d4e-4f7e-9a59-3f1d2c7e8a10", status: "done", note: "x" }, "Invalid option"],
		["upsert_goal", { year: 2093, horizon: "quarter", area: "content", title: "x" }, "quarter is 1-4 when horizon is quarter"],
		["upsert_goal", { year: 2093, horizon: "year", quarter: 2, area: "content", title: "x" }, "quarter is 1-4 when horizon is quarter"],
		["add_checkin", { goal_id: "0b6f8f62-5d4e-4f7e-9a59-3f1d2c7e8a10", note: "x", date: "2093-02-30" }, "Use a date like 2026-11-22"],
	];
	for (const [name, args, message] of cases) {
		const result = await call(name, args);
		expect({ name, isError: result.isError, text: result.content[0]?.text }).toMatchObject({ name, isError: true, text: expect.stringContaining(message) });
		expect(result.content[0]?.text).toStartWith("MCP error -32602");
	}
	expect(await goalCount()).toBe(before);
});

test("rejections name the problem", async () => {
	const missing = "00000000-0000-4000-8000-000000000000";
	const { goal } = await ok<{ goal: Goal }>("upsert_goal", { year: 2092, horizon: "year", area: "fitness", title: "Run a half" });
	const cases: [string, Record<string, unknown>, string][] = [
		["set_status", { id: missing, status: "achieved", note: "x" }, `No goal ${missing}`],
		["upsert_goal", { id: missing, title: "x" }, `No goal ${missing}`],
		["upsert_goal", { id: goal.id, parent_id: goal.id }, "A goal can't be its own parent"],
		["upsert_goal", { year: 2091, horizon: "year", area: "fitness", title: "Elsewhere", parent_id: goal.id }, `Parent ${goal.id} is not a goal in 2091`],
		["upsert_goal", { id: goal.id, horizon: "quarter" }, "A quarter goal needs quarter 1-4, and a year goal has no quarter"],
	];
	for (const [name, args, text] of cases) expect({ name, ...(await call(name, args)) }).toMatchObject({ name, isError: true, content: [{ text }] });
	await ok("upsert_goal", { year: 2092, horizon: "year", area: "fitness", title: "Run a full" });
	expect((await call("upsert_goal", { id: goal.id, title: "RUN A FULL" })).content[0]?.text).toBe("Another goal already has that year, horizon, quarter and title");
});

test("link_todoist replaces the task list and keeps the project when omitted", async () => {
	const { goal } = await ok<{ goal: Goal }>("upsert_goal", { year: 2090, horizon: "year", area: "career", title: "Speak at a conference" });
	await ok("link_todoist", { goal_id: goal.id, project_id: "p1", task_ids: ["a", "b", "a"] });
	const kept = await ok<{ goal: Goal }>("link_todoist", { goal_id: goal.id, task_ids: ["c"] });
	expect({ project: kept.goal.todoistProjectId, tasks: kept.goal.todoistTaskIds }).toEqual({ project: "p1", tasks: ["c"] });
	const cleared = await ok<{ goal: Goal }>("link_todoist", { goal_id: goal.id, project_id: null, task_ids: [] });
	expect({ project: cleared.goal.todoistProjectId, tasks: cleared.goal.todoistTaskIds }).toEqual({ project: null, tasks: [] });
});

test("only gtd-bot's Access identity opens the MCP endpoint", async () => {
	const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
	const statuses = {
		gtd: (await send("/mcp", { body: list })).status,
		unverified: (await send("/mcp", { body: list, access: { kind: "unverified" } })).status,
		matt: (await send("/mcp", { body: list, access: MATT })).status,
		nutritionToken: (await send("/mcp", { body: list, access: { kind: "serviceToken", name: "nutrition-bot" } })).status,
		nutritionBearer: (await send("/mcp", { body: list, access: { kind: "unverified" }, headers: { ...HEADERS, authorization: "Bearer nutrition-token" } })).status,
	};
	expect(statuses).toEqual({ gtd: 200, unverified: 401, matt: 401, nutritionToken: 401, nutritionBearer: 401 });
});

test("the page reads every goal and checks in as Matt, and bots can't use its routes", async () => {
	const { goal } = await ok<{ goal: Goal }>("upsert_goal", { year: 2089, horizon: "year", area: "content", title: "Start a newsletter" });
	const saved = await send("/checkins", { access: MATT, body: { goal_id: goal.id, note: "First issue out", progress: 10, status: "active" } });
	const { goal: after, checkin } = (await saved.json()) as { goal: Goal; checkin: Checkin };
	expect({ status: saved.status, goal: after.status, atCheckin: checkin.statusAtCheckin, source: checkin.source }).toEqual({ status: 200, goal: "active", atCheckin: "active", source: "matt" });
	const overview = (await (await send("/overview", { method: "GET", access: MATT })).json()) as Overview;
	expect(overview.goals.find((item) => item.id === goal.id)?.latestCheckin?.note).toBe("First issue out");
	expect(overview.years.map((year) => year.year)).toContain(2089);
	expect((await send("/overview", { method: "GET" })).status).toBe(403);
	expect((await send("/checkins", { access: MATT, body: { goal_id: goal.id, note: "" } })).status).toBe(409);
});
