import { beforeAll, expect, test } from "bun:test";
import { ACCESS, type AccessConfig, accessGate, BOTS, type Caller, outOfScope } from "./access.ts";

const TEAM = "https://team.cloudflareaccess.com";
const AUD = "aud-tools";
const NOW = Date.UTC(2026, 10, 22, 12) / 1000;
const config: AccessConfig = {
	teamDomain: TEAM,
	audiences: [AUD],
	emails: ["owner@example.com"],
	bots: { "bot-client.access": "nutrition" },
	publicRoutes: ["GET /api/withings/callback"],
};

let keys: CryptoKeyPair;
let other: CryptoKeyPair;
let certFetches = 0;

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

async function sign(claims: Record<string, unknown>, { key = keys.privateKey, kid = "k1", alg = "RS256" } = {}): Promise<string> {
	const unsigned = `${encode({ alg, kid })}.${encode(claims)}`;
	const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
	return `${unsigned}.${Buffer.from(signature).toString("base64url")}`;
}

const claims = (extra: Record<string, unknown> = {}) => ({ iss: TEAM, aud: [AUD], exp: NOW + 600, nbf: NOW - 10, ...extra });

beforeAll(async () => {
	const params = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
	keys = (await crypto.subtle.generateKey(params, true, ["sign", "verify"])) as CryptoKeyPair;
	other = (await crypto.subtle.generateKey(params, true, ["sign", "verify"])) as CryptoKeyPair;
});

function gate() {
	certFetches = 0;
	return accessGate(
		config,
		async (input) => {
			certFetches++;
			expect(input).toBe(`${TEAM}/cdn-cgi/access/certs`);
			return Response.json({ keys: [{ ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "k1" }] });
		},
		() => NOW * 1000,
	);
}

function call(path: string, { token, method = "GET", headers = {} }: { token?: string; method?: string; headers?: Record<string, string> } = {}): Request {
	return new Request(`https://tools.example${path}`, { method, headers: { ...headers, ...(token === undefined ? {} : { "cf-access-jwt-assertion": token }) } });
}

async function status(result: Promise<Caller | Response>): Promise<number> {
	const answer = await result;
	return answer instanceof Response ? answer.status : 200;
}

test("admits the owner's email and allowlisted service tokens", async () => {
	const check = gate();
	expect(await status(check(call("/api/health", { token: await sign(claims({ email: "owner@example.com" })) })))).toBe(200);
	expect(await status(check(call("/api/tools/nutrition/mcp", { method: "POST", token: await sign(claims({ common_name: "bot-client.access" })) })))).toBe(200);
	expect(certFetches).toBe(1);
});

test("names the caller: the owner by email, a service token by its bot", async () => {
	const check = gate();
	expect(await check(call("/api/health", { token: await sign(claims({ email: "Owner@Example.com" })) }))).toEqual({ kind: "owner", email: "owner@example.com" });
	expect(await check(call("/api/tools/nutrition/mcp", { method: "POST", token: await sign(claims({ common_name: "bot-client.access" })) }))).toEqual({ kind: "bot", bot: "nutrition" });
	expect(await check(call("/api/withings/callback"))).toEqual({ kind: "public" });
	expect(await check(new Request("http://localhost:5173/api/health"))).toEqual({ kind: "local" });
	for (const name of ["__proto__", "constructor", "toString"]) expect(await status(check(call("/api/health", { token: await sign(claims({ common_name: name })) })))).toBe(403);
});

test("the production allowlist is exactly the registry's Access clients", () => {
	expect(ACCESS.bots).toEqual({
		"46f516f5dd0738abfa72def83722f0da.access": "nutrition",
		"e7234384aca5ccf0fe162d8a112c76b5.access": "coach",
		"9f5386b746c91cbc0774e9f806a081fa.access": "coordinator",
		"3764ccd9a5d87214d1032418b8c228ed.access": "smoke",
		"9ae32c65cfb73a1cf83b0196b682ba65.access": "apple-health",
		"acfc8c269c4412bc69e52f3f59d9d965.access": "gtd",
	});
	expect(Object.values(BOTS).map((bot) => bot.serviceToken)).toEqual(["nutrition-bot", "coach-bot", "tools-coordinator", "tools-agent-verify", "apple-health-export", "gtd-bot"]);
});

