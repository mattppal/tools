import { PGlite } from "@electric-sql/pglite";
import { beforeEach, expect, spyOn, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Caller } from "../../worker/access.ts";
import type { Database, WithDb } from "../../worker/db.ts";
import { DB_DOWN, xPostsApi } from "./api.ts";
import { type Mention, type MentionSync, RUN_HEARTBEAT_MINUTES, SUMMONS_QUERY, syncMentions } from "./mentions.ts";
import { isSendKey, REPLY_MAX, replyLength } from "./reply-length.ts";

const pg = new PGlite();
const migrations = join(import.meta.dirname, "migrations");
const migrationFiles = (await readdir(migrations)).toSorted();
async function migrate(files: string[]): Promise<void> {
	const sql = await Promise.all(files.map((name) => readFile(join(migrations, name), "utf-8")));
	await pg.exec(`set search_path to x_posts; ${sql.join(";\n")}; set search_path to public;`);
}
await pg.exec("create schema x_posts");
await migrate(migrationFiles);
const client = {
	query: async (text: string, values?: unknown[]) => {
		const result = await pg.query(text, values);
		return { ...result, rowCount: result.affectedRows ?? result.rows.length };
	},
} as unknown as Database;
const db: WithDb = (work) => work(client);

spyOn(console, "log").mockImplementation(() => {});

const BOT: Caller = { kind: "bot", bot: "nutrition" };
const MATT: Caller = { kind: "owner", email: "mattppalmer@gmail.com" };
const NOW = new Date("2026-11-22T20:00:00Z");
const MATT_X_ID = "1518984544421965824";
const CREDS = { clientId: "client", clientSecret: "client-secret" };

beforeEach(async () => {
	await pg.exec(`truncate x_posts.account, x_posts.mentions, x_posts.mention_replies, x_posts.x_users cascade;
		update x_posts.mention_sync set since_id = null, summons_since_id = null, own_since_id = null, last_run_at = null, last_success_at = null, last_error = null, month = '', spent_mills = 0, paused_month = null, paused_reason = null;`);
});

const X_ENV = { X_CLIENT_ID: "client", X_CLIENT_SECRET: "client-secret" } as Env;
type XCall = { url: string; method: string; body: string; authorization: string | null };

function fakeOAuthX(answers: ((call: XCall) => Response)[]): { fetcher: (input: string, init?: RequestInit) => Promise<Response>; calls: XCall[] } {
	const calls: XCall[] = [];
	return {
		calls,
		fetcher: async (input, init) => {
			const call = { url: input, method: init?.method ?? "GET", body: String(init?.body ?? ""), authorization: new Headers(init?.headers).get("authorization") };
			calls.push(call);
			const answer = answers.shift();
			if (answer === undefined) throw new Error(`Unexpected X call ${call.method} ${input}`);
			return answer(call);
		},
	};
}

async function sendAs(path: string, fetcher: (input: string, init?: RequestInit) => Promise<Response>, { method = "GET", body, caller = MATT, cookie, withDb = db }: { method?: string; body?: unknown; caller?: Caller; cookie?: string; withDb?: WithDb } = {}): Promise<Response> {
	const url = `https://tools.test/api/tools/x-posts${path}`;
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (cookie !== undefined) headers["cookie"] = cookie;
	return await xPostsApi({ fetcher })(new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), {
		env: X_ENV,
		ctx: { waitUntil() {} } as never,
		path: new URL(url).pathname.replace("/api/tools/x-posts", ""),
		db: withDb,
		caller,
	});
}

const tokenAnswer = (access: string, refresh: string) => () => Response.json({ token_type: "bearer", expires_in: 7200, access_token: access, refresh_token: refresh, scope: "tweet.read tweet.write users.read offline.access" });

