export type BearerSecret = "BOT_TOKEN_NUTRITION" | "BOT_TOKEN_COACH" | "BOT_TOKEN_COORDINATOR" | "BOT_TOKEN_APPLE_HEALTH";

export type Scope = "all" | readonly string[];

export type Bot = {
	serviceToken: string;
	clientId: string | null;
	bearer: BearerSecret | null;
	tools: Readonly<Record<string, Scope>>;
};

export const BOTS = {
	nutrition: {
		serviceToken: "nutrition-bot",
		clientId: "46f516f5dd0738abfa72def83722f0da.access",
		bearer: "BOT_TOKEN_NUTRITION",
		tools: { nutrition: ["GET *", "POST /mcp"], activity: ["GET /days", "GET /weights", "GET /health"] },
	},
	coach: {
		serviceToken: "coach-bot",
		clientId: "e7234384aca5ccf0fe162d8a112c76b5.access",
		bearer: "BOT_TOKEN_COACH",
		tools: { workouts: "all", activity: ["GET /workouts", "GET /apple-health/workouts"] },
	},
	coordinator: {
		serviceToken: "tools-coordinator",
		clientId: "9f5386b746c91cbc0774e9f806a081fa.access",
		bearer: "BOT_TOKEN_COORDINATOR",
		tools: { liaison: ["POST /notices", "GET /deliveries"] },
	},
	smoke: {
		serviceToken: "tools-agent-verify",
		clientId: "3764ccd9a5d87214d1032418b8c228ed.access",
		bearer: null,
		tools: {
			worker: ["GET /health", "GET /debug"],
			nutrition: ["GET *", "POST /mcp"],
			workouts: ["GET *"],
			activity: ["GET /days", "GET /weights", "GET /health", "GET /workouts", "GET /sleep", "GET /measures", "GET /intraday", "GET /apple-health/workouts", "GET /nights"],
		},
	},
	"apple-health": {
		serviceToken: "apple-health-export",
		clientId: "9ae32c65cfb73a1cf83b0196b682ba65.access",
		bearer: "BOT_TOKEN_APPLE_HEALTH",
		tools: { activity: ["POST /apple-health"] },
	},
	gtd: {
		serviceToken: "gtd-bot",
		clientId: "acfc8c269c4412bc69e52f3f59d9d965.access",
		bearer: null,
		tools: { goals: "all" },
	},
} as const satisfies Record<string, Bot>;

export type BotName = keyof typeof BOTS;

export type Caller = { kind: "owner"; email: string } | { kind: "bot"; bot: BotName } | { kind: "local" } | { kind: "public" };

export type AccessConfig = {
	teamDomain: string;
	audiences: readonly string[];
	emails: readonly string[];
	bots: Readonly<Record<string, BotName>>;
	publicRoutes: readonly string[];
};

function botsByClientId(bots: Readonly<Record<BotName, Bot>>): Record<string, BotName> {
	return Object.fromEntries(Object.entries(bots).flatMap(([name, bot]) => (bot.clientId === null ? [] : [[bot.clientId, name as BotName]])));
}

export const ACCESS: AccessConfig = {
	teamDomain: "https://mattpalmer.cloudflareaccess.com",
	audiences: ["a99f3303259b1e9f2cd5f99542fe69260fd351fd51b7c4596ee0210ca7893b13"],
	emails: ["mattppalmer@gmail.com"],
	bots: botsByClientId(BOTS),
	publicRoutes: ["GET /api/withings/callback", "HEAD /api/withings/callback", "POST /api/withings/callback"],
};

export function allows(bot: BotName, tool: string, route: string): boolean {
	const tools: Readonly<Record<string, Scope>> = BOTS[bot].tools;
	if (!Object.hasOwn(tools, tool)) return false;
	const scope = tools[tool];
	if (scope === "all") return true;
	const method = route.split(" ", 1)[0];
	return scope?.includes(route) === true || scope?.includes(`${method} *`) === true;
}

export function outOfScope(caller: Caller, tool: string, route: string): Response | null {
	if (caller.kind !== "bot" || allows(caller.bot, tool, route)) return null;
	return forbidden(`bot ${caller.bot} may not call ${route} on ${tool}`);
}

type Jwk = JsonWebKey & { kid?: string };
type Claims = { iss?: unknown; aud?: unknown; exp?: unknown; nbf?: unknown; email?: unknown; common_name?: unknown };
type KeySet = { fetchedAt: number; keys: Map<string, CryptoKey> };
type Fetch = (input: string) => Promise<Response>;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const KEYS_TTL_MS = 10 * 60_000;
const REFETCH_AFTER_MS = 60_000;
const CLOCK_SKEW_S = 60;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

