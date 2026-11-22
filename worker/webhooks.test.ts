import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeEach, expect, test } from "bun:test";
import type { WithDb } from "./db.ts";
import { defineWebhook, deliverDue, retryDelayMinutes } from "./webhooks.ts";

declare global {
	interface Env {
		TEST_WEBHOOK_URL?: string;
		TEST_WEBHOOK_KEY?: string;
	}
}

const pg = new PGlite();
await pg.exec(`create schema hooks;
create table hooks.deliveries (
	delivery_id uuid primary key,
	payload jsonb not null,
	attempts integer not null default 0,
	next_attempt_at timestamptz not null default now(),
	delivered_at timestamptz,
	last_status integer,
	last_error text,
	claimed_until timestamptz,
	claim_id uuid
);`);
const db: WithDb = (work) =>
	work({
		query: async (text: string, values?: unknown[]) => {
			const result = await pg.query(text, values);
			return { ...result, rowCount: result.affectedRows ?? result.rows.length };
		},
	} as never);

const received: { authorization: string | null; delivery: string | null; body: unknown }[] = [];
let respondWith = 200;
let respondBody: string | null = null;
const server = Bun.serve({
	port: 0,
	async fetch(request) {
		received.push({ authorization: request.headers.get("authorization"), delivery: request.headers.get("x-test-delivery"), body: await request.json() });
		return new Response(respondBody, { status: respondWith });
	},
});
afterAll(() => server.stop(true));

const KEY = "k3y-with spaces=and/symbols";
const webhook = defineWebhook({ table: "hooks.deliveries", urlSecret: "TEST_WEBHOOK_URL", keySecret: "TEST_WEBHOOK_KEY", deliveryHeader: "X-Test-Delivery" });
const env = { TEST_WEBHOOK_URL: server.url.href, TEST_WEBHOOK_KEY: KEY } as Env;
const ID = "6f1c1f43-3c3e-4b9b-9a43-2a2f5f0f1a11";

async function row() {
	return (await pg.query<{ attempts: number; delivered_at: Date | null; last_status: number | null; due_in_minutes: number }>(
		"select attempts, delivered_at, last_status, round(extract(epoch from next_attempt_at - now()) / 60)::int as due_in_minutes from hooks.deliveries where delivery_id = $1",
		[ID],
	)).rows[0];
}

beforeEach(async () => {
	received.length = 0;
	respondWith = 200;
	respondBody = null;
	await pg.exec("delete from hooks.deliveries");
	await pg.query("insert into hooks.deliveries (delivery_id, payload, next_attempt_at) values ($1, $2, now() + interval '1 minute')", [ID, { event: "test", deliveryId: ID }]);
});

test("sends Authorization as Bearer plus the raw key, and the delivery id header", async () => {
	expect(await deliverDue(db, webhook, env, [ID])).toBe(1);
	expect(received).toEqual([{ authorization: "Bearer k3y-with spaces=and/symbols", delivery: ID, body: { event: "test", deliveryId: ID } }]);
	expect(await row()).toMatchObject({ attempts: 1, last_status: 200 });
	expect((await row())?.delivered_at).not.toBeNull();
});

test("retries a failed delivery with the same delivery id until a 2xx", async () => {
	respondWith = 503;
	expect(await deliverDue(db, webhook, env, [ID])).toBe(0);
	expect(await row()).toMatchObject({ attempts: 1, last_status: 503, delivered_at: null, due_in_minutes: 1 });

	expect(await deliverDue(db, webhook, env)).toBe(0);
	expect(received).toHaveLength(1);

	await pg.exec("update hooks.deliveries set next_attempt_at = now()");
	expect(await deliverDue(db, webhook, env)).toBe(0);
	expect(await row()).toMatchObject({ attempts: 2, due_in_minutes: 2 });

	respondWith = 204;
	await pg.exec("update hooks.deliveries set next_attempt_at = now()");
	expect(await deliverDue(db, webhook, env)).toBe(1);
	expect(await row()).toMatchObject({ attempts: 3, last_status: 204 });
	expect(received.map((delivery) => delivery.delivery)).toEqual([ID, ID, ID]);

	await pg.exec("update hooks.deliveries set next_attempt_at = now()");
	expect(await deliverDue(db, webhook, env)).toBe(0);
	expect(received).toHaveLength(3);
});

test("keeps the start of a rejection body with the key masked", async () => {
	respondWith = 401;
	respondBody = `{"error":"invalid key",\n "got":"${KEY}"}`;
	await deliverDue(db, webhook, env, [ID]);
	expect(await row()).toMatchObject({ last_status: 401 });
	const { last_error } = (await pg.query<{ last_error: string }>("select last_error from hooks.deliveries where delivery_id = $1", [ID])).rows[0] ?? { last_error: "" };
	expect(last_error).toBe('HTTP 401: {"error":"invalid key", "got":"[key]"}');
});

test("a webhook with an envelope wraps the payload as data under its app and event", async () => {
	const enveloped = defineWebhook({ ...webhook, envelope: { app: "hooks", events: ["test"] } });
	expect(await deliverDue(db, enveloped, env, [ID])).toBe(1);
	expect(received.map((delivery) => delivery.body)).toEqual([{ app: "hooks", event: "test", data: { event: "test", deliveryId: ID } }]);
});

test("an event the envelope doesn't declare is recorded as an error and never sent", async () => {
	const enveloped = defineWebhook({ ...webhook, envelope: { app: "hooks", events: ["other"] } });
	expect(await deliverDue(db, enveloped, env, [ID])).toBe(0);
	expect(received).toHaveLength(0);
	const { last_error } = (await pg.query<{ last_error: string }>("select last_error from hooks.deliveries where delivery_id = $1", [ID])).rows[0] ?? { last_error: "" };
	expect(last_error).toBe('Payload event "test" is not one of hooks\'s events: other');
	expect(await row()).toMatchObject({ attempts: 1, last_status: null, delivered_at: null });
});

test("waits without a target", async () => {
	expect(await deliverDue(db, webhook, { TEST_WEBHOOK_URL: server.url.href } as Env, [ID])).toBe(0);
	expect(await deliverDue(db, webhook, { TEST_WEBHOOK_KEY: KEY } as Env, [ID])).toBe(0);
	expect(received).toHaveLength(0);
});

test("backs off 1, 2, 4, 8, 16, 32, then every 60 minutes", () => {
	expect([1, 2, 3, 4, 5, 6, 7, 8, 30].map(retryDelayMinutes)).toEqual([1, 2, 4, 8, 16, 32, 60, 60, 60]);
});
