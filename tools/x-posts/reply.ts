import { z } from "zod";
import type { Database } from "../../worker/db.ts";
import { base64url, secrets } from "../activity/secrets.ts";
import { BadRequest, iso, NotFound } from "./queue.ts";
import { REPLY_MAX, replyLength } from "./reply-length.ts";
import { postUrl } from "./screen.ts";
import { type Fetch, USER_AGENT, X_API } from "./x.ts";

declare global {
	interface Env {
		X_CLIENT_ID?: string;
		X_CLIENT_SECRET?: string;
	}
}

export const CALLBACK_PATH = "/api/tools/x-posts/x/callback";
export const CALLBACK_URL = `https://tools.mattpalmer.io${CALLBACK_PATH}`;
export const SCOPE = "tweet.read tweet.write users.read offline.access";

const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const TOKEN_URL = `${X_API}/oauth2/token`;
const REFRESH_EARLY_MS = 5 * 60_000;
const RECONNECT = "X signed you out. Connect X again.";

export const { seal, unseal, signState, verifyState } = secrets("tools-x-posts", "X");

const PostId = z.string().regex(/^[1-9]\d{0,18}$/, "id must be a post id");
export const replyRequest = z.strictObject({ id: PostId, text: z.string().max(4000) });

export type Credentials = { clientId: string; clientSecret: string };
export type Tokens = { accessToken: string; refreshToken: string; expiresAt: Date; scope: string };
export type XAccount = { username: string; connectedAt: string; lastError: string | null };
export type Reply = { id: string; url: string; text: string; at: string };

export class Disconnected extends Error {}

export class XRefused extends Error {}

export function credentials(env: Env): Credentials | null {
	const clientId = env.X_CLIENT_ID?.trim();
	const clientSecret = env.X_CLIENT_SECRET?.trim();
	return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export async function pkce(): Promise<{ verifier: string; challenge: string }> {
	const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
	return { verifier, challenge: base64url(digest) };
}

export function authorizeUrl({ clientId }: Credentials, state: string, challenge: string): string {
	const params = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: CALLBACK_URL, scope: SCOPE, state, code_challenge: challenge, code_challenge_method: "S256" });
	return `${AUTHORIZE_URL}?${params}`;
}

async function reach(fetcher: Fetch, url: string, init: RequestInit): Promise<Response> {
	try {
		return await fetcher(url, init);
	} catch {
		throw new XRefused("Couldn't reach X. Try again.");
	}
}

function detail(json: unknown): string | null {
	const body = json as { detail?: unknown; error_description?: unknown; error?: unknown; errors?: { message?: unknown }[] } | null;
	const text = [body?.detail, body?.error_description, body?.errors?.[0]?.message, body?.error].find((value): value is string => typeof value === "string" && value !== "");
	return text === undefined ? null : text.slice(0, 200);
}

