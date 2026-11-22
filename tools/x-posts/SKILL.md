---
name: tool-x-posts
description: "The X posts tool at /x-posts. A log of X posts matching one query, screened, reviewed, capped, and queued for matty prints' receipt printer. Use when changing tools/x-posts/, its feed, review or print-queue routes, its screening rules, or its tables."
---

# X posts

Every 5 minutes, and every minute while posts are arriving, the cron reads X recent search for `"mattyp mattyp mattyp" -is:retweet` (any language: X can label a post that is only the phrase as another language (one was tagged Swedish), so `lang:en` dropped real summons; search ignores case), stores each post, and screens it. matty prints' review agent approves, rejects or overflows what passed the screen. Approved posts become print jobs, and a bridge on the Mac Mini claims each job, prints it on the receipt printer, and acks it. tools owns everything except the printing.

Two switches in `query.ts`: `LIVE_INGEST` (reads X with the Worker secret `X_BEARER_TOKEN`) and `QUEUE_OPEN`. While the queue is closed (shadow mode), ingest and screening run, `POST /decisions` and `POST /jobs/claim` answer 503, no jobs are built, and the sweep marks posts pending for 24 hours as overflow without summarizing them. Open the queue only after Matt OKs the shadow numbers.

## Ingest

- One run every 5 minutes, or every minute when a post was ingested in the last 30 minutes (a run that stores a post schedules the next one a minute later), claimed atomically through `sync_state.next_run_at`. Up to 10 pages of 100 per run, paging `next_token` under `since_id`. The first page's `newest_id` is held as `pending_since_id`, and `since_id` moves to it only after the last page. A run that stops early keeps `next_token` and resumes it. X refusing a saved token or `since_id` resets it once.
- Budget: 12,000 reads a month (posts returned, metrics lookups included). At the budget, or when X answers 402 or a usage-cap 429, reading stops until the 1st and one liaison notice goes out. A rate-limit 429 waits for `x-rate-limit-reset`.
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
- Queue closed: `The print queue is closed while x-posts runs in shadow mode`.
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
| `GET /status` | Matt | Sync, reads, counts, today's cap, recent jobs, blocklist, shadow counts. |
| `POST /decide` | Matt | Same body and rules as `/decisions`, logged as `matt`. |
| `POST /jobs/requeue` | Matt | `{ jobId }` of an `unconfirmed` or `failed` job, once. |
| `PUT /blocklist` | Matt | `{ terms }`. Replaces the list and re-screens pending posts. Bots can't read it. |
| `GET /x/connect` | Matt | Connect X. Redirects to X's consent page with PKCE (S256) and scopes `tweet.read tweet.write users.read offline.access`, and sets an HttpOnly `x_oauth` cookie scoped to the callback path holding the signed state and the verifier. 503 until `X_CLIENT_ID` and `X_CLIENT_SECRET` are set. |
| `GET /x/callback` | Matt | Stays behind Access: it loads in Matt's signed-in browser. Checks the state is signed, unexpired and equal to the cookie's, exchanges the code with the verifier, reads `/2/users/me`, saves the account, and redirects to `/x-posts`. |
| `POST /reply` | Matt | `{ id, text }`. Posts `text` (trimmed, 1 to 280 by X's weighted count) to X as a reply to post `id` and records it in `replies`. Returns `{ id, url, text, at }`. 409 `{ error, connect: true }` when X signed Matt out, 502 with X's reason when X refuses, 404 for an unknown post. |

| `POST /repost` | Matt | `{ id, on }`. Reposts (`POST /2/users/:id/retweets`) or undoes it (`DELETE /2/users/:id/retweets/:post`) as Matt, and records it in `reposts`. Returns `{ id, reposted }`. Errors as `/reply`. |

Page routes, these four included, answer only Matt's Access identity (or local dev). Any bot gets 403.

A job is `{ jobId, kind: "posts" | "summary", createdAt, posts: [{ id, handle, name, createdAt, text, url }], summary }`. `text` is the stored clean text. A summary job has `posts: []` and `summary: { count, from, to, handles, moreHandles }`: overflow posts' handles that pass printmc3#4's checks, deduped case-insensitively, at most 50.

Writes record their actor: `decided_by` (`screen`, `prints-review`, `matt`, `caps`, `sweep`), and a job's `claimed_by` and `acked_by`, plus a log line per write.

## Bridge rules (printmc3 side)

- Send `failed` only when nothing reached the printer. If unsure whether paper came out, ack `unconfirmed`, never `failed`.
- Before each claim, check that `192.168.0.97:9100` accepts a TCP connection; don't claim while the printer is offline.
- Ack before `claimExpiresAt` (10 minutes). After it the job is `unconfirmed` and the ack gets 409.
- Fire the review automation from `X-Pending-Total`, once per change: when it goes from 0 to more than 0, or grows since the last trigger, at most once per 15 minutes.
- printmc3's `to_printable` and encode guards stay on as a second floor.

## UI

`/x-posts` is the live view: matched posts newest first, each drawn as it looks on X, then the clean text when it differs, status, flags and Copy link, polled every 10 seconds while the tab is visible, with Check now. Clicking a card opens the post on X. `/x-posts/posts` lists posts by status with the same cards and Copy link, and Approve and Reject on pending posts while the queue is open. Every post on both lists has a reply box once X is connected: the weighted character count against 280, a Reply button (send is click-only), the text shown as Sending until X answers, then the reply's link; on an error the draft stays, with X's reason and a Reply on X link that opens X's composer with the text filled in. Above the box sit a Repost toggle (flips at once, flips back with X's reason on failure) and a Like on X link. Before X is connected, a Connect X line sits above the list. `/x-posts/queue` lists jobs with Print again on terminal ones. `/x-posts/blocklist` edits the list. The Details panel holds sync, budget, cap and shadow counts.