async function connectAs(username = "mattyp"): Promise<XCall[]> {
	const none = fakeOAuthX([]);
	const start = await sendAs("/x/connect", none.fetcher);
	const cookie = (start.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
	const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
	const x = fakeOAuthX([tokenAnswer("access-1", "refresh-1"), () => Response.json({ data: { id: MATT_X_ID, username } })]);
	const done = await sendAs(`/x/callback?code=abc&state=${encodeURIComponent(state)}`, x.fetcher, { cookie });
	expect(done.status).toBe(302);
	return x.calls;
}

const list = async () => (await (await sendAs("/mentions", fakeOAuthX([]).fetcher)).json()) as { mentions: Mention[]; sync: MentionSync; x: { username: string; lastError: string | null } | null };
const mention = (id: string, author: string, text = "@mattyp quick one") => ({ id, text, author_id: author, created_at: "2026-11-23T17:00:00.000Z", conversation_id: id });
const summons = (id: string, author: string, extra: Record<string, unknown> = {}) => ({ ...mention(id, author, "mattyp mattyp mattyp"), ...extra });
const empty = () => Response.json({ meta: { result_count: 0 } });

async function seedMention(id: string, sources: string[] = ["mention"]): Promise<void> {
	await pg.query("insert into x_posts.mentions (id, author_id, text, created_at, ingested_at, sources) values ($1::bigint, 'u1', '@mattyp hi', now(), now(), $2::text[])", [id, sources]);
}

test("a database outage answers 503 with its own error text", async () => {
	const down = Object.assign(new Error("connection failure"), { code: "08006" });
	const timeout = new Error("Connection terminated due to connection timeout");
	spyOn(console, "error").mockImplementation(() => {});
	for (const error of [down, timeout]) {
		const response = await sendAs("/mentions", fakeOAuthX([]).fetcher, {
			withDb: async () => {
				throw error;
			},
		});
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: DB_DOWN });
	}
});

test("the print queue and review routes are gone, and bots reach nothing on x-posts", async () => {
	for (const [method, path] of [["GET", "/feed"], ["GET", "/review"], ["POST", "/decisions"], ["POST", "/jobs/claim"], ["POST", "/jobs/ack"], ["GET", "/posts"], ["GET", "/status"], ["POST", "/reply"]] as const) {
		expect({ path, status: (await sendAs(path, fakeOAuthX([]).fetcher, { method, ...(method === "POST" ? { body: {} } : {}) })).status }).toEqual({ path, status: 404 });
	}
	for (const [method, path] of [["GET", "/x/connect"], ["GET", "/mentions"], ["POST", "/mentions/reply"], ["POST", "/mentions/dismiss"]] as const) {
		const response = await sendAs(path, fakeOAuthX([]).fetcher, { method, caller: BOT, ...(method === "POST" ? { body: { id: "2200000000000000001", text: "x" } } : {}) });
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: `Forbidden: bot nutrition may not call ${method} ${path} on x-posts` });
	}
});

test("Connect X sends Matt to X with PKCE and the posting scopes", async () => {
	const response = await sendAs("/x/connect", fakeOAuthX([]).fetcher);
	expect(response.status).toBe(302);
	const location = new URL(response.headers.get("location") ?? "");
	expect(location.origin + location.pathname).toBe("https://x.com/i/oauth2/authorize");
	expect(Object.fromEntries(location.searchParams)).toMatchObject({ client_id: "client", scope: "tweet.read tweet.write users.read offline.access", code_challenge_method: "S256", redirect_uri: "https://tools.mattpalmer.io/api/tools/x-posts/x/callback" });
	expect(response.headers.get("set-cookie")).toContain("HttpOnly");
});

test("the callback checks the state, sends the verifier, and stores only sealed tokens", async () => {
	const forged = await sendAs("/x/callback?code=abc&state=1.2.3", fakeOAuthX([]).fetcher, { cookie: "x_oauth=1.2.3~verifier" });
	expect(forged.status).toBe(400);
	expect((await list()).x).toBeNull();
	const calls = await connectAs();
	expect(calls[0]?.body).toContain("grant_type=authorization_code");
	expect(calls[0]?.body).toMatch(/code_verifier=[\w-]{43}/);
	expect(calls[0]?.authorization).toBe(`Basic ${btoa("client:client-secret")}`);
	const row = (await pg.query<{ username: string; access_token: string; refresh_token: string }>("select username, access_token, refresh_token from x_posts.account")).rows[0];
	expect(row?.username).toBe("mattyp");
	expect(row?.access_token.startsWith("v1.")).toBe(true);
	expect(JSON.stringify(row)).not.toContain("refresh-1");
	expect((await list()).x).toMatchObject({ username: "mattyp", lastError: null });
});

