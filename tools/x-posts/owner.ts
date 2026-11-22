import { z } from "zod";
import type { Database } from "../../worker/db.ts";
import { monthOf, readBlocklist, rescreen } from "./ingest.ts";
import { LIVE_INGEST, MONTHLY_READ_BUDGET, QUERY, QUEUE_OPEN, STALE_FEED_MS } from "./query.ts";
import { BATCH_CAP, DAILY_CAP, iso, listJobs, printDay, type JobState } from "./queue.ts";
import { readAccount, type Reply, type XAccount } from "./reply.ts";
import { normalizeTerm, postUrl } from "./screen.ts";

export const POST_STATUSES = ["pending", "approved", "rejected", "overflow", "queued", "printed", "unconfirmed", "failed", "summarized"] as const;

export const blocklistRequest = z.strictObject({ terms: z.array(z.string().max(100)).max(1000) });

export type OwnerPost = {
	id: string;
	handle: string;
	name: string;
	createdAt: string;
	url: string;
	isReply: boolean;
	isQuote: boolean;
	text: string;
	cleanText: string;
	flags: string[];
	status: string;
	reason: string | null;
	decidedBy: string | null;
	decidedAt: string | null;
	jobId: string | null;
	sources: string[];
	reply: Reply | null;
	reposted: boolean;
	metrics: { likes: number | null; reposts: number | null; replies: number | null; quotes: number | null; impressions: number | null };
	metricsAt: string;
	ingestedAt: string;
};

export async function listPosts(client: Database, { status, limit, before }: { status: string | null; limit: number; before: string | null }): Promise<{ posts: OwnerPost[]; nextBefore: string | null }> {
	const rows = (
		await client.query<{
			id: string;
			handle: string;
			name: string;
			created_at: Date | string;
			is_reply: boolean;
			is_quote: boolean;
			text: string;
			clean_text: string;
			flags: string[];
			status: string;
			reason: string | null;
			decided_by: string | null;
			decided_at: Date | string | null;
			job_id: string | null;
			sources: string[];
			reply_id: string | null;
			reply_text: string | null;
			reply_username: string | null;
			replied_at: Date | string | null;
			reposted: boolean;
			likes: number | null;
			reposts: number | null;
			replies: number | null;
			quotes: number | null;
			impressions: number | null;
			metrics_at: Date | string;
			ingested_at: Date | string;
		}>(
			`select id::text, handle, name, created_at, is_reply, is_quote, text, clean_text, flags, status, reason, decided_by, decided_at, job_id::text, sources, reply_id, reply_text, reply_username, replied_at, exists (select 1 from x_posts.reposts where post_id = posts.id) as reposted, likes, reposts, replies, quotes, impressions, metrics_at, ingested_at
			from x_posts.posts
			left join lateral (
				select reply_id::text as reply_id, text as reply_text, username as reply_username, created_at as replied_at
				from x_posts.replies where post_id = posts.id order by created_at desc limit 1
			) as latest on true
			where ($1::text is null or status = $1) and ($2::bigint is null or id < $2::bigint)
			order by id desc limit $3`,
			[status, before, limit + 1],
		)
	).rows;
	const page = rows.slice(0, limit);
	return {
		posts: page.map((row) => ({
			id: row.id,
			handle: row.handle,
			name: row.name,
			createdAt: iso(row.created_at),
			url: postUrl(row.handle, row.id),
			isReply: row.is_reply,
			isQuote: row.is_quote,
			text: row.text,
			cleanText: row.clean_text,
			flags: row.flags,
			status: row.status,
			reason: row.reason,
			decidedBy: row.decided_by,
			decidedAt: row.decided_at === null ? null : iso(row.decided_at),
			jobId: row.job_id,
			sources: row.sources,
			reply:
				row.reply_id === null || row.reply_username === null || row.replied_at === null
					? null
					: { id: row.reply_id, url: postUrl(row.reply_username, row.reply_id), text: row.reply_text ?? "", at: iso(row.replied_at) },
			reposted: row.reposted,
			metrics: { likes: row.likes, reposts: row.reposts, replies: row.replies, quotes: row.quotes, impressions: row.impressions },
			metricsAt: iso(row.metrics_at),
			ingestedAt: iso(row.ingested_at),
		})),
		nextBefore: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
	};
}

export type Status = {
	query: string;
	live: boolean;
	queueOpen: boolean;
	sync: { lastRunAt: string | null; lastSuccessAt: string | null; nextRunAt: string | null; lastError: string | null; failures: number; stale: boolean };
	reads: { month: string; used: number; budget: number; capped: boolean };
	counts: Record<string, number>;
	today: { day: string; printedOrQueued: number; dailyCap: number; batchCap: number };
	jobs: JobState[];
	blocklist: string[];
	shadow: Shadow;
	x: XAccount | null;
};

