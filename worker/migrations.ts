import type { Database } from "./db.ts";

export type MigrationFile = { slug: string; name: string; sql: string };
export type Applied = ReadonlyMap<string, string>;
export type MigrationDrift = { pending: string[]; changed: string[]; unknown: string[] };

export const MIGRATION_PATH = /^tools\/([a-z][a-z0-9-]{0,62})\/migrations\/((\d{4})-[a-z0-9-]+\.sql)$/;

export function bundledMigrations(modules: Record<string, string>): MigrationFile[] {
	return Object.entries(modules).map(([path, sql]) => {
		const match = MIGRATION_PATH.exec(path.replace(/^(\.\.\/)+/, ""));
		if (match === null) throw new Error(`${path} is not a migration file name`);
		const [, slug = "", name = ""] = match;
		return { slug, name, sql };
	});
}

export function schemaOf(slug: string): string {
	return `"${slug.replaceAll("-", "_")}"`;
}

export async function checksum(sql: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sql));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function readApplied(db: Database, slug: string): Promise<Applied> {
	const schema = schemaOf(slug);
	const table = await db.query<{ name: string | null }>("select to_regclass($1)::text as name", [`${schema}._migrations`]);
	if (table.rows[0]?.name == null) return new Map();
	const rows = await db.query<{ name: string; checksum: string }>(`select name, checksum from ${schema}._migrations`);
	return new Map(rows.rows.map((row) => [row.name, row.checksum]));
}

export async function migrationDrift(files: readonly MigrationFile[], applied: ReadonlyMap<string, Applied>): Promise<MigrationDrift> {
	const drift: MigrationDrift = { pending: [], changed: [], unknown: [] };
	const known = new Set(files.map((file) => `${file.slug}/${file.name}`));
	for (const file of files) {
		const done = applied.get(file.slug)?.get(file.name);
		if (done === undefined) drift.pending.push(`${file.slug}/${file.name}`);
		else if (done !== (await checksum(file.sql))) drift.changed.push(`${file.slug}/${file.name}`);
	}
	for (const [slug, names] of applied) for (const name of names.keys()) if (!known.has(`${slug}/${name}`)) drift.unknown.push(`${slug}/${name}`);
	return { pending: drift.pending.toSorted(), changed: drift.changed.toSorted(), unknown: drift.unknown.toSorted() };
}

export async function checkMigrations(db: Database, files: readonly MigrationFile[]): Promise<MigrationDrift> {
	const slugs = [...new Set(files.map((file) => file.slug))];
	const applied = new Map<string, Applied>();
	for (const slug of slugs) applied.set(slug, await readApplied(db, slug));
	return migrationDrift(files, applied);
}
