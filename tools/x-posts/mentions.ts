import { z } from "zod";
import type { Database, WithDb } from "../../worker/db.ts";
import { monthOf } from "./ingest.ts";
import { iso, NotFound } from "./queue.ts";
import { accessToken, type Credentials, Disconnected, postReply, type Reply, replyText, XRefused } from "./reply.ts";
import { postUrl } from "./screen.ts";
import { type Fetch, lookupUsers, userMentions, userPosts, XError, type XPost, type XUser } from "./x.ts";

export const MENTIONS_MONTHLY_MILLS = 20_000;
export const MENTION_MILLS = 1;
export const OWN_POST_MILLS = 1;
export const USER_MILLS = 10;
export const MENTION_PAGES_PER_RUN = 3;
const PAGE = 100;
const PAGE_WORST_MILLS = PAGE * (MENTION_MILLS + USER_MILLS);
export const RUN_HEARTBEAT_MINUTES = 15;

const MentionId = z.string().regex(/^[1-9]\d{0,18}$/, "id must be a post id");
export const mentionReplyRequest = z.strictObject({ id: MentionId, text: z.string().max(4000) });
export const dismissRequest = z.strictObject({ id: MentionId });

export type Mention = { id: string; handle: string; name: string; avatarUrl: string | null; text: string; createdAt: string; url: string; reply: Reply | null; replyHere: true };
export type MentionSync = { lastRunAt: string | null; lastSuccessAt: string | null; lastError: string | null; paused: "budget" | "capped" | null; spentMills: number; capMills: number };
export type SyncResult = { status: "disconnected" | "paused" | "ok" | "error"; mentions: number; replies: number; users: number; spentMills: number; error: string | null };

type SyncRow = { since_id: string | null; own_since_id: string | null; month: string; spent_mills: number; paused_month: string | null; paused_reason: "budget" | "capped" | null; last_run_at: Date | string | null; last_error: string | null };

function readSync(client: Database): Promise<SyncRow | undefined> {
	return client.query<SyncRow>("select since_id, own_since_id, month, spent_mills, paused_month, paused_reason, last_run_at, last_error from x_posts.mention_sync").then((result) => result.rows[0]);
}

async function saveUsers(client: Database, users: readonly XUser[], now: Date): Promise<void> {
	for (const user of users)
		await client.query(
			`insert into x_posts.x_users (id, username, name, avatar_url, fetched_at) values ($1, $2, $3, $4, $5)
			on conflict (id) do update set username = excluded.username, name = excluded.name, avatar_url = excluded.avatar_url, fetched_at = excluded.fetched_at`,
			[user.id, user.username, typeof user.name === "string" ? user.name : "", typeof user.profile_image_url === "string" && user.profile_image_url.startsWith("https://pbs.twimg.com/") ? user.profile_image_url : null, now],
		);
}

async function saveMentions(client: Database, posts: readonly XPost[], now: Date): Promise<number> {
	let inserted = 0;
	for (const post of posts) {
		if (typeof post.author_id !== "string") continue;
		const created = post.created_at === undefined ? Number.NaN : Date.parse(post.created_at);
		const result = await client.query("insert into x_posts.mentions (id, author_id, text, created_at, conversation_id, ingested_at) values ($1::bigint, $2, $3, $4, $5, $6) on conflict (id) do nothing", [
			post.id,
			post.author_id,
			post.note_tweet?.text ?? post.text,
			new Date(Number.isFinite(created) ? created : now.getTime()),
			post.conversation_id ?? null,
			now,
		]);
		inserted += result.rowCount ?? 0;
	}
	return inserted;
}

