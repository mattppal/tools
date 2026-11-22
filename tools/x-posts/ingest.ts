import type { Database, WithDb } from "../../worker/db.ts";
import { queueNotice, Refused } from "../liaison/notices.ts";
import { INTERVAL_MINUTES, MONTHLY_READ_BUDGET, PAGES_PER_RUN, REFRESH_CALLS_PER_RUN, REFRESH_SHARE, STALE_NOTICE_MS } from "./query.ts";
import { rejectingFlags, SCREEN_VERSION, screen, validHandle } from "./screen.ts";
import { type Fetch, lookupMetrics, type Rate, searchRecent, type XMetrics, type XPage, XError } from "./x.ts";

export type SyncState = {
	sinceId: string | null;
	pendingSinceId: string | null;
	nextToken: string | null;
	nextRunAt: Date;
	lastRunAt: Date | null;
	lastSuccessAt: Date | null;
	lastError: string | null;
	failures: number;
	month: string;
	monthReads: number;
	cappedMonth: string | null;
	staleNoticedFor: Date | null;
};

export type RunStatus = "ok" | "partial" | "rate limited" | "usage capped" | "budget" | "failed";

export type RunResult = { status: RunStatus; pages: number; read: number; inserted: number; refreshed: number; rescreened: number; error: string | null } | { status: "not due" };

export type IngestDeps = { fetch: Fetch; token: string; now: Date; budget?: number };

const MAX_FAILURES = 3;
const REFRESH_BATCH = 100;
const RESCREEN_BATCH = 500;
const RUN_RETENTION_DAYS = 90;

type StateRow = {
	since_id: string | null;
	pending_since_id: string | null;
	next_token: string | null;
	next_run_at: Date | string;
	last_run_at: Date | string | null;
	last_success_at: Date | string | null;
	last_error: string | null;
	failures: number;
	month: string;
	month_reads: number;
	capped_month: string | null;
	stale_noticed_for: Date | string | null;
};

const date = (value: Date | string | null): Date | null => (value === null ? null : value instanceof Date ? value : new Date(value));

function toState(row: StateRow): SyncState {
	return {
		sinceId: row.since_id === null ? null : String(row.since_id),
		pendingSinceId: row.pending_since_id === null ? null : String(row.pending_since_id),
		nextToken: row.next_token,
		nextRunAt: date(row.next_run_at) ?? new Date(0),
		lastRunAt: date(row.last_run_at),
		lastSuccessAt: date(row.last_success_at),
		lastError: row.last_error,
		failures: Number(row.failures),
		month: row.month,
		monthReads: Number(row.month_reads),
		cappedMonth: row.capped_month,
		staleNoticedFor: date(row.stale_noticed_for),
	};
}

const STATE_COLUMNS = "since_id::text, pending_since_id::text, next_token, next_run_at, last_run_at, last_success_at, last_error, failures, month, month_reads, capped_month, stale_noticed_for";

export async function readSyncState(client: Database): Promise<SyncState> {
	const row = (await client.query<StateRow>(`select ${STATE_COLUMNS} from x_posts.sync_state`)).rows[0];
	if (row === undefined) throw new Error("x_posts.sync_state has no row");
	return toState(row);
}

export function monthOf(at: Date): string {
	return at.toISOString().slice(0, 7);
}

function nextMonth(at: Date): Date {
	return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
}

function minutesAfter(at: Date, minutes: number): Date {
	return new Date(at.getTime() + minutes * 60_000);
}

async function claim(client: Database, now: Date): Promise<SyncState | null> {
	const row = (
		await client.query<StateRow>(
			`update x_posts.sync_state
			set next_run_at = $1::timestamptz + make_interval(mins => $2), last_run_at = $1,
				month_reads = case when month = $3 then month_reads else 0 end,
				month = $3
			where next_run_at <= $1
			returning ${STATE_COLUMNS}`,
			[now, INTERVAL_MINUTES, monthOf(now)],
		)
	).rows[0];
	return row === undefined ? null : toState(row);
}

function metric(value: number | undefined): number | null {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 2_147_483_647 ? value : null;
}

