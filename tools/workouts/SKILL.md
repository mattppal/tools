---
name: tool-workouts
description: The Workouts tool at /workouts. Mirrors Matt's training-log repo into Postgres, shows its weeks, logs sessions set by set in Postgres, and sends each finished session to the coach bot by webhook. Use when changing tools/workouts/, the coach webhook, or how sessions are logged.
---

# Workouts

Shows today's prescribed session from training-log, logs it set by set in the gym, and sends the finished log to coach. Coach writes the session files to training-log and runs progressions. This tool never writes to training-log and never computes a load.

## Rules

- The UI never computes or rounds a load. It shows the values from the program file and the logged values Matt types.
- Logging is literal. Prescribed values are never filled in as actuals unless Matt taps **As written** on a set. That button copies the numeric load, an exact rep target, and a whole-number RIR target, and marks the set `as written`.
- RIR is a whole number from 0 to 10. A half RIR goes in the set's note. The API rejects anything else.
- Every exercise needs at least one set. An exercise with nothing logged, or one Matt skips, is sent with the placeholder set `{ "reps": 0, "type": "working", "notes": "skipped" }`.
- A weight always carries a unit. Units come from the program, which defaults to `lb`.

## Read path

training-log is the source of truth, and the `workouts` schema holds a read model of it. Requests and screens read only the database. Nothing reads GitHub per request.

`sync.ts` keeps the mirror current. `cron.ts` runs it on the Worker's one-minute trigger through `defineToolCron`, and bots can force a run with `POST /sync`. `debug.ts` shows the synced commit, the last check, and any sync error under Workouts on `/settings`.

1. `GET /repos/mattppal/training-log/commits/main` with `Accept: application/vnd.github.sha` and `If-None-Match` set to the stored ETag. A 304 ends the run and doesn't count against the rate limit.
2. When HEAD moved, `GET /git/trees/<sha>?recursive=1`, and keep blobs matching `program/*.json`, `sessions/*.json`, and `prs/profile.json`, plus any `sessions/*.md` that has no `.json` twin. Some rest days exist only as a Markdown note; `parseSessionNote` keeps its frontmatter, heading, and body. A forced sync (`POST /sync?force=1`) picks up files that a filter change newly includes while HEAD stays the same.
3. Fetch only the blobs whose SHA differs from `repo_files.sha`, at most 40 per run to stay under the Worker's subrequest limit.
4. In one transaction, under an advisory lock, upsert those files, delete paths that left the tree, and record `head_sha`. When more than 40 blobs changed, the run saves its batch, clears the ETag, and leaves `head_sha` alone, so the next minute picks up the rest.

The token is `TRAINING_LOG_TOKEN`, a fine-grained token with read-only Contents access. A failed run records `last_error` and leaves the mirror as it was. Files that aren't valid JSON are stored with `parse_error` and skipped by the reader. There is no git clone, since Workers have no filesystem.

`schedule.ts` builds the screens from the mirror, and every session file in it shows up somewhere.

- Weeks come from `calendar.weeks` in a block file. Blocks without one, such as Blocks A and B, get Monday-start weeks built from their logged sessions, labeled with the sessions' `weekId` (`rebuild`, `deload`).
- Planned days come from `calendar.weekPattern`. A slot that matches `days[].id` is a lift day. A slot that matches the block's `conditioning` entry is a run, shown with its duration, effort, and format. `rest` slots aren't shown.
- A repo session fills a planned day only when its `blockId`, `weekId`, and `dayId` all equal the slot's. Never guess a slot from the file name or the date. Older sessions may have no ids, so a session needs only a date (from `date` or the file name) to show. A session that matches no planned day, such as a deload recovery day, a swapped run, or a rest note, shows as its own day under its `name`. In a week that has a plan, its line says **Not in the plan**. Blocks A and B have no planned calendar, so their sessions show without that label.
- Runs follow training-log's contract: `sessions/YYYY-MM-DD-<tag>.json` with `kind: "conditioning"` and `modality` (`pool`, `track`, `z2`, `other`), plus a Markdown mirror. The day line shows the modality in words (Pool, Track, Zone 2, Other).
- Only lift days can be started in the app. Coach logs runs, so a planned run has no button, and a run whose date has passed without a log says so.

`program.ts` turns a block file into days. The week comes from `calendar.weeks` and the date from `calendar.weekPattern`. Each lift resolves to one prescription:

| Lift shape | Source |
| --- | --- |
| `wave: "loads.<key>"` | `loads[key][week]`: `weight` or `load`, `sets`, `reps`, `targetRir`, `notes` |
| `progression: "double_progression"` | `accessoryStartLoads[id]`, with the lift's `repRange`, `setsByWeek`, or `deloadSets` in the deload week |
| anything else | the lift's own `load`, `sets`, and reps |

A text load, such as `"find a weight"` or `"+42.5"`, is shown as text and never parsed.

## Screens

