---
name: tool-activity
description: "Daily steps, active calories, and distance pulled from Withings into activity.days, and Withings weigh-ins into nutrition.weigh_ins, which nutrition reads for steps and weight. No page of its own; the Withings status is under Settings. Covers the Withings OAuth connect and callback routes, token storage, the sync cron, and the backfill. Use when changing tools/activity/ or anything that reads daily activity."
---

# Activity

One row per day of steps, active kcal, total kcal, and distance. Withings is the only writer today. Nutrition reads the same table, so food, weight, and activity line up per day.

## UI

No page. `tool.ts` is hidden, so the sidebar and home skip it, and its debug rows show under Withings on `/settings`. Nutrition shows the steps on Today, Weight, and History.

## Withings connection

| Route | Does |
| --- | --- |
| `GET /api/withings/connect` | Behind Access. Redirects to Withings' consent page with scope `user.info,user.metrics,user.activity` and a signed state that expires in 15 minutes. |
| `GET /api/withings/callback` | Bypasses Access through its own Access app, "tools - Withings callback", scoped to this one path. Checks the state, exchanges the code, saves the tokens, and redirects to `/settings`. Without `code` or `error`, a GET, HEAD, or POST answers 200 so Withings' portal check passes. |
| `GET /api/tools/activity/days?from=&to=` | Days from `daily_activity`, default the last 90, plus the connection state. |
| `GET /api/tools/activity/weights?from=&to=` | Withings weigh-ins in the withings-weight plugin's shape: `daily` like its `get_weights`, and `trend` with `daily` and `summary` like its `trend_weight`. Default the last 30 days. |

`worker/index.ts` maps `/api/withings/*` onto this tool's API, because the callback URL registered with Withings is fixed at `https://tools.mattpalmer.io/api/withings/callback`. Preview deployments can't connect.

Secrets: `WITHINGS_CLIENT_ID` and `WITHINGS_CLIENT_SECRET`, set by Matt. While either is unset, connect answers 503, the cron does nothing, and Settings says so.

Tokens live in `activity.withings`, one row, AES-GCM encrypted with a key derived by HKDF from `WITHINGS_CLIENT_SECRET`. The state is HMAC-signed with a second key from the same secret. Rotating the client secret makes the stored tokens unreadable, so reconnect after rotating it. Withings returns a new refresh token on every refresh, and the sync saves it before it uses the new access token.

Reconnecting the same Withings user keeps the backfill progress. A different user restarts it.

## Sync

`cron.ts` runs `syncWithings` on the Worker's every-minute trigger. Each run claims the `withings` row for 2 minutes, so two runs never refresh at once, and makes at most 3 Withings calls plus one refresh:

1. Refresh the access token when it expires within 5 minutes.
2. Every 30 minutes, pull the last 7 days, so today's total keeps growing.
3. Every 30 minutes, or on every run while history is still paging, pull weigh-ins with `getmeas` (`meastypes=1,6,8`, `category=1`) since the stored `lastupdate`. The first sync starts from 0, so it loads all history. The first page's `updatetime` becomes the next `lastupdate` once paging ends.
4. With the calls left, backfill backward in 180-day windows from 7 days ago to `BACKFILL_FLOOR` (2009-01-01), following Withings' `more` and `offset` paging. The cursor and offset persist between runs. Backfill finishes in about 15 minutes.

The call is Measure v2 `getactivity` with `steps,distance,elevation,soft,moderate,intense,active,calories,totalcalories`. When Withings returns more than one row for a date, the row with the most steps wins and `raw` keeps all of them. An upsert that changes nothing writes nothing.

A failed run stores `last_error`. An auth failure says to reconnect at `/api/withings/connect`. The debug rows under Withings on `/settings` show the connection, scope, last refresh, last 7-day sync, backfill progress, and any error.

## Weight parity rules

These match tinkabot's withings-weight plugin, version 0.1.0, as written up in the Project store at `docs/withings-parity/rules.md`. Bots can retire that plugin and read the same numbers here.

- Every weigh-in Withings returns goes into `withings_weighins`, keyed by `grpid`. Groups with the same `grpid` are merged, keeping the earlier timestamp. A group with a `category` other than 1, or with no type 1 weight, is dropped.
- A weigh-in's day is the wall-clock date of its timestamp in America/Los_Angeles, from local 00:00 to 23:59:59.
- `kg = value * 10^unit`, rounded to `-unit` decimals when `unit` is negative. `weight_lb = round(kg * 2.20462262185, 2)` and `weight_kg = round(kg, 3)`. Rounding is `Math.round(x * 10^dp) / 10^dp`, done in TypeScript so it matches the plugin bit for bit.
- `fat_pct` is the type 6 fat ratio, or else type 8 fat mass divided by weight times 100, rounded to 2 decimals. `fat_source` says which.
- The day's weigh-in is the first one with `attrib` other than 1, sorted by timestamp and then by `grpid` as text. When every weigh-in that day has `attrib` 1, it is the first of any. Manual entries, with `attrib` 2 or 4, count. `saveWeighins` writes that pick to `nutrition.weigh_ins` with source `withings`, plus `measured_at`, `grpid`, and `fat_pct`, so `daily_weights` prefers it over the sheet.
- The trend is an EMA with smoothing 0.1, seeded with the first daily weight in the window. A day without a weigh-in carries the trend forward. No warmup. `trend_lb`, `start_trend`, `end_trend`, `delta_lb`, and `lb_per_week` are rounded to 2 decimals. The math underneath stays unrounded.

## Data

Schema `activity`, from `migrations/0001-create-schema.sql`.

| Table or view | Holds |
| --- | --- |
| `days` | Key `(day, source)`. `source` is `withings`, `apple_health`, or `manual`. `steps`, `active_kcal`, `total_kcal`, `distance_m`, `elevation_m`, `soft_s`, `moderate_s`, `intense_s`, `device`, `raw`, `updated_by`, `updated_at`. |
| `daily_activity` | One row per day, preferring Withings, then Apple Health, then manual. Read this, not `days`. |
| `withings` | The connection: user id, scope, encrypted tokens, expiry, backfill cursor and offset, the `getmeas` cursor (`meas_lastupdate`, `meas_pending_lastupdate`, `meas_offset`), last syncs, last error, and the claim. |
| `withings_weighins` | Every kept Withings weigh-in: `grpid`, `measured_ts`, `local_date`, `local_time`, `weight_kg`, `weight_lb`, `fat_pct`, `fat_mass_lb`, `fat_source`, `attrib`, `model`. |

This tool writes `nutrition.weigh_ins` rows with source `withings`. Nutrition's migration `0003` adds the `measured_at`, `grpid`, and `fat_pct` columns. Nutrition's `getDay` shows `daily_activity.steps` as the day's steps, and falls back to the steps the bot set on `nutrition.days`.

## Tests

`bun test tools/activity` runs the routes and the sync against PGlite with a fake Withings: the bare callback ping, a forged and an expired state, encrypted storage, the 7-day pull and the windowed backfill down to the floor, refresh-token rotation, a rejected token, an unchanged re-sync writing nothing, the weight parity rules, resumable `getmeas` paging, and the EMA trend. One more test rebuilds the raw weigh-ins in tinkabot's 30-day sample and checks that `daily`, the trend rows, and the summary match it exactly. The sample is Matt's real weight data and this repo is public, so the sample stays in the Project store and the test skips when the file is missing, as it is in CI.
