import { allows, BOTS, type BotName, type Caller } from "./access.ts";

declare global {
	interface Env {
		BOT_TOKEN_NUTRITION?: string;
		BOT_TOKEN_COACH?: string;
		BOT_TOKEN_COORDINATOR?: string;
		BOT_TOKEN_APPLE_HEALTH?: string;
	}
}

export type { BotName };

export type BotRequestContext = { env: Env; caller: Caller; path: string };

export type BotAuthLine = { auth: "bot"; tool: string; route: string; bot: BotName | null; via: "access" | "bearer" | null; access: BotName | null; bearer: BotName | "absent" | "unmatched" };

const BEARER = /^Bearer\s+(\S+)$/i;
const encoder = new TextEncoder();

async function sameToken(given: string, expected: string): Promise<boolean> {
	const [a, b] = await Promise.all([given, expected].map(async (value) => new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))));
	if (a === undefined || b === undefined) return false;
	let difference = 0;
	for (let index = 0; index < a.length; index++) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
	return difference === 0;
}

async function bearerBot(request: Request, env: Env): Promise<BotName | "absent" | "unmatched"> {
	const token = BEARER.exec(request.headers.get("authorization") ?? "")?.[1];
	if (token === undefined) return "absent";
	for (const [name, bot] of Object.entries(BOTS) as [BotName, (typeof BOTS)[BotName]][]) {
		const expected = bot.bearer === null ? undefined : env[bot.bearer];
		if (expected === undefined || expected === "") continue;
		if (await sameToken(token, expected)) return name;
	}
	return "unmatched";
}

function unauthorized(): Response {
	return Response.json({ error: "Unauthorized" }, { status: 401, headers: { "www-authenticate": 'Bearer realm="tools"' } });
}

export async function requireBot(request: Request, { env, caller, path }: BotRequestContext, tool: string): Promise<BotName | Response> {
	const route = `${request.method} ${path}`;
	const access = caller.kind === "bot" ? caller.bot : null;
	const bearer = await bearerBot(request, env);
	const byBearer = bearer === "absent" || bearer === "unmatched" ? null : bearer;
	const via = access !== null && allows(access, tool, route) ? "access" : byBearer !== null && allows(byBearer, tool, route) ? "bearer" : null;
	const bot = via === "access" ? access : via === "bearer" ? byBearer : null;
	const line: BotAuthLine = { auth: "bot", tool, route, bot, via, access, bearer };
	console.log(JSON.stringify(line));
	if (bot !== null) return bot;
	const named = access ?? byBearer;
	if (named === null) return unauthorized();
	return Response.json({ error: `Forbidden: bot ${named} may not call ${route} on ${tool}` }, { status: 403, headers: { "cache-control": "no-store" } });
}
