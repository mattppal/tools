import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WithDb } from "../../worker/db.ts";
import { deliverDue } from "../../worker/webhooks.ts";
import api from "./api.ts";
import liaison from "./webhook.ts";

const pg = new PGlite();
const migration = await readFile(join(import.meta.dirname, "migrations", "0001-create-deliveries.sql"), "utf-8");
await pg.exec(`create schema liaison; set search_path to liaison; ${migration} set search_path to public;`);
const db: WithDb = (work) =>
	work({
		query: async (text: string, values?: unknown[]) => {
			const result = await pg.query(text, values);
			return { ...result, rowCount: result.affectedRows ?? result.rows.length };
		},
	} as never);

type Received = { authorization: string | null; delivery: string | null; body: Record<string, any> };
const received: Received[] = [];
let respondWith = 200;
const server = Bun.serve({
	port: 0,
	async fetch(request) {
		received.push({ authorization: request.headers.get("authorization"), delivery: request.headers.get("x-tools-delivery"), body: await request.json() });
		return new Response(null, { status: respondWith });
	},
});
afterAll(() => server.stop(true));

const COORDINATOR = "coordinator-token-5d1e";
const env = { BOT_TOKEN_COORDINATOR: COORDINATOR, BOT_TOKEN_NUTRITION: "nutrition-token", LIAISON_WEBHOOK_URL: server.url.href, LIAISON_WEBHOOK_KEY: "liaison-key" } as Env;

async function call(init: { method?: string; path?: string; body?: unknown; token?: string }) {
	const path = init.path ?? "/notices";
	const request = new Request(`https://tools.example/api/tools/liaison${path}`, {
		method: init.method ?? "POST",
		headers: { authorization: `Bearer ${init.token ?? COORDINATOR}`, "content-type": "application/json" },
		...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
	});
	const response = await api(request, { env, ctx: {} as ExecutionContext, path: path.split("?")[0] ?? path, db });
	return { status: response.status, json: (await response.json()) as Record<string, any> };
}

const nutritionNotice = { for: "nutrition", label: "action needed", subject: "day.closed arrives through the liaison", body: "## What changed\n\n- `test` moved to the top level.", refs: ["https://github.com/mattppal/tools/pull/41"] };
const coachNotice = { for: "coach", label: "please confirm", confirm: "you still write `kind` on every session file", subject: "History import is live", body: "Live." };

beforeEach(async () => {
	received.length = 0;
	respondWith = 200;
	await pg.exec("delete from liaison.deliveries");
});

test("only the coordinator's token may send notices or list deliveries", async () => {
	expect((await call({ body: nutritionNotice, token: "nutrition-token" })).status).toBe(401);
	expect((await call({ method: "GET", path: "/deliveries", token: "wrong" })).status).toBe(401);
	expect(received).toHaveLength(0);
});

test("a notice goes to the liaison in the tools envelope with its bot, label and line", async () => {
	const { status, json } = await call({ body: nutritionNotice });
	expect(status).toBe(201);
	expect(json).toMatchObject({ delivered: true, attempts: 1, lastStatus: 200, lastError: null });
	expect(received).toHaveLength(1);
	const [sent] = received;
	expect(sent?.authorization).toBe("Bearer liaison-key");
	expect(sent?.delivery).toBe(json["deliveryId"]);
	expect(sent?.body).toEqual({
		app: "tools",
		event: "notice",
		deliveryId: json["deliveryId"],
		data: {
			for: "nutrition",
			label: "action needed",
			line: "nutrition bot: action needed",
			subject: "day.closed arrives through the liaison",
			body: "## What changed\n\n- `test` moved to the top level.",
			refs: ["https://github.com/mattppal/tools/pull/41"],
			threadId: json["deliveryId"],
			replyTo: null,
			createdAt: expect.any(String),
		},
	});
	expect(json["sent"]).toEqual(sent?.body);
});

