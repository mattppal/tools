import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { ROLE_GRANTS, roleRequest } from "./planetscale.ts";

const ROOT = resolve(import.meta.dirname, "..");
const SOURCE_DIRS = ["scripts", "worker", "tools", "src", "e2e"];
const ROLE_MODULE = "scripts/planetscale.ts";

async function sourceFiles(dir: string): Promise<string[]> {
	const entries = await readdir(join(ROOT, dir), { withFileTypes: true, recursive: true });
	return entries.filter((entry) => entry.isFile() && /\.(ts|tsx|mjs|js)$/.test(entry.name)).map((entry) => relative(ROOT, join(entry.parentPath, entry.name)));
}

test("app and read roles never inherit postgres", () => {
	expect(ROLE_GRANTS.app).toEqual(["pg_read_all_data", "pg_write_all_data"]);
	expect(ROLE_GRANTS.read).toEqual(["pg_read_all_data"]);
});

test("a migrate role inherits postgres for at most an hour, and every role expires", () => {
	expect(roleRequest("migrate-1", "migrate", 3600)).toEqual({ name: "migrate-1", inherited_roles: ["postgres"], ttl: 3600 });
	expect(() => roleRequest("migrate-1", "migrate", 3601)).toThrow("at most 3600 seconds");
	expect(() => roleRequest("dev-1", "app", 0)).toThrow("positive TTL");
});

test("only scripts/planetscale.ts creates PlanetScale roles", async () => {
	const offenders: string[] = [];
	for (const dir of SOURCE_DIRS) {
		for (const file of await sourceFiles(dir)) {
			if (file === ROLE_MODULE || file.endsWith(".test.ts")) continue;
			const source = await readFile(join(ROOT, file), "utf8");
			if (/inherited_roles|api\.planetscale\.com\/v1\/[^"'`]*\/roles/.test(source)) offenders.push(file);
		}
	}
	expect(offenders).toEqual([]);
});