export type Shadow = { since: string | null; matched: number; autoRejected: number; rejectedByFlag: Record<string, number>; addressed: number; addressedRate: number; passedScreen: number; wouldPrint: number };

export async function readShadow(client: Database): Promise<Shadow> {
	const totals = (
		await client.query<{ since: Date | null; matched: number; rejected: number; addressed: number; passed: number }>(
			`select min(ingested_at) as since, count(*)::int as matched,
				count(*) filter (where decided_by = 'screen')::int as rejected,
				count(*) filter (where 'addressed' = any(flags))::int as addressed,
				count(*) filter (where decided_by is distinct from 'screen')::int as passed
			from x_posts.posts`,
		)
	).rows[0];
	const byFlag = (
		await client.query<{ flag: string; n: number }>("select flag, count(*)::int as n from x_posts.posts, unnest(flags) as flag where decided_by = 'screen' group by flag order by flag")
	).rows;
	const wouldPrint = (
		await client.query<{ n: number }>(
			`select coalesce(sum(least(n, $1)), 0)::int as n from (
				select count(*) as n from x_posts.posts where decided_by is distinct from 'screen'
				group by (ingested_at at time zone 'America/Los_Angeles')::date
			) as days`,
			[DAILY_CAP],
		)
	).rows[0];
	const matched = Number(totals?.matched ?? 0);
	return {
		since: totals?.since == null ? null : iso(totals.since),
		matched,
		autoRejected: Number(totals?.rejected ?? 0),
		rejectedByFlag: Object.fromEntries(byFlag.map((row) => [row.flag, Number(row.n)])),
		addressed: Number(totals?.addressed ?? 0),
		addressedRate: matched === 0 ? 0 : Number(totals?.addressed ?? 0) / matched,
		passedScreen: Number(totals?.passed ?? 0),
		wouldPrint: Number(wouldPrint?.n ?? 0),
	};
}

export async function readStatus(client: Database, now: Date): Promise<Status> {
	const state = (
		await client.query<{ last_run_at: Date | null; last_success_at: Date | null; next_run_at: Date | string; last_error: string | null; failures: number; month: string; month_reads: number; capped_month: string | null }>(
			"select last_run_at, last_success_at, next_run_at, last_error, failures, month, month_reads, capped_month from x_posts.sync_state",
		)
	).rows[0];
	const counts = Object.fromEntries(
		(await client.query<{ status: string; n: number }>("select status, count(*)::int as n from x_posts.posts group by status")).rows.map((row) => [row.status, Number(row.n)]),
	);
	const day = printDay(now);
	const used = Number(
		(await client.query<{ used: number }>("select coalesce(sum(post_count), 0)::int as used from x_posts.jobs where kind = 'posts' and print_day = $1::date", [day])).rows[0]?.used ?? 0,
	);
	const month = monthOf(now);
	const lastSuccess = state?.last_success_at ?? null;
	const nextRun = state === undefined ? null : new Date(state.next_run_at);
	return {
		query: QUERY,
		live: LIVE_INGEST,
		queueOpen: QUEUE_OPEN,
		sync: {
			lastRunAt: state?.last_run_at == null ? null : iso(state.last_run_at),
			lastSuccessAt: lastSuccess === null ? null : iso(lastSuccess),
			nextRunAt: nextRun === null || !Number.isFinite(nextRun.getTime()) ? null : iso(nextRun),
			lastError: state?.last_error ?? null,
			failures: Number(state?.failures ?? 0),
			stale: lastSuccess === null || now.getTime() - new Date(lastSuccess).getTime() > STALE_FEED_MS,
		},
		reads: { month, used: state?.month === month ? Number(state.month_reads) : 0, budget: MONTHLY_READ_BUDGET, capped: state?.capped_month === month },
		counts: Object.fromEntries(POST_STATUSES.map((key) => [key, counts[key] ?? 0])),
		today: { day, printedOrQueued: used, dailyCap: DAILY_CAP, batchCap: BATCH_CAP },
		jobs: await listJobs(client, 30),
		blocklist: await readBlocklist(client),
		shadow: await readShadow(client),
		x: await readAccount(client),
	};
}

export async function replaceBlocklist(client: Database, terms: readonly string[], now: Date): Promise<{ terms: string[]; rescreened: number }> {
	const clean = [...new Set(terms.map(normalizeTerm).filter((term) => term.length > 0))].toSorted();
	await client.query("begin");
	try {
		await client.query("delete from x_posts.blocklist where term <> all($1::text[])", [clean]);
		await client.query("insert into x_posts.blocklist (term, added_at) select unnest($1::text[]), $2 on conflict (term) do nothing", [clean, now]);
		const rescreened = await rescreen(client, clean, { all: true, now });
		await client.query("commit");
		return { terms: clean, rescreened };
	} catch (error) {
		await client.query("rollback");
		throw error;
	}
}
