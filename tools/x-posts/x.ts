export const X_API = "https://api.x.com/2";

export const USER_AGENT = "tools-x-posts/1.0 (mattpalmer.io)";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export type XPost = {
	id: string;
	text: string;
	author_id?: string;
	created_at?: string;
	conversation_id?: string;
	in_reply_to_user_id?: string;
	referenced_tweets?: { type: string; id: string }[];
	note_tweet?: { text?: string; entities?: XEntities };
	entities?: XEntities;
	attachments?: { media_keys?: string[] };
};

export type XEntities = {
	mentions?: { start?: number; end?: number; id?: string; username?: string }[];
	urls?: { start?: number; end?: number; url?: string; expanded_url?: string; display_url?: string; media_key?: string }[];
	hashtags?: { start?: number; end?: number; tag?: string }[];
	cashtags?: { start?: number; end?: number; tag?: string }[];
};

export type XMedia = { media_key: string; type: string; url?: string; preview_image_url?: string; width?: number; height?: number; alt_text?: string; variants?: { content_type?: string; bit_rate?: number; url?: string }[] };

export type XTree = { post: XPost | null; included: XPost[]; media: XMedia[] };

export type XUser = { id: string; username?: string; name?: string; profile_image_url?: string };

export type XPage = { posts: XPost[]; newestId: string | null; nextToken: string | null };

export type XErrorKind = "rate limited" | "usage capped" | "unauthorized" | "bad pagination" | "bad since_id" | "bad request" | "unavailable";

export class XError extends Error {
	constructor(
		readonly kind: XErrorKind,
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

async function failure(response: Response, sent: { nextToken: boolean; sinceId: boolean }): Promise<XError> {
	const body = await response.text().catch(() => "");
	const detail = body.slice(0, 300);
	const lower = body.toLowerCase();
	if (response.status === 429 || response.status === 402) {
		const capped = response.status === 402 || lower.includes("usagecap") || lower.includes("usage-capped") || lower.includes("credits");
		return new XError(capped ? "usage capped" : "rate limited", response.status, `X answered HTTP ${response.status}: ${detail}`);
	}
	if (response.status === 401 || response.status === 403) return new XError("unauthorized", response.status, `X answered HTTP ${response.status}: ${detail}`);
	if (response.status === 400 && sent.nextToken && (lower.includes("next_token") || lower.includes("pagination_token"))) return new XError("bad pagination", 400, `X refused the page token: ${detail}`);
	if (response.status === 400 && sent.sinceId && lower.includes("since_id")) return new XError("bad since_id", 400, `X refused since_id: ${detail}`);
	if (response.status >= 400 && response.status < 500) return new XError("bad request", response.status, `X answered HTTP ${response.status}: ${detail}`);
	return new XError("unavailable", response.status, `X answered HTTP ${response.status}: ${detail}`);
}

async function get(fetcher: Fetch, token: string, url: string, sent: { nextToken: boolean; sinceId: boolean }): Promise<Record<string, unknown>> {
	let response: Response;
	try {
		response = await fetcher(url, { headers: { authorization: `Bearer ${token}`, "user-agent": USER_AGENT }, redirect: "manual" });
	} catch (error) {
		throw new XError("unavailable", 0, `Could not reach X: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!response.ok) throw await failure(response, sent);
	const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
	if (json === null || typeof json !== "object") throw new XError("unavailable", response.status, "X sent a body that is not JSON");
	return json;
}

function validPosts(json: Record<string, unknown>): XPost[] {
	const posts = Array.isArray(json["data"]) ? (json["data"] as XPost[]) : [];
	return posts.filter((post) => typeof post?.id === "string" && /^\d{1,19}$/.test(post.id) && typeof post.text === "string");
}

function page(json: Record<string, unknown>): XPage {
	const meta = (json["meta"] ?? {}) as { newest_id?: string; next_token?: string };
	return {
		posts: validPosts(json),
		newestId: typeof meta.newest_id === "string" && /^\d{1,19}$/.test(meta.newest_id) ? meta.newest_id : null,
		nextToken: typeof meta.next_token === "string" && meta.next_token !== "" ? meta.next_token : null,
	};
}

export async function userMentions(fetcher: Fetch, token: string, userId: string, { sinceId, nextToken }: { sinceId: string | null; nextToken: string | null }): Promise<XPage> {
	const params = new URLSearchParams({ max_results: "100", "tweet.fields": "created_at,author_id,conversation_id,note_tweet,referenced_tweets" });
	if (sinceId !== null) params.set("since_id", sinceId);
	if (nextToken !== null) params.set("pagination_token", nextToken);
	return page(await get(fetcher, token, `${X_API}/users/${userId}/mentions?${params}`, { nextToken: nextToken !== null, sinceId: sinceId !== null }));
}

export async function searchRecent(fetcher: Fetch, token: string, query: string, { sinceId, nextToken }: { sinceId: string | null; nextToken: string | null }): Promise<XPage> {
	const params = new URLSearchParams({ query, max_results: "100", "tweet.fields": "created_at,author_id,conversation_id,note_tweet,entities,in_reply_to_user_id,referenced_tweets" });
	if (sinceId !== null) params.set("since_id", sinceId);
	if (nextToken !== null) params.set("next_token", nextToken);
	return page(await get(fetcher, token, `${X_API}/tweets/search/recent?${params}`, { nextToken: nextToken !== null, sinceId: sinceId !== null }));
}

export async function userPosts(fetcher: Fetch, token: string, userId: string, sinceId: string | null): Promise<XPage> {
	const params = new URLSearchParams({ max_results: "100", "tweet.fields": "created_at,referenced_tweets,note_tweet" });
	if (sinceId !== null) params.set("since_id", sinceId);
	return page(await get(fetcher, token, `${X_API}/users/${userId}/tweets?${params}`, { nextToken: false, sinceId: sinceId !== null }));
}

export async function lookupUsers(fetcher: Fetch, token: string, ids: readonly string[]): Promise<XUser[]> {
	const params = new URLSearchParams({ ids: ids.join(","), "user.fields": "username,name,profile_image_url" });
	const json = await get(fetcher, token, `${X_API}/users?${params}`, { nextToken: false, sinceId: false });
	const users = Array.isArray(json["data"]) ? (json["data"] as XUser[]) : [];
	return users.filter((user) => typeof user?.id === "string" && typeof user.username === "string");
}

export async function lookupRefs(fetcher: Fetch, token: string, id: string): Promise<XPost | null> {
	const params = new URLSearchParams({ ids: id, "tweet.fields": "referenced_tweets" });
	return validPosts(await get(fetcher, token, `${X_API}/tweets?${params}`, { nextToken: false, sinceId: false }))[0] ?? null;
}

export async function lookupTree(fetcher: Fetch, token: string, id: string): Promise<XTree> {
	const params = new URLSearchParams({
		ids: id,
		"tweet.fields": "created_at,author_id,entities,attachments,referenced_tweets,note_tweet",
		expansions: "attachments.media_keys,referenced_tweets.id,referenced_tweets.id.attachments.media_keys",
		"media.fields": "type,url,preview_image_url,width,height,alt_text,variants",
	});
	const json = await get(fetcher, token, `${X_API}/tweets?${params}`, { nextToken: false, sinceId: false });
	const includes = (json["includes"] ?? {}) as { tweets?: unknown; media?: unknown };
	const media = Array.isArray(includes.media) ? (includes.media as XMedia[]).filter((item) => typeof item?.media_key === "string" && typeof item.type === "string") : [];
	return { post: validPosts(json)[0] ?? null, included: validPosts({ data: includes.tweets }), media };
}