test("coach's please confirm needs its confirm text, which ends the line", async () => {
	await call({ body: coachNotice });
	expect(received[0]?.body["data"]).toMatchObject({ for: "coach", label: "please confirm", confirm: "you still write `kind` on every session file", line: "coach: please confirm you still write `kind` on every session file" });
	await call({ body: { for: "all", label: "FYI", subject: "Heads up", body: "b" } });
	expect(received[1]?.body["data"]["line"]).toBe("all bots: FYI");
	expect((await call({ body: { ...coachNotice, confirm: undefined } })).status).toBe(400);
	expect((await call({ body: { for: "coach", label: "no action", confirm: "x", subject: "s", body: "b" } })).status).toBe(400);
	expect((await call({ body: { ...nutritionNotice, label: "no action" } })).status).toBe(400);
	expect((await call({ body: { ...nutritionNotice, for: "someone" } })).status).toBe(400);
	expect((await call({ body: { ...nutritionNotice, refs: ["http://example.com"] } })).status).toBe(400);
	expect(received).toHaveLength(2);
});

test("a test notice carries test: true and a TEST subject, and a real one may not start with TEST", async () => {
	await call({ body: { ...nutritionNotice, test: true } });
	expect(received[0]?.body).toMatchObject({ test: true, data: { subject: "TEST day.closed arrives through the liaison" } });
	expect(received[0]?.body["data"]).not.toHaveProperty("test");
	await call({ body: { ...coachNotice, subject: "TEST already", test: true } });
	expect(received[1]?.body["data"]["subject"]).toBe("TEST already");
	expect((await call({ body: { ...nutritionNotice, subject: "TEST but real" } })).status).toBe(400);
	expect(received[2]).toBeUndefined();
	expect(received.every((sent) => sent.body["test"] === true)).toBe(true);
});

test("replies join the first notice's thread, and an unknown replyTo is refused", async () => {
	const first = await call({ body: nutritionNotice });
	const second = await call({ body: { ...coachNotice, replyTo: first.json["deliveryId"] } });
	const third = await call({ body: { ...nutritionNotice, label: "nothing", replyTo: second.json["deliveryId"] } });
	expect(received[2]?.body["data"]).toMatchObject({ replyTo: second.json["deliveryId"], threadId: first.json["deliveryId"] });
	expect((await call({ body: { ...nutritionNotice, replyTo: crypto.randomUUID() } })).status).toBe(404);
	const thread = await call({ method: "GET", path: `/deliveries?thread=${first.json["deliveryId"]}` });
	expect(thread.json["deliveries"].map((delivery: { deliveryId: string }) => delivery.deliveryId)).toEqual([third, second, first].map((notice) => notice.json["deliveryId"]));
});

test("resending the same noticeId sends nothing new, and reusing it for other content is refused", async () => {
	const noticeId = crypto.randomUUID();
	expect((await call({ body: { ...nutritionNotice, noticeId } })).status).toBe(201);
	const again = await call({ body: { ...nutritionNotice, noticeId } });
	expect(again.status).toBe(200);
	expect(again.json).toMatchObject({ deliveryId: noticeId, delivered: true, attempts: 1 });
	expect(received).toHaveLength(1);
	expect((await call({ body: { ...nutritionNotice, subject: "different", noticeId } })).status).toBe(409);
});

test("a refused notice waits with its status, and the cron retries it under the same delivery id", async () => {
	respondWith = 503;
	const { json } = await call({ body: coachNotice });
	expect(json).toMatchObject({ delivered: false, attempts: 1, lastStatus: 503, lastError: "HTTP 503" });
	respondWith = 200;
	await pg.exec("update liaison.deliveries set next_attempt_at = now()");
	expect(await deliverDue(db, liaison, env)).toBe(1);
	expect(received.map((sent) => sent.delivery)).toEqual([json["deliveryId"], json["deliveryId"]]);
	const listed = await call({ method: "GET", path: "/deliveries?app=tools" });
	expect(listed.json["deliveries"][0]).toMatchObject({ delivered: true, attempts: 2, lastStatus: 200 });
});