test("refuses a valid Access token for an identity off the allowlist", async () => {
	const check = gate();
	const response = await check(call("/api/health", { token: await sign(claims({ common_name: "other-client.access" })) }));
	if (!(response instanceof Response)) throw new Error("expected a refusal");
	expect(response.status).toBe(403);
	expect(await response.json()).toEqual({ error: "Forbidden: this identity is not on the tools allowlist" });
	expect(await status(check(call("/api/health", { token: await sign(claims({ email: "someone@example.com" })) })))).toBe(403);
	expect(await status(check(call("/api/health", { token: await sign(claims({ email: "", common_name: "" })) })))).toBe(403);
});

test("refuses missing, forged, expired and misaddressed tokens", async () => {
	const check = gate();
	const owner = { email: "owner@example.com" };
	expect(await status(check(call("/api/health")))).toBe(403);
	expect(await status(check(call("/api/health", { token: "not.a.jwt" })))).toBe(403);
	expect(await status(check(call("/api/health", { token: await sign(claims(owner), { key: other.privateKey }) })))).toBe(403);
	expect(await status(check(call("/api/health", { token: await sign(claims(owner), { alg: "HS256" }) })))).toBe(403);
	expect(await status(check(call("/api/health", { token: await sign(claims(owner), { kid: "unknown" }) })))).toBe(403);
	expect(await status(check(call("/api/health", { token: await sign(claims({ ...owner, exp: NOW - 120 })) })))).toBe(403);
	expect(await status(check(call("/api/health", { token: await sign(claims({ ...owner, nbf: NOW + 120 })) })))).toBe(403);
	expect(await status(check(call("/api/health", { token: await sign(claims({ ...owner, aud: ["another-app"] })) })))).toBe(403);
	expect(await status(check(call("/api/health", { token: await sign(claims({ ...owner, iss: "https://evil.cloudflareaccess.com" })) })))).toBe(403);
	const token = await sign(claims(owner));
	const [head, , signature] = token.split(".");
	expect(await status(check(call("/api/health", { token: `${head}.${encode(claims({ email: "owner@example.com", exp: NOW + 99999 }))}.${signature}` })))).toBe(403);
});

test("only the exact public routes skip Access", async () => {
	const check = gate();
	expect(await status(check(call("/api/withings/callback?code=x&state=y")))).toBe(200);
	expect(await status(check(call("/api/withings/callback", { method: "PUT" })))).toBe(403);
	expect(await status(check(call("/api/withings//callback")))).toBe(403);
	expect(await status(check(call("/api/withings/callback/x")))).toBe(403);
	expect(await status(check(call("/api/withings/connect")))).toBe(403);
});

test("refuses cross-site writes even with a valid token", async () => {
	const check = gate();
	const token = await sign(claims({ email: "owner@example.com" }));
	expect(await status(check(call("/api/tools/nutrition/day/food", { method: "POST", token, headers: { origin: "https://evil.example" } })))).toBe(403);
	expect(await status(check(call("/api/tools/nutrition/day/food", { method: "POST", token, headers: { "sec-fetch-site": "same-site" } })))).toBe(403);
	expect(await status(check(call("/api/tools/nutrition/day/food", { method: "POST", token, headers: { origin: "https://tools.example", "sec-fetch-site": "same-origin" } })))).toBe(200);
	expect(await status(check(call("/api/tools/nutrition/day", { token, headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } })))).toBe(200);
});

test("local development needs no Access token", async () => {
	const check = gate();
	expect(await status(check(new Request("http://127.0.0.1:5173/api/health")))).toBe(200);
	expect(await status(check(new Request("http://localhost:5173/api/health")))).toBe(200);
	expect(await status(check(new Request("http://localhost:5173/api/tools/nutrition/day/food", { method: "POST", headers: { origin: "https://evil.example" } })))).toBe(403);
});

