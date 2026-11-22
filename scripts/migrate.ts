import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "pg";

const TOOLS_DIR = resolve(import.meta.dirname, "../tools");
const CONNECTION_ENV = "CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB";
const OWNER_ROLE = "postgres";
const LOCK_KEY = "tools:migrate";
const SLUG = /^[a-z][a-z0-9-]{0,62}$/;
const MIGRATION_FILE = /^(\d{4})-[a-z0-9-]+\.sql$/;

type Migration = { name: string; sql: string; checksum: string };
type ToolMigrations = { slug: string; schema: string; migrations: Migration[] };

async function migrationFiles(dir: string): Promise<string[]> {
	try {
		return (await readdir(dir)).toSorted();
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
}

async function readToolMigrations(slug: string): Promise<ToolMigrations | null> {
	const dir = resolve(TOOLS_DIR, slug, "migrations");
	const files = await migrationFiles(dir);
	if (files.length === 0) return null;
	if (!SLUG.test(slug) || slug === "public") throw new Error(`tools/${slug}: a tool with migrations needs a slug matching ${SLUG}`);
	const versions = new Set<string>();
	const migrations: Migration[] = [];
	for (const name of files) {
		const version = MIGRATION_FILE.exec(name)?.[1];
		if (version === undefined) throw new Error(`tools/${slug}/migrations/${name}: name must look like 0001-create-items.sql`);
		if (versions.has(version)) throw new Error(`tools/${slug}/migrations: more than one file uses version ${version}`);
		versions.add(version);
		const sql = await readFile(resolve(dir, name), "utf8");
		migrations.push({ name, sql, checksum: createHash("sha256").update(sql).digest("hex") });
	}
	return { slug, schema: `"${slug.replaceAll("-", "_")}"`, migrations };
}

async function appliedChecksums(client: Client, schema: string): Promise<Map<string, string>> {
	const table = await client.query<{ name: string | null }>("select to_regclass($1)::text as name", [`${schema}._migrations`]);
	if (table.rows[0]?.name == null) return new Map();
	const rows = await client.query<{ name: string; checksum: string }>(`select name, checksum from ${schema}._migrations`);
	return new Map(rows.rows.map((row) => [row.name, row.checksum]));
}

function pendingMigrations(tool: ToolMigrations, applied: Map<string, string>): Migration[] {
	const onDisk = new Map(tool.migrations.map((migration) => [migration.name, migration]));
	for (const [name, checksum] of applied) {
		const migration = onDisk.get(name);
		if (migration === undefined) throw new Error(`tools/${tool.slug}: ${name} was applied but its file is gone`);
		if (migration.checksum !== checksum) throw new Error(`tools/${tool.slug}: ${name} changed after it was applied. Add a new migration instead.`);
	}
	return tool.migrations.filter((migration) => !applied.has(migration.name));
}

async function apply(client: Client, schema: string, migration: Migration): Promise<boolean> {
	await client.query("begin");
	try {
		await client.query(`set local role ${OWNER_ROLE}`);
		await client.query("select pg_advisory_xact_lock(hashtext($1))", [LOCK_KEY]);
		await client.query(`create schema if not exists ${schema}`);
		await client.query(
			`create table if not exists ${schema}._migrations (name text primary key, checksum text not null, applied_at timestamptz not null default now())`,
		);
		const done = await client.query(`select 1 from ${schema}._migrations where name = $1`, [migration.name]);
		if (done.rowCount !== 0) {
			await client.query("rollback");
			return false;
		}
		await client.query(`set local search_path to ${schema}`);
		await client.query(migration.sql);
		await client.query(`insert into ${schema}._migrations (name, checksum) values ($1, $2)`, [migration.name, migration.checksum]);
		await client.query("commit");
		return true;
	} catch (error) {
		await client.query("rollback");
		throw error;
	}
}

async function migrate(client: Client, tool: ToolMigrations, dryRun: boolean): Promise<void> {
	const pending = pendingMigrations(tool, await appliedChecksums(client, tool.schema));
	if (pending.length === 0) console.log(`${tool.slug}: up to date`);
	for (const migration of pending) {
		if (dryRun) {
			console.log(`${tool.slug}: would apply ${migration.name}`);
			continue;
		}
		const started = performance.now();
		try {
			const applied = await apply(client, tool.schema, migration);
			console.log(`${tool.slug}: ${migration.name} ${applied ? `applied in ${Math.round(performance.now() - started)} ms` : "already applied by another run"}`);
		} catch (error) {
			throw new Error(`tools/${tool.slug}/migrations/${migration.name} failed: ${error instanceof Error ? error.message : error}`, { cause: error });
		}
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const dryRun = args.includes("--dry-run");
	if (args.some((arg) => arg !== "--dry-run")) throw new Error("Usage: bun scripts/migrate.ts [--dry-run]");
	const connectionString = process.env[CONNECTION_ENV];
	if (!connectionString) throw new Error(`Set ${CONNECTION_ENV} first. See docs/database.md.`);

	const slugs = (await readdir(TOOLS_DIR, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
	const tools = (await Promise.all(slugs.toSorted().map(readToolMigrations))).filter((tool) => tool !== null);
	const target = new URL(connectionString);
	console.log(`${dryRun ? "Checking" : "Migrating"} database ${target.pathname.slice(1)} on ${target.host}`);
	if (tools.length === 0) {
		console.log("No tool has migrations.");
		return;
	}

	const client = new Client({ connectionString });
	await client.connect();
	try {
		for (const tool of tools) await migrate(client, tool, dryRun);
	} finally {
		await client.end();
	}
}

try {
	await main();
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
}
