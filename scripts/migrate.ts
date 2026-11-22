import { $ } from "bun";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "pg";
import { checksum, MIGRATION_PATH, type MigrationFile, migrationDrift, readApplied, schemaOf } from "../worker/migrations.ts";

const ROOT = resolve(import.meta.dirname, "..");
const CONNECTION_ENV = "CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB";
const OWNER_ROLE = "postgres";
const LOCK_KEY = "tools:migrate";
const SHARED_HOST = /\.psdb\.cloud$/;
const MAIN = "origin/main";

export type Source = { kind: "worktree" } | { kind: "ref"; ref: string; sha: string };

function validate(paths: readonly string[], read: (path: string) => Promise<string>): Promise<MigrationFile[]> {
	const versions = new Set<string>();
	return Promise.all(
		paths.toSorted().map(async (path) => {
			const match = MIGRATION_PATH.exec(path);
			if (match === null) throw new Error(`${path}: name must look like tools/<slug>/migrations/0001-create-items.sql`);
			const [, slug = "", name = "", version = ""] = match;
			if (slug === "public") throw new Error(`${path}: a tool with migrations can't be named public`);
			if (versions.has(`${slug}/${version}`)) throw new Error(`tools/${slug}/migrations: more than one file uses version ${version}`);
			versions.add(`${slug}/${version}`);
			return { slug, name, sql: await read(path) };
		}),
	);
}

async function worktreeFiles(): Promise<MigrationFile[]> {
	const paths: string[] = [];
	for (const tool of await readdir(resolve(ROOT, "tools"), { withFileTypes: true })) {
		if (!tool.isDirectory()) continue;
		const names = await readdir(resolve(ROOT, "tools", tool.name, "migrations")).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return [];
			throw error;
		});
		paths.push(...names.map((name) => `tools/${tool.name}/migrations/${name}`));
	}
	return validate(paths, (path) => readFile(resolve(ROOT, path), "utf8"));
}

export async function refFiles(sha: string): Promise<MigrationFile[]> {
	const listed = (await $`git -C ${ROOT} ls-tree -r --name-only ${sha} -- tools`.text()).split("\n").filter((path) => /^tools\/[^/]+\/migrations\/[^/]+$/.test(path));
	return validate(listed, (path) => $`git -C ${ROOT} show ${`${sha}:${path}`}`.text());
}

export async function resolveSource(connectionString: string, ref: string | undefined): Promise<Source> {
	const shared = SHARED_HOST.test(new URL(connectionString).hostname);
	if (ref === undefined && !shared) return { kind: "worktree" };
	const wanted = ref ?? MAIN;
	await $`git -C ${ROOT} fetch --quiet origin main`;
	const sha = (await $`git -C ${ROOT} rev-parse --verify ${`${wanted}^{commit}`}`.text()).trim();
	if (shared) {
		const onMain = await $`git -C ${ROOT} merge-base --is-ancestor origin/main ${sha}`.nothrow();
		if (onMain.exitCode !== 0) throw new Error(`${wanted} (${sha.slice(0, 7)}) doesn't contain origin/main. A shared database only gets migrations from main or from the PR head bun run land is landing.`);
	}
	return { kind: "ref", ref: wanted, sha };
}

async function apply(client: Pick<Client, "query">, file: MigrationFile): Promise<boolean> {
	const schema = schemaOf(file.slug);
	await client.query("begin");
	try {
		await client.query(`set local role ${OWNER_ROLE}`);
		await client.query("select pg_advisory_xact_lock(hashtext($1))", [LOCK_KEY]);
		await client.query(`create schema if not exists ${schema}`);
		await client.query(`create table if not exists ${schema}._migrations (name text primary key, checksum text not null, applied_at timestamptz not null default now())`);
		const done = await client.query(`select 1 from ${schema}._migrations where name = $1`, [file.name]);
		if (done.rowCount !== 0) {
			await client.query("rollback");
			return false;
		}
		await client.query(`set local search_path to ${schema}`);
		await client.query(file.sql);
		await client.query(`insert into ${schema}._migrations (name, checksum) values ($1, $2)`, [file.name, await checksum(file.sql)]);
		await client.query("commit");
		return true;
	} catch (error) {
		await client.query("rollback");
		throw error;
	}
}

export async function migrate(client: Pick<Client, "query">, files: readonly MigrationFile[], dryRun: boolean): Promise<void> {
	const applied = new Map(await Promise.all([...new Set(files.map((file) => file.slug))].map(async (slug) => [slug, await readApplied(client, slug)] as const)));
	const drift = await migrationDrift(files, applied);
	if (drift.changed.length > 0) throw new Error(`Changed after they were applied: ${drift.changed.join(", ")}. Add a new migration instead.`);
	if (drift.unknown.length > 0) console.log(`Applied here but not in this source, so left alone: ${drift.unknown.join(", ")}. They came from a land that stopped before main moved, or from a branch before migrations came only from main.`);
	if (drift.pending.length === 0) console.log("Up to date");
	for (const file of files.filter((candidate) => drift.pending.includes(`${candidate.slug}/${candidate.name}`))) {
		const label = `tools/${file.slug}/migrations/${file.name}`;
		if (dryRun) {
			console.log(`Would apply ${label}`);
			continue;
		}
		const started = performance.now();
		try {
			console.log(`${label} ${(await apply(client, file)) ? `applied in ${Math.round(performance.now() - started)} ms` : "already applied by another run"}`);
		} catch (error) {
			throw new Error(`${label} failed: ${error instanceof Error ? error.message : error}`, { cause: error });
		}
	}
}

async function main(): Promise<void> {
	const { values } = parseArgs({ options: { "dry-run": { type: "boolean", default: false }, ref: { type: "string" } } });
	const connectionString = process.env[CONNECTION_ENV];
	if (!connectionString) throw new Error(`Set ${CONNECTION_ENV} first. See docs/database.md.`);
	const source = await resolveSource(connectionString, values.ref);
	const files = source.kind === "worktree" ? await worktreeFiles() : await refFiles(source.sha);
	const target = new URL(connectionString);
	console.log(`${values["dry-run"] ? "Checking" : "Migrating"} database ${target.pathname.slice(1)} on ${target.host} from ${source.kind === "worktree" ? "the working tree" : `${source.ref} (${source.sha.slice(0, 7)})`}`);
	const client = new Client({ connectionString });
	await client.connect();
	try {
		await migrate(client, files, values["dry-run"]);
	} finally {
		await client.end();
	}
}

if (import.meta.main) {
	try {
		await main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
