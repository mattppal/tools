import { QUERY } from "./query.ts";

declare global {
	interface Env {
		X_BEARER_TOKEN?: string;
	}
}

export const X_API = "https://api.x.com/2";

export const USER_AGENT = "tools-x-posts/1.0 (mattpalmer.io)";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export type XMetrics = { retweet_count?: number; reply_count?: number; like_count?: number; quote_count?: number; bookmark_count?: number; impression_count?: number };

export type XPost = {
	id: string;
	text: string;
	author_id?: string;
	created_at?: string;
	lang?: string;
	conversation_id?: string;
	in_reply_to_user_id?: string;
	referenced_tweets?: { type: string; id: string }[];
	public_metrics?: XMetrics;
	note_tweet?: { text?: string };
	entities?: { mentions?: { id?: string; username?: string }[] };
};

export type XUser = { id: string; username?: string; name?: string; profile_image_url?: string };

export type XPage = { posts: XPost[]; users: Map<string, XUser>; newestId: string | null; nextToken: string | null; rate: Rate };

export type Rate = { remaining: number | null; resetAt: Date | null };

export type XErrorKind = "rate limited" | "usage capped" | "unauthorized" | "bad pagination" | "bad since_id" | "bad request" | "unavailable";

export class XError extends Error {
	constructor(
		readonly kind: XErrorKind,
		readonly status: number,
		message: string,
		readonly rate: Rate,
	) {
		super(message);
	}
}

const TWEET_FIELDS = "created_at,public_metrics,author_id,conversation_id,in_reply_to_user_id,referenced_tweets,lang,note_tweet,entities";

function rateOf(response: Response): Rate {
	const remaining = response.headers.get("x-rate-limit-remaining");
	const reset = response.headers.get("x-rate-limit-reset");
	const resetSeconds = reset === null ? Number.NaN : Number(reset);
	return { remaining: remaining === null || remaining === "" || !Number.isFinite(Number(remaining)) ? null : Number(remaining), resetAt: Number.isFinite(resetSeconds) && resetSeconds > 0 ? new Date(resetSeconds * 1000) : null };
}

async function failure(response: Response, sent: { nextToken: boolean; sinceId: boolean }): Promise<XError> {
	const rate = rateOf(response);
	const body = await response.text().catch(() => "");
	const detail = body.slice(0, 300);
	const lower = body.toLowerCase();
	if (response.status === 429 || response.status === 402) {
		const capped = response.status === 402 || lower.includes("usagecap") || lower.includes("usage-capped") || lower.includes("credits");
		return new XError(capped ? "usage capped" : "rate limited", response.status, `X answered HTTP ${response.status}: ${detail}`, rate);
	}
	if (response.status === 401 || response.status === 403) return new XError("unauthorized", response.status, `X answered HTTP ${response.status}: ${detail}`, rate);
	if (response.status === 400 && sent.nextToken && (lower.includes("next_token") || lower.includes("pagination_token"))) return new XError("bad pagination", 400, `X refused the page token: ${detail}`, rate);
	if (response.status === 400 && sent.sinceId && lower.includes("since_id")) return new XError("bad since_id", 400, `X refused since_id: ${detail}`, rate);
	if (response.status >= 400 && response.status < 500) return new XError("bad request", response.status, `X answered HTTP ${response.status}: ${detail}`, rate);
	return new XError("unavailable", response.status, `X answered HTTP ${response.status}: ${detail}`, rate);
}

async function get(fetcher: Fetch, token: string, url: string, sent: { nextToken: boolean; sinceId: boolean }): Promise<{ json: Record<string, unknown>; rate: Rate }> {
	let response: Response;
	try {
		response = await fetcher(url, { headers: { authorization: `Bearer ${token}`, "user-agent": USER_AGENT }, redirect: "manual" });
	} catch (error) {
		throw new XError("unavailable", 0, `Could not reach X: ${error instanceof Error ? error.message : String(error)}`, { remaining: null, resetAt: null });
	}
	if (!response.ok) throw await failure(response, sent);
	const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
	if (json === null || typeof json !== "object") throw new XError("unavailable", response.status, "X sent a body that is not JSON", rateOf(response));
	return { json, rate: rateOf(response) };
}

export async function searchRecent(fetcher: Fetch, token: string, { sinceId, nextToken }: { sinceId: string | null; nextToken: string | null }): Promise<XPage> {
	const params = new URLSearchParams({ query: QUERY, max_results: "100", "tweet.fields": TWEET_FIELDS, expansions: "author_id", "user.fields": "username,name,profile_image_url" });
	if (sinceId !== null) params.set("since_id", sinceId);
	if (nextToken !== null) params.set("next_token", nextToken);
	const { json, rate } = await get(fetcher, token, `${X_API}/tweets/search/recent?${params}`, { nextToken: nextToken !== null, sinceId: sinceId !== null });
	const posts = Array.isArray(json["data"]) ? (json["data"] as XPost[]) : [];
	const includes = (json["includes"] ?? {}) as { users?: XUser[] };
	const meta = (json["meta"] ?? {}) as { newest_id?: string; next_token?: string };
	return {
		posts: posts.filter((post) => typeof post?.id === "string" && /^\d{1,19}$/.test(post.id) && typeof post.text === "string"),
		users: new Map((includes.users ?? []).filter((user) => typeof user?.id === "string").map((user) => [user.id, user])),
		newestId: typeof meta.newest_id === "string" && /^\d{1,19}$/.test(meta.newest_id) ? meta.newest_id : null,
		nextToken: typeof meta.next_token === "string" && meta.next_token !== "" ? meta.next_token : null,
		rate,
	};
}

export async function searchReplies(fetcher: Fetch, token: string, query: string, startTime: Date): Promise<{ posts: XPost[]; rate: Rate }> {
	const params = new URLSearchParams({ query, max_results: "100", start_time: startTime.toISOString(), "tweet.fields": "created_at,referenced_tweets,note_tweet" });
	const { json, rate } = await get(fetcher, token, `${X_API}/tweets/search/recent?${params}`, { nextToken: false, sinceId: false });
	const posts = Array.isArray(json["data"]) ? (json["data"] as XPost[]) : [];
	return { posts: posts.filter((post) => typeof post?.id === "string" && /^\d{1,19}$/.test(post.id) && typeof post.text === "string"), rate };
}

export async function lookupMetrics(fetcher: Fetch, token: string, ids: readonly string[]): Promise<{ metrics: Map<string, XMetrics>; rate: Rate }> {
	const params = new URLSearchParams({ ids: ids.join(","), "tweet.fields": "public_metrics" });
	const { json, rate } = await get(fetcher, token, `${X_API}/tweets?${params}`, { nextToken: false, sinceId: false });
	const posts = Array.isArray(json["data"]) ? (json["data"] as XPost[]) : [];
	return { metrics: new Map(posts.filter((post) => typeof post?.id === "string").map((post) => [post.id, post.public_metrics ?? {}])), rate };
}