test("an expiring token is refreshed and the rotated refresh token is saved first", async () => {
	await seedMention("2200000000000000001");
	await connectAs();
	await pg.query("update x_posts.account set expires_at = $1", [new Date(Date.now() + 60_000)]);
	const x = fakeOAuthX([tokenAnswer("access-2", "refresh-2"), () => Response.json({ data: { id: "1990000000000000002" } }, { status: 201 })]);
	expect((await sendAs("/mentions/reply", x.fetcher, { method: "POST", body: { id: "2200000000000000001", text: "hi" } })).status).toBe(200);
	expect(x.calls[0]?.body).toBe("grant_type=refresh_token&refresh_token=refresh-1");
	expect(x.calls[1]?.authorization).toBe("Bearer access-2");
	await pg.query("update x_posts.account set expires_at = $1", [new Date(Date.now() + 60_000)]);
	const again = fakeOAuthX([tokenAnswer("access-3", "refresh-3"), () => Response.json({ data: { id: "1990000000000000003" } }, { status: 201 })]);
	await sendAs("/mentions/reply", again.fetcher, { method: "POST", body: { id: "2200000000000000001", text: "hi again" } });
	expect(again.calls[0]?.body).toBe("grant_type=refresh_token&refresh_token=refresh-2");
});

test("a refused refresh asks Matt to connect again and stops further sends", async () => {
	await seedMention("2200000000000000001");
	await connectAs();
	await pg.query("update x_posts.account set expires_at = $1", [new Date(Date.now() - 1000)]);
	const x = fakeOAuthX([() => Response.json({ error: "invalid_request", error_description: "Value passed for the token was invalid." }, { status: 400 })]);
	const response = await sendAs("/mentions/reply", x.fetcher, { method: "POST", body: { id: "2200000000000000001", text: "hi" } });
	expect(response.status).toBe(409);
	expect(await response.json()).toEqual({ error: "X signed you out. Connect X again.", connect: true });
	expect((await sendAs("/mentions/reply", fakeOAuthX([]).fetcher, { method: "POST", body: { id: "2200000000000000001", text: "hi" } })).status).toBe(409);
	expect((await pg.query("select count(*)::int as n from x_posts.mention_replies")).rows[0]).toEqual({ n: 0 });
});

test("X refusing a reply passes its reason through and records nothing", async () => {
	await seedMention("2200000000000000001");
	await connectAs();
	const detail = "You are not allowed to create a Tweet with duplicate content.";
	const x = fakeOAuthX([() => Response.json({ title: "Forbidden", detail, status: 403 }, { status: 403 })]);
	const response = await sendAs("/mentions/reply", x.fetcher, { method: "POST", body: { id: "2200000000000000001", text: "hi" } });
	expect(response.status).toBe(502);
	expect(((await response.json()) as { error: string }).error).toBe(`X didn't post it: ${detail}`);
	expect((await sendAs("/mentions/reply", fakeOAuthX([]).fetcher, { method: "POST", body: { id: "2200000000000000001", text: "x".repeat(281) } })).status).toBe(400);
	expect((await sendAs("/mentions/reply", fakeOAuthX([]).fetcher, { method: "POST", body: { id: "2200000000000000001", text: "   " } })).status).toBe(400);
	expect((await sendAs("/mentions/reply", fakeOAuthX([]).fetcher, { method: "POST", body: { id: "123", text: "hi" } })).status).toBe(404);
	expect((await pg.query("select count(*)::int as n from x_posts.mention_replies")).rows[0]).toEqual({ n: 0 });
});

