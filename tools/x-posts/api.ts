import { z } from "zod";
import { defineToolApi, type ToolApi } from "../../worker/tool-api.ts";
import { authorizeUrl, CALLBACK_PATH, credentials, Disconnected, exchangeCode, NotMentioned, pkce, saveAccount, signState, verifyState, whoAmI, XRefused } from "./reply.ts";
import type { Fetch } from "./x.ts";
import { dismissMention, dismissRequest, listMentions, mentionReplyRequest, replyToMention } from "./mentions.ts";
import { BadRequest, NotFound } from "./shared.ts";

const NO_STORE = { "cache-control": "no-store" };

export const DB_DOWN = "The x-posts database is unavailable; try again later";
const DB_DOWN_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "57P01", "57P02", "57P03", "53300"]);
const DB_DOWN_MESSAGE = /timeout|connection terminated|connection.*(closed|ended)|connect.*refused/i;

function databaseDown(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const code = (error as { code?: unknown }).code;
	if (typeof code === "string" && (code.startsWith("08") || DB_DOWN_CODES.has(code))) return true;
	return DB_DOWN_MESSAGE.test(error.message);
}
const OAUTH_COOKIE = "x_oauth";
const OAUTH_COOKIE_MAX_AGE_S = 15 * 60;
const CLEAR_OAUTH = `${OAUTH_COOKIE}=; Path=${CALLBACK_PATH}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
const OAUTH_ERROR = /^[a-z_]{1,64}$/;

function text(message: string, status: number, headers: Record<string, string> = {}): Response {
	return new Response(message, { status, headers: { ...NO_STORE, "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff", ...headers } });
}

function oauthCookie(request: Request): { state: string; verifier: string } | null {
	for (const part of (request.headers.get("cookie") ?? "").split(";")) {
		const [name, ...value] = part.trim().split("=");
		if (name !== OAUTH_COOKIE) continue;
		const [state, verifier] = value.join("=").split("~");
		return state && verifier ? { state, verifier } : null;
	}
	return null;
}

async function body<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T>> {
	const parsed = schema.safeParse(await request.json().catch(() => undefined));
	if (!parsed.success) throw new BadRequest(z.prettifyError(parsed.error));
	return parsed.data;
}

function only(url: URL, allowed: readonly string[]): void {
	for (const key of url.searchParams.keys()) {
		if (!allowed.includes(key)) throw new BadRequest(allowed.length === 0 ? `Unknown parameter ${key}; this route takes none` : `Unknown parameter ${key}. Allowed: ${allowed.join(", ")}`);
	}
}

function limitParam(url: URL, fallback: number, max: number): number {
	const raw = url.searchParams.get("limit");
	if (raw === null) return fallback;
	if (!/^\d{1,4}$/.test(raw) || Number(raw) < 1 || Number(raw) > max) throw new BadRequest(`limit must be a whole number from 1 to ${max}`);
	return Number(raw);
}

export function xPostsApi({ fetcher = (input, init) => fetch(input, init) }: { fetcher?: Fetch } = {}): ToolApi {
	return async (request, context) => {
		const { path, db, caller } = context;
		const url = new URL(request.url);
		const route = `${request.method} ${path}`;
		const now = new Date();
		try {
			if (caller.kind === "bot") return Response.json({ error: `Forbidden: bot ${caller.bot} may not call ${route} on x-posts` }, { status: 403, headers: NO_STORE });
			if (caller.kind !== "owner" && caller.kind !== "local") return Response.json({ error: "Forbidden" }, { status: 403, headers: NO_STORE });
			switch (route) {
				case "GET /x/connect": {
					const creds = credentials(context.env);
					if (creds === null) return text("X_CLIENT_ID and X_CLIENT_SECRET are not set on the Worker.", 503);
					const state = await signState(creds.clientSecret);
					const { verifier, challenge } = await pkce();
					return new Response(null, {
						status: 302,
						headers: { ...NO_STORE, location: authorizeUrl(creds, state, challenge), "set-cookie": `${OAUTH_COOKIE}=${state}~${verifier}; Path=${CALLBACK_PATH}; Max-Age=${OAUTH_COOKIE_MAX_AGE_S}; HttpOnly; Secure; SameSite=Lax` },
					});
				}
				case "GET /x/callback": {
					const clear = { "set-cookie": CLEAR_OAUTH };
					const error = url.searchParams.get("error");
					if (error !== null) return text(`X did not connect: ${OAUTH_ERROR.test(error) ? error : "unknown error"}. Try again from /x-posts.`, 400, clear);
					const creds = credentials(context.env);
					if (creds === null) return text("X_CLIENT_ID and X_CLIENT_SECRET are not set on the Worker.", 503, clear);
					const started = oauthCookie(request);
					const state = url.searchParams.get("state") ?? "";
					if (started === null || state !== started.state || !(await verifyState(creds.clientSecret, state))) return text("This link expired or started in another browser. Connect X again from /x-posts.", 400, clear);
					try {
						const tokens = await exchangeCode(fetcher, creds, url.searchParams.get("code") ?? "", started.verifier, now);
						const user = await whoAmI(fetcher, tokens.accessToken);
						await db((client) => saveAccount(client, creds.clientSecret, tokens, user, now));
					} catch (failure) {
						if (failure instanceof Disconnected || failure instanceof XRefused) return text(`${failure.message} Connect X again from /x-posts.`, 502, clear);
						throw failure;
					}
					return new Response(null, { status: 302, headers: { ...NO_STORE, ...clear, location: "/x-posts" } });
				}
				case "GET /mentions": {
					only(url, ["limit"]);
					const limit = limitParam(url, 100, 200);
					return Response.json(await db((client) => listMentions(client, limit, now)), { headers: NO_STORE });
				}
				case "POST /mentions/reply": {
					const input = await body(request, mentionReplyRequest);
					const creds = credentials(context.env);
					if (creds === null) return Response.json({ error: "Replies aren't set up on the server yet." }, { status: 503, headers: NO_STORE });
					try {
						return Response.json(await db((client) => replyToMention(client, { fetcher, creds, now }, input)), { headers: NO_STORE });
					} catch (failure) {
						if (failure instanceof Disconnected) return Response.json({ error: failure.message, connect: true }, { status: 409, headers: NO_STORE });
						if (failure instanceof NotMentioned) return Response.json({ error: failure.message, onX: true }, { status: 422, headers: NO_STORE });
						if (failure instanceof XRefused) return Response.json({ error: failure.message }, { status: 502, headers: NO_STORE });
						throw failure;
					}
				}
				case "POST /mentions/dismiss": {
					const { id } = await body(request, dismissRequest);
					await db((client) => dismissMention(client, id, now));
					return Response.json({ id }, { headers: NO_STORE });
				}
				default:
					return Response.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
			}
		} catch (error) {
			if (error instanceof BadRequest) return Response.json({ error: error.message }, { status: 400, headers: NO_STORE });
			if (error instanceof NotFound) return Response.json({ error: error.message }, { status: 404, headers: NO_STORE });
			if (databaseDown(error)) {
				console.error(`x-posts ${request.method} ${path}: database unavailable`, error);
				return Response.json({ error: DB_DOWN }, { status: 503, headers: NO_STORE });
			}
			throw error;
		}
	};
}

export default defineToolApi(xPostsApi());
