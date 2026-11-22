---
name: tool-nutrition
description: "The Nutrition tool at /nutrition. Matt's daily food log against kcal and macro targets, the weight trend, the phase tracker, the nutrition bot's MCP server, and the day-closed webhook. Use when changing tools/nutrition/ or wiring the nutrition bot."
---

# Nutrition

Matt logs food here and the nutrition bot logs it over MCP. Both write through `store.ts`, so the UI and the bot see the same day.

## UI

Five views nest under Nutrition in the sidebar as sections (`VIEWS` in `ui.tsx`). None of them use status dots. States show as words or as bar color.

Every bar and chart can be inspected. Hovering, keyboard focus, or a tap on a phone opens a compact tooltip with the date, the value against its target, and the day's state. Bars use `Inspect` from `inspect.tsx`, which wraps the kit tooltip with a 150 ms delay and opens on tap. Charts snap a crosshair to the nearest day. With the chart focused, the arrow keys move a day, Page Up and Page Down move a week, Home and End jump to the ends, and Escape clears. A screen reader hears the same readout through a live region.

- Today (`/nutrition`, `?date=YYYY-MM-DD` for another day). Four range bars for kcal, protein, fat, and carbs, each reading "N to go", "in range", or "+N over". Each fill is a muted tint from the `--change-*` tokens: blue under the target, green in range, and red over it. Under the kcal bar a muted, untinted line shows the day's steps, plus "N to go" or "target met" when the plan has a steps target. With no steps the line is absent. Each bar's tooltip gives the date, the value against the range, how far it is from the low end or the top, and whether the day is open, closed, or estimated. The steps tooltip gives the steps against the target, or says the plan has none. Under the bars is the bot's check-in line, then the entries. A row opens the right panel to edit or delete it. Add food is one labeled button under the entries, pinned to the bottom of the screen while the list scrolls. It and each row open the same right panel, which holds only the entry form so it can move to another container. Saves show at once and roll back with an error in the panel if the request fails. Close day locks the entries and fires the webhook. Reopen unlocks them.
- History (`/nutrition/history`). One row per day, newest first, with "Open" on days that aren't closed and the day's steps in the muted text when there are any. A three-way filter, saved in the browser, picks what shows. Logged, the default, shows days with entries that aren't partial. With partial adds partial days, marked "Partial" in the row's muted text. All days adds days with no entries. A muted line under the list says how many days are hidden. Days with entries and a plan get a thin kcal bar along the bottom of the row, drawn against the plan range (`kcalRange` from `/history`) and tinted like Today's. The bar sits beside the row's link rather than inside it, so tapping it opens the tooltip and tapping the rest of the row opens the day. The tooltip gives the date, kcal against the range, how far under or over, and whether the day is partial, closed, or open. A day is partial when it is closed and its kcal is under `PARTIAL_DAY_SHARE` (50%, in `types.ts`) of its target: the midpoint of that day's plan range, or the phase tracker's kcal target when no plan version covers it.
- Weight (`/nutrition/weight`). One range drives everything on the page: 90 days, 1 year, all, a From and To date, or a mouse drag across the chart. Under the controls is a summary of the range: start and end average, change, mean weight, and weekly rate. A second row shows Expenditure, the measured TDEE for the range, with the number of logged days it uses, and the average steps a day. Summary cells sit in `minmax(0, 1fr)` tracks and their text wraps, so a long value never runs into the next cell. The chart draws the 7-day, 14-day, or 28-day average in `--chart-accent` over muted weigh-ins, and either layer can be hidden. Hovering, or tapping on a phone, snaps to the nearest weigh-in. A dashed crosshair appears, with the date on the x-axis and both the weigh-in and the trend value on the y-axis. Dragging with a mouse still selects a range. Changes in the summary and the table are tinted by direction: on a cut, a loss reads as good and a gain as bad, and the reverse on a gain. Any other phase uses neutral blue for a loss and amber for a gain. The tint grows with the size of the change, from 30% at small values to full at 2 lb for one weigh-in, 3 lb for the range, or 1 lb a week. Values that round to zero stay untinted. The table below lists date, weight, the chosen average, and the change from the previous weigh-in, 50 rows a page, sortable by any column. Under 640 px each row stacks onto two lines. A source filter appears only when the data has more than one source. The page loads every weigh-in once and filters in the browser.
- Steps (`/nutrition/steps`). Built from the same pieces as Weight in `series.tsx`: the range control, the 7, 14, or 28-day switch, the chart with hover and drag, and the sortable table. Daily steps draw as muted bars from zero with the trend line over them. The summary shows the average a day, the total, the change in daily average against the same number of days just before the range, tinted green for more and red for fewer, and how many days met the target when a plan sets one. On top of the axis readout, the chart's tooltip says whether that day met the target or how far short it fell. Days with no steps, or zero, are left out rather than drawn as zero.
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
| `GET /steps` | Every day with steps, Withings first and the bot second, with calendar-window 7, 14, and 28 day averages and the plan's steps target for that day, oldest first. |
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

