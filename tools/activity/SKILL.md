---
name: tool-activity
description: "The Activity tool at /activity. Daily steps, active calories, and distance pulled from Withings into activity.days, which nutrition reads for steps and TDEE. Covers the Withings OAuth connect and callback routes, token storage, the sync cron, and the backfill. Use when changing tools/activity/ or anything that reads daily activity."
---

# Activity

One row per day of steps, active kcal, total kcal, and distance. Withings is the only writer today. Nutrition reads the same table, so food, weight, and activity line up per day.

## UI

`/activity` lists the last 90 days, newest first: date and miles on the left, steps and active kcal on the right. A muted line above the list says where the data comes from, or the last sync error. No sections and no Details panel.

## Withings connection

| Route | Does |
| --- | --- |
| `GET /api/withings/connect` | Behind Access. Redirects to Withings' consent page with scope `user.info,user.metrics,user.activity` and a signed state that expires in 15 minutes. |
| `GET /api/withings/callback` | Bypasses Access through its own Access app, "tools - Withings callback", scoped to this one path. Checks the state, exchanges the code, saves the tokens, and redirects to `/settings`. Without `code` or `error`, a GET, HEAD, or POST answers 200 so Withings' portal check passes. |
| `GET /api/tools/activity/days?from=&to=` | Days from `daily_activity`, default the last 90, plus the connection state. |

`worker/index.ts` maps `/api/withings/*` onto this tool's API, because the callback URL registered with Withings is fixed at `https://tools.mattpalmer.io/api/withings/callback`. Preview deployments can't connect.

Secrets: `WITHINGS_CLIENT_ID` and `WITHINGS_CLIENT_SECRET`, set by Matt. While either is unset, connect answers 503, the cron does nothing, and Settings says so.

Tokens live in `activity.withings`, one row, AES-GCM encrypted with a key derived by HKDF from `WITHINGS_CLIENT_SECRET`. The state is HMAC-signed with a second key from the same secret. Rotating the client secret makes the stored tokens unreadable, so reconnect after rotating it. Withings returns a new refresh token on every refresh, and the sync saves it before it uses the new access token.

Reconnecting the same Withings user keeps the backfill progress. A different user restarts it.

## Sync

`cron.ts` runs `syncWithings` on the Worker's every-minute trigger. Each run claims the `withings` row for 2 minutes, so two runs never refresh at once, and makes at most 3 Withings calls plus one refresh:

1. Refresh the access token when it expires within 5 minutes.
2. Every 30 minutes, pull the last 7 days, so today's total keeps growing.
3. With the calls left, backfill backward in 180-day windows from 7 days ago to `BACKFILL_FLOOR` (2009-01-01), following Withings' `more` and `offset` paging. The cursor and offset persist between runs. Backfill finishes in about 15 minutes.

The call is Measure v2 `getactivity` with `steps,distance,elevation,soft,moderate,intense,active,calories,totalcalories`. When Withings returns more than one row for a date, the row with the most steps wins and `raw` keeps all of them. An upsert that changes nothing writes nothing.

A failed run stores `last_error`. An auth failure says to reconnect at `/api/withings/connect`. The debug rows under Activity on `/settings` show the connection, scope, last refresh, last 7-day sync, backfill progress, and any error.

## Data

Schema `activity`, from `migrations/0001-create-schema.sql`.

| Table or view | Holds |
| --- | --- |
| `days` | Key `(day, source)`. `source` is `withings`, `apple_health`, or `manual`. `steps`, `active_kcal`, `total_kcal`, `distance_m`, `elevation_m`, `soft_s`, `moderate_s`, `intense_s`, `device`, `raw`, `updated_by`, `updated_at`. |
| `daily_activity` | One row per day, preferring Withings, then Apple Health, then manual. Read this, not `days`. |
| `withings` | The connection: user id, scope, encrypted tokens, expiry, backfill cursor and offset, last syncs, last error, and the claim. |

Nutrition's `getDay` shows `daily_activity.steps` as the day's steps, and falls back to the steps the bot set on `nutrition.days`.

## Tests

`bun test tools/activity` runs the routes and the sync against PGlite with a fake Withings: the bare callback ping, a forged and an expired state, encrypted storage, the 7-day pull and the windowed backfill down to the floor, refresh-token rotation, a rejected token, and an unchanged re-sync writing nothing.
