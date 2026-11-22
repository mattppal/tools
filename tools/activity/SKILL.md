---
name: tool-activity
description: "Daily steps, active calories, distance, and heart rate pulled from Withings into activity.days, Withings weigh-ins into nutrition.weigh_ins, and Withings workouts, sleep, body measures, and intraday steps and heart rate into activity tables, with daily_health as the per-day view for TDEE. Also takes Apple Health pushes from the Health Auto Export iOS app (sleep stages, resting HR, HRV, workouts) into apple_health_* tables. No page of its own; the Withings and Apple Health status is under Settings. Covers the Withings OAuth connect and callback routes, token storage, the sync cron, the backfill, and the Apple Health ingest route. Use when changing tools/activity/ or anything that reads daily activity."
---

# Activity

One row per day of steps, active kcal, total kcal, distance, and heart rate, plus every workout, sleep, body measure, and 5-minute intraday bucket Withings has. Withings writes them. Apple Health adds sleep stages, samples such as resting HR and HRV, and workouts, pushed by the Health Auto Export app on Matt's iPhone. Nutrition reads the same tables, so food, weight, and activity line up per day.

## UI

No page. `tool.ts` is hidden, so the sidebar and home skip it, and its debug rows show under Withings on `/settings`. Nutrition shows the steps on Today, Weight, and History.

## Withings connection

| Route | Does |
| --- | --- |
| `GET /api/withings/connect` | Behind Access. Redirects to Withings' consent page with scope `user.info,user.metrics,user.activity` and a signed state that expires in 15 minutes. Also sets the state in an HttpOnly `withings_state` cookie scoped to the callback path. |
| `GET /api/withings/callback` | Bypasses Access through its own Access app, "tools - Withings callback", scoped to this one path. Checks that the state is signed, unexpired and equal to the `withings_state` cookie, so a state only works in the browser that started the connect, then clears the cookie, exchanges the code, saves the tokens, and redirects to `/settings`. Without `code` or `error`, a GET, HEAD, or POST answers 200 so Withings' portal check passes. |
| `GET /api/tools/activity/days?from=&to=` | Days from `daily_activity`, default the last 90, plus the connection state. |
| `GET /api/tools/activity/health?from=&to=` | One row per day from `daily_health`. Default the last 30 days. |
| `GET /api/tools/activity/workouts?from=&to=` | Withings workouts with HR zones and the training-log link, if any. `activity` is the category name from `WORKOUT_CATEGORIES`, which copies the category table in Withings' OpenAPI spec (`developer.withings.com/openapi.yaml`, `getworkouts`), lowercased. An unknown category reads `category <n>`. |
| `GET /api/tools/activity/sleep?from=&to=` | Withings sleep summaries with the device model and device hash. |
| `GET /api/tools/activity/measures?from=&to=&types=` | Body measures, decoded, with names from `MEASURE_TYPES`. `types` is a comma list of Withings type numbers. |
| `GET /api/tools/activity/intraday?day=` | One day of 5-minute buckets. |
| `POST /api/tools/activity/apple-health` | Health Auto Export's REST API automation. Bot `apple-health` only. See Apple Health. |
| `GET /api/tools/activity/apple-health/workouts?from=&to=` | Apple Health workouts, with `withingsId` set when a Withings workout overlaps it in time. Default the last 30 days. |
| `GET /api/tools/activity/weights?from=&to=` | Withings weigh-ins in the withings-weight plugin's shape: `daily` like its `get_weights`, and `trend` with `daily` and `summary` like its `trend_weight`. Default the last 30 days. |

The GET routes above are for bots only and call `requireBot(request, context, "activity")`. The `activity` scope of each bot in `BOTS` in `worker/access.ts` lists the routes it may read: nutrition gets `/days`, `/weights` and `/health`, and coach gets `/workouts` and `/apple-health/workouts`. No bot reads `/sleep`, `/measures` or `/intraday`. A caller with no bot identity, Matt's browser included, gets 401, and a known bot outside its scope gets 403. To grant a route, add it to that bot's scope in `BOTS`.