The bot sends `CF-Access-Client-Id` and `CF-Access-Client-Secret` from the `nutrition-bot` Access service token, and an explicit `User-Agent`. That token is its only credential; `Authorization: Bearer <BOT_TOKEN_NUTRITION>` still works until the bearer-removal PR, but isn't needed. A 302 to `cloudflareaccess.com` means the Access headers are missing or wrong, a 403 naming the bot means the route is outside its scopes, and a 403 with Cloudflare error 1010 means Browser Integrity Check blocked a client's default User-Agent, such as Python urllib's.

Since the 2026-11-22 cutover the bot logs each food through `log_food` as Matt reports it, and this database is the source of truth. Days on or after the cutover never come from `training-log`; rerun the import only with `--cutover 2026-11-22`.

A retry is safe with the same body. An add whose `client_key` exists is skipped, an edit sets the same values again, and a remove of an entry that is already gone is skipped. A remove of an entry that sits on another day is rejected.

Every object in a tool's input is strict. An argument name the tool doesn't know, such as `bodyweight` for `bodyweight_lb` or `calories` on a food, fails the call with `isError: true` and `Unrecognized key`, instead of being dropped while the call reports success.

### Requests

`POST /api/tools/nutrition/mcp` with `Content-Type: application/json` (otherwise 415) and `Accept: application/json, text/event-stream` (otherwise 406). The endpoint is stateless, so `tools/call` works without `initialize`. A rejected call is still HTTP 200, with `result.isError: true` and the reason in `content[0].text`. `mcp.test.ts` sends each body below, in order, so they stay true.

