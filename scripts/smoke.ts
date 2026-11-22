import { parseArgs } from "node:util";
import { type AccessToken, PRODUCTION, upstreamHeaders } from "./live-proxy.ts";

export const USER_AGENT = "tools-smoke/1 (+https://github.com/mattppal/tools/blob/main/scripts/smoke.ts)";

export const READ_ROUTES = [
	"/api/health",
	"/api/debug",
	"/api/tools/nutrition/day",
	"/api/tools/nutrition/history",
	"/api/tools/nutrition/weights",
	"/api/tools/nutrition/expenditure",
	"/api/tools/nutrition/phase",
	"/api/tools/workouts/program",
	"/api/tools/workouts/sessions",
	"/api/tools/workouts/history/summary",
	"/api/tools/workouts/history/timeline",
	"/api/tools/workouts/history/exercises",
	"/api/tools/workouts/history/runs",
	"/api/tools/activity/days",
	"/api/tools/activity/weights",
	"/api/tools/activity/health",
	"/api/tools/activity/workouts",
	"/api/tools/activity/sleep",
	"/api/tools/activity/measures",
];

export const OUT_OF_SCOPE_ROUTES = ["/api/withings/connect"];

const IMAGE_PATH = /["'`(](\/[\w./-]+\.(?:png|svg|webp|avif|jpe?g|gif|ico))["'`)]/g;
const SCRIPT_PATH = /<script[^>]+src="(\/assets\/[\w.-]+\.js)"/g;

export const TEST_DAY = "2099-01-01";
export const SMOKE_TOOLS = ["discard_test_day", "get_phase_summary", "log_food", "update_day", "update_targets"];

type McpResult = { isError?: boolean; content?: { text?: string }[]; structuredContent?: Record<string, unknown>; tools?: { name: string; inputSchema: Schema }[] };
type Schema = { type?: string; additionalProperties?: unknown; properties?: Record<string, Schema>; items?: Schema; anyOf?: Schema[]; oneOf?: Schema[]; allOf?: Schema[] };
type Get = (path: string, options?: { init?: RequestInit & { headers?: Record<string, string> } }) => Promise<Response>;
type Recorder = (name: string, ok: boolean | null, detail: string) => void;

function openObjects(schema: Schema, path: string): string[] {
	const here = schema.type === "object" && schema.additionalProperties !== false ? [path] : [];
	const children = [
		...Object.entries(schema.properties ?? {}).map(([key, child]) => openObjects(child, `${path}.${key}`)),
		...(schema.items === undefined ? [] : [openObjects(schema.items, `${path}[]`)]),
		...[...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...(schema.allOf ?? [])].map((child) => openObjects(child, path)),
	];
	return [...here, ...children.flat()];
}

async function mcpChecks({ get, record }: { get: Get; record: Recorder }): Promise<void> {
	let id = 0;
	async function rpc(method: string, params?: unknown): Promise<McpResult> {
		const response = await get("/api/tools/nutrition/mcp", {
			init: { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) },
		});
		if (response.status !== 200) throw new Error(`${method} answered HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
		const body = (await response.json()) as { result?: McpResult; error?: { message?: string } };
		if (body.result === undefined) throw new Error(`${method} answered a JSON-RPC error: ${body.error?.message ?? "no message"}`);
		return body.result;
	}
	const call = (name: string, args: Record<string, unknown>) => rpc("tools/call", { name, arguments: args });
	const text = (result: McpResult) => result.content?.[0]?.text ?? "";
	const discard = async (name: string) => {
		const result = await call("discard_test_day", { date: TEST_DAY });
		record(name, result.isError !== true, result.isError === true ? text(result) : JSON.stringify(result.structuredContent));
		return result.structuredContent;
	};
	const clientKey = `smoke:${crypto.randomUUID()}`;
	try {
		await discard("MCP discards leftovers first");
		const listed = (await rpc("tools/list")).tools ?? [];
		const names = listed.map((tool) => tool.name).toSorted();
		record("MCP tools/list", JSON.stringify(names) === JSON.stringify(SMOKE_TOOLS), names.join(", "));
		const open = listed.flatMap((tool) => openObjects(tool.inputSchema, tool.name));
		record("MCP schemas are strict", open.length === 0, open.length === 0 ? "every object has additionalProperties: false" : `open: ${open.join(", ")}`);
		const unknown = await call("update_day", { date: TEST_DAY, bodyweight: 180 });
		record("MCP rejects an unknown argument", unknown.isError === true && text(unknown).startsWith("MCP error -32602") && text(unknown).includes("Unrecognized key"), text(unknown));
		const realDay = await call("update_day", {});
		record("MCP smoke identity refuses a real day", realDay.isError === true && text(realDay).includes(`only works on test days, ${TEST_DAY} or later`), text(realDay));
		const food = { food: "TEST smoke check", qty: 1, unit: "g", kcal: 1, protein_g: 0, carbs_g: 0, fat_g: 0, client_key: clientKey };
		await call("log_food", { date: TEST_DAY, add: [food] });
		const retried = await call("log_food", { date: TEST_DAY, add: [food] });
		const entries = (retried.structuredContent?.["entries"] as unknown[] | undefined)?.length;
		record("MCP retried add is a no-op", retried.isError !== true && entries === 1, retried.isError === true ? text(retried) : `${entries} entries after two adds with one client_key`);
		const weighed = await call("update_day", { date: TEST_DAY, bodyweight_lb: 180 });
		record("MCP update_day writes a test day", weighed.isError !== true, weighed.isError === true ? text(weighed) : "bodyweight set");
		const counts = await discard("MCP discards the test day");
		record("MCP discard removed exactly what smoke wrote", counts?.["entries"] === 1 && counts["weighIns"] === 1 && counts["days"] === 1, JSON.stringify(counts));
	} catch (error) {
		record("MCP checks", false, error instanceof Error ? error.message : String(error));
		await call("discard_test_day", { date: TEST_DAY }).catch((cleanup: unknown) => record("MCP cleanup after a failure", false, String(cleanup)));
	}
}

export type Outcome = { name: string; ok: boolean | null; detail: string };
export type SmokeOptions = { target: URL; token: AccessToken; unlisted: AccessToken | null; sha: string | null; allowPending?: boolean; fetcher?: typeof fetch };

export async function smoke({ target, token, unlisted, sha, allowPending = false, fetcher = fetch }: SmokeOptions): Promise<Outcome[]> {
	const outcomes: Outcome[] = [];
	const record = (name: string, ok: boolean | null, detail: string) => outcomes.push({ name, ok, detail });

	async function get(path: string, { as = token, init = {} }: { as?: AccessToken | null; init?: RequestInit & { headers?: Record<string, string> } } = {}): Promise<Response> {
		const url = new URL(path, target);
		const incoming = new Headers({ "user-agent": USER_AGENT, referer: new URL("/", target).href, ...init.headers });
		const headers = as === null ? incoming : upstreamHeaders(incoming, url, as);
		return fetcher(url, { ...init, headers, redirect: "manual" });
	}

	async function expectStatus(name: string, path: string, wanted: number | readonly number[], options?: Parameters<typeof get>[1]): Promise<Response | null> {
		const statuses = typeof wanted === "number" ? [wanted] : wanted;
		try {
			const response = await get(path, options);
			record(name, statuses.includes(response.status), `${options?.init?.method ?? "GET"} ${path} answered ${response.status}, expected ${statuses.join(" or ")}`);
			return response;
		} catch (error) {
			record(name, false, `${path}: ${error instanceof Error ? error.message : error}`);
			return null;
		}
	}

	const build = await expectStatus("build", "/build.json", 200);
	if (build?.ok) {
		const deployed = ((await build.json()) as { sha?: string }).sha ?? "";
		if (sha !== null) record("build sha", deployed === sha, `deployed ${deployed.slice(0, 7)}, expected ${sha.slice(0, 7)}`);
	}

	const health = await expectStatus("health", "/api/health", allowPending ? [200, 503] : 200);
	if (health !== null) {
		const body = (await health.json().catch(() => null)) as { ok?: boolean; db?: { error?: string }; migrations?: { pending: string[]; changed: string[] } } | null;
		const migrations = body?.migrations;
		const clean = migrations !== undefined && migrations.changed.length === 0 && (allowPending || migrations.pending.length === 0);
		record("health body", clean && (body?.ok === true || allowPending), body?.db?.error ?? `migrations ${JSON.stringify(migrations ?? null)}`);
	}

	for (const path of READ_ROUTES.slice(1)) await expectStatus(`read ${path}`, path, 200);

	await expectStatus("unknown API", "/api/tools/nutrition/no-such-route", 404);
	await expectStatus("unknown tool", "/api/tools/no-such-tool/x", 404);
	await expectStatus("MCP over GET", "/api/tools/nutrition/mcp", 405);
	for (const path of OUT_OF_SCOPE_ROUTES) await expectStatus(`${path} refuses the smoke identity`, path, 403);
	await expectStatus("workouts sync refuses the smoke identity", "/api/tools/workouts/sync", 403, { init: { method: "POST" } });
	await mcpChecks({ get, record });

	const page = await expectStatus("app shell", "/", 200);
	if (page !== null) {
		const html = await page.text();
		const scripts = [...html.matchAll(SCRIPT_PATH)].map((match) => match[1] ?? "");
		const sources = [html, ...(await Promise.all(scripts.map(async (path) => (await get(path)).text())))];
		const images = [...new Set(sources.flatMap((text) => [...text.matchAll(IMAGE_PATH)].map((match) => match[1] ?? "")))];
		record("images found", images.length > 0, `${images.length} image paths in / and ${scripts.length} scripts`);
		for (const path of images) {
			const response = await get(path);
			const type = response.headers.get("content-type") ?? "";
			record(`image ${path}`, response.status === 200 && type.startsWith("image/"), `answered ${response.status} ${type}`);
		}
	}

	await expectStatus("no Access credentials", "/api/health", 302, { as: null });
	if (unlisted === null) record("unlisted service token", null, "skipped: set SMOKE_UNLISTED_CLIENT_ID and SMOKE_UNLISTED_CLIENT_SECRET to a token with its own Service Auth policy that is not on the Worker allowlist");
	else {
		const denied = await expectStatus("unlisted service token", "/api/health", 403, { as: unlisted });
		const body = denied?.status === 403 ? ((await denied.json().catch(() => null)) as { error?: string } | null) : null;
		if (denied?.status === 403) record("unlisted token reason", body?.error === "Forbidden: this identity is not on the tools allowlist", body?.error ?? "no JSON error");
	}
	return outcomes;
}

export function isToolsOrigin(target: string): boolean {
	if (!URL.canParse(target)) return false;
	const url = new URL(target);
	if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.pathname !== "/") return false;
	return url.origin === PRODUCTION || /^[a-z0-9-]+-tools\.mpal\.workers\.dev$/.test(url.hostname);
}

export function previewOrigin(branch: string): string {
	return `https://${branch.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-tools.mpal.workers.dev`;
}

function tokenFrom(prefix: string): AccessToken | null {
	const id = process.env[`${prefix}_CLIENT_ID`];
	const secret = process.env[`${prefix}_CLIENT_SECRET`];
	return id && secret ? { id, secret } : null;
}

export async function waitForSha({ target, token, sha, seconds, fetcher = fetch }: { target: URL; token: AccessToken; sha: string; seconds: number; fetcher?: typeof fetch }): Promise<string> {
	const url = new URL("/build.json", target);
	const deadline = Date.now() + seconds * 1000;
	let seen = "nothing";
	while (true) {
		const response = await fetcher(url, { headers: upstreamHeaders(new Headers({ "user-agent": USER_AGENT }), url, token), redirect: "manual" }).catch((error: unknown) => error);
		if (response instanceof Response) seen = response.ok ? (((await response.json().catch(() => ({}))) as { sha?: string }).sha ?? "no sha") : `HTTP ${response.status}`;
		if (seen === sha) return seen;
		if (Date.now() >= deadline) return seen;
		await Bun.sleep(10_000);
	}
}

if (import.meta.main) {
	const { values } = parseArgs({
		options: { target: { type: "string", default: PRODUCTION }, branch: { type: "string" }, sha: { type: "string" }, wait: { type: "string", default: "0" }, "allow-pending-migrations": { type: "boolean", default: false } },
	});
	if (values.branch !== undefined) values.target = previewOrigin(values.branch);
	if (!isToolsOrigin(values.target)) {
		console.error(`smoke: ${values.target} is neither ${PRODUCTION} nor a https://<branch>-tools.mpal.workers.dev preview, so it does not get the Access token.`);
		process.exit(1);
	}
	const token = tokenFrom("CF_ACCESS");
	if (token === null) {
		console.error("smoke: set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET to the tools-agent-verify service token.");
		process.exit(1);
	}
	if (values.sha !== undefined && Number(values.wait) > 0) {
		const seen = await waitForSha({ target: new URL(values.target), token, sha: values.sha, seconds: Number(values.wait) });
		if (seen !== values.sha) console.log(`smoke: ${values.target} still serves ${seen.slice(0, 12)} after ${values.wait}s, not ${values.sha.slice(0, 7)}`);
	}
	const outcomes = await smoke({ target: new URL(values.target), token, unlisted: tokenFrom("SMOKE_UNLISTED"), sha: values.sha ?? null, allowPending: values["allow-pending-migrations"] });
	for (const { name, ok, detail } of outcomes) console.log(`${ok === null ? "skip" : ok ? "ok  " : "FAIL"} ${name}: ${detail}`);
	const failed = outcomes.filter((outcome) => outcome.ok === false);
	console.log(`smoke: ${values.target} ${failed.length === 0 ? "passed" : `failed ${failed.length} of ${outcomes.length}`}`);
	process.exitCode = failed.length === 0 ? 0 : 1;
}
