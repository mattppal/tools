import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import nutrition from "../tools/nutrition/api.ts";
import type { Database, WithDb } from "../worker/db.ts";
import { BOT_READ_ROUTES, isToolsOrigin, previewOrigin, READ_ROUTES, smoke, TEST_DAY, USER_AGENT } from "./smoke.ts";

const pg = new PGlite();
for (const slug of ["nutrition", "activity", "liaison"]) {
	const dir = join(import.meta.dirname, "..", "tools", slug, "migrations");
	const files = await Promise.all((await readdir(dir)).toSorted().map((name) => readFile(join(dir, name), "utf-8")));
	await pg.exec(`create schema ${slug}; set search_path to ${slug}; ${files.join(";\n")}; set search_path to public;`);
}
const client = {
	query: async (text: string, values?: unknown[]) => {
		const result = await pg.query(text, values);
		return { ...result, rowCount: result.affectedRows ?? result.rows.length };
	},
} as unknown as Database;
const db: WithDb = (work) => work(client);

async function rowsOnTestDay(): Promise<number> {
	const { rows } = await pg.query<{ n: number }>(
		"select (select count(*) from nutrition.days where day = $1) + (select count(*) from nutrition.food_entries where day = $1) + (select count(*) from nutrition.weigh_ins where measured_on = $1) as n",
		[TEST_DAY],
	);
	return Number(rows[0]?.n);
}

const target = new URL("https://tools.example");
const token = { id: "verify.access", secret: "s" };
const unlisted = { id: "other.access", secret: "s" };
const SHA = "a".repeat(40);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function worker(overrides: Record<string, number> = {}): { fetcher: typeof fetch; seen: Request[] } {
	const seen: Request[] = [];
	const fetcher = (async (input: URL, init?: RequestInit) => {
		const request = new Request(input, init);
		seen.push(request);
		const { pathname } = new URL(request.url);
		const id = request.headers.get("cf-access-client-id");
		const override = overrides[pathname];
		if (override !== undefined) return new Response("broken", { status: override });
		if (pathname.startsWith("/api/") && id === null) return new Response(null, { status: 302, headers: { location: "https://team.cloudflareaccess.com/" } });
		if (pathname.startsWith("/api/") && id !== token.id) return Response.json({ error: "Forbidden: this identity is not on the tools allowlist" }, { status: 403 });
		if (pathname === "/build.json") return Response.json({ sha: SHA, branch: "main" });
		if (pathname === "/api/health") return Response.json({ ok: true, db: {}, migrations: { pending: [], changed: [], unknown: [] } });
		if (READ_ROUTES.includes(pathname)) return Response.json({});
		if (BOT_READ_ROUTES.includes(pathname)) return Response.json({ error: "Forbidden: bot smoke may not call this route" }, { status: 403 });
		if (pathname === "/api/tools/nutrition/mcp") return nutrition(request, { env: {} as Env, ctx: { waitUntil() {} } as never, path: "/mcp", db, caller: { kind: "bot", bot: "smoke" } });
		if (pathname === "/api/tools/workouts/sync") return Response.json({ error: "Forbidden: bot smoke may not call POST /sync on workouts" }, { status: 403 });
		if (pathname === "/") return new Response('<link rel="icon" href="/favicon-32.png"><script type="module" src="/assets/index-x.js"></script>');
		if (pathname === "/assets/index-x.js") return new Response('const logo="/assets/logo-x.png"');
		if (pathname.endsWith(".png")) return new Response(PNG, { headers: { "content-type": "image/png" } });
		return Response.json({ error: "Not found" }, { status: 404 });
	}) as typeof fetch;
	return { fetcher, seen };
}

test("a healthy deploy passes every check and every request names itself", async () => {
	const { fetcher, seen } = worker();
	const outcomes = await smoke({ target, token, unlisted, sha: SHA, fetcher });
	expect(outcomes.filter((outcome) => outcome.ok !== true)).toEqual([]);
	expect(outcomes.map((outcome) => outcome.name)).toEqual(expect.arrayContaining(["image /favicon-32.png", "image /assets/logo-x.png", "unlisted service token", "no Access credentials"]));
	expect(seen.every((request) => request.headers.get("user-agent") === USER_AGENT)).toBe(true);
});

