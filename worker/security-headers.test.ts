import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pageCsp, SECURITY_HEADERS, withScriptNonce, withSecurityHeaders } from "./security-headers.ts";

function staticHeaders(): Record<string, string> {
	const text = readFileSync(resolve(import.meta.dirname, "../public/_headers"), "utf8");
	const block = text.split(/\n(?=\S)/).find((section) => section.startsWith("/*\n")) ?? "";
	return Object.fromEntries(
		block
			.split("\n")
			.slice(1)
			.map((line) => line.trim())
			.filter((line) => line !== "")
			.map((line) => {
				const at = line.indexOf(":");
				return [line.slice(0, at).toLowerCase(), line.slice(at + 1).trim()];
			}),
	);
}

test("public/_headers sends the same security headers as Worker responses", () => {
	expect(staticHeaders()).toEqual({ ...SECURITY_HEADERS });
});

test("adds every security header and keeps a header the response already set", async () => {
	const response = withSecurityHeaders(new Response("{}", { status: 201, headers: { "content-type": "application/json", "referrer-policy": "no-referrer" } }));
	expect(response.status).toBe(201);
	expect(await response.text()).toBe("{}");
	expect(response.headers.get("referrer-policy")).toBe("no-referrer");
	for (const [name, value] of Object.entries(SECURITY_HEADERS)) if (name !== "referrer-policy") expect(response.headers.get(name)).toBe(value);
});

test("an HTML page gets a fresh script nonce on every script tag and in its CSP, and is never cached", async () => {
	const html = '<!doctype html><html><head><script>var t=1</script></head><body><script type="module" src="/assets/index.js"></script></body></html>';
	const serve = () => withScriptNonce(new Response(html, { headers: { "content-type": "text/html; charset=utf-8", etag: '"abc"', "cache-control": "public, max-age=0" } }));
	const first = serve();
	const csp = first.headers.get("content-security-policy") ?? "";
	const nonce = /'nonce-([^']+)'/.exec(csp)?.[1] ?? "";
	expect(nonce.length).toBeGreaterThanOrEqual(24);
	expect(csp).toBe(pageCsp(nonce));
	expect(csp).toStartWith("script-src 'self' 'nonce-");
	const body = await first.text();
	expect(body.match(/<script[^>]*>/g)).toEqual([`<script nonce="${nonce}">`, `<script type="module" src="/assets/index.js" nonce="${nonce}">`]);
	expect(first.headers.get("cache-control")).toBe("no-store");
	expect(first.headers.get("etag")).toBeNull();
	expect(serve().headers.get("content-security-policy")).not.toBe(csp);
});

test("non-HTML responses pass through without a nonce", async () => {
	const response = withScriptNonce(Response.json({ ok: true }));
	expect(response.headers.get("content-security-policy")).toBeNull();
	expect(await response.json()).toEqual({ ok: true });
});