`worker/index.ts` maps `/api/withings/*` onto this tool's API, because the callback URL registered with Withings is fixed at `https://tools.mattpalmer.io/api/withings/callback`. Preview deployments can't connect.

Secrets: `WITHINGS_CLIENT_ID` and `WITHINGS_CLIENT_SECRET`, set by Matt. While either is unset, connect answers 503, the cron does nothing, and Settings says so.

Tokens live in `activity.withings`, one row, AES-GCM encrypted with a key derived by HKDF from `WITHINGS_CLIENT_SECRET`. The state is HMAC-signed with a second key from the same secret. Rotating the client secret makes the stored tokens unreadable, so reconnect after rotating it. Withings returns a new refresh token on every refresh, and the sync saves it before it uses the new access token.

Reconnecting the same Withings user keeps the backfill progress. A different user restarts it.

## Sync

`cron.ts` runs `syncWithings` on the Worker's every-minute trigger. Each run claims the `withings` row for 2 minutes, so two runs never refresh at once, and makes at most 6 Withings calls (`CALLS_PER_RUN`) plus one refresh, in this order:

1. Refresh the access token when it expires within 5 minutes.
2. Every 30 minutes, pull the last 7 days, so today's total keeps growing.
3. Every 30 minutes, or on every run while history is still paging, pull weigh-ins with `getmeas` (`meastypes=1,6,8`, `category=1`) since the stored `lastupdate`. The first sync starts from 0, so it loads all history. The first page's `updatetime` becomes the next `lastupdate` once paging ends.
4. Every 30 minutes, or on every run while history is paging, pull the three feeds since each one's `lastupdate`: `measures` (`getmeas`, every type, `category=1`), `workouts` (Measure v2 `getworkouts`), and `sleep` (Sleep v2 `getsummary`). Each keeps `{lastupdate, pending, offset}` in `withings_streams`, and starts from 0 so the first sync loads all history. A feed that fails without needing a reconnect stores its error in its stream row, waits 30 minutes, and leaves the other feeds running. After `workouts` finishes, the training-log links are rebuilt.
5. With the calls left, backfill backward in 180-day windows from 7 days ago to `BACKFILL_FLOOR` (2009-01-01), following Withings' `more` and `offset` paging. The cursor and offset persist between runs.
6. Every 30 minutes, pull intraday activity (`getintradayactivity`, one local day per call) for today and yesterday. Then backfill one day per call from the day before yesterday. The intraday backfill stops after 120 days in a row with no samples, or at the floor. A failure pauses intraday for 30 minutes.

The call is Measure v2 `getactivity` with `steps,distance,elevation,soft,moderate,intense,active,calories,totalcalories,hr_average,hr_min,hr_max,hr_zone_0..3`. Migration `0003` resets the backfill cursor once so older days pick up the heart-rate fields. When Withings returns more than one row for a date, the row with the most steps wins and `raw` keeps all of them. An upsert that changes nothing writes nothing.

A failed run stores `last_error`. An auth failure says to reconnect at `/api/withings/connect`. The debug rows under Withings on `/settings` show the connection, scope, last refresh, last 7-day sync, backfill progress, and any error.

## Apple Health

Health Auto Export on Matt's iPhone posts JSON, export version 2, to `POST /api/tools/activity/apple-health` on a schedule. Eight Sleep writes sleep to Apple Health, so this is how Eight Sleep's nights reach tools. The phone sends `CF-Access-Client-Id` and `CF-Access-Client-Secret` for the `apple-health-export` service token. `BOTS` in `worker/access.ts` names that caller `apple-health` and lets it call only `POST /apple-health`. The phone's `Authorization: Bearer <BOT_TOKEN_APPLE_HEALTH>` header still works until the bearer-removal PR and is ignored after it, so the phone needs no change. The setup Matt follows on the phone is in the Project store at `docs/apple-health-setup.md`.

The body is `{"data":{"metrics":[...],"workouts":[...]}}` in the shapes of Health Auto Export's help center (Export Format, Health Metrics and Workouts). `samples/` holds one push of each kind, and the tests post them.

