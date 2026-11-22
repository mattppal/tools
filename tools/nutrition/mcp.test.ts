import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database, WithDb } from "../../worker/db.ts";
import api from "./api.ts";

const pg = new PGlite();
for (const slug of ["nutrition", "activity"]) {
	const dir = join(import.meta.dirname, "..", slug, "migrations");
	const files = await Promise.all((await readdir(dir)).toSorted().map((name) => readFile(join(dir, name), "utf-8")));
	await pg.exec(`create schema ${slug}; set search_path to ${slug}; ${files.join(";\n")}; set search_path to public;`);
}
const client = {
	query: async (text: string, values?: unknown[]) => {
		const result = await pg.query(text, values);
		return { ...result, rowCount: result.affectedRows ?? result.rows.length };
	},
} as unknown as Database;
const db: WithDb = (work) => work(client);

const TOKEN = "nutrition-bot-token";
const env = { BOT_TOKEN_NUTRITION: TOKEN, BOT_TOKEN_COACH: "coach-bot-token" } as Env;
const HEADERS = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
const skill = await readFile(join(import.meta.dirname, "SKILL.md"), "utf-8");

type Day = { date: string; closed: boolean; entries: { clientKey: string | null; qty: number }[]; checkIn: { bodyweightLb: number | null } };
type CallResult = { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> };

async function post(body: unknown, headers: Record<string, string> = HEADERS, method = "POST"): Promise<Response> {
	return await api(new Request("https://tools.test/api/tools/nutrition/mcp", { method, headers, body: method === "POST" ? JSON.stringify(body) : undefined }), {
		env,
		ctx: { waitUntil() {} } as never,
		path: "/mcp",
		db,
	});
}

async function call(name: string, args: Record<string, unknown>): Promise<CallResult> {
	const response = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
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
	expect(statuses).toEqual({ noBearer: 401, coachToken: 401, get: 405, noAccept: 406, textBody: 415 });
});