export type PostRow = {
	id: string;
	authorId: string;
	handle: string;
	name: string;
	cleanName: string;
	text: string;
	cleanText: string;
	createdAt: string;
	lang: string | null;
	conversationId: string | null;
	isReply: boolean;
	isQuote: boolean;
	metrics: { likes: number | null; reposts: number | null; replies: number | null; quotes: number | null; bookmarks: number | null; impressions: number | null };
	flags: string[];
	notes: string[];
};

export function toPostRows(page: Pick<XPage, "posts" | "users">, now: Date, blocklist: readonly string[] = []): PostRow[] {
	return page.posts.map((post) => {
		const user = post.author_id === undefined ? undefined : page.users.get(post.author_id);
		const text = post.note_tweet?.text ?? post.text;
		const name = typeof user?.name === "string" ? user.name : "";
		const handle = validHandle(user?.username);
		const screened = screen(text, name, blocklist, handle);
		const created = post.created_at === undefined ? Number.NaN : Date.parse(post.created_at);
		const types = new Set((post.referenced_tweets ?? []).map((reference) => reference.type));
		const metrics: XMetrics = post.public_metrics ?? {};
		return {
			id: post.id,
			authorId: post.author_id ?? "",
			handle,
			name,
			cleanName: screened.cleanName,
			text,
			cleanText: screened.cleanText,
			createdAt: new Date(Number.isFinite(created) ? created : now.getTime()).toISOString(),
			lang: post.lang ?? null,
			conversationId: post.conversation_id ?? null,
			isReply: types.has("replied_to") || post.in_reply_to_user_id !== undefined,
			isQuote: types.has("quoted"),
			metrics: { likes: metric(metrics.like_count), reposts: metric(metrics.retweet_count), replies: metric(metrics.reply_count), quotes: metric(metrics.quote_count), bookmarks: metric(metrics.bookmark_count), impressions: metric(metrics.impression_count) },
			flags: screened.flags,
			notes: screened.notes,
		};
	});
}

export function screenDecision(flags: readonly string[], notes: readonly string[], now: Date): [string, string | null, string | null, Date | null] {
	const rejecting = rejectingFlags(flags);
	if (rejecting.length === 0) return ["pending", null, null, null];
	return ["rejected", `screen: ${rejecting.join(", ")}${notes.length === 0 ? "" : ` (${notes.join("; ")})`}`, "screen", now];
}

export async function readBlocklist(client: Database): Promise<string[]> {
	return (await client.query<{ term: string }>("select term from x_posts.blocklist order by term")).rows.map((row) => row.term);
}

async function insertPosts(client: Database, rows: PostRow[], now: Date): Promise<number> {
	let inserted = 0;
	for (const row of rows.toSorted((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))) {
		const result = await client.query(
			`insert into x_posts.posts (id, author_id, handle, name, clean_name, text, clean_text, created_at, lang, conversation_id, is_reply, is_quote, likes, reposts, replies, quotes, bookmarks, impressions, metrics_at, flags, screen_version, status, reason, decided_by, decided_at)
			values ($1::bigint, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::text[], $21, $22, $23, $24, $25)
			on conflict (id) do nothing`,
			[row.id, row.authorId, row.handle, row.name, row.cleanName, row.text, row.cleanText, row.createdAt, row.lang, row.conversationId, row.isReply, row.isQuote, row.metrics.likes, row.metrics.reposts, row.metrics.replies, row.metrics.quotes, row.metrics.bookmarks, row.metrics.impressions, now, row.flags, SCREEN_VERSION, ...screenDecision(row.flags, row.notes, now)],
		);
		inserted += result.rowCount ?? 0;
	}
	return inserted;
}

async function savePage(client: Database, rows: PostRow[], state: { sinceId: string | null; pendingSinceId: string | null; nextToken: string | null }, reads: number, now: Date): Promise<number> {
	await client.query("begin");
	try {
		const inserted = await insertPosts(client, rows, now);
		await client.query("update x_posts.sync_state set since_id = $1::bigint, pending_since_id = $2::bigint, next_token = $3, month_reads = month_reads + $4", [state.sinceId, state.pendingSinceId, state.nextToken, reads]);
		await client.query("commit");
		return inserted;
	} catch (error) {
		await client.query("rollback");
		throw error;
	}
}

