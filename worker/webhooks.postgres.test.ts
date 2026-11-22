import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "pg";
import type { WithDb } from "./db.ts";
import { defineWebhook, deliverDue } from "./webhooks.ts";

const url = process.env.TEST_DATABASE_URL;
if (url === undefined && process.env.CI) throw new Error("TEST_DATABASE_URL must be set in CI so the Postgres webhook tests run");

const SCHEMA = `hooks_${process.pid}`;
const TABLE = `${SCHEMA}.deliveries`;
const ID = "0b7d4c1e-2f3a-4c5d-8e9f-a0b1c2d3e4f5";
const RESPONSE_DELAY_MS = 300;

describe.skipIf(url === undefined)("webhook delivery against Postgres", () => {
	const clients: Client[] = [];
	let inFlight = 0;
	let maxInFlight = 0;
	let sends = 0;
	let responses: { delayMs: number; status: number }[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch() {
			sends++;
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			const { delayMs, status } = responses.shift() ?? { delayMs: RESPONSE_DELAY_MS, status: 204 };
			await Bun.sleep(delayMs);
			inFlight--;
			return new Response(null, { status });
		},
	});
	const webhook = defineWebhook({ table: TABLE, target: () => ({ url: server.url.href, authorization: "key", deliveryHeader: "X-Test-Delivery" }) });
	const env = {} as Env;

	async function connect(): Promise<Client> {
		const client = new Client({ connectionString: url });
		await client.connect();
		clients.push(client);
		return client;
	}

	async function sender(): Promise<WithDb> {
		const client = await connect();
		return (work) => work(client);
	}

	let admin: Client;

	beforeAll(async () => {
		admin = await connect();
		await admin.query(`create schema ${SCHEMA}`);
		await admin.query(`create table ${TABLE} (
			delivery_id uuid primary key,
			payload jsonb not null,
			attempts integer not null default 0,
			next_attempt_at timestamptz not null default now() + interval '1 minute',
			delivered_at timestamptz,
			last_status integer,
			last_error text,
			claimed_until timestamptz,
			claim_id uuid
		)`);
	});

	afterAll(async () => {
		await admin.query(`drop schema ${SCHEMA} cascade`);
		await Promise.all(clients.map((client) => client.end()));
		server.stop(true);
	});

	beforeEach(async () => {
		inFlight = 0;
		maxInFlight = 0;
		sends = 0;
		responses = [];
		await admin.query(`delete from ${TABLE}`);
	});

	test("overlapping cron runs and the first attempt send a due delivery once", async () => {
		await admin.query(`insert into ${TABLE} (delivery_id, payload, next_attempt_at) values ($1, '{}', now())`, [ID]);
		const [cronA, cronB, request] = await Promise.all([sender(), sender(), sender()]);
		const delivered = await Promise.all([deliverDue(cronA, webhook, env), deliverDue(cronB, webhook, env), deliverDue(request, webhook, env, [ID])]);
		expect(delivered.reduce((sum, count) => sum + count, 0)).toBe(1);
		expect(sends).toBe(1);
	});

	test("send again during an in-flight send leaves that send to finish alone", async () => {
		await admin.query(`insert into ${TABLE} (delivery_id, payload) values ($1, '{}')`, [ID]);
		const [first, again, requeuer] = await Promise.all([sender(), sender(), connect()]);
		const firstAttempt = deliverDue(first, webhook, env, [ID]);
		await Bun.sleep(RESPONSE_DELAY_MS / 3);
		await requeuer.query(`update ${TABLE} set next_attempt_at = now() + interval '1 minute', delivered_at = null where delivery_id = $1`, [ID]);
		expect(await deliverDue(again, webhook, env, [ID])).toBe(0);
		expect(await firstAttempt).toBe(1);
		expect(maxInFlight).toBe(1);
		const { rows } = await admin.query<{ delivered: boolean }>(`select delivered_at is not null as delivered from ${TABLE} where delivery_id = $1`, [ID]);
		expect(rows[0]?.delivered).toBe(true);
	});

	test("a sender whose claim expired cannot overwrite the result of the sender that took over", async () => {
		await admin.query(`insert into ${TABLE} (delivery_id, payload) values ($1, '{}')`, [ID]);
		responses = [
			{ delayMs: RESPONSE_DELAY_MS * 2, status: 503 },
			{ delayMs: 0, status: 204 },
		];
		const [stale, takeover] = await Promise.all([sender(), sender()]);
		const staleAttempt = deliverDue(stale, webhook, env, [ID]);
		await Bun.sleep(RESPONSE_DELAY_MS / 3);
		await admin.query(`update ${TABLE} set claimed_until = now() - interval '1 second' where delivery_id = $1`, [ID]);
		expect(await deliverDue(takeover, webhook, env, [ID])).toBe(1);
		expect(await staleAttempt).toBe(0);
		const { rows } = await admin.query<{ delivered: boolean; attempts: number; last_status: number }>(
			`select delivered_at is not null as delivered, attempts, last_status from ${TABLE} where delivery_id = $1`,
			[ID],
		);
		expect(rows[0]).toEqual({ delivered: true, attempts: 1, last_status: 204 });
	});
});
