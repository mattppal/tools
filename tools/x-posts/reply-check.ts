import type { WithDb } from "../../worker/db.ts";
import { monthOf } from "./ingest.ts";
import { MONTHLY_READ_BUDGET, REFRESH_SHARE } from "./query.ts";
import { accessToken, type Credentials, Disconnected, XRefused } from "./reply.ts";
import { type Fetch, searchReplies, XError } from "./x.ts";

export const QUERY_MAX = 512;
export const CHECK_CALLS_PER_RUN = 3;
const SEARCH_WINDOW_MS = 7 * 24 * 60 * 60_000 - 15 * 60_000;

export type CheckResult = { checked: number; found: number; read: number; error: string | null };

export function replyQueries(username: string, ids: readonly string[]): string[][] {
	const head = `from:${username} (`;
	const chunks: string[][] = [];
	let chunk: string[] = [];
	let length = head.length + 1;
	for (const id of ids) {
		const term = `in_reply_to_tweet_id:${id}`;
		const added = (chunk.length === 0 ? 0 : 4) + term.length;
		if (chunk.length > 0 && length + added > QUERY_MAX) {
			chunks.push(chunk);
			chunk = [];
			length = head.length + 1;
		}
		chunk.push(id);
		length += (chunk.length === 1 ? 0 : 4) + term.length;
	}
	if (chunk.length > 0) chunks.push(chunk);
	return chunks;
}

export function replyQuery(username: string, ids: readonly string[]): string {
	return `from:${username} (${ids.map((id) => `in_reply_to_tweet_id:${id}`).join(" OR ")})`;
}

export async function checkReplies(withDb: WithDb, { fetcher, creds, now, budget = MONTHLY_READ_BUDGET }: { fetcher: Fetch; creds: Credentials; now: Date; budget?: number }): Promise<CheckResult> {
	const result: CheckResult = { checked: 0, found: 0, read: 0, error: null };
	const state = await withDb(async (client) => (await client.query<{ month: string; month_reads: number; capped_month: string | null }>("select month, month_reads, capped_month from x_posts.sync_state")).rows[0]);
	const month = monthOf(now);
	const used = state?.month === month ? Number(state.month_reads) : 0;
	if (state?.capped_month === month || used >= budget * REFRESH_SHARE) return result;
	const windowStart = new Date(now.getTime() - SEARCH_WINDOW_MS);
	const due = await withDb(async (client) =>
		(
			await client.query<{ id: string; created_at: Date | string }>(
				`select id::text, created_at from x_posts.posts
				where created_at > $2
					and not exists (select 1 from x_posts.replies where post_id = posts.id)
					and (reply_checked_at is null or reply_checked_at < $1::timestamptz - case when created_at > $1::timestamptz - interval '24 hours' then interval '5 minutes' else interval '1 hour' end)
				order by created_at desc limit 200`,
				[now, windowStart],
			)
		).rows,
	);
	if (due.length === 0) return result;
	let auth: { token: string; username: string };
	try {
		auth = await withDb((client) => accessToken(client, fetcher, creds, now));
	} catch (error) {
		if (error instanceof Disconnected || error instanceof XRefused) return { ...result, error: error.message };
		throw error;
	}
	const created = new Map(due.map((row) => [row.id, new Date(row.created_at)]));
	for (const ids of replyQueries(auth.username, [...created.keys()]).slice(0, CHECK_CALLS_PER_RUN)) {
		const oldest = Math.min(...ids.map((id) => created.get(id)?.getTime() ?? now.getTime()));
		let posts;
		try {
			({ posts } = await searchReplies(fetcher, auth.token, replyQuery(auth.username, ids), new Date(Math.max(oldest, windowStart.getTime()))));
		} catch (error) {
			if (!(error instanceof XError)) throw error;
			result.error = error.message;
			break;
		}
		const asked = new Set(ids);
		const found = posts.flatMap((post) => {
			const target = post.referenced_tweets?.find((ref) => ref.type === "replied_to")?.id;
			return target !== undefined && asked.has(target) ? [{ replyId: post.id, postId: target, text: post.note_tweet?.text ?? post.text, at: post.created_at ?? now.toISOString() }] : [];
		});
		await withDb(async (client) => {
			await client.query("begin");
			try {
				for (const reply of found) {
					await client.query("insert into x_posts.replies (reply_id, post_id, text, username, created_at, via) values ($1::bigint, $2::bigint, $3, $4, $5, 'x') on conflict (reply_id) do nothing", [
						reply.replyId,
						reply.postId,
						reply.text,
						auth.username,
						reply.at,
					]);
				}
				await client.query("update x_posts.posts set reply_checked_at = $2 where id = any($1::bigint[])", [ids, now]);
				await client.query("update x_posts.sync_state set month = $1, month_reads = case when month = $1 then month_reads else 0 end + $2", [month, posts.length]);
				await client.query("commit");
			} catch (error) {
				await client.query("rollback");
				throw error;
			}
		});
		result.checked += ids.length;
		result.found += found.length;
		result.read += posts.length;
	}
	console.log(JSON.stringify({ xPosts: "reply check", actor: "cron", ...result }));
	return result;
}
