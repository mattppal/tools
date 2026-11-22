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

Job: `ready`, then `claimed`, then `printed`, `unconfirmed` or `failed`. A `failed` ack before the third returns the job to `ready` with `notBefore` 1, then 5 minutes later. The third `failed` is terminal and sends the liaison a notice that Matt needs to check the printer. `unconfirmed` is terminal and never blocks newer jobs. Only Matt can send a terminal job again, from the Queue page, which makes a new job.

## Caps

Enforced in the `POST /decisions` transaction, never at claim. A posts job holds at most 10 posts. At most 150 posts go into jobs created per America/Los_Angeles day, counting every job created that day, failed, unconfirmed and Matt's requeues included, with no refunds. Approvals past either cap become `overflow` with reason `batch cap of 10` or `daily cap of 150`, come back in `capped`, and go into the next summary. They don't roll to tomorrow.

## Routes

Base `/api/tools/x-posts`. Bot routes check the bot with `requireBot`: Matt or any non-bot identity gets 401, another bot 403 `Forbidden: bot <name> may not call <route> on x-posts`. Bad parameters or bodies get 400, unknown jobs 404, conflicts 409, and the closed queue 503. Every response is `no-store`.

| Route | Who | Does |
| --- | --- | --- |
| `GET /feed` | prints-review | Read-only log. `since=now` returns no posts and a cursor at the head; `since=start` starts at the first post; `since=<nextCursor>` continues. Or `from`, `to` (ISO, at most 31 days) and `cursor`. `limit` 1 to 200, default 50. Since mode omits the aggregates; window mode adds `window`, `total`, `counts`, `authors` (up to 500, `authorsTruncated`) and `top` (5, never `injection`). Delivery is at least once: dedupe on `id`. |
| `GET /review?limit=25&idsOnly=false` | prints-review | Pending posts, oldest first: `{ pendingTotal, posts: [{ id, handle, url, createdAt, flags, metrics, untrustedText }] }`, or ids with `idsOnly=true`. |
| `POST /decisions` | prints-review | `{ approve?: [id], reject?: [{ id, reason }], overflow?: [{ id, reason }] }`, reasons 1 to 200 characters, each id once. Returns id lists `{ approved, rejected, overflowed, capped, refused, unknownIds, notPending, jobs }`. `refused` holds approvals of posts with a rejecting flag; `notPending` holds posts already decided. Reasons are never printed and never go into a job. |
| `POST /jobs/claim` | prints-bridge | `{ bridge }`. 200 `{ claimId, claimExpiresAt, job }` for the oldest ready job whose `notBefore` has passed, or 204 with no body. One job is claimed at a time. Both carry `X-Pending-Total`. |
| `POST /jobs/ack` | prints-bridge | `{ jobId, claimId, result: printed\|failed\|unconfirmed, error? }`. Idempotent on (jobId, claimId): the same result again is 200 `changed: false`; a different result, a stale claim, or an ack after `claimExpiresAt` is 409. |
| `GET /posts?status=&before=&limit=` | Matt | Posts newest first with raw text. |
| `POST /check` | Matt | Check now: runs an ingest at once unless one ran in the last 30 seconds, X rate-limited or capped the last 15 minutes, or the month's budget is spent. 503 when ingest is off. |
| `GET /status` | Matt | Sync, reads, counts, today's cap, recent jobs, blocklist, shadow counts. |
| `POST /decide` | Matt | Same body and rules as `/decisions`, logged as `matt`. |
| `POST /jobs/requeue` | Matt | `{ jobId }` of an `unconfirmed` or `failed` job, once. |
| `PUT /blocklist` | Matt | `{ terms }`. Replaces the list and re-screens pending posts. Bots can't read it. |

A job is `{ jobId, kind: "posts" | "summary", createdAt, posts: [{ id, handle, name, createdAt, text, url }], summary }`. `text` is the stored clean text. A summary job has `posts: []` and `summary: { count, from, to, handles, moreHandles }`: overflow posts' handles that pass printmc3#4's checks, deduped case-insensitively, at most 50.

Writes record their actor: `decided_by` (`screen`, `prints-review`, `matt`, `caps`, `sweep`), and a job's `claimed_by` and `acked_by`, plus a log line per write.

## Bridge rules (printmc3 side)

- Send `failed` only when nothing reached the printer. A bridge that isn't sure sends `unconfirmed`, never `failed`.
- Before each claim, check that `192.168.0.97:9100` accepts a TCP connection; don't claim while the printer is offline.
- Ack before `claimExpiresAt` (10 minutes). After it the job is `unconfirmed` and the ack gets 409.
- Fire the review automation from `X-Pending-Total`, once per change: when it goes from 0 to more than 0, or grows since the last trigger, at most once per 15 minutes.
- printmc3's `to_printable` and encode guards stay on as a second floor.

## UI

`/x-posts` is the live view: matched posts newest first with name, handle, time, raw text, metrics, status, flags, a timestamp that opens the post on X and Copy link, polled every 10 seconds while the tab is visible, with Check now. `/x-posts/posts` lists posts by status, with the same timestamp link and Copy link, with raw text, the clean text when it differs, flags and reasons as words, and Approve and Reject on pending posts while the queue is open. `/x-posts/queue` lists jobs with Print again on terminal ones. `/x-posts/blocklist` edits the list. The Details panel holds sync, budget, cap and shadow counts.

## Tables

Schema `x_posts`: `posts` (one row per X post, `seq` is the feed cursor), `jobs` (payload, state, claim, ack, actor columns), `blocklist`, `sync_state` (one row), `runs` (one per ingest run).