- **Today** shows the first planned day from the current week on that isn't logged in the repo or the app. A missed lift day stays until it's logged, and a run counts only from its date on. It comes with **Start session**, or **Continue logging** if one is open.
- **Week** opens on the current week, with arrows to every earlier and later week in the mirror. A day's button says what's left to do: **Start session**, **Continue logging**, or **View session**. Days already in training-log have no button and show the logged sets as the repo has them: weight × reps @RIR for lifts, distance and duration for cardio, and **Skipped** for skipped work.
- Today and Week end with a quiet line, `Synced <sha> · <time>`, plus the last sync error if there is one.
- **History** opens with the last recovery week (how long ago, its dates, block, and week) and the next planned deload. Below it, a bar strip shows every week grouped by block: bar height is sessions logged that week, deload and recovery weeks use `--chart-accent`, this week is outlined, and weeks still ahead are dashed. Each block then lists its dates, week and session counts, goal, and weeks, newest block first. A week row gives its counts in words and opens that week in **Week**. A week is a recovery week when a session in it is `recovery` (see the history tables), its `weekId` says `deload`, or it holds the block's `deloadWeek`. History has two views, **Blocks** and **Exercises**. Blocks ends with **Logged in this app**, the sessions logged here with their delivery state in plain words. Test sessions start with "Test ·".
- **Exercises** lists every lift from training-log sessions, most-trained first, with **Runs** on top. An exercise page (`?exercise=<key>`) charts the top set, volume, and reps at the top weight per session. It lists the rep records from `prs/profile.json` (reps, weight, and date only; their notes cite e1RM and aren't shown) and every session with its prescription and sets as logged. **Runs** (`?exercise=runs`) covers `RUN_KEYS`, with one point per run from its longest effort, compared in meters. It charts distance, duration, and pace, and lists every run with its modality. Skipped runs have no point.
- Charts draw one `--chart-accent` line with no fill, points in `--text-3`, and neutral axes. A readout above each chart shows the latest point, or the one under the pointer. The server picks the top set (heaviest working set in the exercise's most-used unit, ignoring skipped `reps: 0` sets) and sums volume (weight × reps over working sets in that unit). The UI only formats those values. Sessions in another unit stay in the list, not the charts.
- **Logging** shows one exercise at a time. Each set has weight and reps fields, an **As written** button, and RIR chips from 0 to 6. Every change saves at once, and a failed save shows **Retry**. The bottom bar moves between exercises. **Review** opens the right panel, where Matt adds a session note, finishes, or discards the session.

No status dots or status pills anywhere. State is said in plain words, or left to the button label.

## API

All routes are under `/api/tools/workouts`.

| Route | Does |
| --- | --- |
| `GET /program?week=<blockId>/<weekId>` | `{ today, weeks, currentWeek, week, next, sync, webhookReady }` from the mirror. Without `week`, the current week. |
| `GET /history/timeline` | `{ today, currentWeek, blocks, lastRecovery, nextDeload }`. Blocks from `history_blocks`, weeks from the same week refs as `/program`, and per-week counts from `history_sessions` |
| `GET /history/exercises` | `{ exercises, runs }`: lift exercises with session count and last date, and the Runs entry |
| `GET /history/exercises/:key` | `{ key, name, unit, sessions, prs }`. Each session has `prescribed` text, `sets`, `top`, `volume`, and `topReps`. 404 when there's no history. |
| `GET /history/runs` | `{ sessions }`. Each run has its longest effort's `distance`, `distanceUnit`, `miles`, `durationSeconds`, and `paceSecondsPerMile`, plus `modality` and `status`. |
| `GET /history/summary` | Session counts by kind and block, recovery sessions, exercises with session count and last date, and PR count, all from the history tables |
| `POST /sync` | Bots only, through `requireBot`. Runs one sync now. `?force=1` skips the ETag check. Returns `{ result, sync }`, or 502 when the run fails. The bot sends both Access headers, its bearer token, and an explicit `User-Agent`. A 302 means the Access headers are wrong, a 401 the bearer token, and a 403 with error 1010 a blocked default User-Agent. |
| `GET /sessions` | The latest 100 sessions with their delivery state |
| `POST /sessions` | `{ blockId, weekId, dayId, test? }`. Creates the session from the mirrored program, or returns the open one for that day. |
| `GET`, `PATCH`, `DELETE /sessions/:id` | Read, set the session note, or discard. Only open or test sessions can be deleted. |
| `PUT`, `DELETE /sessions/:id/sets/:position/:index` | Save or clear one set. Open sessions only. |
| `PATCH /sessions/:id/exercises/:position` | `{ status?: "planned" \| "skipped", notes? }` |
| `POST /sessions/:id/finish` | Builds and validates the log, marks the session finished, queues the delivery, and sends the first attempt |
| `POST /sessions/:id/redeliver` | Queues the same delivery again, with the same delivery ID |

## Data

Schema `workouts`, created by the files in `migrations/`.

| Table | Holds |
| --- | --- |
| `sessions` | One row per logged day: `block_id`, `week_id`, `day_id`, `day_title`, `session_date`, `notes`, `status` (`open` or `finished`), `test`. A partial unique index allows one non-test session per block, week, and day. |
| `exercises` | One row per program lift, keyed by `(session_id, position)`, with the resolved prescription in `prescribed` and `status` (`planned`, `completed`, or `skipped`) |
| `sets` | One row per logged set, keyed by `(session_id, position, set_index)`: `weight`, `unit`, `reps`, `rir`, `as_written`, `notes` |
| `deliveries` | The shared `worker/webhooks.ts` delivery table, plus `session_id` |
| `repo_files` | One row per mirrored `program/` or `sessions/` JSON file: `path`, blob `sha`, `kind`, `content`, `parse_error` |
| `history_blocks`, `history_sessions`, `history_exercises`, `history_sets`, `history_prs` | Read tables that `history.ts` rebuilds from `repo_files` inside every complete sync. Blocks get an end date from the next block's start when the file has none. A session is `recovery` when its week is `deload`, its day is `recovery`, or it falls in the block's `deloadWeek`. Exercises are keyed by `id`, or a slug of the name, through `EXERCISE_ALIASES`. PRs come from `prs/profile.json`. |
| `repo_sync` | One row: `head_sha` and `head_etag` of the last complete sync, `synced_at`, `checked_at`, `last_error` |

## Webhook to coach

`webhook.ts` registers the delivery with `defineWebhook`. The cron in `worker/index.ts` retries due rows every minute: 1, 2, 4, 8, 16, and 32 minutes, then hourly, with no limit, until coach returns a 2xx. A 2xx means only that Grok Bot received the request.

| Secret | Use |
| --- | --- |
| `COACH_WEBHOOK_URL` | The Grok Bot routine URL. It's a secret because the URL is a capability. |
| `COACH_WEBHOOK_KEY` | The raw key. Every delivery sends `Authorization: Bearer <key>`, and `worker/webhooks.ts` adds `Bearer ` |

Matt sets both with `bunx wrangler secret put`. No agent reads the values. While either is unset, finished sessions wait in `deliveries`.

The request is a `POST` with `X-Workouts-Delivery: <deliveryId>` and this body:

```json
{ "event": "session.finished", "deliveryId": "<uuid>", "sessionId": "<uuid>", "log": { "date": "2026-11-23T00:00:00-08:00", "name": "W5 Legs", "blockId": "build-block-c", "weekId": "w5", "dayId": "day-1", "status": "completed", "kind": "lift", "exercises": [] } }
```

`deliveryId` and `sessionId` never change across retries or **Send again**, so coach drops duplicates on them. `log` is an openweight WorkoutLog. Each exercise carries `id`, `status`, `prescribed` (`targetWeight` and `unit` or `targetLoad`, `targetReps` or `targetRepsMin` and `targetRepsMax`, `targetSets`, `targetRIR`), and its sets. Test sessions add `"test": true` to the body and the log, and prefix the name with `TEST`.

The log is checked before it's queued, by `openweight/workout-log-validator.js` and the rules above. The validator is generated from `@openweight/sdk` by `bun ./tools/workouts/openweight/generate.ts`, because Workers block Ajv's runtime code generation. Rerun it after upgrading the SDK.

## Decisions for Matt

The app sends the literal log and resolves none of the 13 progression ambiguities listed in the plan. Coach's interim behavior until Matt decides:

| # | Case | Coach until Matt decides |
| --- | --- | --- |
| 1 | Secondary compounds: `compound_hypertrophy_advance` or `wave_slot` | The higher of the two |
| 2 | Wave inputs that live only in notes | Reads them from the program notes |
| 4 | What counts as a miss | Asks Matt |
| 5 | Which set feeds `double_progression` when reps differ | The last set |
| 6 | Progress from the load used or prescribed | The load used |
| 7 | Substitutions | Progresses by slot id |
| 8 | Half-RIR target against a whole-number log | Asks Matt |
| 9 | A set logged without RIR | Asks Matt |
| 13 | Which week is next when days shift | Asks Matt |

Cases 3, 10, 11, and 12 have no interim behavior.

## Tests

`bun test ./tools/workouts` runs the resolver, week building, set parsing, and the full session lifecycle against PGlite, including the exact `Authorization` header and a redelivery that reuses the delivery ID. The sync tests use a fake GitHub to cover the 304 path, fetching only changed blobs, removed files, a tree larger than one batch, and a failed run.

## Live tests

Matt doesn't want test data in the app. A live test against production or preview creates its session with `"test": true` and deletes it with `DELETE /sessions/:id` before it ends, even when a step fails. The delete cascades to the session's exercises, sets, and delivery row. When the test checks delivery, read the delivery state first, then delete.