type Paging = { sinceId: string | null; pendingSinceId: string | null; nextToken: string | null };

function afterPage(paging: Paging, page: XPage): Paging {
	const pendingSinceId = paging.nextToken === null ? (page.newestId ?? paging.pendingSinceId) : paging.pendingSinceId;
	if (page.nextToken !== null) return { sinceId: paging.sinceId, pendingSinceId, nextToken: page.nextToken };
	return { sinceId: pendingSinceId ?? paging.sinceId, pendingSinceId: null, nextToken: null };
}

function waitUntil(rate: Rate, now: Date): Date | null {
	if (rate.remaining !== 0) return null;
	return rate.resetAt !== null && rate.resetAt > now ? rate.resetAt : minutesAfter(now, INTERVAL_MINUTES);
}

async function refreshMetrics(withDb: WithDb, deps: IngestDeps, budget: number): Promise<{ refreshed: number; read: number; rate: Rate | null }> {
	let refreshed = 0;
	let read = 0;
	let rate: Rate | null = null;
	for (let call = 0; call < REFRESH_CALLS_PER_RUN; call++) {
		const { monthReads } = await withDb(readSyncState);
		if (monthReads + REFRESH_BATCH > budget * REFRESH_SHARE) break;
		const due = await withDb(async (client) =>
			(
				await client.query<{ id: string }>(
					`select id::text from x_posts.posts
					where metrics_at < created_at + interval '48 hours'
						and $1::timestamptz >= created_at + case
							when metrics_at < created_at + interval '6 hours' then interval '6 hours'
							when metrics_at < created_at + interval '24 hours' then interval '24 hours'
							else interval '48 hours' end
					order by created_at limit $2`,
					[deps.now, REFRESH_BATCH],
				)
			).rows.map((row) => row.id),
		);
		if (due.length === 0) break;
		const looked = await lookupMetrics(deps.fetch, deps.token, due);
		rate = looked.rate;
		await withDb(async (client) => {
			await client.query("begin");
			try {
				for (const id of due) {
					const found = looked.metrics.get(id);
					if (found === undefined) {
						await client.query("update x_posts.posts set metrics_at = $2 where id = $1::bigint", [id, deps.now]);
						continue;
					}
					await client.query(
						"update x_posts.posts set likes = $2, reposts = $3, replies = $4, quotes = $5, bookmarks = $6, impressions = $7, metrics_at = $8 where id = $1::bigint",
						[id, metric(found.like_count), metric(found.retweet_count), metric(found.reply_count), metric(found.quote_count), metric(found.bookmark_count), metric(found.impression_count), deps.now],
					);
					refreshed++;
				}
				await client.query("update x_posts.sync_state set month_reads = month_reads + $1", [looked.metrics.size]);
				await client.query("commit");
			} catch (error) {
				await client.query("rollback");
				throw error;
			}
		});
		read += looked.metrics.size;
		if (rate.remaining === 0) break;
	}
	return { refreshed, read, rate };
}

export async function rescreen(client: Database, blocklist: readonly string[], { all = false, now = new Date() }: { all?: boolean; now?: Date } = {}): Promise<number> {
	const stale = (
		await client.query<{ id: string; text: string; name: string; handle: string }>(
			all ? "select id::text, text, name, handle from x_posts.posts where status = 'pending' order by id" : "select id::text, text, name, handle from x_posts.posts where screen_version < $1 order by id limit $2",
			all ? [] : [SCREEN_VERSION, RESCREEN_BATCH],
		)
	).rows;
	for (const row of stale) {
		const screened = screen(row.text, row.name, blocklist, row.handle);
		const [status, reason, decidedBy, decidedAt] = screenDecision(screened.flags, screened.notes, now);
		await client.query(
			`update x_posts.posts set clean_text = $2, clean_name = $3, flags = $4::text[], screen_version = $5,
				status = case when status = 'pending' and $6 = 'rejected' then 'rejected' else status end,
				reason = case when status = 'pending' and $6 = 'rejected' then $7 else reason end,
				decided_by = case when status = 'pending' and $6 = 'rejected' then $8 else decided_by end,
				decided_at = case when status = 'pending' and $6 = 'rejected' then $9::timestamptz else decided_at end
			where id = $1::bigint`,
			[row.id, screened.cleanText, screened.cleanName, screened.flags, SCREEN_VERSION, status, reason, decidedBy, decidedAt],
		);
	}
	return stale.length;
}