test("the MCP checks clean up a cancelled run's leftovers first and leave nothing behind", async () => {
	await pg.query("insert into nutrition.days (day) values ($1) on conflict do nothing", [TEST_DAY]);
	const { fetcher } = worker();
	const outcomes = await smoke({ target, token, unlisted, sha: SHA, fetcher });
	const mcp = outcomes.filter((outcome) => outcome.name.startsWith("MCP") && outcome.name !== "MCP over GET");
	expect(mcp.filter((outcome) => outcome.ok !== true)).toEqual([]);
	expect(mcp.map((outcome) => outcome.name)).toEqual([
		"MCP discards leftovers first",
		"MCP tools/list",
		"MCP schemas are strict",
		"MCP rejects an unknown argument",
		"MCP smoke identity refuses a real day",
		"MCP retried add is a no-op",
		"MCP update_day writes a test day",
		"MCP discards the test day",
		"MCP discard removed exactly what smoke wrote",
	]);
	expect(mcp[0]?.detail).toContain('"days":1');
	expect(await rowsOnTestDay()).toBe(0);
});

test("a broken route and a stale deploy each fail by name", async () => {
	const { fetcher } = worker({ "/api/tools/nutrition/phase": 500, "/api/tools/activity/sleep": 200 });
	const failed = (await smoke({ target, token, unlisted, sha: "b".repeat(40), fetcher })).filter((outcome) => outcome.ok === false).map((outcome) => outcome.name);
	expect(failed).toEqual(["build sha", "read /api/tools/nutrition/phase", "bot read /api/tools/activity/sleep refuses the smoke identity"]);
});

test("only production and tools previews get the Access token", () => {
	expect(isToolsOrigin("https://tools.mattpalmer.io")).toBe(true);
	expect(isToolsOrigin(previewOrigin("cursor/live-smoke-b556"))).toBe(true);
	expect(previewOrigin("cursor/live-smoke-b556")).toBe("https://cursor-live-smoke-b556-tools.mpal.workers.dev");
	for (const target of ["http://tools.mattpalmer.io", "https://tools.mattpalmer.io.evil.example", "https://evil.example/tools.mattpalmer.io", "https://x-tools.mpal.workers.dev.evil.example", "https://a.b-tools.mpal.workers.dev", "https://tools.mattpalmer.io:8443", "https://user@tools.mattpalmer.io", "not a url"]) {
		expect({ target, allowed: isToolsOrigin(target) }).toEqual({ target, allowed: false });
	}
});

test("a preview may run ahead of its migrations, but never with a changed one", async () => {
	const pending = { ok: false, db: { error: "Migrations not applied: notes/0002-add-done.sql" }, migrations: { pending: ["notes/0002-add-done.sql"], changed: [], unknown: [] } };
	const changed = { ...pending, migrations: { ...pending.migrations, changed: ["notes/0001-create-items.sql"] } };
	for (const [body, allowPending, ok] of [
		[pending, false, false],
		[pending, true, true],
		[changed, true, false],
	] as const) {
		const { fetcher } = worker();
		const healthy = (async (input: URL, init?: RequestInit) =>
			new URL(input).pathname === "/api/health" && new Headers(init?.headers).get("cf-access-client-id") === token.id ? Response.json(body, { status: 503 }) : fetcher(input, init)) as typeof fetch;
		const outcomes = await smoke({ target, token, unlisted, sha: SHA, allowPending, fetcher: healthy });
		expect({ allowPending, changed: body.migrations.changed, failed: outcomes.filter((outcome) => outcome.ok === false).map((outcome) => outcome.name) }).toEqual({
			allowPending,
			changed: body.migrations.changed,
			failed: ok ? [] : allowPending ? ["health body"] : ["health", "health body"],
		});
	}
});

test("without an unlisted token the allowlist denial is skipped and says so", async () => {
	const { fetcher } = worker();
	const outcomes = await smoke({ target, token, unlisted: null, sha: null, fetcher });
	expect(outcomes.find((outcome) => outcome.name === "unlisted service token")?.ok).toBeNull();
});
