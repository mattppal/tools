import { requireBot } from "../../worker/bot-auth.ts";
import { defineToolApi } from "../../worker/tool-api.ts";
import { listAppleWorkouts, parsePayload, saveAppleHealth } from "./apple-health.ts";
import { addDays, isIsoDate, today } from "./dates.ts";
import { dailyHealth, intradayDay, listMeasures, listSleep, listWorkouts, resetStreams } from "./health.ts";
import { listNights } from "./nights.ts";
import { signState, verifyState } from "./secrets.ts";
import { listDays, readConnection, saveConnection } from "./store.ts";
import { weightReport } from "./weights.ts";
import { authorizeUrl, credentials, exchangeCode, type Fetch } from "./withings.ts";

const NO_STORE = { "cache-control": "no-store" };
const RECENT_DAYS = 7;
const STATE_COOKIE = "withings_state";
const STATE_COOKIE_PATH = "/api/withings/callback";
const STATE_COOKIE_MAX_AGE_S = 15 * 60;
const CLEAR_STATE = `${STATE_COOKIE}=; Path=${STATE_COOKIE_PATH}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
const OAUTH_ERROR = /^[a-z_]{1,64}$/;

function text(body: string, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(body, { status, headers: { ...NO_STORE, "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff", ...headers } });
}

function stateCookie(request: Request): string | null {
	for (const part of (request.headers.get("cookie") ?? "").split(";")) {
		const [name, ...value] = part.trim().split("=");
		if (name === STATE_COOKIE) return value.join("=");
	}
	return null;
}

export function activityApi(fetcher: Fetch = fetch) {
	return defineToolApi(async (request, { path, db, env }) => {
		const url = new URL(request.url);
		if (path === "/withings/callback") {
			if (request.method === "HEAD") return new Response(null, { status: 200, headers: NO_STORE });
			const code = url.searchParams.get("code");
			const error = url.searchParams.get("error");
			if (request.method !== "GET" || (code === null && error === null)) return text("Withings callback for tools.mattpalmer.io.");
			const clear = { "set-cookie": CLEAR_STATE };
			if (error !== null) return text(`Withings did not connect: ${OAUTH_ERROR.test(error) ? error : "unknown error"}. Try again from /api/withings/connect.`, 400, clear);
			const creds = credentials(env);
			if (creds === null) return text("WITHINGS_CLIENT_ID and WITHINGS_CLIENT_SECRET are not set on the Worker.", 503, clear);
			const state = url.searchParams.get("state") ?? "";
			if (state !== stateCookie(request) || !(await verifyState(creds.clientSecret, state))) {
				return text("This link expired or did not start in this browser. Start again from /api/withings/connect.", 400, clear);
			}
			const tokens = await exchangeCode(fetcher, creds, code ?? "");
			await db(async (client) => {
				const previous = await readConnection(client);
				if (previous !== null && previous.userid !== tokens.userid) await resetStreams(client);
				await saveConnection(client, creds.clientSecret, tokens, addDays(today(), -RECENT_DAYS));
			});
			return new Response(null, { status: 302, headers: { ...NO_STORE, ...clear, location: "/settings" } });
		}
		if (path === "/withings/connect" && request.method === "GET") {
			const creds = credentials(env);
			if (creds === null) return text("WITHINGS_CLIENT_ID and WITHINGS_CLIENT_SECRET are not set on the Worker yet.", 503);
			const state = await signState(creds.clientSecret);
			return new Response(null, {
				status: 302,
				headers: {
					...NO_STORE,
					location: authorizeUrl(creds, state),
					"set-cookie": `${STATE_COOKIE}=${state}; Path=${STATE_COOKIE_PATH}; Max-Age=${STATE_COOKIE_MAX_AGE_S}; HttpOnly; Secure; SameSite=Lax`,
				},
			});
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
		if (path === "/weights" && request.method === "GET") {
			const to = url.searchParams.get("to") ?? today();
			const from = url.searchParams.get("from") ?? addDays(to, -29);
			if (!isIsoDate(from) || !isIsoDate(to) || from > to) return Response.json({ error: "Use dates like 2026-11-22, from on or before to" }, { status: 400 });
			return Response.json(await db((client) => weightReport(client, from, to)), { headers: NO_STORE });
		}
		if (request.method === "GET" && (path === "/health" || path === "/workouts" || path === "/sleep" || path === "/measures")) {
			const to = url.searchParams.get("to") ?? today();
			const from = url.searchParams.get("from") ?? addDays(to, -29);
			if (!isIsoDate(from) || !isIsoDate(to) || from > to) return Response.json({ error: "Use dates like 2026-11-22, from on or before to" }, { status: 400 });
			const types = (url.searchParams.get("types") ?? "")
				.split(",")
				.filter((type) => /^\d+$/.test(type))
				.map(Number);
			return db(async (client) => {
				if (path === "/health") return Response.json({ days: await dailyHealth(client, from, to) }, { headers: NO_STORE });
				if (path === "/workouts") return Response.json({ workouts: await listWorkouts(client, from, to) }, { headers: NO_STORE });
				if (path === "/sleep") return Response.json({ sleep: await listSleep(client, from, to) }, { headers: NO_STORE });
				return Response.json({ measures: await listMeasures(client, from, to, types) }, { headers: NO_STORE });
			});
		}
		if (path === "/apple-health" && request.method === "POST") {
			const bot = await requireBot(request, env, "activity");
			if (bot instanceof Response) return bot;
			const body = await request.json().catch(() => null);
			const result = parsePayload(body);
			if (!result.ok) return Response.json({ error: result.error }, { status: 422, headers: NO_STORE });
			const push = { automation: request.headers.get("automation-name") ?? "Health Auto Export", sessionId: request.headers.get("session-id") };
			return Response.json(await db((client) => saveAppleHealth(client, result.parsed, push)), { headers: NO_STORE });
		}
		if (path === "/nights" && request.method === "GET") {
			const to = url.searchParams.get("to") ?? today();
			const from = url.searchParams.get("from") ?? addDays(to, -29);
			if (!isIsoDate(from) || !isIsoDate(to) || from > to) return Response.json({ error: "Use dates like 2026-11-22, from on or before to" }, { status: 400 });
			return Response.json({ nights: await db((client) => listNights(client, from, to)) }, { headers: NO_STORE });
		}
		if (path === "/apple-health/workouts" && request.method === "GET") {
			const to = url.searchParams.get("to") ?? today();
			const from = url.searchParams.get("from") ?? addDays(to, -29);
			if (!isIsoDate(from) || !isIsoDate(to) || from > to) return Response.json({ error: "Use dates like 2026-11-22, from on or before to" }, { status: 400 });
			return Response.json({ workouts: await db((client) => listAppleWorkouts(client, from, to)) }, { headers: NO_STORE });
		}
		if (path === "/intraday" && request.method === "GET") {
			const day = url.searchParams.get("day") ?? today();
			if (!isIsoDate(day)) return Response.json({ error: "Use a day like 2026-11-22" }, { status: 400 });
			const result = await db((client) => intradayDay(client, day));
			return result === null ? Response.json({ error: `No intraday data for ${day}` }, { status: 404 }) : Response.json(result, { headers: NO_STORE });
		}
		return Response.json({ error: "Not found" }, { status: 404 });
	});
}

export default activityApi();
