import { z } from "zod";
import type { Database, WithDb } from "../../worker/db.ts";
import { addSpend, MENTIONS_MONTHLY_MILLS, referenced, USER_MILLS } from "./mentions.ts";
import { accessToken, type Credentials } from "./reply.ts";
import { monthOf, NotFound, postUrl } from "./shared.ts";
import { type Fetch, lookupRefs, lookupTree, lookupUsers, type XEntities, type XMedia, type XPost, type XUser } from "./x.ts";

export class NotSetUp extends Error {}

export const CONTEXT_POST_MILLS = 5;
const WORST_MILLS = 3 * CONTEXT_POST_MILLS + 2 * USER_MILLS;

export const contextRequest = z.strictObject({ id: z.string().regex(/^[1-9]\d{0,18}$/, "id must be a post id") });

export type Segment = { text: string; href?: string };
export type ContextMedia = { type: "photo" | "video" | "animated_gif"; url: string; width: number | null; height: number | null; alt: string | null; videoUrl: string | null };
export type ContextPost = { id: string; url: string; handle: string; name: string; avatarUrl: string | null; createdAt: string | null; segments: Segment[]; media: ContextMedia[]; quoted: ContextPost | null };
export type Context = { kind: "reply" | "quote" | "none"; post: ContextPost | null } | { kind: "paused"; post: null };

const ENTITY_DECODE: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };

function decode(text: string): string {
	return text.replace(/&(amp|lt|gt|quot|#39);/g, (entity) => ENTITY_DECODE[entity] ?? entity);
}

export function segments(text: string, entities: XEntities | undefined, hidden: (url: string) => boolean): Segment[] {
	const chars = Array.from(text);
	type Span = { start: number; end: number; href: string | null; label: string | null };
	const spans: Span[] = [];
	for (const url of entities?.urls ?? []) {
		if (url.start === undefined || url.end === undefined) continue;
		const expanded = url.expanded_url ?? url.url ?? "";
		if (url.media_key !== undefined || hidden(expanded)) spans.push({ start: url.start, end: url.end, href: null, label: "" });
		else if (/^https?:\/\//.test(expanded)) spans.push({ start: url.start, end: url.end, href: expanded, label: url.display_url ?? expanded });
	}
	for (const mention of entities?.mentions ?? []) {
		if (mention.start !== undefined && mention.end !== undefined && mention.username !== undefined) spans.push({ start: mention.start, end: mention.end, href: `https://x.com/${mention.username}`, label: null });
	}
	for (const tag of entities?.hashtags ?? []) {
		if (tag.start !== undefined && tag.end !== undefined && tag.tag !== undefined) spans.push({ start: tag.start, end: tag.end, href: `https://x.com/hashtag/${encodeURIComponent(tag.tag)}`, label: null });
	}
	for (const tag of entities?.cashtags ?? []) {
		if (tag.start !== undefined && tag.end !== undefined && tag.tag !== undefined) spans.push({ start: tag.start, end: tag.end, href: `https://x.com/search?q=${encodeURIComponent(`$${tag.tag}`)}`, label: null });
	}
	spans.sort((a, b) => a.start - b.start);
	const out: Segment[] = [];
	const push = (segment: Segment) => {
		if (segment.text === "") return;
		const last = out.at(-1);
		if (last !== undefined && last.href === undefined && segment.href === undefined) last.text += segment.text;
		else out.push(segment);
	};
	let at = 0;
	for (const span of spans) {
		if (span.start < at || span.end > chars.length || span.end <= span.start) continue;
		push({ text: decode(chars.slice(at, span.start).join("")) });
		const original = decode(chars.slice(span.start, span.end).join(""));
		const label = span.label ?? original;
		push(span.href === null ? { text: label } : { text: label, href: span.href });
		at = span.end;
	}
	push({ text: decode(chars.slice(at).join("")) });
	const last = out.at(-1);
	if (last !== undefined && last.href === undefined) last.text = last.text.trimEnd();
	return out.filter((segment) => segment.text !== "");
}

function videoUrl(media: XMedia): string | null {
	const mp4 = (media.variants ?? []).filter((variant) => variant.content_type === "video/mp4" && typeof variant.url === "string" && variant.url.startsWith("https://video.twimg.com/"));
	mp4.sort((a, b) => (b.bit_rate ?? 0) - (a.bit_rate ?? 0));
	return mp4[0]?.url ?? null;
}

function toMedia(post: XPost, media: readonly XMedia[]): ContextMedia[] {
	return (post.attachments?.media_keys ?? []).flatMap((key) => {
		const item = media.find((candidate) => candidate.media_key === key);
		if (item === undefined || (item.type !== "photo" && item.type !== "video" && item.type !== "animated_gif")) return [];
		const url = item.type === "photo" ? item.url : item.preview_image_url;
		if (url === undefined || !url.startsWith("https://pbs.twimg.com/")) return [];
		return [{ type: item.type, url, width: item.width ?? null, height: item.height ?? null, alt: item.alt_text ?? null, videoUrl: item.type === "photo" ? null : videoUrl(item) }];
	});
}

function toPost(post: XPost, users: ReadonlyMap<string, XUser>, media: readonly XMedia[], quoted: ContextPost | null): ContextPost {
	const user = post.author_id === undefined ? undefined : users.get(post.author_id);
	const handle = user?.username ?? "";
	const quotedId = referenced(post, "quoted");
	const hidden = (url: string) => quotedId !== null && new RegExp(`^https://(x|twitter)\\.com/[^/]+/status/${quotedId}(\\?|$)`).test(url);
	const note = post.note_tweet?.text;
	return {
		id: post.id,
		url: handle === "" ? `https://x.com/i/status/${post.id}` : postUrl(handle, post.id),
		handle,
		name: typeof user?.name === "string" ? user.name : "",
		avatarUrl: typeof user?.profile_image_url === "string" && user.profile_image_url.startsWith("https://pbs.twimg.com/") ? user.profile_image_url : null,
		createdAt: post.created_at ?? null,
		segments: note === undefined ? segments(post.text, post.entities, hidden) : segments(note, post.note_tweet?.entities, hidden),
		media: toMedia(post, media),
		quoted,
	};
}

async function knownUsers(client: Database, ids: readonly string[]): Promise<Map<string, XUser>> {
	if (ids.length === 0) return new Map();
	const rows = (await client.query<{ id: string; username: string; name: string; avatar_url: string | null }>("select id, username, name, avatar_url from x_posts.x_users where id = any($1::text[])", [ids])).rows;
	return new Map(rows.map((row) => [row.id, { id: row.id, username: row.username, name: row.name, ...(row.avatar_url === null ? {} : { profile_image_url: row.avatar_url }) }]));
}

type MentionRefs = { refs_known: boolean; replied_to_id: string | null; quoted_id: string | null };

export async function readContext(withDb: WithDb, { fetcher, creds, now, cap = MENTIONS_MONTHLY_MILLS }: { fetcher: Fetch; creds: Credentials | null; now: Date; cap?: number }, id: string): Promise<Context> {
	const month = monthOf(now);
	const row = await withDb(async (client) => (await client.query<MentionRefs>("select refs_known, replied_to_id::text, quoted_id::text from x_posts.mentions where id = $1::bigint", [id])).rows[0]);
	if (row === undefined) throw new NotFound(`No mention ${id}`);
	const target = (refs: MentionRefs) => (refs.replied_to_id !== null ? { kind: "reply" as const, id: refs.replied_to_id } : refs.quoted_id !== null ? { kind: "quote" as const, id: refs.quoted_id } : null);
	const cached = async (refs: MentionRefs): Promise<Context | null> => {
		const found = target(refs);
		if (found === null) return { kind: "none", post: null };
		const hit = await withDb(async (client) => (await client.query<{ post: ContextPost | null }>("select post from x_posts.post_context where id = $1::bigint", [found.id])).rows[0]);
		return hit === undefined ? null : { kind: found.kind, post: hit.post };
	};
	if (row.refs_known) {
		const hit = await cached(row);
		if (hit !== null) return hit;
	}
	const budget = await withDb(async (client) => (await client.query<{ month: string; spent_mills: number; paused_month: string | null }>("select month, spent_mills, paused_month from x_posts.mention_sync")).rows[0]);
	const spent = budget?.month === month ? budget.spent_mills : 0;
	if (budget === undefined || budget.paused_month === month || spent + WORST_MILLS > cap) return { kind: "paused", post: null };
	if (creds === null) throw new NotSetUp("X isn't set up on the server yet.");
	const { token } = await withDb((client) => accessToken(client, fetcher, creds, now));
	let mills = 0;
	try {
		let refs = row;
		if (!refs.refs_known) {
			const mention = await lookupRefs(fetcher, token, id);
			mills += mention === null ? 0 : CONTEXT_POST_MILLS;
			refs = { refs_known: true, replied_to_id: mention === null ? null : referenced(mention, "replied_to"), quoted_id: mention === null ? null : referenced(mention, "quoted") };
			await withDb((client) => client.query("update x_posts.mentions set refs_known = true, replied_to_id = $2::bigint, quoted_id = $3::bigint where id = $1::bigint", [id, refs.replied_to_id, refs.quoted_id]));
			const hit = await cached(refs);
			if (hit !== null) return hit;
		}
		const found = target(refs);
		if (found === null) return { kind: "none", post: null };
		const tree = await lookupTree(fetcher, token, found.id);
		mills += (tree.post === null ? 0 : 1 + tree.included.length) * CONTEXT_POST_MILLS;
		let post: ContextPost | null = null;
		if (tree.post !== null) {
			const quotedId = referenced(tree.post, "quoted");
			const quotedPost = quotedId === null ? undefined : tree.included.find((candidate) => candidate.id === quotedId);
			const authors = [...new Set([tree.post.author_id, quotedPost?.author_id].filter((author): author is string => typeof author === "string"))];
			const users = await withDb((client) => knownUsers(client, authors));
			const missing = authors.filter((author) => !users.has(author));
			if (missing.length > 0) {
				const looked = await lookupUsers(fetcher, token, missing);
				mills += looked.length * USER_MILLS;
				await withDb(async (client) => {
					for (const user of looked) {
						await client.query("insert into x_posts.x_users (id, username, name, avatar_url, fetched_at) values ($1, $2, $3, $4, $5) on conflict (id) do nothing", [
							user.id,
							user.username,
							typeof user.name === "string" ? user.name : "",
							typeof user.profile_image_url === "string" && user.profile_image_url.startsWith("https://pbs.twimg.com/") ? user.profile_image_url : null,
							now,
						]);
						users.set(user.id, user);
					}
				});
			}
			post = toPost(tree.post, users, tree.media, quotedPost === undefined ? null : toPost(quotedPost, users, tree.media, null));
		}
		await withDb((client) =>
			client.query("insert into x_posts.post_context (id, post, fetched_at) values ($1::bigint, $2::jsonb, $3) on conflict (id) do update set post = excluded.post, fetched_at = excluded.fetched_at", [found.id, JSON.stringify(post), now]),
		);
		return { kind: found.kind, post };
	} finally {
		if (mills > 0) await withDb((client) => addSpend(client, month, mills));
	}
}
