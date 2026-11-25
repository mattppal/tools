---
name: tool-x-posts
description: "The X posts tool at /x-posts. A log of X posts matching one query, screened, reviewed, capped, and queued for matty prints' receipt printer. Use when changing tools/x-posts/, its feed, review or print-queue routes, its screening rules, or its tables."
---

# X posts

Every 5 minutes, and every minute while posts are arriving, the cron reads X recent search for `"mattyp mattyp mattyp" -is:retweet` (any language: X can label a post that is only the phrase as another language (one was tagged Swedish), so `lang:en` dropped real summons; search ignores case), stores each post, and screens it. matty prints' review agent approves, rejects or overflows what passed the screen. Approved posts become print jobs, and a bridge on the Mac Mini claims each job, prints it on the receipt printer, and acks it. tools owns everything except the printing.

Two switches in `query.ts`: `LIVE_INGEST` (reads X with the Worker secret `X_BEARER_TOKEN`) and `QUEUE_OPEN`. The queue is open: Matt approved it on 2026-11-22 at 7:04pm PT. Posts still pending when it opened were skipped (`overflow`, reason `matched before the queue opened`, no summary; migration `0004-open-queue.sql`), so printing starts with posts matched after that. With `QUEUE_OPEN = false`, ingest and screening still run, `POST /decisions` and `POST /jobs/claim` answer 503, no jobs are built, and the sweep marks posts pending for 24 hours as overflow without summarizing them.

Bridge cutover: no bridge or review agent runs yet; matty prints' local printmc3 pipeline prints until Matt merges the printmc3 bridge PR. Matt chose on 2026-11-22 at 8:13pm PT: "Skip them (send to overflow) so only post-cutover matches print". At the cutover Matt presses Skip backlog on `/x-posts/queue` (or calls `POST /backlog/skip`). Every post still `pending` that was ingested before that moment becomes `overflow` with reason `matched before the bridge cutover`, `decided_by` `matt` and `summarized_at` set, so it never prints, not even in a summary. Posts matched after it stay pending for review. Landing code never runs the skip.

## Ingest

- One run every 5 minutes, or every minute when a post was ingested in the last 30 minutes (a run that stores a post schedules the next one a minute later), claimed atomically through `sync_state.next_run_at`. Up to 10 pages of 100 per run, paging `next_token` under `since_id`. The first page's `newest_id` is held as `pending_since_id`, and `since_id` moves to it only after the last page. A run that stops early keeps `next_token` and resumes it. X refusing a saved token or `since_id` resets it once.
- Budget: 12,000 reads a month (posts returned, metrics lookups included). At the budget, or when X answers 402 or a usage-cap 429, reading stops until the 1st and one liaison notice goes out. A rate-limit 429 waits for `x-rate-limit-reset`.
- Search expands each author (`expansions=author_id`, `user.fields=username,name,profile_image_url`) for the name, handle and profile picture. Since 2026-11-22 X bills each expanded author as a user read ($0.010, once per author per UTC day), which the budget above doesn't count.
- After catching up, metrics are refreshed for posts under 48 hours old at 6, 24 and 48 hours of age, up to 300 posts a run, within 80% of the budget. `metricsAt` says when.
- No success for 24 hours sends one liaison notice. Unauthorized, a bad request, or 3 failed runs in a row throw, and `worker/cron-alerts.ts` reports it.
- Posts deleted on X stay in the log. Raw text is kept indefinitely and shown only to Matt.

## Screening

`screen.ts`, deterministic, versioned by `SCREEN_VERSION`; a new version re-screens stored posts 500 a run. printmc3's `screen.py` is the floor: tools rejects on the union of both rule sets.