export async function syncMentions(withDb: WithDb, { fetcher, creds, now, cap = MENTIONS_MONTHLY_MILLS }: { fetcher: Fetch; creds: Credentials; now: Date; cap?: number }): Promise<SyncResult> {
	const result: SyncResult = { status: "ok", mentions: 0, replies: 0, users: 0, spentMills: 0, error: null };
	const month = monthOf(now);
	const [state, account] = await withDb(async (client) => [await readSync(client), (await client.query<{ user_id: string; last_error: string | null }>("select user_id, last_error from x_posts.account")).rows[0]] as const);
	if (state === undefined || account === undefined || account.last_error !== null) return { ...result, status: "disconnected" };
	let spent = state.month === month ? state.spent_mills : 0;
	if (state.paused_month === month) return { ...result, status: "paused", spentMills: spent };
	let paused: "budget" | "capped" | null = null;
	const stored: Record<string, unknown> = { ...state };
	let wrote = false;
	const save = async (patch: Record<string, unknown>) => {
		const changed = Object.entries(patch).filter(([key, value]) => stored[key] !== value);
		if (changed.length === 0) return;
		await withDb((client) => client.query(`update x_posts.mention_sync set ${changed.map(([key], index) => `${key} = $${index + 1}`).join(", ")}`, changed.map(([, value]) => value)));
		Object.assign(stored, Object.fromEntries(changed));
		wrote = true;
	};
	const fits = (worst: number) => {
		if (spent + worst <= cap) return true;
		paused = "budget";
		return false;
	};
	let token: string;
	try {
		({ token } = await withDb((client) => accessToken(client, fetcher, creds, now)));
	} catch (error) {
		if (error instanceof Disconnected || error instanceof XRefused) return { ...result, status: "disconnected", error: error.message };
		throw error;
	}
	try {
		const sinceId = state.since_id;
		let nextToken: string | null = null;
		let newest: string | null = null;
		for (let page = 0; page < (state.since_id === null ? 1 : MENTION_PAGES_PER_RUN) && fits(PAGE_WORST_MILLS); page++) {
			const found = await userMentions(fetcher, token, account.user_id, { sinceId, nextToken });
			spent += found.posts.length * MENTION_MILLS;
			newest ??= found.newestId;
			const authors = [...new Set(found.posts.flatMap((post) => (typeof post.author_id === "string" ? [post.author_id] : [])))];
			const known = authors.length === 0 ? new Set<string>() : new Set(await withDb(async (client) => (await client.query<{ id: string }>("select id from x_posts.x_users where id = any($1::text[])", [authors])).rows.map((row) => row.id)));
			const unknown = authors.filter((id) => !known.has(id));
			const users = unknown.length === 0 ? [] : await lookupUsers(fetcher, token, unknown);
			spent += users.length * USER_MILLS;
			await withDb(async (client) => {
				await saveUsers(client, users, now);
				result.mentions += await saveMentions(client, found.posts, now);
			});
			result.users += users.length;
			await save({ month, spent_mills: spent });
			nextToken = found.nextToken;
			if (nextToken === null) break;
		}
		if (newest !== null) await save({ since_id: newest });
		if (paused === null && fits(PAGE * OWN_POST_MILLS)) {
			const own = await userPosts(fetcher, token, account.user_id, state.own_since_id);
			spent += own.posts.length * OWN_POST_MILLS;
			const replies = own.posts.flatMap((post) => {
				const target = post.referenced_tweets?.find((ref) => ref.type === "replied_to")?.id;
				return target === undefined ? [] : [{ replyId: post.id, mentionId: target, text: post.note_tweet?.text ?? post.text, at: post.created_at ?? now.toISOString() }];
			});
			await withDb(async (client) => {
				for (const reply of replies) {
					const inserted = await client.query(
						`insert into x_posts.mention_replies (reply_id, mention_id, text, username, created_at, via)
						select $1::bigint, id, $3, (select username from x_posts.account), $4, 'x' from x_posts.mentions where id = $2::bigint
						on conflict (reply_id) do nothing`,
						[reply.replyId, reply.mentionId, reply.text, reply.at],
					);
					result.replies += inserted.rowCount ?? 0;
				}
			});
			await save({ month, spent_mills: spent, ...(own.newestId === null ? {} : { own_since_id: own.newestId }) });
		}
	} catch (error) {
		if (!(error instanceof XError)) throw error;
		if (error.kind === "usage capped") paused = "capped";
		else {
			result.status = "error";
			result.error = error.message;
		}
		await save({ month, spent_mills: spent });
	}
	if (paused !== null) {
		result.status = "paused";
		await save({ paused_month: month, paused_reason: paused });
	}
	const lastRunAt = state.last_run_at === null ? null : new Date(state.last_run_at);
	if (wrote || state.last_error !== result.error || lastRunAt === null || now.getTime() - lastRunAt.getTime() > RUN_HEARTBEAT_MINUTES * 60_000) {
		await save(result.status === "error" ? { last_run_at: now, last_error: result.error } : { last_run_at: now, last_success_at: now, last_error: null });
	}
	result.spentMills = spent;
	console.log(JSON.stringify({ xPosts: "mentions", actor: "cron", ...result }));
	return result;
}