Log a food:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "log_food", "arguments": { "date": "2099-01-01", "add": [{ "client_key": "bot:msg-1:0", "food": "Greek yogurt, plain nonfat", "qty": 200, "unit": "g", "kcal": 118, "protein_g": 20.6, "carbs_g": 7.2, "fat_g": 0.8, "fiber_g": 0, "source": "USDA FDC 170894 (Yogurt, Greek, plain, nonfat)" }] } } }
```

Edit it by its key, then remove it:

```json
{ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "log_food", "arguments": { "date": "2099-01-01", "edit": [{ "client_key": "bot:msg-1:0", "qty": 250, "kcal": 147.5 }] } } }
```

```json
{ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "log_food", "arguments": { "date": "2099-01-01", "remove": ["bot:msg-1:0"] } } }
```

Read the day, set the check-in, and close it:

```json
{ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "update_day", "arguments": { "date": "2099-01-01" } } }
```

```json
{ "jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": { "name": "update_day", "arguments": { "date": "2099-01-01", "bodyweight_lb": 181.2, "steps": 12000, "energy": 7, "sleep": 8, "notes": "Felt good", "closed": true } } }
```

Reopen it:

```json
{ "jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": { "name": "update_day", "arguments": { "date": "2099-01-01", "closed": false } } }
```

Start a plan version, and read the tracker:

```json
{ "jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": { "name": "update_targets", "arguments": { "effective_from": "2099-01-01", "kcal": { "min": 2600, "max": 2900 }, "protein_g": { "min": 170, "max": 200 }, "fat_g": { "min": 55, "max": 70 }, "carbs_g": { "min": 330, "max": 380 }, "steps_target": 10000, "change": "Maintain" } } }
```

```json
{ "jsonrpc": "2.0", "id": 8, "method": "tools/call", "params": { "name": "get_phase_summary", "arguments": { "date": "2099-01-01" } } }
```

## Webhook

Closing a day in the UI POSTs to `NUTRITION_WEBHOOK_URL`. Closing it through `update_day` sends nothing, because the bot already knows.

- Headers: `Authorization: Bearer <NUTRITION_WEBHOOK_KEY>`, where the secret holds the raw key and `worker/webhooks.ts` adds `Bearer `, `X-Nutrition-Delivery: <uuid>`, and `content-type: application/json`.
- Body: `{ app: "nutrition", event: "day.closed", data: { event, deliveryId, date, closedAt, estimated, entries, totals, targets, progress, test? } }`. The receiver rejects a body without `app` or `data`. `webhook.ts` declares the app and its events with `envelope`, and `worker/webhooks.ts` wraps the stored payload as `data` on every send, so retries of older rows go out in this shape too. `targets` and `progress` are null when no plan covers the day.
- `test: true` sits in `data` only for a test close, `POST /day/close` with `{ date, test: true }`. A real close has no `test` key.
- `closeDayFromUi` writes the delivery row in the same transaction as the close. The route then tries it once with `deliverSoon`, and the every-minute cron in `worker/webhooks.ts` retries it with backoff until a 2xx. Every retry keeps the same delivery ID.
- `nutrition.deliveries` shows each delivery's attempts, last status, and when it landed.
- The same close also queues `day.closed` for the tools liaison (`tools/liaison/`), in the same transaction and under the same delivery ID, with body `{ app: "nutrition", event: "day.closed", deliveryId, test?, data: { date, closedAt, estimated, entries, totals, targets, progress } }`. `totals` is always present, and `targets` is null when no plan covers the day; the nutrition bot relies on both. Until phase 2 of `docs/webhook-simplification.md` in the Project store, the bot gets each close twice and dedupes on the delivery ID.
- A live test closes a far-future day such as 2099-01-01 with `test: true`, or inserts a `deliveries` row whose payload has `test: true`, and removes it as soon as the check is done, so it never shows in History. Delete its `liaison.deliveries` and `deliveries` rows, then its `food_entries`, then the `days` row; the foreign keys need that order.

## Data

Schema `nutrition`. See `migrations/0001-create-schema.sql`.

- `days`, `food_entries`, `plan_versions`, `phases`, `phase_trackers`, `weigh_ins`, `deliveries`.
- Views: `daily_weights` takes one weigh-in a day, preferring Withings, then the bot, then the sheet, then the daily files. `weight_trend` adds unrounded rolling averages, and `day_totals` sums the entries.
- Plan versions are never edited. A change starts a new version on its `effective_from` date. `steps_target` is optional and carries forward from the previous version unless `update_targets` sets it or sends `null`. No target means Today shows bare steps. Targets never move with steps.
- Steps come from `activity.daily_activity` when Withings has the day, and from the bot's `update_day` steps otherwise. Withings wins.
- Expenditure comes only from `getExpenditure` in `store.ts`, behind `GET /expenditure`. A better TDEE model replaces that one function and keeps the response shape, so the UI doesn't change. Today it calls `rangeExpenditure` in `phase.ts`: mean intake over closed, non-partial logged days, minus the 7-day trend change at 3,500 kcal a pound over the days between the range's first and last trend points. Under `MIN_EXPENDITURE_DAYS` (14) logged days, or a span under 14 days, it returns no number, and the cell reads "Needs N logged days" with "M so far", where N is the response's `minDays`.
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
