import type { Database } from "../../worker/db.ts";
import { QUERY, STALE_FEED_MS } from "./query.ts";
import { iso } from "./queue.ts";
import { FLAGS, postUrl } from "./screen.ts";

export const FEED_LIMIT = 50;
export const FEED_MAX_LIMIT = 200;
export const MAX_WINDOW_DAYS = 31;
export const MAX_AUTHORS = 500;
export const TOP_POSTS = 5;
const PARAMS = new Set(["since", "from", "to", "cursor", "limit"]);
const SINCE_CURSOR = /^c1:(0|[1-9]\d{0,17})$/;
const WINDOW_CURSOR = /^w1:(\d{1,15}):([1-9]\d{0,18})$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

export class FeedError extends Error {}

export type FeedPost = {
	id: string;
	handle: string;
	name: string;
	createdAt: string;
	url: string;
	isReply: boolean;
	isQuote: boolean;
	cleanText: string;
	flags: string[];
	metrics: { likes: number | null; reposts: number | null; replies: number | null; quotes: number | null; bookmarks: number | null; impressions: number | null };
	metricsAt: string;
};

export type FeedRequest = { mode: "since"; since: "now" | "start" | bigint; limit: number } | { mode: "window"; from: Date; to: Date; after: { at: Date; id: string } | null; limit: number };

type Sync = { lastSuccessAt: string | null; stale: boolean };

export type SinceFeed = { query: string; mode: "since"; posts: FeedPost[]; nextCursor: string; hasMore: boolean; sync: Sync };

export type WindowFeed = {
	query: string;
	mode: "window";
	window: { from: string; to: string };
	total: number;
	counts: { originals: number; replies: number; quotes: number; authors: number; flagged: Record<string, number>; metrics: { likes: number; reposts: number; replies: number; quotes: number } };
	authors: { handle: string; name: string; posts: number }[];
	authorsTruncated: boolean;
	top: FeedPost[];
	posts: FeedPost[];
	nextCursor: string | null;
	hasMore: boolean;
	sync: Sync;
};

function time(value: string, name: string): Date {
	const at = new Date(value);
	if (!ISO.test(value) || Number.isNaN(at.getTime())) throw new FeedError(`${name} must be an ISO 8601 time with a zone, like 2026-11-21T08:00:00Z`);
	return at;
}

export function parseFeedRequest(url: URL, now: Date): FeedRequest {
	for (const key of url.searchParams.keys()) {
		if (!PARAMS.has(key)) throw new FeedError(`Unknown parameter ${key}. Send since, or from with to and cursor, and optionally limit`);
	}
	for (const key of PARAMS) {
		if (url.searchParams.getAll(key).length > 1) throw new FeedError(`Send ${key} once`);
	}
	const get = (key: string) => url.searchParams.get(key);
	const rawLimit = get("limit");
	let limit = FEED_LIMIT;
	if (rawLimit !== null) {
		if (!/^\d{1,3}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > FEED_MAX_LIMIT) throw new FeedError(`limit must be a whole number from 1 to ${FEED_MAX_LIMIT}`);
		limit = Number(rawLimit);
	}
	const since = get("since");
	const from = get("from");
	if ((since === null) === (from === null)) throw new FeedError("Send exactly one of since or from");
	if (since !== null) {
		if (get("to") !== null || get("cursor") !== null) throw new FeedError("to and cursor go with from, not since; since takes the nextCursor itself");
		if (since === "now" || since === "start") return { mode: "since", since, limit };
		const match = SINCE_CURSOR.exec(since);
		if (match?.[1] === undefined) throw new FeedError("since must be now, start, or a nextCursor from an earlier since response");
		return { mode: "since", since: BigInt(match[1]), limit };
	}
	const start = time(from ?? "", "from");
	const rawTo = get("to");
	const end = rawTo === null ? now : time(rawTo, "to");
	if (end.getTime() <= start.getTime()) throw new FeedError("to must be after from");
	if (end.getTime() - start.getTime() > MAX_WINDOW_DAYS * 86_400_000) throw new FeedError(`A window is at most ${MAX_WINDOW_DAYS} days`);
	const rawCursor = get("cursor");
	let after: { at: Date; id: string } | null = null;
	if (rawCursor !== null) {
		const match = WINDOW_CURSOR.exec(rawCursor);
		if (match?.[1] === undefined || match[2] === undefined) throw new FeedError("cursor must be a nextCursor from an earlier response for the same window");
		after = { at: new Date(Number(match[1])), id: match[2] };
	}
	return { mode: "window", from: start, to: end, after, limit };
}

type PostRow = {
	id: string;
	seq: string;
	handle: string;
	clean_name: string;
	created_at: Date | string;
	is_reply: boolean;
	is_quote: boolean;
	clean_text: string;
	flags: string[];
	likes: number | null;
	reposts: number | null;
	replies: number | null;
	quotes: number | null;
	bookmarks: number | null;
	impressions: number | null;
	metrics_at: Date | string;
};

const POST_COLUMNS = "id::text, seq::text, handle, clean_name, created_at, is_reply, is_quote, clean_text, flags, likes, reposts, replies, quotes, bookmarks, impressions, metrics_at";

function toFeedPost(row: PostRow): FeedPost {
	return {
		id: row.id,
		handle: row.handle,
		name: row.clean_name,
		createdAt: iso(row.created_at),
		url: postUrl(row.handle, row.id),
		isReply: row.is_reply,
		isQuote: row.is_quote,
		cleanText: row.clean_text,
		flags: row.flags,
		metrics: { likes: row.likes, reposts: row.reposts, replies: row.replies, quotes: row.quotes, bookmarks: row.bookmarks, impressions: row.impressions },
		metricsAt: iso(row.metrics_at),
	};
}