- `sleep_analysis` must arrive as stage segments, which is what Summarize Data off sends. A summarized night has no stages and no per-source segments, so the route answers 422 with the setting to change and writes nothing.
- Each segment is stored by `(source, started_at, stage)`, each other sample by `(metric, source, measured_at)`, each workout by Health Auto Export's `id`. Pushing the same export again changes nothing, so overlapping date ranges and batched requests are safe.
- Anything whose source names Withings or Health Mate is dropped and counted under `skipped.withings`, because the Withings sync already has it. A missing source is stored as `Apple Health`.
- Workouts are converted to kcal and metres, and `route` is dropped. The rest of the workout is kept in `data`.
- Each push records the `automation-name` and `session-id` headers in `apple_health_pushes`. Settings shows one row per automation with its last push and counts.

The response is `{ received, changed, skipped }`. `received` and `changed` count `sleep`, `samples` and `workouts`; `skipped` counts `withings` and `invalid` (no date, no value, or an unknown stage).

## Weight parity rules

These match tinkabot's withings-weight plugin, version 0.1.0, as written up in the Project store at `docs/withings-parity/rules.md`. Bots can retire that plugin and read the same numbers here.

- Every weigh-in Withings returns goes into `withings_weighins`, keyed by `grpid`. Groups with the same `grpid` are merged, keeping the earlier timestamp. A group with a `category` other than 1, or with no type 1 weight, is dropped.
- A weigh-in's day is the wall-clock date of its timestamp in America/Los_Angeles, from local 00:00 to 23:59:59.
- `kg = value * 10^unit`, rounded to `-unit` decimals when `unit` is negative. `weight_lb = round(kg * 2.20462262185, 2)` and `weight_kg = round(kg, 3)`. Rounding is `Math.round(x * 10^dp) / 10^dp`, done in TypeScript so it matches the plugin bit for bit.
- `fat_pct` is the type 6 fat ratio, or else type 8 fat mass divided by weight times 100, rounded to 2 decimals. `fat_source` says which.
- The day's weigh-in is the first one with `attrib` other than 1, sorted by timestamp and then by `grpid` as text. When every weigh-in that day has `attrib` 1, it is the first of any. Manual entries, with `attrib` 2 or 4, count. `saveWeighins` writes that pick to `nutrition.weigh_ins` with source `withings`, plus `measured_at`, `grpid`, and `fat_pct`, so `daily_weights` prefers it over the sheet.
- The trend is an EMA with smoothing 0.1, seeded with the first daily weight in the window. A day without a weigh-in carries the trend forward. No warmup. `trend_lb`, `start_trend`, `end_trend`, `delta_lb`, and `lb_per_week` are rounded to 2 decimals. The math underneath stays unrounded.

## Workout links

`withings_workout_links` is derived and rebuilt in full after each workouts sync. It never writes to the training log. A Withings workout links to a `workouts.history_sessions` row of kind `conditioning` that isn't skipped only when:

- The workout's category maps to a modality (walk, run, bike, swim, row, elliptical). Weights and other categories never link.
- The session names exactly one modality in its `modality`, `name`, and exercise names. `z2` alone names none, so "Zone 2" doesn't link and "C W3 Easy jog" links as a run.
- The session falls on the workout's local date. When the session file's `date` has a time other than midnight, its start must also fall within 3 hours of the workout's start.
- Exactly one session is a candidate for the workout, and that session is a candidate for no other workout.

Anything else with at least one candidate is stored as `ambiguous` with `session_path` null and the candidate paths listed. A workout with no candidate has no row.

## Data

Schema `activity`, from `migrations/`. Other tools read it through the functions in `health.ts` (`dailyHealth`, `listWorkouts`, `listSleep`, `listMeasures`, `intradayDay`) or the views.

