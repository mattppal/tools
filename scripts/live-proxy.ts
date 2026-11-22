import { parseArgs } from "node:util";

export type AccessToken = { id: string; secret: string };

export const PRODUCTION = "https://tools.mattpalmer.io";

export function upstreamHeaders(incoming: Headers, target: URL, token: AccessToken): Headers {
	const headers = new Headers(incoming);
	headers.set("CF-Access-Client-Id", token.id);
	headers.set("CF-Access-Client-Secret", token.secret);
	headers.delete("host");
	headers.delete("accept-encoding");
	const referer = headers.get("referer");
	if (referer !== null && URL.canParse(referer)) {
		const page = new URL(referer);
		headers.set("referer", new URL(page.pathname + page.search, target.origin).href);
	}
	if (headers.has("origin")) headers.set("origin", target.origin);
	return headers;
}

export function serveLiveProxy({ port, target, token }: { port: number; target: URL; token: AccessToken }) {
	return Bun.serve({
		hostname: "127.0.0.1",
		port,
		async fetch(request) {
			const url = new URL(request.url);
			const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
			const response = await fetch(new URL(url.pathname + url.search, target.origin), { method: request.method, headers: upstreamHeaders(request.headers, target, token), body, redirect: "manual" });
			const headers = new Headers(response.headers);
			headers.delete("content-encoding");
			headers.delete("content-length");
			return new Response(response.body, { status: response.status, headers });
		},
	});
}

if (import.meta.main) {
	const { values } = parseArgs({ options: { port: { type: "string", default: "8788" }, target: { type: "string", default: PRODUCTION } } });
	const id = process.env.CF_ACCESS_CLIENT_ID;
	const secret = process.env.CF_ACCESS_CLIENT_SECRET;
	if (!id || !secret) {
		console.error("live-proxy: set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET to an Access service token first.");
		process.exit(1);
	}
	const target = new URL(values.target);
	const server = serveLiveProxy({ port: Number(values.port), target, token: { id, secret } });
	console.log(`live-proxy: http://127.0.0.1:${server.port} -> ${target.origin}`);
}
