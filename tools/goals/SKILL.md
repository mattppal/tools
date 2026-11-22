---
name: tool-goals
description: "The Goals tool at /goals. Yearly and quarterly goals by area, with check-ins, for Matt and gtd bot. Use when changing tools/goals/, its MCP tools, or its tables."
---

# Goals

Matt's goals by year and quarter, grouped by area, with dated check-ins. The tools database is the source of truth for goals, check-ins and each year's north star. Todoist holds the next actions, and a goal stores only the Todoist ids it links to. There is no webhook; gtd bot pulls.

## UI

`index.tsx` picks the page from `useToolPath()`. Every page has a year switcher, and `?year=` holds the year.

| Path | Page |
| --- | --- |
| `/goals` | The year's north star, then its goals by area. Each goal shows its status as plain text, its latest check-in, and a Check in button that opens a form under the goal. |
| `/goals/quarters` | The year's quarter goals in four columns, one per quarter, stacked on phones. |
| `/goals/themes` | Year goals by area across every year, one row per area. |

Status is a word in the meta line, never a pill, chip, badge, dot or color. The check-in form takes a note, an optional percent, and an optional new status. It saves with `source: "matt"`.

## API

| Route | Who | Does |
| --- | --- | --- |
| `GET /api/tools/goals/overview` | Matt | `{ years: [{ year, northStar }], goals: Goal[] }`, every goal with its latest check-in |
| `POST /api/tools/goals/checkins` | Matt | `{ goal_id, note, progress?, date?, status? }`. Adds a check-in and, with `status`, changes the goal's status first. Returns `{ goal, checkin }`. A rejection is a 409 with `{ error }`. |
| `POST /api/tools/goals/mcp` | gtd bot | MCP, below |

A service token gets 403 on the page routes.

## Bot

`bot.ts` mounts the tools with `toolMcp` from `worker/mcp.ts`. Only `gtd-bot` can call them.

| Tool | Flow |
| --- | --- |
| `upsert_goal` | Create a goal, or update one by `id` or by year, horizon, quarter and title. Omitted fields keep their values. No status or Todoist fields. |
| `bulk_import` | Goals and north stars in one transaction, all or nothing. Idempotent on the natural key. `status` only as the source states it. `parent_title` names a year goal in the same year. |
| `list_goals` | Filter by year, area and status. Read-only. |
| `set_status` | Set the status and record the note as a check-in. |
| `add_checkin` | A dated note with an optional percent. Never changes the status. |
| `link_todoist` | Set the Todoist project and replace the task id list. |
| `set_north_star` | Set one year's north star. |
| `get_year` | The north star and every goal of one year. Read-only. |

gtd bot authenticates with its Access service token alone: `CF-Access-Client-Id` and `CF-Access-Client-Secret` from `gtd-bot`, and an explicit `User-Agent`. There is no bearer. The Worker reads the token's name from the verified Access JWT (`worker/access.ts`) and `worker/bot-auth.ts` scopes `gtd-bot` to this tool. Any other tool answers it with 403 `Forbidden: gtd-bot may not call <tool>`. The client ID and secret live in the 1Password item `tools-gtd-bot`.

Status is never inferred. A new goal starts at `unknown`. Only `set_status`, `bulk_import` with an explicit `status`, and Matt's check-in form change it. Each check-in records the goal's status at that moment as `statusAtCheckin`.

Inputs are snake_case and strict: an argument name a tool doesn't list, at any depth, fails the call with `MCP error -32602` and `Unrecognized key`. Outputs are camelCase. The contract with every shape is `docs/goals-contract.md` in the Project store.

### Requests

`POST /api/tools/goals/mcp` with `Content-Type: application/json` and `Accept: application/json, text/event-stream`. A rejected call is HTTP 200 with `result.isError: true` and the reason in `content[0].text`. `goals.test.ts` sends each body below, in order, replacing `<goal id>` with the id `upsert_goal` returned, so they stay true. Test data uses year 2099.

Import a year:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "bulk_import", "arguments": { "years": [{ "year": 2099, "north_star": "Strong, calm, and shipping weekly" }], "goals": [{ "year": 2099, "horizon": "year", "area": "content", "title": "Ship 50 videos", "metric": "videos published", "target": "50" }, { "year": 2099, "horizon": "quarter", "quarter": 1, "area": "content", "title": "Ship 12 videos", "parent_title": "Ship 50 videos" }] } } }
```

Create or update one goal:

```json
{ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "upsert_goal", "arguments": { "year": 2099, "horizon": "year", "area": "fitness", "title": "Squat 315 x 3", "metric": "top set", "target": "315 x 3" } } }
```

Check in, set the status, and link Todoist:

```json
{ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "add_checkin", "arguments": { "goal_id": "<goal id>", "note": "Hit 295 x 3", "progress": 60 } } }
```

```json
{ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "set_status", "arguments": { "id": "<goal id>", "status": "active", "note": "Matt confirmed this is the focus" } } }
```

```json
{ "jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": { "name": "link_todoist", "arguments": { "goal_id": "<goal id>", "project_id": "2203306141", "task_ids": ["7012345678"] } } }
```

Read:

```json
{ "jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": { "name": "list_goals", "arguments": { "year": 2099, "area": "fitness" } } }
```

```json
{ "jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": { "name": "set_north_star", "arguments": { "year": 2099, "north_star": "Strong, calm, and shipping every week" } } }
```

```json
{ "jsonrpc": "2.0", "id": 8, "method": "tools/call", "params": { "name": "get_year", "arguments": { "year": 2099 } } }
```

## Data

Schema `goals`, from `migrations/0001-create-schema.sql`.

| Table | Holds |
| --- | --- |
| `goal_years` | One row per year: `north_star`. A goal write for a new year inserts the row with an empty north star. |
| `goals` | `year`, `horizon` (`year` or `quarter`), `quarter` (1 to 4, set only for quarter goals), `area`, `title`, `description`, `metric`, `target`, `status` (default `unknown`), `parent_id`, `source_url`, `todoist_project_id`, `todoist_task_ids`. Unique on `(year, horizon, coalesce(quarter, 0), lower(title))`. |
| `goal_checkins` | `goal_id`, `date`, `note`, `progress` (0 to 100 or null), `status_at_checkin`, `source` (`matt` or `gtd-bot`). The latest is the newest `date`, then `created_at`. |

Areas, in display order: fitness, relationships, career, content, finance, life-quality, systems, inner.