| Table or view | Holds |
| --- | --- |
| `days` | Key `(day, source)`. `source` is `withings`, `apple_health`, or `manual`. `steps`, `active_kcal`, `total_kcal`, `distance_m`, `elevation_m`, `soft_s`, `moderate_s`, `intense_s`, `hr_avg`, `hr_min`, `hr_max`, `hr_zone_0_s` to `hr_zone_3_s`, `device`, `raw`, `updated_by`, `updated_at`. |
| `daily_activity` | One row per day, preferring Withings, then Apple Health, then manual. Read this, not `days`. |
| `withings` | The connection: user id, scope, encrypted tokens, expiry, backfill cursor and offset, the `getmeas` cursor (`meas_lastupdate`, `meas_pending_lastupdate`, `meas_offset`), last syncs, last error, and the claim. |
| `withings_streams` | Cursor state per feed (`measures`, `workouts`, `sleep`, `intraday`), with `synced_at` and `done_at`. |
| `withings_measures` | Key `(grpid, type)`. Every real body measure, `value = value * 10^unit`. `weight_kg`, fat, muscle, bone, hydration, BP, pulse, SpO2, temperature, PWV, and so on. |
| `withings_workouts` | Key Withings `id`. Category, local date, start and end, elapsed `duration_s`, distance, calories, steps, elevation, HR avg, min, max, and zone seconds, pool laps, model, and the raw series item in `data`. |
| `withings_sleep` | Key Withings `id`. Local date (the wake-up date Withings gives), start and end, `model`, `model_id`, `device_hash`, durations by stage, wakeups, latency, efficiency, HR, breathing rate, breathing disturbances, snoring, score, and the raw item. |
| `withings_intraday` | One row per local day: `bucket_s` (300), `samples`, `models`, and `buckets`, a JSON array of `{m, steps, kcal, distance_m, hr, hr_min, hr_max, spo2}` with `m` the minutes since local midnight. Fields without data are left out. |
| `withings_workout_links` | See Workout links. |
| `daily_health` | One row per day: steps and kcal from `daily_activity`, the day's HR, `resting_hr` (the lowest HR of the day's longest sleep), sleep totals, and Withings workout count, kcal, and seconds. Read this for the TDEE model. |
| `apple_health_sleep` | Key `(source, started_at, stage)`. One Apple Health sleep segment: `stage` (`in_bed`, `asleep`, `awake`, `core`, `deep`, `rem`, `unspecified`), `ended_at`, and the phone's `utc_offset_min`. |
| `apple_health_samples` | Key `(metric, source, measured_at)`. One reading of any other metric, by Health Auto Export's snake_case name: `qty`, or `min`, `avg` and `max` for heart rate, plus `units` and `utc_offset_min`. |
| `apple_health_workouts` | Key Health Auto Export's workout `id`. Name, source, local date, start and end, `duration_s`, active and total kcal, `distance_m`, `elevation_m`, HR avg, min and max, location, and the workout without its route in `data`. |
| `apple_health_pushes` | Key `automation`. The last push from each Health Auto Export automation: time, `session_id`, and the response counts. |
| `withings_weighins` | Every kept Withings weigh-in: `grpid`, `measured_ts`, `local_date`, `local_time`, `weight_kg`, `weight_lb`, `fat_pct`, `fat_mass_lb`, `fat_source`, `attrib`, `model`. |

This tool writes `nutrition.weigh_ins` rows with source `withings`. Nutrition's migration `0003` adds the `measured_at`, `grpid`, and `fat_pct` columns. Nutrition's `getDay` shows `daily_activity.steps` as the day's steps, and falls back to the steps the bot set on `nutrition.days`.

## Tests

`apple-health.test.ts` posts the samples in `samples/` through the route: bearer checks, sources and Withings drops, an unchanged re-push writing nothing, unit conversion and Withings overlap on workouts, the 422 for summarized sleep, the Settings row, and date offsets. `bun test tools/activity` also runs the routes and the sync against PGlite with a fake Withings: the bare callback ping, a forged and an expired state, a state from another browser, encrypted storage, the 7-day pull and the windowed backfill down to the floor, refresh-token rotation, a rejected token, an unchanged re-sync writing nothing, the weight parity rules, resumable `getmeas` paging, the EMA trend, the workouts, sleep, and measures feeds with an idempotent re-sync, a failing feed that leaves the others running, intraday bucketing across DST and the empty-run stop, and the workout link rules. One more test rebuilds the raw weigh-ins in tinkabot's 30-day sample and checks that `daily`, the trend rows, and the summary match it exactly. The sample is Matt's real weight data and this repo is public, so the sample stays in the Project store and the test skips when the file is missing, as it is in CI.
