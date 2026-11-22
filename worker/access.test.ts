import { beforeAll, expect, test } from "bun:test";
import { type AccessConfig, accessGate } from "./access.ts";

const TEAM = "https://team.cloudflareaccess.com";
const AUD = "aud-tools";
const NOW = Date.UTC(2026, 10, 22, 12) / 1000;
const config: AccessConfig = {
	teamDomain: TEAM,
	audiences: [AUD],
	emails: ["owner@example.com"],
	serviceTokens: { "tools-bot": "bot-client.access" },
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

async function status(result: Promise<Response | null>): Promise<number> {
	return (await result)?.status ?? 200;
}

test("admits the owner's email and allowlisted service tokens", async () => {
	const check = gate();
	expect(await status(check(call("/api/health", { token: await sign(claims({ email: "owner@example.com" })) })))).toBe(200);
	expect(await status(check(call("/api/tools/nutrition/mcp", { method: "POST", token: await sign(claims({ common_name: "bot-client.access" })) })))).toBe(200);
	expect(certFetches).toBe(1);
});

test("refuses a valid Access token for an identity off the allowlist", async () => {
	const check = gate();
	const response = await check(call("/api/health", { token: await sign(claims({ common_name: "other-client.access" })) }));
	expect(response?.status).toBe(403);
	expect(await response?.json()).toEqual({ error: "Forbidden: this identity is not on the tools allowlist" });
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