`card.tsx` draws each card in the browser with xeet (`@xeet/core`) from the stored row: raw text, name, handle, time and metrics. It reads nothing more from X, so it costs no reads. Avatars are X's default picture, and media and link cards aren't drawn because they aren't stored. `scripts/xeet-vite.ts` serves xeet's WebAssembly and font packs as hashed assets, which the service worker caches after first use. A pack is fetched only when a post needs it. The CJK pack is over the 25 MiB asset limit, so a post that needs it, or any card that fails to draw, shows as text with a timestamp link instead. The page CSP allows `'wasm-unsafe-eval'` for this.

## Tables

Schema `x_posts`: `posts` (one row per X post, `seq` is the feed cursor), `jobs` (payload, state, claim, ack, actor columns), `blocklist`, `sync_state` (one row), `runs` (one per ingest run), `account` (one row: Matt's X user, AES-GCM sealed tokens, expiry, `last_error`), `replies` (one per reply Matt sent, by `post_id`), `reposts` (one per post Matt reposted). `posts.sources` names where a post came from, `{summons}` today, so other sources such as mentions add rows without a new table.

## Replies

Matt replies as himself with an OAuth 2.0 user token from the existing X app ("x api project"), whose client is in the Worker secrets `X_CLIENT_ID` and `X_CLIENT_SECRET`. The app's callback URL must be `https://tools.mattpalmer.io/api/tools/x-posts/x/callback`, so previews can't connect. Tokens are sealed with a key derived by HKDF from `X_CLIENT_SECRET` (the activity tool's `secrets()`), so rotating the client secret means connecting again. The access token lasts 2 hours. A reply within 5 minutes of expiry refreshes it under `select ... for update` and saves X's rotated refresh token in the same transaction. A refused refresh or a 401 sets `account.last_error`, and every send then answers 409 until Matt connects again.

On self-serve API plans, X accepts API replies only to posts that mention or quote the account; others get a 403 whose reason the box shows, next to Reply on X. Likes, follows and quote posts were removed from every self-serve tier on 2026-04-20 (`POST /2/users/:id/likes` answers 403 whatever the scopes), so Like opens X's like intent instead of calling the API. `like.write` isn't requested: X refuses consent for it on a self-serve app. Reposts still work on self-serve.
