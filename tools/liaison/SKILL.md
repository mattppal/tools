---
name: tool-liaison
description: "The outbox to the tools liaison bot, the single bot channel. Every webhook event (nutrition day.closed, workouts session.finished, coordinator notices) goes to LIAISON_WEBHOOK_URL in one envelope with one delivery header, and the liaison relays it to nutrition bot, coach, fog or tinkabot. Covers the envelope, notices and their threading, POST /api/tools/liaison/notices, bun run notify, and the dual path to the old per-bot webhooks. Use when changing tools/liaison/, sending a notice to a bot, or changing what any tool sends to a bot."
---

# Liaison

tools talks to Matt's bots through one bot, the tools liaison. Every outbound event goes to the liaison's Grok Bot routine. The liaison dedupes on `deliveryId`, routes by `app` and `event` (and by `data.for` for notices), and marks test relays as tests. No page; `tool.ts` is hidden and the backlog shows under Liaison on `/settings`.

## Delivery

`webhook.ts` registers `liaison.deliveries` with `defineWebhook`, so `worker/webhooks.ts` sends it with the same claim, fence and retry as every webhook.

- `POST <LIAISON_WEBHOOK_URL>` with `Authorization: Bearer <LIAISON_WEBHOOK_KEY>`, `X-Tools-Delivery: <deliveryId>` and `content-type: application/json`.
- The first attempt runs in the request; the every-minute cron retries after 1, 2, 4, 8, 16 and 32 minutes, then hourly, until a 2xx. The `deliveryId` never changes across retries or **Send again**.
- Matt holds both secrets in the 1Password item `tools-liaison-webhook` (fields `url`, `key`) and sets them in the Cloudflare dashboard. No agent reads them. While either is unset, rows wait.
- The liaison answers 2xx on receipt, before it relays. If a relay fails it retries once and alerts Matt, but tools has already stopped retrying.

## Envelope

```json
{ "app": "nutrition" | "workouts" | "tools", "event": "day.closed" | "session.finished" | "notice", "deliveryId": "<uuid>", "test": true, "data": {} }
```

`test: true` is present only on test deliveries. `queueForLiaison` writes the row with the envelope as `payload`, in the same transaction as the event. `payload` is jsonb, which reorders keys, so `liaisonWire` rebuilds this key order on every send and moves `data.body` last. The liaison's receiver keeps only the first 4,000 characters of a request body. Notices over that are refused, and `day.closed` and `session.finished` carry a bounded summary plus `full`, a `GET` route the bot already has for the whole record (`events.ts`).

| `app` / `event` | Relayed to | `data` |
| --- | --- | --- |
| `nutrition` / `day.closed` | nutrition bot | `date, closedAt, estimated, entries, totals, targets, progress, full`. `entries` is a count. `totals` is always present. `targets` and `progress` are null when no plan covers the day. `full` is `{ method: "GET", path: "/api/tools/nutrition/day?date=<date>" }`. |
| `workouts` / `session.finished` | coach | `sessionId, day, date, name, kind, blockId, weekId, dayId, exercises, sets, full`. See below. A test session's name starts with `TEST`. |
| `tools` / `notice` | `data.for` | See below. |

`session.finished` fields:

| Field | Meaning |
| --- | --- |
| `sessionId` | The session's UUID. The only id to key on. |
| `day` | The session's date, `YYYY-MM-DD`, like `day.closed`'s `date`. |
| `date` | The log's `date`: an ISO datetime with offset, Pacific midnight, e.g. `2026-11-23T00:00:00-08:00`. |
| `name`, `kind`, `blockId`, `weekId`, `dayId` | Copied from the log. |
| `exercises` | `{ total, completed, skipped }`. |
| `sets` | Working sets on completed exercises. A skipped exercise's 0-rep set isn't counted. |
| `full` | `{ method: "GET", path: "/api/tools/workouts/sessions/<sessionId>" }`. |

Text fields (`date`, `name`, `kind`, `blockId`, `weekId`, `dayId`) are clipped by characters (Unicode code points) to 80, and a clipped value ends in `…`. Never use a clipped value as an id. Take ids from `full`.

## Fetching `full`

- Call `https://tools.mattpalmer.io` + `full.path` with `full.method` (always `GET`), the bot's usual Access headers (`CF-Access-Client-Id`, `CF-Access-Client-Secret`) and an explicit `User-Agent`.
- `full` is for the bot that owns the record: nutrition bot for `GET /day`, coach for `GET /sessions/<id>`. Deny-by-default scopes (`BOTS` in `worker/access.ts`) give any other bot a 403 `Forbidden: bot <name> may not call <route> on <tool>`. The liaison has no `BOTS` entry, so it gets the allowlist 403 and can't fetch `full`. The `smoke` identity (tools-agent-verify) can also read both, for deploy checks.
- `full` returns the live record, not a snapshot of what fired.
  - `GET /api/tools/nutrition/day?date=<date>`: always 200 with the day view, which includes `closedAt`. A day can be reopened, edited and closed again; a new close sends a new `day.closed` with a new `deliveryId` and `closedAt`. Compare the fetched `closedAt` with the event's. They match when the day is unchanged since this close. `null` means the day is open again, or was deleted (a deleted or never-used day returns `closed: false`, `closedAt: null`, `entries: []`). A later value means a newer close, which has its own event. A malformed date gets 409 `{ "error": "Use a date like 2026-11-22" }`.
  - `GET /api/tools/workouts/sessions/<sessionId>`: a finished session returns 200 `{ session, log }`, where `log` is the openweight WorkoutLog the direct webhook sends. A finished session can't be edited (set, note and exercise changes get 409 `{ "error": "This session is finished" }`), so `log` matches what fired. An open session returns 200 `{ session }` with `session.status: "open"` and no `log`. A deleted or unknown session gets 404 `{ "error": "Session not found" }` (finished test sessions can be deleted). A path that isn't a UUID gets 404 `{ "error": "Not found" }`.