test("a summons that doesn't @mention Matt replies on X, before sending and when X refuses", async () => {
	await seedMention("2200000000000000001", ["summons"]);
	await seedMention("2200000000000000002", ["mention", "summons"]);
	await connectAs();
	const early = await sendAs("/mentions/reply", fakeOAuthX([]).fetcher, { method: "POST", body: { id: "2200000000000000001", text: "hi" } });
	expect(early.status).toBe(422);
	expect(await early.json()).toEqual({ error: "X only takes replies from here on posts that @mention you.", onX: true });
	const refused = fakeOAuthX([() => Response.json({ title: "Forbidden", detail: "You can only reply to or quote posts where you are mentioned or are the author.", status: 403 }, { status: 403 })]);
	const late = await sendAs("/mentions/reply", refused.fetcher, { method: "POST", body: { id: "2200000000000000002", text: "hi" } });
	expect(late.status).toBe(422);
	expect(await late.json()).toEqual({ error: "X only takes replies from here on posts that @mention you.", onX: true });
	expect(Object.fromEntries((await list()).mentions.map((item) => [item.id, [item.replyHere, item.summons]]))).toEqual({ "2200000000000000001": [false, true], "2200000000000000002": [true, true] });
});

test("reply length counts like X", () => {
	expect(replyLength("hello")).toBe(5);
	expect(replyLength("see https://example.com/a/very/long/path/that/goes/on")).toBe(4 + 23);
	expect(replyLength("👍🏽")).toBe(2);
	expect(replyLength("日本")).toBe(4);
	expect(replyLength("x".repeat(280))).toBe(REPLY_MAX);
});

test("Cmd+Enter sends on a Mac and Ctrl+Enter elsewhere; plain Enter makes a new line", () => {
	const key = (metaKey: boolean, ctrlKey: boolean, k = "Enter") => ({ key: k, metaKey, ctrlKey });
	expect([isSendKey(key(true, false), true), isSendKey(key(false, true), true), isSendKey(key(false, false), true)]).toEqual([true, false, false]);
	expect([isSendKey(key(false, true), false), isSendKey(key(true, false), false), isSendKey(key(false, true, "a"), false)]).toEqual([true, false, false]);
});

test("mentions sync reads new mentions with since_id, looks up each author once, and finds replies Matt made on X", async () => {
	await connectAs();
	const first = fakeOAuthX([
		(call) => {
			expect(call.url).toStartWith(`https://api.x.com/2/users/${MATT_X_ID}/mentions?`);
			expect(new URL(call.url).searchParams.get("since_id")).toBeNull();
			return Response.json({ data: [mention("2200000000000000002", "u1"), mention("2200000000000000001", "u2")], meta: { newest_id: "2200000000000000002" } });
		},
		(call) => {
			expect(new URL(call.url).searchParams.get("ids")).toBe("u1,u2");
			return Response.json({ data: [{ id: "u1", username: "ada", name: "Ada", profile_image_url: "https://pbs.twimg.com/a.jpg" }, { id: "u2", username: "bo", name: "Bo", profile_image_url: "https://evil.example/b.jpg" }] });
		},
		empty,
		(call) => {
			expect(call.url).toStartWith(`https://api.x.com/2/users/${MATT_X_ID}/tweets?`);
			return Response.json({ data: [{ id: "2200000000000000009", text: "on it", created_at: "2026-11-23T17:05:00.000Z", referenced_tweets: [{ type: "replied_to", id: "2200000000000000001" }] }], meta: { newest_id: "2200000000000000009" } });
		},
	]);
	expect(await syncMentions(db, { fetcher: first.fetcher, creds: CREDS, now: NOW })).toMatchObject({ status: "ok", mentions: 2, summons: 0, users: 2, replies: 1, spentMills: 2 + 20 + 1 });
	const second = fakeOAuthX([
		(call) => {
			expect(new URL(call.url).searchParams.get("since_id")).toBe("2200000000000000002");
			return Response.json({ data: [mention("2200000000000000003", "u1")], meta: { newest_id: "2200000000000000003" } });
		},
		empty,
		(call) => {
			expect(new URL(call.url).searchParams.get("since_id")).toBe("2200000000000000009");
			return empty();
		},
	]);
	expect(await syncMentions(db, { fetcher: second.fetcher, creds: CREDS, now: NOW })).toMatchObject({ status: "ok", mentions: 1, users: 0, spentMills: 24 });
	const listed = await list();
	expect(listed.mentions.map((item) => [item.id, item.handle, item.avatarUrl, item.reply?.id ?? null, item.summons])).toEqual([
		["2200000000000000003", "ada", "https://pbs.twimg.com/a.jpg", null, false],
		["2200000000000000002", "ada", "https://pbs.twimg.com/a.jpg", null, false],
		["2200000000000000001", "bo", null, "2200000000000000009", false],
	]);
	expect(listed.sync).toMatchObject({ paused: null, spentMills: 24, lastError: null });
});