export async function notice(client: Database, noticeKey: string, subject: string, body: string): Promise<void> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(noticeKey)));
	const hex = [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	const noticeId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
	try {
		await queueNotice(client, { for: "liaison", label: "action needed", noticeId, subject, body, refs: ["https://tools.mattpalmer.io/x-posts"], test: false });
	} catch (error) {
		if (!(error instanceof Refused && error.status === 409)) throw error;
	}
}

async function noticeStale(withDb: WithDb, state: SyncState, now: Date): Promise<void> {
	const since = state.lastSuccessAt;
	if (since === null || now.getTime() - since.getTime() < STALE_NOTICE_MS) return;
	if (state.staleNoticedFor !== null && state.staleNoticedFor.getTime() === since.getTime()) return;
	await withDb(async (client) => {
		await notice(
			client,
			`x-posts-stale:${since.toISOString()}`,
			"tools: x-posts has not ingested for 24 hours",
			`The X post log last ingested at ${since.toISOString()}. Last error: ${state.lastError ?? "none recorded"}. X recent search only reaches back 7 days, so posts older than that are lost if this lasts. Please tell Matt.`,
		);
		await client.query("update x_posts.sync_state set stale_noticed_for = $1", [since]);
	});
}

async function finish(withDb: WithDb, started: Date, result: Exclude<RunResult, { status: "not due" }>, rate: Rate | null, now: Date): Promise<void> {
	await withDb(async (client) => {
		await client.query("insert into x_posts.runs (started_at, finished_at, pages, read, inserted, refreshed, status, rate_remaining, error) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)", [
			started,
			new Date(),
			result.pages,
			result.read,
			result.inserted,
			result.refreshed,
			result.status,
			rate?.remaining ?? null,
			result.error,
		]);
		await client.query("delete from x_posts.runs where started_at < $1::timestamptz - make_interval(days => $2)", [now, RUN_RETENTION_DAYS]);
		if (result.status === "ok" || result.status === "partial") await client.query("update x_posts.sync_state set last_success_at = $1, last_error = $2, failures = 0", [now, result.error]);
		else if (result.status === "failed") await client.query("update x_posts.sync_state set last_error = $1, failures = failures + 1", [result.error]);
		else await client.query("update x_posts.sync_state set last_error = $1", [result.error]);
	});
}