| Flag | Rejects | Means |
| --- | --- | --- |
| `injection` | yes | Steering phrases on normalized text, printmc3's injection list on raw and clean text, template tokens, invisible or direction-override characters on raw text, base64 runs. Also run on the display name. |
| `phone`, `email` | yes | tools' patterns or printmc3's, on raw text. Masked as `[phone]`, `[email]` in clean text. Workout numbers like "315 x 3", years and post ids don't match. |
| `blocked` | yes | A blocklist term as a word in the text or display name, or inside the handle after squashing to lowercase letters and digits. |
| `empty` | yes | Nothing printable, or only `[link]`. |
| `overlong` | yes | Clean text over 500 characters. |
| `addressed` | no | Speaks to matty prints, "print this", or `@grok`. The review agent applies printmc3's `AGENTS.md`. |
| `mentions`, `unprintable`, `encoded` | no | printmc3's hint flags: 5 or more `@`, clean text under half the raw length, a 40-character token. |

A rejected post's `reason` names the flags and, for the name or handle, the field. Clean text decodes entities, turns URLs into `[link]`, applies NFKC, strips invisibles, emoji and leading mentions, and is cut at 500.

## States

Post: `pending`, then `approved`, `rejected` or `overflow`; an approved post becomes `queued` in the same transaction (or `overflow` past a cap); then `printed`, `unconfirmed` or `failed` with its job. An overflow post becomes `summarized` when its summary job prints.

Job: `ready`, then `claimed`, then `printed`, `unconfirmed` or `failed`. A job gets 3 tries.

Ack outcomes:
- `printed` is final.
- `unconfirmed` is final and never retried. Only Matt's Print again on the Queue page sends it again, as a new job. It never blocks newer jobs.
- `failed` means nothing printed. The first two return the job to `ready` with `notBefore` 1 minute, then 5 minutes later; there is no third delay. The third `failed` is final and sends the liaison a notice (`data.for` `"liaison"`) that Matt needs to check the printer. Print again works on it too.
- A claim not acked by `claimExpiresAt` becomes `unconfirmed`.
- A stale `claimId`, or a different result for a claim already acked, gets 409. The same result again gets 200 with `changed: false`.

## Caps

Enforced in the `POST /decisions` transaction, never at claim. A posts job holds at most 10 posts. At most 150 posts go into jobs created per America/Los_Angeles day, counting every job created that day, failed, unconfirmed and Matt's requeues included, with no refunds. Approvals past either cap become `overflow` with reason `batch cap of 10` or `daily cap of 150`, come back in `capped`, and go into the next summary. They don't roll to tomorrow.

## Routes

Base `/api/tools/x-posts`. Bot routes check the bot with `requireBot`: Matt or any non-bot identity gets 401, another bot 403 `Forbidden: bot <name> may not call <route> on x-posts`. Bad parameters or bodies get 400, unknown jobs 404, conflicts 409, and 503 means try later. Every response is `no-store`.

Two 503s, told apart by `error`:
- Queue closed: `The print queue is closed`.
- Database down: `The x-posts database is unavailable; try again later`.

The bridge treats both as try later and doesn't ack because of them; a 503 is never a print outcome. After a 503 on claim it holds no job, so it prints nothing. After a 503 on an ack it already owes, it sends the same ack again before `claimExpiresAt`, which is safe because acks are idempotent.

