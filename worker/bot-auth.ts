declare global {
	interface Env {
		BOT_TOKEN_NUTRITION?: string;
		BOT_TOKEN_COACH?: string;
	}
}

type BotSecret = "BOT_TOKEN_NUTRITION" | "BOT_TOKEN_COACH";

const BOTS = {
	nutrition: { secret: "BOT_TOKEN_NUTRITION", tools: ["nutrition"] },
	coach: { secret: "BOT_TOKEN_COACH", tools: ["workouts"] },
} as const satisfies Record<string, { secret: BotSecret; tools: readonly string[] }>;

export type BotName = keyof typeof BOTS;

const BEARER = /^Bearer\s+(\S+)$/i;
const encoder = new TextEncoder();

async function sameToken(given: string, expected: string): Promise<boolean> {
	const [a, b] = await Promise.all([given, expected].map(async (value) => new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))));
	if (a === undefined || b === undefined) return false;
	let difference = 0;
	for (let index = 0; index < a.length; index++) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
	return difference === 0;
}

function unauthorized(): Response {
	return Response.json({ error: "Unauthorized" }, { status: 401, headers: { "www-authenticate": 'Bearer realm="tools"' } });
}

export async function requireBot(request: Request, env: Env, tool: string): Promise<BotName | Response> {
	const token = BEARER.exec(request.headers.get("authorization") ?? "")?.[1];
	if (token === undefined) return unauthorized();
	for (const [name, bot] of Object.entries(BOTS) as [BotName, (typeof BOTS)[BotName]][]) {
		const expected = env[bot.secret];
		if (expected === undefined || expected === "") continue;
		if (!(bot.tools as readonly string[]).includes(tool)) continue;
		if (await sameToken(token, expected)) return name;
	}
	return unauthorized();
}