test("summons come from recent search with Matt's token, share the list with mentions once per post, and count at the search price", async () => {
	await connectAs();
	const x = fakeOAuthX([
		() => Response.json({ data: [mention("2200000000000000002", "u1")], meta: { newest_id: "2200000000000000002" } }),
		() => Response.json({ data: [{ id: "u1", username: "ada", name: "Ada" }] }),
		(call) => {
			const sent = new URL(call.url);
			expect(sent.pathname).toBe("/2/tweets/search/recent");
			expect(sent.searchParams.get("query")).toBe(SUMMONS_QUERY);
			expect(sent.searchParams.get("since_id")).toBeNull();
			expect(call.authorization).toBe("Bearer access-1");
			return Response.json({
				data: [summons("2200000000000000003", "u2"), summons("2200000000000000002", "u1", { entities: { mentions: [{ id: MATT_X_ID }] } }), summons("2200000000000000001", "u1", { in_reply_to_user_id: MATT_X_ID })],
				meta: { newest_id: "2200000000000000003" },
			});
		},
		(call) => {
			expect(new URL(call.url).searchParams.get("ids")).toBe("u2");
			return Response.json({ data: [{ id: "u2", username: "cy", name: "Cy" }] });
		},
		empty,
	]);
	expect(await syncMentions(db, { fetcher: x.fetcher, creds: CREDS, now: NOW })).toMatchObject({ status: "ok", mentions: 1, summons: 3, users: 2, spentMills: 1 + 10 + 3 * 5 + 10 });
	expect((await pg.query("select id::text, sources from x_posts.mentions order by id")).rows).toEqual([
		{ id: "2200000000000000001", sources: ["mention", "summons"] },
		{ id: "2200000000000000002", sources: ["mention", "summons"] },
		{ id: "2200000000000000003", sources: ["summons"] },
	]);
	expect((await list()).mentions.map((item) => [item.id, item.url, item.replyHere, item.summons])).toEqual([
		["2200000000000000003", "https://x.com/cy/status/2200000000000000003", false, true],
		["2200000000000000002", "https://x.com/ada/status/2200000000000000002", true, true],
		["2200000000000000001", "https://x.com/ada/status/2200000000000000001", true, true],
	]);
	const next = fakeOAuthX([
		empty,
		(call) => {
			expect(new URL(call.url).searchParams.get("since_id")).toBe("2200000000000000003");
			return Response.json({ title: "Invalid Request", detail: "since_id must be within the last 7 days" }, { status: 400 });
		},
		empty,
	]);
	expect(await syncMentions(db, { fetcher: next.fetcher, creds: CREDS, now: NOW })).toMatchObject({ status: "ok" });
	expect((await pg.query("select summons_since_id from x_posts.mention_sync")).rows[0]).toEqual({ summons_since_id: null });
});

test("the migration starts summons where the old print-queue search left off", async () => {
	await pg.exec("drop schema x_posts cascade; create schema x_posts");
	await migrate(migrationFiles.filter((name) => name < "0008"));
	await pg.exec("update x_posts.sync_state set since_id = 2200000000000000005");
	await migrate(migrationFiles.filter((name) => name >= "0008"));
	expect((await pg.query("select summons_since_id from x_posts.mention_sync")).rows[0]).toEqual({ summons_since_id: "2200000000000000005" });
	expect((await pg.query("select column_default from information_schema.columns where table_schema = 'x_posts' and table_name = 'mentions' and column_name = 'sources'")).rows[0]).toEqual({ column_default: "'{mention}'::text[]" });
});

