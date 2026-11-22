---
name: tool-workouts
description: The Workouts tool at /workouts. Reads Matt's program from training-log, logs sessions set by set in Postgres, and sends each finished session to the coach bot by webhook. Use when changing tools/workouts/, the coach webhook, or how sessions are logged.
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

`github.ts` reads `mattppal/training-log` through the GitHub contents API with the `TRAINING_LOG_TOKEN` secret, a fine-grained token with read-only Contents access. Each `GET /program` lists `program/` and `sessions/`, then fetches block files from newest to oldest until one contains today (Pacific time). Nothing is cached.

`program.ts` turns a block file into days. The week comes from `calendar.weeks` and the date from `calendar.weekPattern`. Each lift resolves to one prescription:

| Lift shape | Source |
| --- | --- |
| `wave: "loads.<key>"` | `loads[key][week]`: `weight` or `load`, `sets`, `reps`, `targetRir`, `notes` |
| `progression: "double_progression"` | `accessoryStartLoads[id]`, with the lift's `repRange`, `setsByWeek`, or `deloadSets` in the deload week |
| anything else | the lift's own `load`, `sets`, and reps |

A text load, such as `"find a weight"` or `"+42.5"`, is shown as text and never parsed. A day counts as logged in the repo when `sessions/` has a file named `YYYY-MM-DD-<x>-w<N>-d<N>.json` dated inside the block.

## Screens

- **Today** shows the first day from this week on that isn't logged in the repo or the app, with **Start session**, or **Continue logging** if one is open.
- **Week** lists this week and next, with each day's state: Planned, In progress, Sent to coach, or In training-log.
- **History** lists sessions logged in the app, with their delivery state. Test sessions carry a Test tag.
- **Logging** shows one exercise at a time. Each set has weight and reps fields, an **As written** button, and RIR chips from 0 to 6. Every change saves at once, and a failed save shows **Retry**. The bottom bar moves between exercises. **Review** opens the right panel, where Matt adds a session note, finishes, or discards the session.

No status dots anywhere. States are text tags.

## API

All routes are under `/api/tools/workouts`.

| Route | Does |
| --- | --- |
| `GET /program` | `{ schedule, webhookReady }`. A failed read returns 502 with `code` set to `missing_token`, `no_access`, or `github`. |
| `GET /sessions` | The latest 100 sessions with their delivery state |
| `POST /sessions` | `{ weekId, dayId, test? }`. Creates the session from the current program, or returns the open one for that day. |
| `GET`, `PATCH`, `DELETE /sessions/:id` | Read, set the session note, or discard. Only open or test sessions can be deleted. |
| `PUT`, `DELETE /sessions/:id/sets/:position/:index` | Save or clear one set. Open sessions only. |
| `PATCH /sessions/:id/exercises/:position` | `{ status?: "planned" \| "skipped", notes? }` |
| `POST /sessions/:id/finish` | Builds and validates the log, marks the session finished, queues the delivery, and sends the first attempt |
| `POST /sessions/:id/redeliver` | Queues the same delivery again, with the same delivery ID |

## Data

Schema `workouts`, created by `migrations/0001-create-sessions.sql`.

| Table | Holds |
| --- | --- |
| `sessions` | One row per logged day: `block_id`, `week_id`, `day_id`, `day_title`, `session_date`, `notes`, `status` (`open` or `finished`), `test`. A partial unique index allows one non-test session per block, week, and day. |
| `exercises` | One row per program lift, keyed by `(session_id, position)`, with the resolved prescription in `prescribed` and `status` (`planned`, `completed`, or `skipped`) |
| `sets` | One row per logged set, keyed by `(session_id, position, set_index)`: `weight`, `unit`, `reps`, `rir`, `as_written`, `notes` |
| `deliveries` | The shared `worker/webhooks.ts` delivery table, plus `session_id` |

## Webhook to coach

`webhook.ts` registers the delivery with `defineWebhook`. The cron in `worker/index.ts` retries due rows every minute: 1, 2, 4, 8, 16, and 32 minutes, then hourly, with no limit, until coach returns a 2xx. A 2xx means only that Grok Bot received the request.

| Secret | Use |
| --- | --- |
| `COACH_WEBHOOK_URL` | The Grok Bot routine URL. It's a secret because the URL is a capability. |
| `COACH_WEBHOOK_KEY` | Sent as the whole `Authorization` header, with no `Bearer` or other scheme |

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

`bun test ./tools/workouts` runs the resolver, set parsing, and the full session lifecycle against PGlite, including the exact `Authorization` header and a redelivery that reuses the delivery ID.
