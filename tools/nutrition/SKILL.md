---
name: tool-nutrition
description: "The Nutrition tool at /nutrition. Matt's daily food log against kcal and macro targets, the weight trend, the phase tracker, the nutrition bot's MCP server, and the day-closed webhook. Use when changing tools/nutrition/ or wiring the nutrition bot."
---

# Nutrition

Matt logs food here and the nutrition bot logs it over MCP. Both write through `store.ts`, so the UI and the bot see the same day.

## UI

Four views nest under Nutrition in the sidebar as sections (`VIEWS` in `ui.tsx`). None of them use status dots. States show as words or as bar color.

- Today (`/nutrition`, `?date=YYYY-MM-DD` for another day). Four range bars for kcal, protein, fat, and carbs, each reading "N to go", "in range", or "+N over". Each fill is a muted tint from the `--change-*` tokens: blue under the target, green in range, and red over it. Under the kcal bar a muted, untinted line shows the day's steps, plus "N to go" or "target met" when the plan has a steps target. With no steps the line is absent. Under the bars is the bot's check-in line, then the entries. A row opens the right panel to edit or delete it. Add food is one labeled button under the entries, pinned to the bottom of the screen while the list scrolls. It and each row open the same right panel, which holds only the entry form so it can move to another container. Saves show at once and roll back with an error in the panel if the request fails. Close day locks the entries and fires the webhook. Reopen unlocks them.
- History (`/nutrition/history`). One row per day, newest first, with "Open" on days that aren't closed and the day's steps in the muted text when there are any. A three-way filter, saved in the browser, picks what shows. Logged, the default, shows days with entries that aren't partial. With partial adds partial days, marked in the row's muted text with their share of the target. All days adds days with no entries. A muted line under the list says how many days are hidden. A day is partial when it is closed and its kcal is under `PARTIAL_DAY_SHARE` (50%, in `types.ts`) of its target: the midpoint of that day's plan range, or the phase tracker's kcal target when no plan version covers it.
- Weight (`/nutrition/weight`). One range drives everything on the page: 90 days, 1 year, all, a From and To date, or a mouse drag across the chart. Under the controls is a summary of the range: start and end average, change, mean weight, and weekly rate. A second row shows Expenditure, the measured TDEE for the range, with the number of logged days it uses, and the average steps a day. The chart draws the 7-day, 14-day, or 28-day average in `--chart-accent` over muted weigh-ins, and either layer can be hidden. Hovering, or tapping on a phone, snaps to the nearest weigh-in. A dashed crosshair appears, with the date on the x-axis and both the weigh-in and the trend value on the y-axis. Dragging with a mouse still selects a range. Changes in the summary and the table are tinted by direction: on a cut, a loss reads as good and a gain as bad, and the reverse on a gain. Any other phase uses neutral blue for a loss and amber for a gain. The tint grows with the size of the change, from 30% at small values to full at 2 lb for one weigh-in, 3 lb for the range, or 1 lb a week. Values that round to zero stay untinted. The table below lists date, weight, the chosen average, and the change from the previous weigh-in, 50 rows a page, sortable by any column. Under 640 px each row stacks onto two lines. A source filter appears only when the data has more than one source. The page loads every weigh-in once and filters in the browser.
- Phase (`/nutrition/phase`). The open phase's verdict and suggested kcal for next week, then the weekly rows.

## API

All routes are under `/api/tools/nutrition` and sit behind Cloudflare Access.

| Route | Does |
| --- | --- |
| `GET /day?date=` | The day with entries, totals, targets, progress, and check-in. Defaults to today in America/Los_Angeles. |
| `POST /day/food` | `{ date, add?, edit?, remove? }`. Each add takes a `client_key`, so a retry doesn't log twice. An edit names its entry by `id` or `client_key`, and `remove` takes either. Removing an entry that is already gone is skipped. Every entry in the result carries its `clientKey`. |
| `POST /day/close` | `{ date, test? }`. Closes the day and queues the webhook. |
| `POST /day/reopen` | Reopens the day. |
| `GET /history` | The last 400 days with totals, kcal target, and the partial flag. |
| `GET /weights` | Every weigh-in with its source and 7, 14, and 28 day averages, oldest first. |
| `GET /expenditure?from=&to=` | Measured TDEE over the range, the logged days it used, and the average steps over days that have steps. Defaults to the last 90 days. |
| `GET /phase` | The open phase, its tracker settings, and the weekly summary. |
| `POST /mcp` | The bot's MCP server. |

A rejected write, such as an edit to a closed day, returns `409 { error }`.

## Bot

`bot.ts` mounts four tools with `toolMcp` from `worker/mcp.ts`. Only the `nutrition` bot can call them.

| Tool | Flow |
| --- | --- |
| `log_food` | Add, edit, or remove entries on one day. Returns the day. Same rules as `POST /day/food`. |
| `update_day` | Read the day, or set bodyweight, steps, scores, notes, estimated totals, or closed. |
| `update_targets` | Start a new plan version with kcal and macro ranges and an optional `steps_target`, and optionally set the tracker's current kcal target. |
| `get_phase_summary` | The tracker week and the day's progress. Read-only. |

