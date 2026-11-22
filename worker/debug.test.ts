import { PGlite } from "@electric-sql/pglite";
import { beforeEach, expect, spyOn, test } from "bun:test";
import type { WithDb } from "./db.ts";
import { debugReport } from "./debug.ts";
import { defineToolDebug } from "./tool-debug.ts";
import { defineWebhook } from "./webhooks.ts";

const pg = new PGlite();
await pg.exec(`create schema hooks;
create table hooks.deliveries (
	delivery_id uuid primary key,
	payload jsonb not null,
	attempts integer not null default 0,
	next_attempt_at timestamptz not null default now(),
	delivered_at timestamptz,
	last_status integer,
	last_error text
);`);
const db: WithDb = (work) => work({ query: (text: string, values?: unknown[]) => pg.query(text, values) } as never);

const env = { CF_VERSION_METADATA: { id: "0f3a9c1e-77aa-4d2b-9a43-2a2f5f0f1a11", tag: "", timestamp: "2026-11-22T16:32:00.000Z" } } as Env;
const request = new Request("https://tools.example/api/debug", { headers: { "cf-access-authenticated-user-email": "matt@example.com" } });
const configured = defineWebhook({ table: "hooks.deliveries", target: () => ({ url: "https://coach.example/hooks/abc?key=secret", authorization: "k", deliveryHeader: "X-Test" }) });
const unset = defineWebhook({ table: "hooks.deliveries", target: () => null });

beforeEach(async () => {
	await pg.exec("delete from hooks.deliveries");
});

test("reports the version, the Access identity, and an empty backlog", async () => {
	const report = await debugReport(request, env, db, new Map([["coach", configured]]), new Map());
	expect(report.version).toEqual({ id: "0f3a9c1e-77aa-4d2b-9a43-2a2f5f0f1a11", deployedAt: "2026-11-22T16:32:00.000Z" });
	expect(report.access).toBe("matt@example.com");
	expect(report.tools).toEqual([
		{
			slug: "coach",
			rows: [
				{ label: "Webhook", value: "Sends to coach.example" },
				{ label: "Backlog", value: "Nothing waiting" },
			],
		},
	]);
});

test("counts undelivered rows and shows the error of the most-retried one", async () => {
	await pg.exec(`insert into hooks.deliveries (delivery_id, payload, attempts, last_error, delivered_at) values
		('6f1c1f43-3c3e-4b9b-9a43-2a2f5f0f1a11', '{}', 4, 'HTTP 500: down', null),
		('6f1c1f43-3c3e-4b9b-9a43-2a2f5f0f1a12', '{}', 1, 'HTTP 502', null),
		('6f1c1f43-3c3e-4b9b-9a43-2a2f5f0f1a13', '{}', 9, 'HTTP 404', now())`);
	const report = await debugReport(new Request("https://tools.example/api/debug"), env, db, new Map([["coach", unset]]), new Map());
	expect(report.access).toBeNull();
	expect(report.tools[0]?.rows).toEqual([
		{ label: "Webhook", value: "No target set, so deliveries wait" },
		{ label: "Backlog", value: "2 waiting, oldest tried 4 times" },
		{ label: "Last error", value: "HTTP 500: down" },
	]);
});

test("adds registered rows and turns a failing tool debug into an error row", async () => {
	const synced = defineToolDebug(async () => [{ label: "Synced", value: "abc1234" }]);
	const broken = defineToolDebug(async () => {
		throw new Error("GitHub said no");
	});
	const logged = spyOn(console, "error").mockImplementation(() => {});
	const report = await debugReport(request, env, db, new Map([["coach", configured]]), new Map([["coach", synced], ["log", broken]]));
	expect(logged).toHaveBeenCalledTimes(1);
	logged.mockRestore();
	expect(report.tools.map((tool) => [tool.slug, tool.rows.map((row) => row.label)])).toEqual([
		["coach", ["Webhook", "Backlog", "Synced"]],
		["log", ["Error"]],
	]);
	expect(report.tools[1]?.rows[0]?.value).toBe("Could not read: GitHub said no");
});