- Whenever `data.log` is missing from a `session.finished`, the receiver GETs `full` before logging, and never logs from the summary.

## Dual path until phase 2

`day.closed` and `session.finished` still go straight to nutrition bot and coach through `tools/nutrition/webhook.ts` and `tools/workouts/webhook.ts`, unchanged, because the liaison can't retry onward. Both rows share one `deliveryId`, so the two copies can be matched. Receivers dedupe per channel: only the direct copy (`X-Workouts-Delivery` for coach, `X-Nutrition-Delivery` for nutrition bot) marks a `deliveryId` as processed. A relayed copy (`X-Tools-Delivery`) is informational and never marks it. tools always sends the direct copy and the liaison copy; whether the liaison relays a copy onward is the liaison's choice (today it doesn't relay `session.finished` to coach). Phase 2 changes the direct hooks and needs its own contract review. **Send again** requeues both, and deleting a test session deletes both. Phase 2 (`docs/webhook-simplification.md` in the Project store) would remove the direct path after 7 clean days.

## Notices

The coordinator's messages to bots. `data`:

| Field | Value |
| --- | --- |
| `for` | `liaison` (for the liaison only; not relayed), `nutrition`, `coach`, `fog`, `tinkabot` or `all` (relayed to every bot) |
| `label` | liaison, nutrition, fog, tinkabot, all: `action needed`, `FYI`, `nothing`. coach: `no action`, `please confirm`. |
| `confirm` | Only with coach's `please confirm`: what coach should confirm. |
| `line` | Ready to relay: `nutrition bot: action needed`, `coach: please confirm <confirm>`, `all bots: FYI`. |
| `subject` | Up to 200 characters. Starts with `TEST` exactly when the delivery is a test; a test subject gets the prefix added. |
| `body` | Markdown. The whole envelope as sent must fit in 4,000 characters, or the notice is refused with a 413 that says how much to cut. Send longer material as notices that reply to the first one (`replyTo`). |
| `refs` | Up to 20 https URLs. |
| `threadId`, `replyTo` | A notice's id is its `deliveryId`. `replyTo` names an earlier notice, and `threadId` is the first notice of that thread. |
| `createdAt` | When the coordinator created it. Unchanged on retries. |

## API

Both routes need the `tools-coordinator` Access service token (bot `coordinator` in `BOTS`, `worker/access.ts`), whose scopes are exactly these two routes. Another bot gets a 403, and a caller with no bot identity gets a 401. Until the bearer-removal PR, `Authorization: Bearer <BOT_TOKEN_COORDINATOR>` also works.

| Route | Does |
| --- | --- |
| `POST /api/tools/liaison/notices` | `{ for, label, confirm?, subject, body, refs?, replyTo?, test?, noticeId? }`. Queues the notice, tries it once, and returns its delivery state and the exact body sent: 201 new, 200 when `noticeId` was already sent with the same content (nothing is resent), 409 for the same id with other content, 404 for an unknown `replyTo`, 413 for a notice over 4,000 characters as sent, 400 for a bad label or a real subject starting with `TEST`. |
| `GET /api/tools/liaison/deliveries?app=&thread=` | The latest 50 liaison deliveries, newest first, with attempts, last status and the body sent. |

`bun run notify [<for>] <label> --subject <text> [--confirm <text>] [--ref <url>]... [--reply-to <id>] [--test] [--body-file <path>]` sends one, with the body from stdin when there's no `--body-file`. Without `<for>` it goes to the liaison alone; use `all` only for something every bot should read. It generates the `noticeId` once and retries 5xx and network errors under it, so a retry never sends twice. `bun run notify --list [--app tools] [--thread <id>]` lists deliveries. Both send only the `tools-coordinator` Access headers, from `TOOLS_COORDINATOR_CLIENT_ID` and `TOOLS_COORDINATOR_CLIENT_SECRET`. When those are unset, `--mint` rotates that token's secret through the Cloudflare API (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) and uses it in this process only. Access takes a few seconds to accept a new secret, so with a minted secret a 302 is retried every 2 seconds for up to 30. It never prints the secret and needs no Worker secret or deploy. Cloudflare keeps only the previous secret valid, for one hour, so a third `--mint` within that hour cuts off the oldest run's secret and leaves any stored copy stale. `TOOLS_URL` defaults to production. `--dry-run` prints the notice without sending.

## Data

Schema `liaison`, table `deliveries`: the shared delivery columns plus `app`, `event`, `ref` (the date, session id, or a notice's thread) and `payload`, the envelope as sent.

## Tests

The Worker also sends notices itself. When a webhook retry run or a tool's `cron.ts` throws, `worker/cron-alerts.ts` queues `{ for: "liaison", label: "action needed", subject: "tools: <source> is failing" }`. The `noticeId` is derived from the source and the UTC hour, so each failing source gets at most one notice an hour. Later failures in that hour only reach the Worker logs.

`bun test ./tools/liaison` covers the 4,000-character bound for every event (`events.test.ts`, worst-case inputs, exhaustive over `LiaisonEvent`), auth, the envelope, labels and lines, test subjects, threading, `noticeId` retries, and a cron retry. `tools/nutrition/store.test.ts` and `tools/workouts/workouts.test.ts` check that each event reaches both paths under one `deliveryId`.

## Live tests

Send test events with `test: true` and a `TEST` subject or name: close day 2099-01-01 with `{ test: true }`, finish a test workout session, and `bun run notify all nothing --subject "channel check" --body-file <file> --test`. Read the status from `GET /deliveries`, then delete the test session with `DELETE /sessions/:id` and the test day's rows.
