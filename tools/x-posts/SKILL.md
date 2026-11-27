---
name: tool-x-posts
description: "The X posts tool at /x-posts. Matt's @mentions on X and every \"mattyp mattyp mattyp\" summons, in one list he can reply from. Use when changing tools/x-posts/, its mentions sync, its routes, or its tables."
---

# X posts

Every minute the cron reads two things into one list, with Matt's OAuth token: his @mentions, and X recent search for `"mattyp mattyp mattyp" -is:retweet` (any language: X can label a post that is only the phrase as another language, and search ignores case). A post found both ways is stored once. `/x-posts` shows the list, newest first, and every row opens its post on x.com in a new tab. No bot calls x-posts.

## Sync

- Mentions: `GET /2/users/:id/mentions` with `since_id` (one page of 100 on the first run, then up to 3 pages a run), without expansions.
- Summons: `GET /2/tweets/search/recent` with the query above and its own `summons_since_id`, paged the same way. Search reaches back 7 days, so when X refuses a stale `summons_since_id` (after a pause), the run clears it and the next run starts with one page. A summons that also @mentions Matt (a mention entity with his user id, or a reply to him) is stored as both.
- Authors not in `x_users` are looked up once with `GET /2/users?ids=` and kept, so an author costs one user read ever rather than one a day.
- The same run reads Matt's own new posts (`GET /2/users/:id/tweets` with `since_id`) and saves any that reply to a stored post to `mention_replies` with `via` `x`, which is the Replied state for replies he made on X.

A run writes `mention_sync` only for values that changed. When it finds nothing, it skips the write unless `last_error` changes or `last_run_at` is more than 15 minutes old (`RUN_HEARTBEAT_MINUTES`), so the view's "Checked" time can trail the real check by up to 15 minutes. The access token is read without a lock while it has more than the refresh margin left; only a refresh takes `select ... for update`.

Spend is counted in mills (thousandths of a dollar): 1 per mention and per own post (owned reads), 5 per summons (a search read), 10 per looked-up author. The hard cap is 20,000 mills ($20) a month for all of it. A page is only read if its worst case (100 posts and 100 new authors) still fits, so the month never goes over. At the cap, or when X answers with a usage cap, sync pauses until the 1st and the view says `Paused: budget` (or `X usage cap`). Sync stops while X isn't connected or `account.last_error` is set. An X error ends the run, is kept in `last_error`, and the next run tries again.

## Routes

Base `/api/tools/x-posts`. Only Matt's Access identity (or local dev) gets in; any bot gets 403 `Forbidden: bot <name> may not call <route> on x-posts`. Bad bodies get 400, unknown posts 404, and 503 `The x-posts database is unavailable; try again later`. Every response is `no-store`.

| Route | Does |
| --- | --- |
| `GET /x/connect` | Connect X. Redirects to X's consent page with PKCE (S256) and scopes `tweet.read tweet.write users.read offline.access`, and sets an HttpOnly `x_oauth` cookie scoped to the callback path holding the signed state and the verifier. 503 until `X_CLIENT_ID` and `X_CLIENT_SECRET` are set. |
| `GET /x/callback` | Stays behind Access: it loads in Matt's signed-in browser. Checks the state is signed, unexpired and equal to the cookie's, exchanges the code with the verifier, reads `/2/users/me`, saves the account, and redirects to `/x-posts`. |
| `GET /mentions` | `?limit` (default 100, at most 200). Posts not dismissed, newest first, as `{ mentions: [{ id, handle, name, avatarUrl, text, createdAt, url, reply, replyHere, summons }], sync: { lastRunAt, lastSuccessAt, lastError, paused, spentMills, capMills }, x }`. `replyHere` is false for a summons that doesn't @mention Matt. `paused` is `budget`, `capped` or null for this month. `x` is the connected account or null. |
| `POST /mentions/reply` | `{ id, text }`. Posts `text` (trimmed, 1 to 280 by X's weighted count) to X as a reply and records it in `mention_replies`. Returns `{ id, url, text, at }`. 409 `{ error, connect: true }` when X signed Matt out, 422 `{ error, onX: true }` for a post X won't take an API reply on, 502 with X's reason when X refuses. |
| `POST /mentions/dismiss` | `{ id }`. Hides the post from `GET /mentions`. |

## UI

`/x-posts` lists the posts, polled every 10 seconds while the tab is visible: the author's picture (or a blank circle), name, handle, a timestamp, the text, then an Open on X link and, on a summons, Summons. The timestamp and Open on X are plain links with `target="_blank" rel="noopener noreferrer"`, so the post opens at once in a new tab. Above the list: when it last checked and the month's spend against the cap.

The selected row holds its own reply box; the newest unreplied post is selected first. Cmd+Enter (Ctrl+Enter off a Mac) sends and moves to the next unreplied post with its box focused. Outside the box, j and k move, r or Enter focuses the box (Enter on a link or button does that link or button), d dismisses, and Esc leaves the box. Dismiss is also a quiet button on the selected row. A replied post shows Replied linking to the reply. Under 900px wide, tapping a row opens the post on X (its timestamp link stretched over the row, so iOS can hand it to the X app), and a quiet Reply opens the box in place. The box keeps a draft per post and shows X's weighted count against 280. On an error the draft stays, with X's reason and a Reply on X link that opens X's composer with the text filled in. A post without `replyHere` says Reply on X, and its box sends to X's composer. Before X is connected, the page shows Connect X.

## Replies

Matt replies as himself with an OAuth 2.0 user token from the existing X app ("x api project"), whose client is in the Worker secrets `X_CLIENT_ID` and `X_CLIENT_SECRET`. The app's callback URL must be `https://tools.mattpalmer.io/api/tools/x-posts/x/callback`, so previews can't connect. Tokens are sealed with a key derived by HKDF from `X_CLIENT_SECRET` (the activity tool's `secrets()`), so rotating the client secret means connecting again. The access token lasts 2 hours. A reply within 5 minutes of expiry refreshes it under `select ... for update` and saves X's rotated refresh token in the same transaction. A refused refresh or a 401 sets `account.last_error`, and every send then answers 409 until Matt connects again.

On self-serve API plans, X accepts API replies only to posts that mention or quote the account; others get a 403 whose reason the box shows, next to Reply on X. Likes, follows and quote posts were removed from every self-serve tier on 2026-04-20 (`POST /2/users/:id/likes` answers 403 whatever the scopes), so the view has no Like. `like.write` isn't requested: X refuses consent for it on a self-serve app.

## Tables

Schema `x_posts`. In use: `mentions` (one per post, `sources` is `{mention}`, `{summons}` or both, `dismissed_at`), `mention_replies` (one per reply Matt made, by `mention_id`; `via` is `tools` or `x`), `x_users` (authors looked up once: username, name, picture, only ever on `pbs.twimg.com`), `mention_sync` (one row: `since_id`, `summons_since_id`, `own_since_id`, the month's spend in mills, the pause), `account` (one row: Matt's X user, AES-GCM sealed tokens, expiry, `last_error`).

Left from the retired print queue, read by no code: `posts`, `jobs`, `replies`, `runs`, `sync_state`, `blocklist`.
