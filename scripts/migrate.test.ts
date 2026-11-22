import { PGlite } from "@electric-sql/pglite";
import { afterEach, expect, spyOn, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Client } from "pg";
import { checkMigrations, type MigrationFile } from "../worker/migrations.ts";
import { migrate, refFiles } from "./migrate.ts";

const ROOT = resolve(import.meta.dirname, "..");
const quiet = spyOn(console, "log").mockImplementation(() => {});
afterEach(() => quiet.mockClear());

function database(): Pick<Client, "query"> {
	const pg = new PGlite();
	return {
		query: async (text: string, values?: unknown[]) => {
			const result = values === undefined && !text.includes("$1") ? (await pg.exec(text)).at(-1) : await pg.query(text, values);
			return { ...result, rows: result?.rows ?? [], rowCount: result?.affectedRows ?? result?.rows.length ?? 0 };
		},
	} as never;
}

const one: MigrationFile = { slug: "notes", name: "0001-create-items.sql", sql: "create table items (id int primary key)" };
const two: MigrationFile = { slug: "notes", name: "0002-add-done.sql", sql: "alter table items add column done boolean" };
const other: MigrationFile = { slug: "notes", name: "0002-add-tag.sql", sql: "alter table items add column tag text" };

test("a migration applied from another source is reported and left alone instead of blocking the ones this source has", async () => {
	const db = database();
	await migrate(db, [one, other], false);
	await migrate(db, [one, two], false);
	const printed = quiet.mock.calls.flat().join("\n");
	expect(await checkMigrations(db as never, [one, two])).toEqual({ pending: [], changed: [], unknown: ["notes/0002-add-tag.sql"] });
	expect(printed).toContain("not in this source, so left alone: notes/0002-add-tag.sql");
});

test("a file changed after it was applied stops the run", async () => {
	const db = database();
	await migrate(db, [one], false);
	await expect(migrate(db, [{ ...one, sql: `${one.sql}; select 1` }], false)).rejects.toThrow("Changed after they were applied: notes/0001-create-items.sql");
});

test("drift names pending files, so a deploy ahead of its migrations shows up in /api/health", async () => {
	const db = database();
	await migrate(db, [one], false);
	expect(await checkMigrations(db as never, [one, two])).toEqual({ pending: ["notes/0002-add-done.sql"], changed: [], unknown: [] });
});

test("a git ref yields the same migration files as the committed tree", async () => {
	const fromRef = await refFiles("HEAD");
	const onDisk: MigrationFile[] = [];
	for (const slug of await readdir(join(ROOT, "tools"))) {
		const names = await readdir(join(ROOT, "tools", slug, "migrations")).catch(() => []);
		for (const name of names) onDisk.push({ slug, name, sql: await readFile(join(ROOT, "tools", slug, "migrations", name), "utf8") });
	}
	expect(fromRef.length).toBeGreaterThan(0);
	expect(fromRef.map((file) => `${file.slug}/${file.name}`)).toEqual(onDisk.map((file) => `${file.slug}/${file.name}`).toSorted());
	expect(fromRef.every((file) => onDisk.find((disk) => disk.slug === file.slug && disk.name === file.name)?.sql === file.sql)).toBe(true);
});