The bot sends three headers: `CF-Access-Client-Id` and `CF-Access-Client-Secret` from the `nutrition-bot` Access service token, and `Authorization: Bearer <BOT_TOKEN_NUTRITION>`. It also sends an explicit `User-Agent`. A 302 to `cloudflareaccess.com` means the Access headers are missing or wrong, a 401 means the bearer token is, and a 403 with Cloudflare error 1010 means Browser Integrity Check blocked a client's default User-Agent, such as Python urllib's.

Since the 2026-11-22 cutover the bot logs each food through `log_food` as Matt reports it, and this database is the source of truth. Days on or after the cutover never come from `training-log`; rerun the import only with `--cutover 2026-11-22`.

A retry is safe with the same body. An add whose `client_key` exists is skipped, an edit sets the same values again, and a remove of an entry that is already gone is skipped. A remove of an entry that sits on another day is rejected.

## Webhook

Closing a day in the UI POSTs to `NUTRITION_WEBHOOK_URL`. Closing it through `update_day` sends nothing, because the bot already knows.

- Headers: `Authorization: Bearer <NUTRITION_WEBHOOK_KEY>`, where the secret holds the raw key and `worker/webhooks.ts` adds `Bearer `, `X-Nutrition-Delivery: <uuid>`, and `content-type: application/json`.
- Body: `{ app: "nutrition", event: "day.closed", data: { event, deliveryId, date, closedAt, estimated, entries, totals, targets, progress, test? } }`. The receiver rejects a body without `app` or `data`. `webhook.ts` declares the app and its events with `envelope`, and `worker/webhooks.ts` wraps the stored payload as `data` on every send, so retries of older rows go out in this shape too. `targets` and `progress` are null when no plan covers the day.
- `test: true` sits in `data` only for a test close, `POST /day/close` with `{ date, test: true }`. A real close has no `test` key.
- `closeDayFromUi` writes the delivery row in the same transaction as the close. The route then tries it once with `deliverSoon`, and the every-minute cron in `worker/webhooks.ts` retries it with backoff until a 2xx. Every retry keeps the same delivery ID.
- `nutrition.deliveries` shows each delivery's attempts, last status, and when it landed.
- A live test closes a far-future day such as 2099-01-01 with `test: true`, or inserts a `deliveries` row whose payload has `test: true`, and removes it as soon as the check is done, so it never shows in History. Delete its `deliveries` rows, then its `food_entries`, then the `days` row; the foreign keys need that order.

## Data

Schema `nutrition`. See `migrations/0001-create-schema.sql`.

- `days`, `food_entries`, `plan_versions`, `phases`, `phase_trackers`, `weigh_ins`, `deliveries`.
- Views: `daily_weights` takes one weigh-in a day, preferring Withings, then the bot, then the sheet, then the daily files. `weight_trend` adds unrounded rolling averages, and `day_totals` sums the entries.
- Plan versions are never edited. A change starts a new version on its `effective_from` date. `steps_target` is optional and carries forward from the previous version unless `update_targets` sets it or sends `null`. No target means Today shows bare steps. Targets never move with steps.
- Steps come from `activity.daily_activity` when Withings has the day, and from the bot's `update_day` steps otherwise. Withings wins.
- Expenditure comes only from `getExpenditure` in `store.ts`, behind `GET /expenditure`. A better TDEE model replaces that one function and keeps the response shape, so the UI doesn't change. Today it calls `rangeExpenditure` in `phase.ts`: mean intake over closed, non-partial logged days, minus the 7-day trend change at 3,500 kcal a pound over the days between the range's first and last trend points. Under `MIN_EXPENDITURE_DAYS` (14) logged days, or a span under 14 days, it shows no number.
- `phase.ts` reproduces the sheet's Phase tracker: compounding planned weight, calendar-window averages, and a 28-day TDEE. Only closed days with kcal that aren't partial count as logged, so a half-logged day doesn't drag the averages or the TDEE down. The sheet counted those days. `phase.test.ts` pins it to the sheet.

## Import

`import.ts` loads the `training-log` repo's `nutrition/` files and the sheet's Weight tab in one transaction. Every row upserts on its natural key, so running it again changes nothing.

```bash
bun tools/nutrition/import.ts --training-log ../training-log --weights weights.csv [--cutover YYYY-MM-DD] [--dry-run]
```

- `weights.csv` has the columns `date_serial,weight_lb,rolling_7d,rolling_14d,rolling_28d`. The date is the sheet's serial number. Leave the rolling columns empty on rows that shouldn't be checked.
- The run rolls back unless every day's entries add up to the file's totals and `weight_trend` matches the sheet's averages to 0.01 lb. The totals check allows 1 unit, or half a unit per entry on tracker-export days.
- `--cutover` refuses daily files on or after that date, once the bot writes only through MCP.
- It connects with `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB`, like `bun run migrate`.