| Route | Who | Does |
| --- | --- | --- |
| `GET /feed` | prints-review | Read-only log. `since=now` returns no posts and a cursor at the head; `since=start` starts at the first post; `since=<nextCursor>` continues. Or `from`, `to` (ISO, at most 31 days) and `cursor`. `limit` 1 to 200, default 50. Since mode omits the aggregates; window mode adds `window`, `total`, `counts`, `authors` (up to 500, `authorsTruncated`) and `top` (5, never `injection`). Delivery is at least once: dedupe on `id`. |
| `GET /review?limit=25&idsOnly=false` | prints-review | Pending posts, oldest first: `{ pendingTotal, posts: [{ id, handle, url, createdAt, flags, metrics, untrustedText }] }`, or ids with `idsOnly=true`. |
| `POST /decisions` | prints-review | `{ approve?: [id], reject?: [{ id, reason }], overflow?: [{ id, reason }] }`, reasons 1 to 200 characters, each id once. Returns id lists `{ approved, rejected, overflowed, capped, refused, unknownIds, notPending, jobs }`. `refused` lists approved ids the screen rejected (a rejecting flag); approving them does nothing. `notPending` holds posts already decided. Reasons are never printed and never go into a job. |
| `POST /jobs/claim` | prints-bridge | `{ bridge }`. 200 `{ claimId, claimExpiresAt, job }` for the oldest ready job whose `notBefore` has passed, or 204 with no body. One job is claimed at a time. Both carry `X-Pending-Total`. |
| `POST /jobs/ack` | prints-bridge | `{ jobId, claimId, result: printed\|failed\|unconfirmed, error? }`. Idempotent on (jobId, claimId): the same result again is 200 `changed: false`; a different result, a stale claim, or an ack after `claimExpiresAt` is 409. |
| `GET /posts?status=&before=&limit=` | Matt | Posts newest first with raw text. |
| `POST /check` | Matt | Check now: runs an ingest at once unless one ran in the last 30 seconds, X rate-limited or capped the last 15 minutes, or the month's budget is spent. 503 when ingest is off. |
| `GET /status` | Matt | Sync, reads, counts, today's cap, recent jobs, blocklist, screening counts (matched, auto-rejected per flag, addressed, would print). |
| `POST /decide` | Matt | Same body and rules as `/decisions`, logged as `matt`. |
| `POST /jobs/requeue` | Matt | `{ jobId }` of an `unconfirmed` or `failed` job, once. |
| `POST /backlog/skip` | Matt | `{ before }` (ISO time, not in the future). Overflows every pending post ingested before it, as above. Returns `{ before, skipped }`; running it again skips only posts still pending from before `before`. |
| `PUT /blocklist` | Matt | `{ terms }`. Replaces the list and re-screens pending posts. Bots can't read it. |
| `GET /x/connect` | Matt | Connect X. Redirects to X's consent page with PKCE (S256) and scopes `tweet.read tweet.write users.read offline.access`, and sets an HttpOnly `x_oauth` cookie scoped to the callback path holding the signed state and the verifier. 503 until `X_CLIENT_ID` and `X_CLIENT_SECRET` are set. |
| `GET /x/callback` | Matt | Stays behind Access: it loads in Matt's signed-in browser. Checks the state is signed, unexpired and equal to the cookie's, exchanges the code with the verifier, reads `/2/users/me`, saves the account, and redirects to `/x-posts`. |
| `POST /reply` | Matt | `{ id, text }`. Posts `text` (trimmed, 1 to 280 by X's weighted count) to X as a reply to post `id` and records it in `replies`. Returns `{ id, url, text, at }`. 409 `{ error, connect: true }` when X signed Matt out, 502 with X's reason when X refuses, 404 for an unknown post. |
| `GET /mentions` | Matt | `?limit` (default 100, at most 200). Mentions not dismissed, newest first, as `{ mentions: [{ id, handle, name, avatarUrl, text, createdAt, url, reply, replyHere }], sync: { lastRunAt, lastSuccessAt, lastError, paused, spentMills, capMills } }`. `paused` is `budget`, `capped` or null for this month. |
| `POST /mentions/reply` | Matt | `{ id, text }`. Like `POST /reply`, for a mention; records it in `mention_replies`. |
| `POST /mentions/dismiss` | Matt | `{ id }`. Hides the mention from `GET /mentions`. |


Page routes, these three included, answer only Matt's Access identity (or local dev). Any bot gets 403.

A job is `{ jobId, kind: "posts" | "summary", createdAt, posts: [{ id, handle, name, createdAt, text, url }], summary }`. `text` is the stored clean text. A summary job has `posts: []` and `summary: { count, from, to, handles, moreHandles }`: overflow posts' handles that pass printmc3#4's checks, deduped case-insensitively, at most 50.

Writes record their actor: `decided_by` (`screen`, `prints-review`, `matt`, `caps`, `sweep`), and a job's `claimed_by` and `acked_by`, plus a log line per write.

## Bridge rules (printmc3 side)

- Send `failed` only when nothing reached the printer. If unsure whether paper came out, ack `unconfirmed`, never `failed`.
- Before each claim, check that `192.168.0.97:9100` accepts a TCP connection; don't claim while the printer is offline.
- Ack before `claimExpiresAt` (10 minutes). After it the job is `unconfirmed` and the ack gets 409.
- Fire the review automation from `X-Pending-Total`, once per change: when it goes from 0 to more than 0, or grows since the last trigger, at most once per 15 minutes.
- printmc3's `to_printable` and encode guards stay on as a second floor.

## UI

The sections are Receipts, Mentions and Queue. `/x-posts` is Receipts, the live view: matched posts newest first as plain rows (the author's X profile picture when the search returned one, otherwise a blank circle; name, handle, a timestamp that opens the post on X; the text; then a status other than pending, flags and reason), polled every 10 seconds while the tab is visible; the last ingest error shows above the list when there is one. `/x-posts/queue/review` lists posts as Pending, Rejected or All in the same rows, with Approve and Reject on pending posts while the queue is open. On both, the reply pane sits in the right column with the selected post's handle, Copy link and text; the newest post without a reply is selected first, and clicking a row, or Enter on it, selects it and focuses the box. A post Matt already replied to, here or directly on X, shows a quiet Replied at the end of its first line, linking to his reply. Under 900px wide, tapping a row opens the post on X (its timestamp link stretched over the row, so iOS can hand it to the X app), and a quiet Reply on the first line of a row without a reply opens the box inside that row, focused in the same tap so the keyboard comes up. The box keeps a draft per post and shows X's weighted count against 280. Reply or Cmd+Enter (Ctrl+Enter off a Mac) sends; the text shows as Sending until X answers, then the reply's link. On an error the draft stays, with X's reason and a Reply on X link that opens X's composer with the text filled in. X only accepts replies from the API on posts that @mention Matt (a mention entity with his user id, or a reply to him). Ingest stores those user ids in `posts.addressed`, and older rows fall back to an `@username` match in the text. A post that doesn't qualify says Reply on X on its row, and its box sends to X's reply composer with the draft filled in. `POST /reply` refuses such a post with 422 `{ error, onX: true }` before calling X, and maps X's own "mentioned" 403 to the same answer. Before X is connected, the pane shows Connect X. Queue holds the owner tools behind a quiet Jobs, Review, Blocklist row. `/x-posts/queue` shows today's prints against the cap, Skip backlog while posts wait for review (two steps; the cutover time is fixed at the first click), jobs with Print again on terminal ones, and a collapsed Details list (ingest, print queue, last check, reads this month, the connected X account). `/x-posts/queue/blocklist` edits the list. The old `/x-posts/posts` and `/x-posts/blocklist` paths still open Review and Blocklist.

## Tables

Schema `x_posts`: `posts` (one row per X post, `seq` is the feed cursor), `jobs` (payload, state, claim, ack, actor columns), `blocklist`, `sync_state` (one row), `runs` (one per ingest run), `account` (one row: Matt's X user, AES-GCM sealed tokens, expiry, `last_error`), `replies` (one per reply Matt made, by `post_id`; `via` is `tools` for replies sent here and `x` for ones found on X). `posts.reply_checked_at` is when the reply check last searched for the post. `posts.addressed` holds the user ids a post mentions or replies to (null before it was stored). `posts.avatar_url` is the author's profile picture from the search response, only ever on `pbs.twimg.com`. `posts.sources` names where a post came from, `{summons}` today. Mentions live apart from posts so they never reach the print queue or the bots: `mentions` (one per post that @mentions Matt, `dismissed_at`), `mention_replies` (like `replies`, by `mention_id`), `x_users` (authors looked up once: username, name, picture), `mention_sync` (one row: `since_id`, `own_since_id`, the month's spend in mills, the pause).

## Mentions

The cron reads Matt's @mentions every minute with his OAuth token: `GET /2/users/:id/mentions` with `since_id` (one page of 100 on the first run, then up to 3 pages a run), without expansions. Authors not in `x_users` are looked up once with `GET /2/users?ids=` and kept, so an author costs one user read ever rather than one a day. The same run reads Matt's own new posts (`GET /2/users/:id/tweets` with `since_id`) and saves any that reply to a stored mention to `mention_replies` with `via` `x`, which is the Replied state for replies he made on X.

A run writes `mention_sync` only for values that changed. When it finds nothing, it skips the write unless `last_error` changes or `last_run_at` is more than 15 minutes old (`RUN_HEARTBEAT_MINUTES`), so the view's "Checked" time can trail the real check by up to 15 minutes. The access token is read without a lock while it has more than the refresh margin left; only a refresh takes `select ... for update`.

Spend is counted in mills (thousandths of a dollar): 1 per mention and per own post (owned reads), 10 per looked-up author. The hard cap is 20,000 mills ($20) a month. A page is only read if its worst case (100 mentions and 100 new authors, 1,100 mills) still fits, so the month never goes over. At the cap, or when X answers with a usage cap, mentions pause until the 1st and the view says `Paused: budget` (or `X usage cap`). Mentions stop while X isn't connected or `account.last_error` is set.

`/x-posts/mentions` lists them newest first, polled every 10 seconds. The selected row holds its own reply box; the newest unreplied mention is selected first. Cmd+Enter (Ctrl+Enter off a Mac) sends and moves to the next unreplied mention with its box focused. Outside the box, j and k move, r or Enter focuses the box, d dismisses, and Esc leaves the box. Dismiss is also a quiet button on the selected row. A replied mention shows Replied linking to the reply. Under 900px wide, tapping a row opens the post on X and a quiet Reply opens the box in place, as in the live view.

## Replies

Matt replies as himself with an OAuth 2.0 user token from the existing X app ("x api project"), whose client is in the Worker secrets `X_CLIENT_ID` and `X_CLIENT_SECRET`. The app's callback URL must be `https://tools.mattpalmer.io/api/tools/x-posts/x/callback`, so previews can't connect. Tokens are sealed with a key derived by HKDF from `X_CLIENT_SECRET` (the activity tool's `secrets()`), so rotating the client secret means connecting again. The access token lasts 2 hours. A reply within 5 minutes of expiry refreshes it under `select ... for update` and saves X's rotated refresh token in the same transaction. A refused refresh or a 401 sets `account.last_error`, and every send then answers 409 until Matt connects again.

On self-serve API plans, X accepts API replies only to posts that mention or quote the account; others get a 403 whose reason the box shows, next to Reply on X. Likes, follows and quote posts were removed from every self-serve tier on 2026-04-20 (`POST /2/users/:id/likes` answers 403 whatever the scopes), so the view has no Like. `like.write` isn't requested: X refuses consent for it on a self-serve app.

## Reply checks

The cron also looks for replies Matt made directly on X, with his OAuth token (`tweet.read`, already granted) and X recent search: `from:<his username> (in_reply_to_tweet_id:<id> OR ...)`, as many ids as fit X's 512-character query (11), `start_time` at the oldest of them, up to 3 searches a run. A found reply is saved to `replies` with `via` `x`, so the post counts as replied wherever a tools reply would. It checks posts under 7 days old (recent search's reach) with no reply yet: every 5 minutes for a day, then hourly. Posts returned count toward the monthly read budget, and checks stop at 80% of it, at a usage cap, before X is connected, and while `account.last_error` is set. An X error ends that run's checks and is logged; it never sets `last_error`. Replies to posts older than 7 days when first checked aren't found.
