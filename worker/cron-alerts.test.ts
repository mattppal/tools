import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { noticeCronFailure } from "./cron-alerts.ts";
import type { Database, WithDb } from "./db.ts";

const pg = new PGlite();
await pg.exec(`create schema liaison; set search_path to liaison; ${await readFile(join(import.meta.dirname, "../tools/liaison/migrations/0001-create-deliveries.sql"), "utf-8")} set search_path to public;`);
const client = {
	query: async (text: string, values?: unknown[]) => {
		const result = await pg.query(text, values);
		return { ...result, rowCount: result.affectedRows ?? result.rows.length };
	},
} as unknown as Database;
const withDb: WithDb = (work) => work(client);

type Notice = { app: string; event: string; payload: { data: { for: string; label: string; subject: string; body: string } } };

test("a failing cron queues one liaison notice per source per UTC hour", async () => {
	const at = new Date("2026-11-22T18:05:00Z");
	expect(await noticeCronFailure(withDb, "Tool cron activity", new Error("Withings sync failed: HTTP 503"), at)).toBe("queued");
	expect(await noticeCronFailure(withDb, "Tool cron activity", new Error("Withings sync failed: timeout"), new Date("2026-11-22T18:59:00Z"))).toBe("already noticed this hour");
	expect(await noticeCronFailure(withDb, "Tool cron workouts", new Error("training-log sync failed"), at)).toBe("queued");
	expect(await noticeCronFailure(withDb, "Tool cron activity", new Error("Withings sync failed: HTTP 503"), new Date("2026-11-22T19:00:00Z"))).toBe("queued");

	const { rows } = await pg.query<Notice>("select app, event, payload from liaison.deliveries order by created_at");
	expect(rows.map((row) => [row.app, row.event, row.payload.data.for, row.payload.data.label, row.payload.data.subject])).toEqual([
		["tools", "notice", "liaison", "action needed", "tools: Tool cron activity is failing"],
		["tools", "notice", "liaison", "action needed", "tools: Tool cron workouts is failing"],
		["tools", "notice", "liaison", "action needed", "tools: Tool cron activity is failing"],
	]);
	expect(rows[0]?.payload.data.body).toContain("Withings sync failed: HTTP 503");
});
