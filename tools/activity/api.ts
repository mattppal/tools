import { defineToolApi } from "../../worker/tool-api.ts";
import { addDays, isIsoDate, today } from "./dates.ts";
import { signState, verifyState } from "./secrets.ts";
import { listDays, readConnection, saveConnection } from "./store.ts";
import { authorizeUrl, credentials, exchangeCode, type Fetch } from "./withings.ts";

const NO_STORE = { "cache-control": "no-store" };
const RECENT_DAYS = 7;

function text(body: string, status = 200): Response {
	return new Response(body, { status, headers: { ...NO_STORE, "content-type": "text/plain; charset=utf-8" } });
}

export function activityApi(fetcher: Fetch = fetch) {
	return defineToolApi(async (request, { path, db, env }) => {
		const url = new URL(request.url);
		if (path === "/withings/callback") {
			if (request.method === "HEAD") return new Response(null, { status: 200, headers: NO_STORE });
			const code = url.searchParams.get("code");
			const error = url.searchParams.get("error");
			if (request.method !== "GET" || (code === null && error === null)) return text("Withings callback for tools.mattpalmer.io.");
			if (error !== null) return text(`Withings did not connect: ${error}. Try again from /api/withings/connect.`, 400);
			const creds = credentials(env);
			if (creds === null) return text("WITHINGS_CLIENT_ID and WITHINGS_CLIENT_SECRET are not set on the Worker.", 503);
			if (!(await verifyState(creds.clientSecret, url.searchParams.get("state") ?? ""))) return text("This link expired or did not start here. Start again from /api/withings/connect.", 400);
			const tokens = await exchangeCode(fetcher, creds, code ?? "");
			await db((client) => saveConnection(client, creds.clientSecret, tokens, addDays(today(), -RECENT_DAYS)));
			return new Response(null, { status: 302, headers: { ...NO_STORE, location: "/settings" } });
		}
		if (path === "/withings/connect" && request.method === "GET") {
			const creds = credentials(env);
			if (creds === null) return text("WITHINGS_CLIENT_ID and WITHINGS_CLIENT_SECRET are not set on the Worker yet.", 503);
			return new Response(null, { status: 302, headers: { ...NO_STORE, location: authorizeUrl(creds, await signState(creds.clientSecret)) } });
		}
		if (path === "/days" && request.method === "GET") {
			const to = url.searchParams.get("to") ?? today();
			const from = url.searchParams.get("from") ?? addDays(to, -89);
			if (!isIsoDate(from) || !isIsoDate(to)) return Response.json({ error: "Use dates like 2026-11-22" }, { status: 400 });
			return db(async (client) => {
				const connection = await readConnection(client);
				return Response.json(
					{
						days: await listDays(client, from, to),
						withings: connection === null ? null : { connectedAt: connection.connectedAt, backfillDone: connection.backfillCursor === null, lastError: connection.lastError },
					},
					{ headers: NO_STORE },
				);
			});
		}
		return Response.json({ error: "Not found" }, { status: 404 });
	});
}

export default activityApi();