export async function runIngest(withDb: WithDb, deps: IngestDeps): Promise<RunResult> {
	const { now } = deps;
	const budget = deps.budget ?? MONTHLY_READ_BUDGET;
	const state = await withDb((client) => claim(client, now));
	if (state === null) return { status: "not due" };
	await noticeStale(withDb, state, now);
	const started = new Date();
	const month = monthOf(now);
	const totals = { pages: 0, read: 0, inserted: 0, refreshed: 0, rescreened: 0 };
	let rate: Rate | null = null;

	if (state.cappedMonth === month || state.monthReads >= budget) {
		const result = { status: "budget" as const, ...totals, error: state.cappedMonth === month ? "X usage cap reached this month" : `Monthly read budget of ${budget} reached` };
		await withDb(async (client) => {
			await client.query("update x_posts.sync_state set next_run_at = $1", [nextMonth(now)]);
			if (state.cappedMonth !== month) await notice(client, `x-posts-budget:${month}`, `tools: x-posts reached its ${budget}-read budget for ${month}`, `The X post log read ${state.monthReads} posts in ${month} and stopped. It resumes on the 1st. Recent search reaches back 7 days, so posts from more than 7 days before then are lost. Please tell Matt.`);
		});
		await finish(withDb, started, result, null, now);
		return result;
	}

	const blocklist = await withDb(readBlocklist);
	let paging: Paging = { sinceId: state.sinceId, pendingSinceId: state.pendingSinceId, nextToken: state.nextToken };
	let monthReads = state.monthReads;
	let retried = false;
	let stopped: Exclude<RunStatus, "ok" | "partial"> | null = null;
	let error: string | null = null;
	let caughtUp = false;

	while (totals.pages < PAGES_PER_RUN) {
		if (monthReads >= budget) {
			stopped = "budget";
			error = `Monthly read budget of ${budget} reached`;
			break;
		}
		let page: XPage;
		try {
			page = await searchRecent(deps.fetch, deps.token, paging);
		} catch (caught) {
			if (!(caught instanceof XError)) throw caught;
			rate = caught.rate;
			if (!retried && (caught.kind === "bad pagination" || caught.kind === "bad since_id")) {
				retried = true;
				paging = caught.kind === "bad pagination" ? { sinceId: paging.sinceId, pendingSinceId: null, nextToken: null } : { sinceId: null, pendingSinceId: null, nextToken: null };
				const reset = paging;
				await withDb((client) => client.query("update x_posts.sync_state set since_id = $1::bigint, pending_since_id = null, next_token = null", [reset.sinceId]));
				continue;
			}
			error = caught.message;
			if (caught.kind === "rate limited") {
				stopped = "rate limited";
				const until = caught.rate.resetAt !== null && caught.rate.resetAt > now ? caught.rate.resetAt : minutesAfter(now, INTERVAL_MINUTES);
				await withDb((client) => client.query("update x_posts.sync_state set next_run_at = $1", [until]));
			} else if (caught.kind === "usage capped") {
				stopped = "usage capped";
				await withDb(async (client) => {
					await client.query("update x_posts.sync_state set capped_month = $1, next_run_at = $2", [month, nextMonth(now)]);
					await notice(client, `x-posts-capped:${month}`, `tools: X refused x-posts reads for ${month}`, `X answered ${caught.status}: the account's usage cap or credits ran out. The X post log stopped until the 1st. ${caught.message}. Please tell Matt.`);
				});
			} else {
				stopped = "failed";
				const result = { status: "failed" as const, ...totals, error };
				await finish(withDb, started, result, rate, now);
				if (caught.kind === "unauthorized" || caught.kind === "bad request" || state.failures + 1 >= MAX_FAILURES) throw new Error(`X post log ingest failed: ${caught.message}`);
				return result;
			}
			break;
		}
		rate = page.rate;
		totals.pages++;
		totals.read += page.posts.length;
		monthReads += page.posts.length;
		paging = afterPage(paging, page);
		const rows = toPostRows(page, now, blocklist);
		const saved = paging;
		totals.inserted += await withDb((client) => savePage(client, rows, saved, page.posts.length, now));
		const until = waitUntil(page.rate, now);
		if (until !== null) {
			await withDb((client) => client.query("update x_posts.sync_state set next_run_at = greatest(next_run_at, $1)", [until]));
			break;
		}
		if (paging.nextToken === null) {
			caughtUp = true;
			break;
		}
	}

	if (caughtUp && stopped === null) {
		try {
			const refreshed = await refreshMetrics(withDb, deps, budget);
			totals.refreshed = refreshed.refreshed;
			totals.read += refreshed.read;
			rate = refreshed.rate ?? rate;
		} catch (caught) {
			if (!(caught instanceof XError)) throw caught;
			rate = caught.rate;
			error = `Metrics refresh: ${caught.message}`;
		}
	}
	totals.rescreened = await withDb((client) => rescreen(client, blocklist, { now }));
	const status: RunStatus = stopped ?? (caughtUp ? "ok" : "partial");
	const result = { status, ...totals, error };
	await finish(withDb, started, result, rate, now);
	return result;
}
