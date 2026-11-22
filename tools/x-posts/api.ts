import { z } from "zod";
import { requireBot } from "../../worker/bot-auth.ts";
import { defineToolApi, type ToolApi } from "../../worker/tool-api.ts";
import { FeedError, parseFeedRequest, readFeed } from "./feed.ts";
import { blocklistRequest, listPosts, POST_STATUSES, readStatus, replaceBlocklist } from "./owner.ts";
import { checkNow, runIngest } from "./ingest.ts";
import { CHECK_NOW_COOLDOWN_MS, LIVE_INGEST, QUEUE_OPEN } from "./query.ts";
import { ackJob, ackRequest, applyDecisions, BadRequest, claimJob, claimRequest, Closed, Conflict, QUEUE_CLOSED, decisionsRequest, NotFound, pendingTotal, requeueJob, reviewQueue } from "./queue.ts";

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
const BOT_ROUTES = new Set(["GET /feed", "GET /review", "POST /decisions", "POST /jobs/claim", "POST /jobs/ack"]);
const requeueRequest = z.strictObject({ jobId: z.uuid() });

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

export function xPostsApi({ queueOpen }: { queueOpen: boolean }): ToolApi {
	return async (request, context) => {
		const { path, db, caller } = context;
		const url = new URL(request.url);
		const route = `${request.method} ${path}`;
		const now = new Date();
		try {
			if (BOT_ROUTES.has(route)) {
				const bot = await requireBot(request, context, "x-posts");
				if (bot instanceof Response) return bot;
				switch (route) {
					case "GET /feed": {
						const feed = parseFeedRequest(url, now);
						return Response.json(await db((client) => readFeed(client, feed, now)), { headers: NO_STORE });
					}
					case "GET /review": {
						only(url, ["limit", "idsOnly"]);
						const idsOnly = url.searchParams.get("idsOnly") ?? "false";
						if (idsOnly !== "true" && idsOnly !== "false") throw new BadRequest("idsOnly must be true or false");
						const limit = limitParam(url, 25, 100);
						return Response.json(await db((client) => reviewQueue(client, limit, idsOnly === "true")), { headers: NO_STORE });
					}
					case "POST /decisions": {
						only(url, []);
						const input = await body(request, decisionsRequest);
						return Response.json(await db((client) => applyDecisions(client, input, "prints-review", now, queueOpen)), { headers: NO_STORE });
					}
					case "POST /jobs/claim": {
						only(url, []);
						const { bridge } = await body(request, claimRequest);
						const pending = await db(pendingTotal);
						const headers = { ...NO_STORE, "x-pending-total": String(pending) };
						if (!queueOpen) return Response.json({ error: QUEUE_CLOSED }, { status: 503, headers });
						const claimed = await db((client) => claimJob(client, { bridge, actor: "prints-bridge" }, now, queueOpen));
						return claimed === null ? new Response(null, { status: 204, headers }) : Response.json(claimed, { headers });
					}
					default: {
						only(url, []);
						const ack = await body(request, ackRequest);
						return Response.json(await db((client) => ackJob(client, ack, "prints-bridge", now)), { headers: NO_STORE });
					}
				}
			}
			if (caller.kind === "bot") return Response.json({ error: `Forbidden: bot ${caller.bot} may not call ${route} on x-posts` }, { status: 403, headers: NO_STORE });
			switch (route) {
				case "GET /posts": {
					only(url, ["status", "before", "limit"]);
					const status = url.searchParams.get("status");
					if (status !== null && !(POST_STATUSES as readonly string[]).includes(status)) throw new BadRequest(`status must be one of ${POST_STATUSES.join(", ")}`);
					const before = url.searchParams.get("before");
					if (before !== null && !/^[1-9]\d{0,18}$/.test(before)) throw new BadRequest("before must be a post id");
					const limit = limitParam(url, 50, 200);
					return Response.json(await db((client) => listPosts(client, { status, before, limit })), { headers: NO_STORE });
				}
				case "GET /status":
					only(url, []);
					return Response.json(await db((client) => readStatus(client, now)), { headers: NO_STORE });
				case "POST /decide": {
					const input = await body(request, decisionsRequest);
					return Response.json(await db((client) => applyDecisions(client, input, "matt", now, queueOpen)), { headers: NO_STORE });
				}
				case "POST /check": {
					const token = context.env.X_BEARER_TOKEN?.trim();
					if (!LIVE_INGEST || !token) return Response.json({ error: "Ingest is off" }, { status: 503, headers: NO_STORE });
					await db((client) => checkNow(client, now, CHECK_NOW_COOLDOWN_MS));
					const result = await runIngest(db, { fetch: (input, init) => fetch(input, init), token, now });
					return Response.json(result, { headers: NO_STORE });
				}
				case "POST /jobs/requeue": {
					const { jobId } = await body(request, requeueRequest);
					return Response.json({ jobId: await db((client) => requeueJob(client, jobId, now)) }, { headers: NO_STORE });
				}
				case "PUT /blocklist": {
					const { terms } = await body(request, blocklistRequest);
					return Response.json(await db((client) => replaceBlocklist(client, terms, now)), { headers: NO_STORE });
				}
				default:
					return Response.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
			}
		} catch (error) {
			if (error instanceof BadRequest || error instanceof FeedError) return Response.json({ error: error.message }, { status: 400, headers: NO_STORE });
			if (error instanceof NotFound) return Response.json({ error: error.message }, { status: 404, headers: NO_STORE });
			if (error instanceof Closed) return Response.json({ error: error.message }, { status: 503, headers: NO_STORE });
			if (error instanceof Conflict) return Response.json({ error: error.message }, { status: 409, headers: NO_STORE });
			if (databaseDown(error)) {
				console.error(`x-posts ${request.method} ${path}: database unavailable`, error);
				return Response.json({ error: DB_DOWN }, { status: 503, headers: NO_STORE });
			}
			throw error;
		}
	};
}

export default defineToolApi(xPostsApi({ queueOpen: QUEUE_OPEN }));
