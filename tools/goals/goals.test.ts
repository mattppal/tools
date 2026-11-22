import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Caller } from "../../worker/access.ts";
import type { Database, WithDb } from "../../worker/db.ts";
import api from "./api.ts";
import { type Checkin, type Goal, type Overview, today, type YearView } from "./types.ts";

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

const GTD: Caller = { kind: "bot", bot: "gtd" };
const MATT: Caller = { kind: "owner", email: "mattppalmer@gmail.com" };
const env = { BOT_TOKEN_NUTRITION: "nutrition-token" } as Env;
const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const skill = await readFile(join(import.meta.dirname, "SKILL.md"), "utf-8");

type CallResult = { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> };

async function send(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; caller?: Caller } = {}): Promise<Response> {
	const { method = "POST", body, headers = HEADERS, caller = GTD } = init;
	return await api(new Request(`https://tools.test/api/tools/goals${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), {
		env,
		ctx: { waitUntil() {} } as never,
		path,
		db,
		caller,
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
const checkinCount = async () => Number((await pg.query<{ n: number }>("select count(*)::int as n from goals.goal_checkins")).rows[0]?.n);
let keys = 0;
const key = () => `key-${++keys}`;

async function rejected(name: string, args: Record<string, unknown>): Promise<string> {
	const result = await call(name, args);
	expect({ name, isError: result.isError }).toEqual({ name, isError: true });
	return result.content[0]?.text ?? "";
}

function documentedRequests(): { id: number; params: { name: string; arguments: Record<string, unknown> } }[] {
	return [...skill.matchAll(/```json\n([\s\S]*?)\n```/g)].map(([, json]) => JSON.parse(json ?? "")).filter((body) => body.method === "tools/call");
}

test("every documented request succeeds, in order", async () => {
	const requests = documentedRequests();
	expect(requests.length).toBeGreaterThanOrEqual(9);
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

test("the skill names exactly the tools the server lists, with read-only and idempotent hints", async () => {
	const response = await send("/mcp", { body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
	const { tools } = ((await response.json()) as { result: { tools: { name: string; annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean } }[] } }).result;
	const botSection = skill.slice(skill.indexOf("## Bot"), skill.indexOf("### Requests"));
	const documented = [...botSection.matchAll(/^\| `([a-z_]+)` \|/gm)].map(([, name]) => name);
	expect(documented.toSorted()).toEqual(tools.map((tool) => tool.name).toSorted());
	expect(tools.filter((tool) => tool.annotations?.readOnlyHint).map((tool) => tool.name)).toEqual(["list_goals", "list_checkins", "get_year"]);
	expect(tools.filter((tool) => tool.annotations?.idempotentHint).map((tool) => tool.name)).toEqual(["upsert_goal", "bulk_import", "set_status", "add_checkin", "link_todoist", "set_north_star"]);
});

test("outputs are camelCase", async () => {
	const { goal } = await ok<{ goal: Goal }>("upsert_goal", { year: 2098, horizon: "year", area: "inner", title: "Meditate daily", source_url: "https://example.com/plan" });
	const { checkin } = await ok<{ checkin: Checkin }>("add_checkin", { goal_id: goal.id, note: "Ten days in a row", date: "2026-01-10", client_key: key() });
	const { goals } = await ok<{ goals: Goal[] }>("list_goals", { year: 2098 });
	expect(Object.keys(goals[0] ?? {}).toSorted()).toEqual(
		["area", "createdAt", "description", "horizon", "id", "latestCheckin", "metric", "parentId", "quarter", "sourceUrl", "status", "target", "title", "todoistProjectId", "todoistTaskIds", "updatedAt", "year"].toSorted(),
	);
	expect(Object.keys(checkin).toSorted()).toEqual(["clientKey", "createdAt", "date", "goalId", "id", "note", "progress", "source", "statusAtCheckin"]);
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
	const first = await ok<{ created: number; updated: number; unchanged: number; goals: { title: string; result: string }[]; years: object }>("bulk_import", args);
	expect({ created: first.created, order: first.goals.map((goal) => goal.title), years: first.years }).toEqual({ created: 2, order: ["Save 10k by June", "Save 40k"], years: { created: 1, updated: 0, unchanged: 0 } });
	const second = await ok<{ created: number; updated: number; unchanged: number }>("bulk_import", { ...args, goals: args.goals.map((goal) => ({ ...goal, title: goal.title.toUpperCase(), parent_title: goal.parent_title?.toLowerCase() })) });
	expect(second).toMatchObject({ created: 0, updated: 2, unchanged: 0, years: { created: 0, updated: 0, unchanged: 1 } });
	const third = await ok<{ created: number; updated: number; unchanged: number }>("bulk_import", {
		years: [{ year: 2097, north_star: "Steadier" }],
		goals: args.goals.map((goal) => ({ ...goal, title: `  ${goal.title.toUpperCase().replaceAll(" ", "   ")} `, parent_title: goal.parent_title?.toLowerCase() })),
	});
	expect(third).toMatchObject({ created: 0, updated: 0, unchanged: 2, years: { created: 0, updated: 1, unchanged: 0 } });
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
	const done = await ok<{ goal: Goal; checkin: Checkin }>("add_checkin", { goal_id: goal.id, note: "Every Sunday this year", progress: 100, client_key: key() });
	expect({ status: done.goal.status, atCheckin: done.checkin.statusAtCheckin, source: done.checkin.source, progress: done.checkin.progress }).toEqual({ status: "unknown", atCheckin: "unknown", source: "gtd-bot", progress: 100 });
	const set = await ok<{ goal: Goal; checkin: Checkin }>("set_status", { id: goal.id, status: "achieved", note: "Matt: done", client_key: key() });
	expect({ status: set.goal.status, atCheckin: set.checkin.statusAtCheckin, progress: set.checkin.progress, latest: set.goal.latestCheckin?.id }).toEqual({ status: "achieved", atCheckin: "achieved", progress: null, latest: set.checkin.id });
	const renamed = await ok<{ goal: Goal; created: boolean }>("upsert_goal", { year: 2095, horizon: "year", area: "systems", title: "weekly review every sunday", description: "Sunday evening" });
	expect({ created: renamed.created, id: renamed.goal.id, status: renamed.goal.status, title: renamed.goal.title }).toEqual({ created: false, id: goal.id, status: "achieved", title: "weekly review every sunday" });
});

test("the latest check-in is the newest date, not the newest write", async () => {
	const { goal } = await ok<{ goal: Goal }>("upsert_goal", { year: 2094, horizon: "quarter", quarter: 3, area: "relationships", title: "Call parents weekly" });
	await ok("add_checkin", { goal_id: goal.id, note: "September", date: "2026-09-28", client_key: key() });
	await ok("add_checkin", { goal_id: goal.id, note: "Backfilled July", date: "2026-07-05", client_key: key() });
	await ok("add_checkin", { goal_id: goal.id, note: "Backfilled August", date: "2026-08-01", client_key: key() });
	expect((await ok<YearView>("get_year", { year: 2094 })).goals[0]?.latestCheckin?.note).toBe("September");
	const all = await ok<{ checkins: Checkin[] }>("list_checkins", { goal_id: goal.id });
	const two = await ok<{ checkins: Checkin[] }>("list_checkins", { goal_id: goal.id, limit: 2 });
	expect({ all: all.checkins.map((checkin) => checkin.note), two: two.checkins.map((checkin) => checkin.date) }).toEqual({ all: ["September", "Backfilled August", "Backfilled July"], two: ["2026-09-28", "2026-08-01"] });
});

test("a client_key replays its first check-in, and rejects different content", async () => {
	const { goal } = await ok<{ goal: Goal }>("upsert_goal", { year: 2088, horizon: "year", area: "fitness", title: "Deadlift 405" });
	const args = { goal_id: goal.id, note: "Pulled 365", progress: 40, client_key: "gtd-1" };
	const first = await ok<{ checkin: Checkin }>("add_checkin", args);
	const before = await checkinCount();
	const again = await ok<{ checkin: Checkin }>("add_checkin", args);
	expect({ id: again.checkin.id, clientKey: again.checkin.clientKey, count: await checkinCount() }).toEqual({ id: first.checkin.id, clientKey: "gtd-1", count: before });
	expect(await rejected("add_checkin", { ...args, progress: 45 })).toBe("client_key gtd-1 already used with different content");
	expect(await rejected("set_status", { id: goal.id, status: "active", note: "Pulled 365", client_key: "gtd-1" })).toBe("client_key gtd-1 already used with different content");

	const active = await ok<{ goal: Goal; checkin: Checkin }>("set_status", { id: goal.id, status: "active", note: "Focus", client_key: "gtd-2" });
	await ok("set_status", { id: goal.id, status: "dropped", note: "Back injury", client_key: "gtd-3" });
	const replayed = await ok<{ goal: Goal; checkin: Checkin }>("set_status", { id: goal.id, status: "active", note: "Focus", client_key: "gtd-2" });
	expect({ checkin: replayed.checkin.id, status: replayed.goal.status }).toEqual({ checkin: active.checkin.id, status: "dropped" });

	const { goal: other } = await ok<{ goal: Goal }>("upsert_goal", { year: 2088, horizon: "year", area: "fitness", title: "Bench 275" });
	expect((await ok<{ checkin: Checkin }>("add_checkin", { ...args, goal_id: other.id })).checkin.goalId).toBe(other.id);
});

test("parents are year goals in the same year, one level deep", async () => {
	const year = async (title: string, extra: Record<string, unknown> = {}) => (await ok<{ goal: Goal }>("upsert_goal", { year: 2087, horizon: "year", area: "career", title, ...extra })).goal;
	const top = await year("Lead a team");
	const quarter = (await ok<{ goal: Goal }>("upsert_goal", { year: 2087, horizon: "quarter", quarter: 1, area: "career", title: "Hire two", parent_id: top.id })).goal;
	const elsewhere = (await ok<{ goal: Goal }>("upsert_goal", { year: 2086, horizon: "year", area: "career", title: "Lead a team" })).goal;
	const child = await year("Mentor one", { parent_id: top.id });
	expect({ quarter: quarter.parentId, child: child.parentId }).toEqual({ quarter: top.id, child: top.id });
	expect(await rejected("upsert_goal", { id: child.id, parent_id: quarter.id })).toBe(`Parent ${quarter.id} is not a year goal in 2087`);
	expect(await rejected("upsert_goal", { id: child.id, parent_id: elsewhere.id })).toBe(`Parent ${elsewhere.id} is not a year goal in 2087`);
	expect(await rejected("upsert_goal", { year: 2087, horizon: "year", area: "career", title: "Grandchild", parent_id: child.id })).toBe(`Parent ${child.id} has a parent itself; goals nest one level`);
	expect(await rejected("upsert_goal", { id: top.id, parent_id: elsewhere.id })).toBe(`Goal ${top.id} has child goals, so it can't have a parent`);
	expect(await rejected("upsert_goal", { id: top.id, horizon: "quarter", quarter: 2 })).toBe(`Goal ${top.id} has child goals, so it stays a year goal`);
	expect(await rejected("upsert_goal", { id: top.id, parent_id: top.id })).toBe(`Goal ${top.id} has child goals, so it can't have a parent`);
});

test("an id update can't take another goal's natural key or change the year", async () => {
	const { goal } = await ok<{ goal: Goal }>("upsert_goal", { year: 2085, horizon: "year", area: "inner", title: "Journal daily" });
	const { goal: other } = await ok<{ goal: Goal }>("upsert_goal", { year: 2085, horizon: "year", area: "inner", title: "Read 30 books" });
	expect(await rejected("upsert_goal", { id: goal.id, title: "  read  30 BOOKS " })).toBe(`Natural key collides with goal ${other.id}`);
	expect(await rejected("upsert_goal", { id: goal.id, year: 2084 })).toBe(`Goal ${goal.id} is in 2085; year can't change`);
	const same = await ok<{ goal: Goal; created: boolean }>("upsert_goal", { year: 2085, horizon: "year", area: "inner", title: " journal \t  DAILY", description: "Morning pages" });
	expect({ id: same.goal.id, created: same.created, title: same.goal.title }).toEqual({ id: goal.id, created: false, title: "journal DAILY" });
});

test("set_north_star needs 1 to 500 characters, and clear: true removes it", async () => {
	expect((await ok("set_north_star", { year: 2083, north_star: "  Calm  " })) as object).toEqual({ year: 2083, northStar: "Calm" });
	for (const args of [{ year: 2083, north_star: "" }, { year: 2083, north_star: "   " }, { year: 2083, north_star: "x".repeat(501) }, { year: 2083 }, { year: 2083, north_star: "Calm", clear: true }, { year: 2083, clear: false }]) {
		expect(await rejected("set_north_star", args)).toStartWith("MCP error -32602");
	}
	expect((await ok("set_north_star", { year: 2083, clear: true })) as object).toEqual({ year: 2083, northStar: "" });
	expect((await ok<YearView>("get_year", { year: 2083 })).northStar).toBe("");
});

test("an argument name the tool doesn't know fails the call and writes nothing", async () => {
	const before = await goalCount();
	const cases: [string, Record<string, unknown>, string][] = [
		["set_status", { id: "0b6f8f62-5d4e-4f7e-9a59-3f1d2c7e8a10", status: "achieved", note: "x", client_key: "k", progres: 100 }, 'Unrecognized key: "progres"'],
		["set_status", { id: "0b6f8f62-5d4e-4f7e-9a59-3f1d2c7e8a10", status: "achieved", note: "x" }, "client_key"],
		["add_checkin", { goal_id: "0b6f8f62-5d4e-4f7e-9a59-3f1d2c7e8a10", note: "x", client_key: "" }, "client_key"],
		["add_checkin", { goal_id: "0b6f8f62-5d4e-4f7e-9a59-3f1d2c7e8a10", note: "x", client_key: "k".repeat(101) }, "client_key"],
		["add_checkin", { goal_id: "0b6f8f62-5d4e-4f7e-9a59-3f1d2c7e8a10", note: "x", progress: 101, client_key: "k" }, "progress"],
		["add_checkin", { goal_id: "0b6f8f62-5d4e-4f7e-9a59-3f1d2c7e8a10", note: "x", date: "2099-01-01", client_key: "k" }, "Use a date no later than today in America/Los_Angeles"],
		["list_checkins", { goal_id: "0b6f8f62-5d4e-4f7e-9a59-3f1d2c7e8a10", limit: 0 }, "limit"],
		["list_checkins", { goal_id: "0b6f8f62-5d4e-4f7e-9a59-3f1d2c7e8a10", limit: 201 }, "limit"],
		["bulk_import", { goals: [{ year: 2093, horizon: "year", area: "content", title: "x", progress: 10 }] }, 'Unrecognized key: "progress" at goals[0]'],
		["upsert_goal", { year: 2093, horizon: "year", area: "content", title: "x", status: "active" }, 'Unrecognized key: "status"'],
		["upsert_goal", { year: 2093, horizon: "year", area: "content", title: "x", createdAt: "2093-01-01" }, 'Unrecognized key: "createdAt"'],
		["set_status", { id: "0b6f8f62-5d4e-4f7e-9a59-3f1d2c7e8a10", status: "done", note: "x", client_key: "k" }, "Invalid option"],
		["upsert_goal", { year: 2093, horizon: "quarter", area: "content", title: "x" }, "quarter is 1-4 when horizon is quarter"],
		["upsert_goal", { year: 2093, horizon: "year", quarter: 2, area: "content", title: "x" }, "quarter is 1-4 when horizon is quarter"],
		["add_checkin", { goal_id: "0b6f8f62-5d4e-4f7e-9a59-3f1d2c7e8a10", note: "x", date: "2026-02-30", client_key: "k" }, "Use a date like 2026-11-22"],
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
		["set_status", { id: missing, status: "achieved", note: "x", client_key: "k" }, `No goal ${missing}`],
		["list_checkins", { goal_id: missing }, `No goal ${missing}`],
		["upsert_goal", { id: missing, title: "x" }, `No goal ${missing}`],
		["upsert_goal", { id: goal.id, parent_id: goal.id }, "A goal can't be its own parent"],
		["upsert_goal", { year: 2091, horizon: "year", area: "fitness", title: "Elsewhere", parent_id: goal.id }, `Parent ${goal.id} is not a year goal in 2091`],
		["upsert_goal", { id: goal.id, horizon: "quarter" }, "A quarter goal needs quarter 1-4, and a year goal has no quarter"],
	];
	for (const [name, args, text] of cases) expect({ name, ...(await call(name, args)) }).toMatchObject({ name, isError: true, content: [{ text }] });
	const { goal: full } = await ok<{ goal: Goal }>("upsert_goal", { year: 2092, horizon: "year", area: "fitness", title: "Run a full" });
	expect(await rejected("upsert_goal", { id: goal.id, title: "RUN A FULL" })).toBe(`Natural key collides with goal ${full.id}`);
});

test("link_todoist replaces the task list and keeps the project when omitted", async () => {
	const { goal } = await ok<{ goal: Goal }>("upsert_goal", { year: 2090, horizon: "year", area: "career", title: "Speak at a conference" });
	await ok("link_todoist", { goal_id: goal.id, project_id: "p1", task_ids: ["a", "b", "a"] });
	const kept = await ok<{ goal: Goal }>("link_todoist", { goal_id: goal.id, task_ids: ["c"] });
	expect({ project: kept.goal.todoistProjectId, tasks: kept.goal.todoistTaskIds }).toEqual({ project: "p1", tasks: ["c"] });
	const cleared = await ok<{ goal: Goal }>("link_todoist", { goal_id: goal.id, project_id: null, task_ids: [] });
	expect({ project: cleared.goal.todoistProjectId, tasks: cleared.goal.todoistTaskIds }).toEqual({ project: null, tasks: [] });
});

test("only the gtd bot's Access identity opens the MCP endpoint", async () => {
	const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
	const statuses = {
		gtd: (await send("/mcp", { body: list })).status,
		local: (await send("/mcp", { body: list, caller: { kind: "local" } })).status,
		matt: (await send("/mcp", { body: list, caller: MATT })).status,
		nutritionToken: (await send("/mcp", { body: list, caller: { kind: "bot", bot: "nutrition" } })).status,
		nutritionBearer: (await send("/mcp", { body: list, caller: { kind: "local" }, headers: { ...HEADERS, authorization: "Bearer nutrition-token" } })).status,
	};
	expect(statuses).toEqual({ gtd: 200, local: 401, matt: 401, nutritionToken: 403, nutritionBearer: 403 });
});

test("the page reads every goal and checks in as Matt, and bots can't use its routes", async () => {
	const { goal } = await ok<{ goal: Goal }>("upsert_goal", { year: 2089, horizon: "year", area: "content", title: "Start a newsletter" });
	const saved = await send("/checkins", { caller: MATT, body: { goal_id: goal.id, note: "First issue out", progress: 10, status: "active", client_key: "page-1" } });
	const { goal: after, checkin } = (await saved.json()) as { goal: Goal; checkin: Checkin };
	expect({ status: saved.status, goal: after.status, atCheckin: checkin.statusAtCheckin, source: checkin.source }).toEqual({ status: 200, goal: "active", atCheckin: "active", source: "matt" });
	const overview = (await (await send("/overview", { method: "GET", caller: MATT })).json()) as Overview;
	expect(overview.goals.find((item) => item.id === goal.id)?.latestCheckin?.note).toBe("First issue out");
	expect(overview.years.map((year) => year.year)).toContain(2089);
	expect((await send("/overview", { method: "GET" })).status).toBe(403);
	expect((await send("/checkins", { caller: MATT, body: { goal_id: goal.id, note: "", client_key: "page-2" } })).status).toBe(409);
	expect((await send("/checkins", { caller: MATT, body: { goal_id: goal.id, note: "Second issue", date: today(new Date(Date.now() + 2 * 86_400_000)), client_key: "page-3" } })).status).toBe(409);
});
