---
name: tool-nutrition
description: "The Nutrition tool at /nutrition. Matt's daily food log against kcal and macro targets, the weight trend, the phase tracker, the nutrition bot's MCP server, and the day-closed webhook. Use when changing tools/nutrition/ or wiring the nutrition bot."
---

# Nutrition

Matt logs food here and the nutrition bot logs it over MCP. Both write through `store.ts`, so the UI and the bot see the same day.

## UI

Four views nest under Nutrition in the sidebar as sections (`VIEWS` in `ui.tsx`). None of them use status dots. States show as words or as bar color.

- Today (`/nutrition`, `?date=YYYY-MM-DD` for another day). Four range bars for kcal, protein, fat, and carbs, each reading "N to go", "in range", or "+N over". Under them is the bot's check-in line, then the entries. A row opens the right panel to edit or delete it. Add food is one labeled button under the entries, pinned to the bottom of the screen while the list scrolls. It and each row open the same right panel, which holds only the entry form so it can move to another container. Saves show at once and roll back with an error in the panel if the request fails. Close day locks the entries and fires the webhook. Reopen unlocks them.
- History (`/nutrition/history`). One row per day, newest first, with "Open" on days that aren't closed.
- Weight (`/nutrition/weight`). An SVG of each weigh-in with the 7, 14, and 28 day averages over 90 days, 1 year, or all.
- Phase (`/nutrition/phase`). The open phase's verdict and suggested kcal for next week, then the weekly rows.

## API

All routes are under `/api/tools/nutrition` and sit behind Cloudflare Access.

| Route | Does |
| --- | --- |
| `GET /day?date=` | The day with entries, totals, targets, progress, and check-in. Defaults to today in America/Los_Angeles. |
| `POST /day/food` | `{ date, add?, edit?, remove? }`. Each add takes a `client_key`, so a retry doesn't log twice. |
| `POST /day/close` | Closes the day and queues the webhook. |
| `POST /day/reopen` | Reopens the day. |
| `GET /history` | The last 400 days with totals. |
| `GET /weights?range=90d\|1y\|all` | Weigh-ins with rolling averages. |
| `GET /phase` | The open phase, its tracker settings, and the weekly summary. |
| `POST /mcp` | The bot's MCP server. |

A rejected write, such as an edit to a closed day, returns `409 { error }`.

## Bot

`bot.ts` mounts four tools with `toolMcp` from `worker/mcp.ts`. Only the `nutrition` bot can call them.

| Tool | Flow |
| --- | --- |
| `log_food` | Add, edit, or remove entries on one day. Returns the day. |
| `update_day` | Read the day, or set bodyweight, steps, scores, notes, estimated totals, or closed. |
| `update_targets` | Start a new plan version and optionally set the tracker's current kcal target. |
| `get_phase_summary` | The tracker week and the day's progress. Read-only. |

The bot sends three headers: `CF-Access-Client-Id` and `CF-Access-Client-Secret` from the `nutrition-bot` Access service token, and `Authorization: Bearer <BOT_TOKEN_NUTRITION>`.

## Webhook

Closing a day in the UI POSTs to `NUTRITION_WEBHOOK_URL`. Closing it through `update_day` sends nothing, because the bot already knows.

- Headers: `Authorization: Bearer <NUTRITION_WEBHOOK_KEY>`, where the secret holds the raw key and `worker/webhooks.ts` adds `Bearer `, `X-Nutrition-Delivery: <uuid>`, and `content-type: application/json`.
- Body: `{ event: "day.closed", deliveryId, date, closedAt, estimated, entries, totals, targets, progress }`.
- `closeDayFromUi` writes the delivery row in the same transaction as the close. The route then tries it once with `deliverSoon`, and the every-minute cron in `worker/webhooks.ts` retries it with backoff until a 2xx. Every retry keeps the same delivery ID.
- `nutrition.deliveries` shows each delivery's attempts, last status, and when it landed.

## Data

Schema `nutrition`. See `migrations/0001-create-schema.sql`.

- `days`, `food_entries`, `plan_versions`, `phases`, `phase_trackers`, `weigh_ins`, `deliveries`.
- Views: `daily_weights` takes one weigh-in a day, preferring Withings, then the bot, then the sheet, then the daily files. `weight_trend` adds unrounded rolling averages, and `day_totals` sums the entries.
- Plan versions are never edited. A change starts a new version on its `effective_from` date.
- `phase.ts` reproduces the sheet's Phase tracker: compounding planned weight, calendar-window averages, and a 28-day TDEE. Only closed days with kcal count as logged. `phase.test.ts` pins it to the sheet.

## Import

`import.ts` loads the `training-log` repo's `nutrition/` files and the sheet's Weight tab in one transaction. Every row upserts on its natural key, so running it again changes nothing.

```bash
bun tools/nutrition/import.ts --training-log ../training-log --weights weights.csv [--cutover YYYY-MM-DD] [--dry-run]
```

- `weights.csv` has the columns `date_serial,weight_lb,rolling_7d,rolling_14d,rolling_28d`. The date is the sheet's serial number. Leave the rolling columns empty on rows that shouldn't be checked.
- The run rolls back unless every day's entries add up to the file's totals and `weight_trend` matches the sheet's averages to 0.01 lb. The totals check allows 1 unit, or half a unit per entry on tracker-export days.
- `--cutover` refuses daily files on or after that date, once the bot writes only through MCP.
- It connects with `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB`, like `bun run migrate`.