function forbidden(reason: string): Response {
	return Response.json({ error: `Forbidden: ${reason}` }, { status: 403, headers: { "cache-control": "no-store" } });
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
	const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function decodePart(text: string): unknown {
	try {
		return JSON.parse(decoder.decode(fromBase64url(text)));
	} catch {
		return null;
	}
}

function crossSite(request: Request, url: URL): boolean {
	if (SAFE_METHODS.has(request.method)) return false;
	const site = request.headers.get("sec-fetch-site");
	if (site !== null && site !== "same-origin" && site !== "none") return true;
	const origin = request.headers.get("origin");
	return origin !== null && origin !== url.origin;
}

export function accessGate(config: AccessConfig = ACCESS, fetcher: Fetch = (input) => fetch(input), clock: () => number = Date.now) {
	let keySet: KeySet | null = null;

	async function loadKeys(): Promise<Map<string, CryptoKey>> {
		const response = await fetcher(`${config.teamDomain}/cdn-cgi/access/certs`);
		if (!response.ok) throw new Error(`Access certs answered HTTP ${response.status}`);
		const { keys } = (await response.json()) as { keys?: Jwk[] };
		const imported = new Map<string, CryptoKey>();
		for (const jwk of keys ?? []) {
			if (jwk.kid === undefined || jwk.kty !== "RSA") continue;
			imported.set(jwk.kid, await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
		}
		keySet = { fetchedAt: clock(), keys: imported };
		return imported;
	}

	async function keyFor(kid: string): Promise<CryptoKey | undefined> {
		const age = keySet === null ? Infinity : clock() - keySet.fetchedAt;
		const known = age < KEYS_TTL_MS ? keySet?.keys.get(kid) : undefined;
		if (known !== undefined) return known;
		if (keySet !== null && age < REFETCH_AFTER_MS) return keySet.keys.get(kid);
		return (await loadKeys()).get(kid);
	}

	async function verify(token: string): Promise<Claims | null> {
		const [header, payload, signature] = token.split(".");
		if (header === undefined || payload === undefined || signature === undefined) return null;
		const head = decodePart(header) as { alg?: unknown; kid?: unknown } | null;
		if (head === null || head.alg !== "RS256" || typeof head.kid !== "string") return null;
		const key = await keyFor(head.kid);
		if (key === undefined) return null;
		const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromBase64url(signature), encoder.encode(`${header}.${payload}`)).catch(() => false);
		return valid ? (decodePart(payload) as Claims | null) : null;
	}

	function admitted(claims: Claims): Caller | string {
		const now = clock() / 1000;
		if (claims.iss !== config.teamDomain) return "token has the wrong issuer";
		const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
		if (!audiences.some((aud) => typeof aud === "string" && config.audiences.includes(aud))) return "token is for another Access app";
		if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_S < now) return "token expired";
		if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_S > now) return "token is not valid yet";
		if (typeof claims.email === "string" && claims.email !== "" && config.emails.includes(claims.email.toLowerCase())) return { kind: "owner", email: claims.email.toLowerCase() };
		const bot = typeof claims.common_name === "string" && Object.hasOwn(config.bots, claims.common_name) ? config.bots[claims.common_name] : undefined;
		if (bot !== undefined) return { kind: "bot", bot };
		return "this identity is not on the tools allowlist";
	}

	return async function gate(request: Request): Promise<Caller | Response> {
		const url = new URL(request.url);
		if (config.publicRoutes.includes(`${request.method} ${url.pathname}`)) return { kind: "public" };
		if (crossSite(request, url)) return forbidden("cross-site request");
		if (LOCAL_HOSTS.has(url.hostname)) return { kind: "local" };
		const token = request.headers.get("cf-access-jwt-assertion");
		if (token === null || token === "") return forbidden("no Cloudflare Access token");
		let claims: Claims | null;
		try {
			claims = await verify(token);
		} catch (error) {
			console.error("Could not verify the Cloudflare Access token", error);
			return Response.json({ error: "Could not verify the Cloudflare Access token" }, { status: 503, headers: { "cache-control": "no-store" } });
		}
		if (claims === null) return forbidden("Cloudflare Access token did not verify");
		const caller = admitted(claims);
		return typeof caller === "string" ? forbidden(caller) : caller;
	};
}