async function token(fetcher: Fetch, { clientId, clientSecret }: Credentials, form: Record<string, string>, now: Date): Promise<Tokens> {
	const response = await reach(fetcher, TOKEN_URL, {
		method: "POST",
		headers: { authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`, "content-type": "application/x-www-form-urlencoded", "user-agent": USER_AGENT },
		body: new URLSearchParams(form).toString(),
	});
	const json = (await response.json().catch(() => null)) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown } | null;
	if (response.status === 400 || response.status === 401) throw new Disconnected(`X refused the sign-in: ${detail(json) ?? `HTTP ${response.status}`}`);
	if (!response.ok || typeof json?.access_token !== "string" || typeof json.refresh_token !== "string") throw new XRefused(`X answered HTTP ${response.status}. Try again.`);
	const seconds = typeof json.expires_in === "number" ? json.expires_in : 7200;
	return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresAt: new Date(now.getTime() + seconds * 1000), scope: typeof json.scope === "string" ? json.scope : SCOPE };
}

export function exchangeCode(fetcher: Fetch, creds: Credentials, code: string, verifier: string, now: Date): Promise<Tokens> {
	return token(fetcher, creds, { grant_type: "authorization_code", code, redirect_uri: CALLBACK_URL, code_verifier: verifier }, now);
}

export async function whoAmI(fetcher: Fetch, accessToken: string): Promise<{ id: string; username: string }> {
	const response = await reach(fetcher, `${X_API}/users/me`, { headers: { authorization: `Bearer ${accessToken}`, "user-agent": USER_AGENT } });
	const json = (await response.json().catch(() => null)) as { data?: { id?: unknown; username?: unknown } } | null;
	if (!response.ok || typeof json?.data?.id !== "string" || typeof json.data.username !== "string") throw new XRefused(`X didn't say which account signed in: ${detail(json) ?? `HTTP ${response.status}`}`);
	return { id: json.data.id, username: json.data.username };
}

export async function saveAccount(client: Database, secret: string, tokens: Tokens, user: { id: string; username: string }, now: Date): Promise<void> {
	await client.query(
		`insert into x_posts.account (id, user_id, username, scope, access_token, refresh_token, expires_at, connected_at, refreshed_at, last_error)
		values (true, $1, $2, $3, $4, $5, $6, $7, null, null)
		on conflict (id) do update set user_id = excluded.user_id, username = excluded.username, scope = excluded.scope, access_token = excluded.access_token,
			refresh_token = excluded.refresh_token, expires_at = excluded.expires_at, connected_at = excluded.connected_at, refreshed_at = null, last_error = null`,
		[user.id, user.username, tokens.scope, await seal(secret, tokens.accessToken), await seal(secret, tokens.refreshToken), tokens.expiresAt, now],
	);
}

export async function readAccount(client: Database): Promise<XAccount | null> {
	const row = (await client.query<{ username: string; connected_at: Date | string; last_error: string | null }>("select username, connected_at, last_error from x_posts.account")).rows[0];
	return row === undefined ? null : { username: row.username, connectedAt: iso(row.connected_at), lastError: row.last_error };
}

export async function accessToken(client: Database, fetcher: Fetch, creds: Credentials, now: Date): Promise<{ token: string; username: string }> {
	await client.query("begin");
	let failure: Error | null = null;
	try {
		const row = (
			await client.query<{ username: string; access_token: string; refresh_token: string; expires_at: Date | string; last_error: string | null }>(
				"select username, access_token, refresh_token, expires_at, last_error from x_posts.account for update",
			)
		).rows[0];
		if (row === undefined) throw new Disconnected("Connect X first.");
		if (row.last_error !== null) throw new Disconnected(RECONNECT);
		if (new Date(row.expires_at).getTime() - now.getTime() > REFRESH_EARLY_MS) {
			await client.query("commit");
			return { token: await unseal(creds.clientSecret, row.access_token), username: row.username };
		}
		try {
			const fresh = await token(fetcher, creds, { grant_type: "refresh_token", refresh_token: await unseal(creds.clientSecret, row.refresh_token) }, now);
			await client.query("update x_posts.account set access_token = $1, refresh_token = $2, expires_at = $3, scope = $4, refreshed_at = $5", [
				await seal(creds.clientSecret, fresh.accessToken),
				await seal(creds.clientSecret, fresh.refreshToken),
				fresh.expiresAt,
				fresh.scope,
				now,
			]);
			await client.query("commit");
			return { token: fresh.accessToken, username: row.username };
		} catch (error) {
			if (!(error instanceof Disconnected)) throw error;
			failure = error;
			await client.query("update x_posts.account set last_error = $1", [error.message]);
			await client.query("commit");
		}
	} catch (error) {
		await client.query("rollback");
		throw error;
	}
	throw new Disconnected(RECONNECT, { cause: failure });
}

async function signedOut<T>(client: Database, work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (error instanceof Disconnected) await client.query("update x_posts.account set last_error = $1", [error.message]);
		throw error;
	}
}

async function refusal(response: Response, what: string): Promise<Error> {
	const json: unknown = await response.json().catch(() => null);
	if (response.status === 401) return new Disconnected(RECONNECT);
	if (response.status === 429) return new XRefused("X is limiting posts right now. Try again in a few minutes.");
	return new XRefused(`X didn't ${what}: ${detail(json) ?? `HTTP ${response.status}`}`);
}

async function createReply(fetcher: Fetch, accessToken: string, postId: string, text: string): Promise<string> {
	const response = await reach(fetcher, `${X_API}/tweets`, {
		method: "POST",
		headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", "user-agent": USER_AGENT },
		body: JSON.stringify({ text, reply: { in_reply_to_tweet_id: postId } }),
	});
	if (!response.ok) throw await refusal(response, "post it");
	const json = (await response.json().catch(() => null)) as { data?: { id?: unknown } } | null;
	const id = json?.data?.id;
	if (typeof id !== "string" || !/^\d{1,19}$/.test(id)) throw new XRefused("X posted it but sent no id. Check your profile before trying again.");
	return id;
}

export async function sendReply(client: Database, { fetcher, creds, now }: { fetcher: Fetch; creds: Credentials; now: Date }, { id, text }: { id: string; text: string }): Promise<Reply> {
	const body = text.trim();
	if (body === "") throw new BadRequest("Write something first.");
	if (replyLength(body) > REPLY_MAX) throw new BadRequest(`Replies are ${REPLY_MAX} characters at most.`);
	const found = (await client.query("select 1 from x_posts.posts where id = $1::bigint", [id])).rows.length > 0;
	if (!found) throw new NotFound(`No post ${id}`);
	const { token: bearer, username } = await accessToken(client, fetcher, creds, now);
	const replyId = await signedOut(client, () => createReply(fetcher, bearer, id, body));
	await client.query("insert into x_posts.replies (reply_id, post_id, text, username, created_at) values ($1::bigint, $2::bigint, $3, $4, $5) on conflict (reply_id) do nothing", [replyId, id, body, username, now]);
	return { id: replyId, url: postUrl(username, replyId), text: body, at: iso(now) };
}