const APP_ROUTES = [
	["worker", "GET /health"],
	["worker", "GET /debug"],
	["worker", "POST /health"],
	["nutrition", "GET /day"],
	["nutrition", "GET /history"],
	["nutrition", "GET /weights"],
	["nutrition", "GET /expenditure"],
	["nutrition", "GET /phase"],
	["nutrition", "GET /steps"],
	["nutrition", "GET /mcp"],
	["nutrition", "POST /mcp"],
	["nutrition", "POST /day/food"],
	["nutrition", "POST /day/close"],
	["nutrition", "POST /day/reopen"],
	["workouts", "GET /program"],
	["workouts", "GET /sessions"],
	["workouts", "GET /history/summary"],
	["workouts", "GET /history/timeline"],
	["workouts", "GET /history/exercises"],
	["workouts", "GET /history/runs"],
	["workouts", "POST /sessions"],
	["workouts", "PATCH /sessions/0b6d3f1e-7c2a-4e8b-9f4d-2a1c5e7b9d30"],
	["workouts", "DELETE /sessions/0b6d3f1e-7c2a-4e8b-9f4d-2a1c5e7b9d30"],
	["workouts", "POST /sync"],
	["activity", "GET /days"],
	["activity", "GET /weights"],
	["activity", "GET /health"],
	["activity", "GET /workouts"],
	["activity", "GET /sleep"],
	["activity", "GET /measures"],
	["activity", "GET /intraday"],
	["activity", "GET /apple-health/workouts"],
	["activity", "GET /nights"],
	["activity", "GET /withings/connect"],
	["activity", "POST /apple-health"],
	["liaison", "GET /deliveries"],
	["liaison", "POST /notices"],
	["x-posts", "GET /mentions"],
	["x-posts", "GET /x/connect"],
	["x-posts", "POST /mentions/reply"],
	["x-posts", "POST /mentions/dismiss"],
] as const;

const SMOKE_READS = APP_ROUTES.filter(([tool, route]) => tool !== "liaison" && tool !== "x-posts" && route.startsWith("GET ") && route !== "GET /withings/connect").map(([tool, route]) => `${tool} ${route}`);

const REACHABLE: Record<string, readonly string[]> = {
	nutrition: [...APP_ROUTES.filter(([tool, route]) => tool === "nutrition" && (route.startsWith("GET ") || route === "POST /mcp")).map(([tool, route]) => `${tool} ${route}`), "activity GET /days", "activity GET /weights", "activity GET /health", "activity GET /sleep"],
	coach: [...APP_ROUTES.filter(([tool]) => tool === "workouts").map(([tool, route]) => `${tool} ${route}`), "activity GET /workouts", "activity GET /apple-health/workouts"],
	coordinator: ["liaison GET /deliveries", "liaison POST /notices"],
	smoke: [...SMOKE_READS, "nutrition POST /mcp"],
	"apple-health": ["activity POST /apple-health"],
	gtd: [],
};

test("a bot identity reaches only its scopes, on app routes as well as bot routes", () => {
	for (const bot of Object.keys(BOTS) as (keyof typeof BOTS)[]) {
		const reached = APP_ROUTES.filter(([tool, route]) => outOfScope({ kind: "bot", bot }, tool, route) === null).map(([tool, route]) => `${tool} ${route}`);
		expect({ bot, reached: reached.toSorted() }).toEqual({ bot, reached: [...(REACHABLE[bot] ?? [])].toSorted() });
	}
});

test("neither smoke nor the nutrition bot writes outside the nutrition MCP", () => {
	for (const bot of ["smoke", "nutrition"] as const) {
		const writes = APP_ROUTES.filter(([tool, route]) => !route.startsWith("GET ") && outOfScope({ kind: "bot", bot }, tool, route) === null);
		expect({ bot, writes }).toEqual({ bot, writes: [["nutrition", "POST /mcp"]] });
	}
});

test("the owner, localhost and public routes are never scope-checked", async () => {
	for (const caller of [{ kind: "owner", email: "mattppalmer@gmail.com" }, { kind: "local" }, { kind: "public" }] as Caller[]) {
		for (const [tool, route] of APP_ROUTES) expect(outOfScope(caller, tool, route)).toBeNull();
	}
	const refused = outOfScope({ kind: "bot", bot: "coach" }, "nutrition", "GET /day");
	expect(refused?.status).toBe(403);
	expect(await refused?.json()).toEqual({ error: "Forbidden: bot coach may not call GET /day on nutrition" });
});