export async function listMentions(client: Database, limit: number, now: Date): Promise<{ mentions: Mention[]; sync: MentionSync }> {
	const rows = (
		await client.query<{ id: string; username: string | null; name: string | null; avatar_url: string | null; text: string; created_at: Date | string; reply_id: string | null; reply_text: string | null; reply_username: string | null; replied_at: Date | string | null }>(
			`select mentions.id::text, users.username, users.name, users.avatar_url, mentions.text, mentions.created_at, latest.reply_id, latest.reply_text, latest.reply_username, latest.replied_at
			from x_posts.mentions
			left join x_posts.x_users as users on users.id = mentions.author_id
			left join lateral (
				select reply_id::text as reply_id, text as reply_text, username as reply_username, created_at as replied_at
				from x_posts.mention_replies where mention_id = mentions.id order by created_at desc limit 1
			) as latest on true
			where mentions.dismissed_at is null
			order by mentions.id desc limit $1`,
			[limit],
		)
	).rows;
	const sync = (
		await client.query<{ last_run_at: Date | string | null; last_success_at: Date | string | null; last_error: string | null; month: string; spent_mills: number; paused_month: string | null; paused_reason: "budget" | "capped" | null }>(
			"select last_run_at, last_success_at, last_error, month, spent_mills, paused_month, paused_reason from x_posts.mention_sync",
		)
	).rows[0];
	const month = monthOf(now);
	return {
		mentions: rows.map((row) => ({
			id: row.id,
			handle: row.username ?? "",
			name: row.name ?? "",
			avatarUrl: row.avatar_url,
			text: row.text,
			createdAt: iso(row.created_at),
			url: row.username === null ? `https://x.com/i/status/${row.id}` : postUrl(row.username, row.id),
			reply: row.reply_id === null || row.reply_username === null || row.replied_at === null ? null : { id: row.reply_id, url: postUrl(row.reply_username, row.reply_id), text: row.reply_text ?? "", at: iso(row.replied_at) },
			replyHere: true,
		})),
		sync: {
			lastRunAt: sync?.last_run_at == null ? null : iso(sync.last_run_at),
			lastSuccessAt: sync?.last_success_at == null ? null : iso(sync.last_success_at),
			lastError: sync?.last_error ?? null,
			paused: sync?.paused_month === month ? sync.paused_reason : null,
			spentMills: sync?.month === month ? sync.spent_mills : 0,
			capMills: MENTIONS_MONTHLY_MILLS,
		},
	};
}

export async function replyToMention(client: Database, deps: { fetcher: Fetch; creds: Credentials; now: Date }, { id, text }: { id: string; text: string }): Promise<Reply> {
	const body = replyText(text);
	if ((await client.query("select 1 from x_posts.mentions where id = $1::bigint", [id])).rows.length === 0) throw new NotFound(`No mention ${id}`);
	const { replyId, username } = await postReply(client, deps, id, body);
	await client.query("insert into x_posts.mention_replies (reply_id, mention_id, text, username, created_at, via) values ($1::bigint, $2::bigint, $3, $4, $5, 'tools') on conflict (reply_id) do nothing", [replyId, id, body, username, deps.now]);
	return { id: replyId, url: postUrl(username, replyId), text: body, at: iso(deps.now) };
}

export async function dismissMention(client: Database, id: string, now: Date): Promise<void> {
	const result = await client.query("update x_posts.mentions set dismissed_at = coalesce(dismissed_at, $2) where id = $1::bigint", [id, now]);
	if ((result.rowCount ?? 0) === 0) throw new NotFound(`No mention ${id}`);
}

