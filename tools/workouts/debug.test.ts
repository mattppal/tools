import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database, WithDb } from "../../worker/db.ts";
import debug from "./debug.ts";

const pg = new PGlite();
await pg.exec(`create schema workouts; set search_path to workouts; ${await readFile(join(import.meta.dirname, "migrations", "0002-create-repo-mirror.sql"), "utf-8")}; set search_path to public;`);
const db: WithDb = (work) => work({ query: (text: string, values?: unknown[]) => pg.query(text, values) } as unknown as Database);
const env = {} as Env;

test("says when the training log has never synced", async () => {
	expect(await debug({ env, db })).toEqual([
		{ label: "Training log", value: "Not synced yet" },
		{ label: "Last check", value: "Never" },
	]);
});

test("shows the synced commit, the last check, and a sync error", async () => {
	await pg.exec(
		"update workouts.repo_sync set head_sha = '9c1e2d3f4a5b6c7d8e9f', synced_at = '2026-11-22T16:40:00Z', checked_at = '2026-11-22T16:52:00Z', last_error = 'GitHub returned 502'",
	);
	expect(await debug({ env, db })).toEqual([
		{ label: "Training log", value: "9c1e2d3, synced 2026-11-22 16:40 UTC" },
		{ label: "Last check", value: "2026-11-22 16:52 UTC" },
		{ label: "Sync error", value: "GitHub returned 502" },
	]);
});