test("before dropping the print queue, its summons, their authors and Matt's replies move into mentions", async () => {
	await pg.exec("drop schema x_posts cascade; create schema x_posts");
	await migrate(migrationFiles.filter((name) => name < "0009"));
	await pg.exec(`insert into x_posts.account (user_id, username, scope, access_token, refresh_token, expires_at, connected_at) values ('${MATT_X_ID}', 'mattyp', 'tweet.read', 'sealed', 'sealed', now(), now());
		insert into x_posts.x_users (id, username, name, fetched_at) values ('u1', 'ada_now', 'Ada Now', now());
		insert into x_posts.mentions (id, author_id, text, created_at, ingested_at, dismissed_at) values (2200000000000000001, 'u1', '@mattyp mattyp mattyp mattyp', now(), now(), now());
		insert into x_posts.posts (id, author_id, handle, name, clean_name, text, clean_text, created_at, is_reply, is_quote, metrics_at, screen_version, status, ingested_at, addressed, avatar_url) values
			(2200000000000000001, 'u1', 'ada_then', 'Ada', 'Ada', '@mattyp mattyp mattyp mattyp', '', '2026-11-20T10:00:00Z', false, false, now(), 1, 'overflow', '2026-11-20T10:01:00Z', '{${MATT_X_ID}}', null),
			(2200000000000000002, 'u2', 'bo', 'Bo', 'Bo', 'mattyp mattyp mattyp', '', '2026-11-21T10:00:00Z', false, false, now(), 1, 'rejected', '2026-11-21T10:01:00Z', '{}', 'https://pbs.twimg.com/b.jpg'),
			(2200000000000000003, 'u2', 'bo', 'Bo', 'Bo', 'hey @MattyP mattyp mattyp mattyp', '', '2026-11-22T10:00:00Z', false, false, now(), 1, 'pending', '2026-11-22T10:01:00Z', null, null),
			(2200000000000000004, 'u3', 'cy', 'Cy', 'Cy', 'mattyp mattyp mattyp @mattypalmer', '', '2026-11-23T10:00:00Z', false, false, now(), 1, 'overflow', '2026-11-23T10:01:00Z', null, null);
		insert into x_posts.replies (reply_id, post_id, text, username, created_at, via) values (2200000000000000009, 2200000000000000002, 'hi bo', 'mattyp', now(), 'x');`);
	await migrate(migrationFiles.filter((name) => name >= "0009"));
	expect((await pg.query("select id::text, author_id, text, created_at, sources, dismissed_at is not null as dismissed from x_posts.mentions order by id")).rows).toEqual([
		{ id: "2200000000000000001", author_id: "u1", text: "@mattyp mattyp mattyp mattyp", created_at: expect.any(Date), sources: ["mention", "summons"], dismissed: true },
		{ id: "2200000000000000002", author_id: "u2", text: "mattyp mattyp mattyp", created_at: new Date("2026-11-21T10:00:00Z"), sources: ["summons"], dismissed: false },
		{ id: "2200000000000000003", author_id: "u2", text: "hey @MattyP mattyp mattyp mattyp", created_at: new Date("2026-11-22T10:00:00Z"), sources: ["mention", "summons"], dismissed: false },
		{ id: "2200000000000000004", author_id: "u3", text: "mattyp mattyp mattyp @mattypalmer", created_at: new Date("2026-11-23T10:00:00Z"), sources: ["summons"], dismissed: false },
	]);
	expect((await pg.query("select id, username, avatar_url from x_posts.x_users order by id")).rows).toEqual([
		{ id: "u1", username: "ada_now", avatar_url: null },
		{ id: "u2", username: "bo", avatar_url: "https://pbs.twimg.com/b.jpg" },
		{ id: "u3", username: "cy", avatar_url: null },
	]);
	expect((await pg.query("select reply_id::text, mention_id::text, via from x_posts.mention_replies")).rows).toEqual([{ reply_id: "2200000000000000009", mention_id: "2200000000000000002", via: "x" }]);
	expect((await pg.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'x_posts' order by 1")).rows.map((row) => row.table_name)).toEqual(["account", "mention_replies", "mention_sync", "mentions", "x_users"]);
});

test("a mentions run that finds nothing writes nothing until the heartbeat, and keeps since_id", async () => {
	await connectAs();
	const nothing = () => fakeOAuthX([empty, empty, empty]);
	const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
	const stamp = (minutes: number) => later(minutes).toISOString().replace(".000Z", "Z");
	const first = fakeOAuthX([() => Response.json({ data: [mention("2200000000000000002", "u1")], meta: { newest_id: "2200000000000000002" } }), () => Response.json({ data: [{ id: "u1", username: "ada", name: "Ada" }] }), empty, empty]);
	expect((await syncMentions(db, { fetcher: first.fetcher, creds: CREDS, now: NOW })).status).toBe("ok");
	const versions = async () => (await pg.query<{ xmin: string }>("select xmin::text from x_posts.mention_sync union all select xmin::text from x_posts.account order by 1")).rows.map((row) => row.xmin);
	const before = await versions();
	for (const minutes of [1, 2, RUN_HEARTBEAT_MINUTES - 1]) {
		const x = nothing();
		expect(await syncMentions(db, { fetcher: x.fetcher, creds: CREDS, now: later(minutes) })).toMatchObject({ status: "ok", mentions: 0 });
		expect(new URL(x.calls[0]?.url ?? "").searchParams.get("since_id")).toBe("2200000000000000002");
	}
	expect(await versions()).toEqual(before);

	const broken = fakeOAuthX([() => new Response("down", { status: 503 })]);
	expect(await syncMentions(db, { fetcher: broken.fetcher, creds: CREDS, now: later(RUN_HEARTBEAT_MINUTES) })).toMatchObject({ status: "error" });
	expect((await list()).sync.lastError).not.toBeNull();
	expect(await syncMentions(db, { fetcher: nothing().fetcher, creds: CREDS, now: later(RUN_HEARTBEAT_MINUTES + 1) })).toMatchObject({ status: "ok" });
	expect((await list()).sync).toMatchObject({ lastError: null, lastRunAt: stamp(RUN_HEARTBEAT_MINUTES + 1) });

	await syncMentions(db, { fetcher: nothing().fetcher, creds: CREDS, now: later(2 * RUN_HEARTBEAT_MINUTES + 1) });
	expect((await list()).sync.lastRunAt).toBe(stamp(RUN_HEARTBEAT_MINUTES + 1));
	await syncMentions(db, { fetcher: nothing().fetcher, creds: CREDS, now: later(2 * RUN_HEARTBEAT_MINUTES + 2) });
	expect((await list()).sync.lastRunAt).toBe(stamp(2 * RUN_HEARTBEAT_MINUTES + 2));
});

test("sync stops at the monthly cap before reading, and says so", async () => {
	await connectAs();
	const x = fakeOAuthX([]);
	expect(await syncMentions(db, { fetcher: x.fetcher, creds: CREDS, now: NOW, cap: 1000 })).toMatchObject({ status: "paused" });
	expect(x.calls).toEqual([]);
	expect((await list()).sync.paused).toBe("budget");
	expect((await syncMentions(db, { fetcher: x.fetcher, creds: CREDS, now: NOW })).status).toBe("paused");
	expect((await syncMentions(db, { fetcher: fakeOAuthX([tokenAnswer("access-2", "refresh-2"), empty, empty, empty]).fetcher, creds: CREDS, now: new Date("2026-12-01T00:01:00Z") })).status).toBe("ok");
});

test("Matt replies to a mention from here and dismisses another", async () => {
	await connectAs();
	await seedMention("2200000000000000001");
	await seedMention("2200000000000000002");
	const x = fakeOAuthX([() => Response.json({ data: { id: "2200000000000000010" } }, { status: 201 })]);
	const sent = await sendAs("/mentions/reply", x.fetcher, { method: "POST", body: { id: "2200000000000000001", text: " thanks " } });
	expect(sent.status).toBe(200);
	expect(x.calls[0]?.url).toBe("https://api.x.com/2/tweets");
	expect(x.calls[0]?.authorization).toBe("Bearer access-1");
	expect(JSON.parse(x.calls[0]?.body ?? "")).toEqual({ text: "thanks", reply: { in_reply_to_tweet_id: "2200000000000000001" } });
	expect((await sendAs("/mentions/dismiss", fakeOAuthX([]).fetcher, { method: "POST", body: { id: "2200000000000000002" } })).status).toBe(200);
	expect((await list()).mentions.map((item) => [item.id, item.reply?.text ?? null, item.url])).toEqual([["2200000000000000001", "thanks", "https://x.com/i/status/2200000000000000001"]]);
});
