import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { serveLiveProxy, upstreamHeaders } from "./live-proxy.ts";

const TOKEN = { id: "client-id", secret: "client-secret" };
const TARGET = new URL("https://tools.example.test");
const LOGO = readFileSync(new URL("../src/assets/logo.png", import.meta.url));

test("a loopback Referer becomes the target's, keeping the page path", () => {
	const headers = upstreamHeaders(new Headers({ referer: "http://127.0.0.1:8788/workouts?tab=week", host: "127.0.0.1:8788" }), TARGET, TOKEN);
	expect(headers.get("referer")).toBe("https://tools.example.test/workouts?tab=week");
	expect(headers.has("host")).toBe(false);
});

test("Origin is rewritten only when the browser sent one", () => {
	expect(upstreamHeaders(new Headers({ origin: "http://127.0.0.1:8788" }), TARGET, TOKEN).get("origin")).toBe("https://tools.example.test");
	expect(upstreamHeaders(new Headers(), TARGET, TOKEN).has("origin")).toBe(false);
});

test("every request carries the Access service token", () => {
	const headers = upstreamHeaders(new Headers({ "accept-encoding": "gzip" }), TARGET, TOKEN);
	expect(headers.get("cf-access-client-id")).toBe("client-id");
	expect(headers.get("cf-access-client-secret")).toBe("client-secret");
	expect(headers.has("accept-encoding")).toBe(false);
});

const upstream = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		const referer = request.headers.get("referer") ?? "";
		if (!referer.startsWith(`http://127.0.0.1:${upstream.port}/`)) return new Response("hotlink", { status: 403 });
		return new Response(LOGO, { headers: { "content-type": "image/png" } });
	},
});
const proxy = serveLiveProxy({ port: 0, target: new URL(`http://127.0.0.1:${upstream.port}`), token: TOKEN });
afterAll(() => {
	proxy.stop(true);
	upstream.stop(true);
});

test("an image fetched through the proxy passes a same-site Referer check byte for byte", async () => {
	const response = await fetch(`http://127.0.0.1:${proxy.port}/assets/logo.png`, { headers: { referer: `http://127.0.0.1:${proxy.port}/` } });
	expect(response.status).toBe(200);
	expect(Buffer.from(await response.arrayBuffer()).equals(LOGO)).toBe(true);
});
