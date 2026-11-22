export type AccessConfig = {
	teamDomain: string;
	audiences: readonly string[];
	emails: readonly string[];
	serviceTokens: Readonly<Record<string, string>>;
	publicRoutes: readonly string[];
};

export const ACCESS: AccessConfig = {
	teamDomain: "https://mattpalmer.cloudflareaccess.com",
	audiences: ["a99f3303259b1e9f2cd5f99542fe69260fd351fd51b7c4596ee0210ca7893b13"],
	emails: ["mattppalmer@gmail.com"],
	serviceTokens: {
		"tools-agent-verify": "3764ccd9a5d87214d1032418b8c228ed.access",
		"coach-bot": "e7234384aca5ccf0fe162d8a112c76b5.access",
		"nutrition-bot": "46f516f5dd0738abfa72def83722f0da.access",
	},
	publicRoutes: ["GET /api/withings/callback", "HEAD /api/withings/callback"],
};

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
	const allowedTokens = new Set(Object.values(config.serviceTokens));

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

	function admitted(claims: Claims): string | null {
		const now = clock() / 1000;
		if (claims.iss !== config.teamDomain) return "token has the wrong issuer";
		const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
		if (!audiences.some((aud) => typeof aud === "string" && config.audiences.includes(aud))) return "token is for another Access app";
		if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_S < now) return "token expired";
		if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_S > now) return "token is not valid yet";
		if (typeof claims.email === "string" && claims.email !== "" && config.emails.includes(claims.email.toLowerCase())) return null;
		if (typeof claims.common_name === "string" && allowedTokens.has(claims.common_name)) return null;
		return "this identity is not on the tools allowlist";
	}

	return async function gate(request: Request): Promise<Response | null> {
		const url = new URL(request.url);
		if (config.publicRoutes.includes(`${request.method} ${url.pathname}`)) return null;
		if (crossSite(request, url)) return forbidden("cross-site request");
		if (LOCAL_HOSTS.has(url.hostname)) return null;
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
		const reason = admitted(claims);
		return reason === null ? null : forbidden(reason);
	};
}