async function readSync(client: Database, now: Date): Promise<Sync> {
	const row = (await client.query<{ last_success_at: Date | string | null }>("select last_success_at from x_posts.sync_state")).rows[0];
	const last = row?.last_success_at == null ? null : new Date(row.last_success_at);
	return { lastSuccessAt: last === null ? null : iso(last), stale: last === null || now.getTime() - last.getTime() > STALE_FEED_MS };
}

async function sinceFeed(client: Database, request: Extract<FeedRequest, { mode: "since" }>, now: Date): Promise<SinceFeed> {
	const head = BigInt((await client.query<{ head: string }>("select coalesce(max(seq), 0)::text as head from x_posts.posts")).rows[0]?.head ?? "0");
	const sync = await readSync(client, now);
	if (request.since === "now") return { query: QUERY, mode: "since", posts: [], nextCursor: `c1:${head}`, hasMore: false, sync };
	const after = request.since === "start" ? 0n : request.since;
	if (after > head) throw new FeedError("since is ahead of the log. Send a nextCursor from an earlier response, or since=now");
	const rows = (await client.query<PostRow>(`select ${POST_COLUMNS} from x_posts.posts where seq > $1::bigint order by seq limit $2`, [after.toString(), request.limit + 1])).rows;
	const page = rows.slice(0, request.limit);
	const last = page.at(-1);
	return { query: QUERY, mode: "since", posts: page.map(toFeedPost), nextCursor: `c1:${last === undefined ? after : last.seq}`, hasMore: rows.length > request.limit, sync };
}

async function windowFeed(client: Database, request: Extract<FeedRequest, { mode: "window" }>, now: Date): Promise<WindowFeed> {
	const range = [request.from, request.to];
	const totals = (
		await client.query<{ total: number; originals: number; replies: number; quotes: number; authors: number; likes: string; reposts: string; reply_count: string; quote_count: string }>(
			`select count(*)::int as total,
				count(*) filter (where not is_reply and not is_quote)::int as originals,
				count(*) filter (where is_reply)::int as replies,
				count(*) filter (where is_quote)::int as quotes,
				count(distinct author_id)::int as authors,
				coalesce(sum(likes), 0)::text as likes,
				coalesce(sum(reposts), 0)::text as reposts,
				coalesce(sum(replies), 0)::text as reply_count,
				coalesce(sum(quotes), 0)::text as quote_count
			from x_posts.posts where created_at >= $1 and created_at < $2`,
			range,
		)
	).rows[0];
	const flagRows = (
		await client.query<{ flag: string; n: number }>("select flag, count(*)::int as n from x_posts.posts, unnest(flags) as flag where created_at >= $1 and created_at < $2 group by flag", range)
	).rows;
	const flagged = Object.fromEntries(FLAGS.map((flag) => [flag, Number(flagRows.find((row) => row.flag === flag)?.n ?? 0)]));
	const authorRows = (
		await client.query<{ handle: string; name: string; posts: number }>(
			`select (array_agg(handle order by created_at desc, id desc))[1] as handle, (array_agg(clean_name order by created_at desc, id desc))[1] as name, count(*)::int as posts
			from x_posts.posts where created_at >= $1 and created_at < $2
			group by author_id order by posts desc, lower((array_agg(handle order by created_at desc, id desc))[1]), author_id limit $3`,
			[...range, MAX_AUTHORS + 1],
		)
	).rows;
	const top = (
		await client.query<PostRow>(
			`select ${POST_COLUMNS} from x_posts.posts
			where created_at >= $1 and created_at < $2 and not ('injection' = any(flags))
			order by coalesce(likes, 0) + coalesce(reposts, 0) + coalesce(replies, 0) + coalesce(quotes, 0) desc, created_at desc, id desc limit $3`,
			[...range, TOP_POSTS],
		)
	).rows;
	const after = request.after;
	const rows = (
		await client.query<PostRow>(
			`select ${POST_COLUMNS} from x_posts.posts
			where created_at >= $1 and created_at < $2 and ($3::timestamptz is null or (created_at, id) > ($3::timestamptz, $4::bigint))
			order by created_at, id limit $5`,
			[...range, after?.at ?? null, after?.id ?? null, request.limit + 1],
		)
	).rows;
	const page = rows.slice(0, request.limit);
	const last = page.at(-1);
	const hasMore = rows.length > request.limit;
	return {
		query: QUERY,
		mode: "window",
		window: { from: iso(request.from), to: iso(request.to) },
		total: Number(totals?.total ?? 0),
		counts: {
			originals: Number(totals?.originals ?? 0),
			replies: Number(totals?.replies ?? 0),
			quotes: Number(totals?.quotes ?? 0),
			authors: Number(totals?.authors ?? 0),
			flagged,
			metrics: { likes: Number(totals?.likes ?? 0), reposts: Number(totals?.reposts ?? 0), replies: Number(totals?.reply_count ?? 0), quotes: Number(totals?.quote_count ?? 0) },
		},
		authors: authorRows.slice(0, MAX_AUTHORS).map((row) => ({ handle: row.handle, name: row.name, posts: Number(row.posts) })),
		authorsTruncated: authorRows.length > MAX_AUTHORS,
		top: top.map(toFeedPost),
		posts: page.map(toFeedPost),
		nextCursor: hasMore && last !== undefined ? `w1:${new Date(last.created_at).getTime()}:${last.id}` : null,
		hasMore,
		sync: await readSync(client, now),
	};
}

export async function readFeed(client: Database, request: FeedRequest, now: Date): Promise<SinceFeed | WindowFeed> {
	return request.mode === "since" ? await sinceFeed(client, request, now) : await windowFeed(client, request, now);
}
