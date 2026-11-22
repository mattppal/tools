---
name: tools-add-a-tool
description: How to add, change, or remove a tool in the tools repo. Covers the tools/<slug>/ folder contract, the new-tool generator, tool APIs, database use, and the per-tool skill. Use for any "add this tool" request.
---

# Add a tool

## Steps

1. Pick a kebab-case slug. It becomes the URL (`/<slug>`) and the folder name.
2. Run `bun run new-tool <slug> --name "Display Name" --description "One line." [--icon <icon>] [--api]`.
3. Build the UI in `tools/<slug>/index.tsx`. Follow `tools-styling`.
4. Fill in `tools/<slug>/SKILL.md` as the tool grows.
5. Run `bun run build` and `bun run typecheck`, then open `/<slug>` in `bun run dev` at phone and desktop widths.

The shell finds the tool by itself. Don't edit the sidebar, the homepage, or the router.

## Reference tools

Workouts and Nutrition are the working examples. Copy from the file that already does what you need.

| Pattern | Look at |
| --- | --- |
| Sections, one page per path | `tools/nutrition/ui.tsx` (`VIEWS`) and `tools/nutrition/index.tsx` (`useToolPath()`) |
| Details panel opened from your own control | `tools/nutrition/today.tsx` (entry form), `tools/workouts/session.tsx` (Review) |
| API routes with input checks | `tools/workouts/api.ts`, `tools/nutrition/api.ts` |
| Migrations and a tool schema | `tools/workouts/migrations/`, `tools/nutrition/migrations/` |
| Bot MCP endpoint | `tools/nutrition/bot.ts` |
| Bot-only HTTP route | `POST /sync` in `tools/workouts/api.ts` |
| Webhook to a bot | `tools/workouts/webhook.ts`, `tools/nutrition/webhook.ts` |
| Cron job | `tools/workouts/cron.ts` |
| Debug rows on `/settings` | `tools/workouts/debug.ts` |
| Tests against PGlite | `tools/workouts/workouts.test.ts`, `tools/nutrition/store.test.ts` |

## Folder contract

| File | Required | Purpose |
| --- | --- | --- |
| `tool.ts` | yes | `export default defineTool({ name, description, icon?, order?, hidden? })`. Icons are the names in `src/shell/icons.tsx`. |
| `index.tsx` | yes | Default-exported React component. Loaded lazily. Render `ToolLayout` at the top. |
| `SKILL.md` | yes | The tool's skill. `name: tool-<slug>`. The build fails without it. |
| `api.ts` | no | `export default defineToolApi(handler)`. Served at `/api/tools/<slug>/*`. |
| `debug.ts` | no | `export default defineToolDebug(async ({ env, db }) => rows)`. Rows show under the tool in the Debug section of `/settings`. |
| `*.module.css` | no | Styles, using the tokens in `src/styles/tokens.css`. |

Keep everything a tool needs inside its folder. Shared code goes in `src/` only when two tools need it.

## API and data

`api.ts` receives `(request, { env, ctx, path, db })`. `path` is the part after `/api/tools/<slug>`. `db(async (client) => ...)` runs on the request's single Postgres connection through Hyperdrive. The first call opens it, and the Worker closes it after the response, so finish database work before the handler returns.

Only add tables a tool needs. A tool's tables live in its own schema, named after the slug with `-` replaced by `_`. Write each change as a numbered file in `tools/<slug>/migrations/` (`0001-create-items.sql`), apply it with `bun run migrate`, and never edit an applied file. Qualify table names with the schema in queries (`my_tool.items`). Document each table in the tool's `SKILL.md`. `docs/database.md` has the full rules.

## Bot access

Bots reach a tool through an MCP endpoint or bot-only HTTP routes. Every bot request carries two credentials:

- an Access service token, sent as `CF-Access-Client-Id` and `CF-Access-Client-Secret`, which Cloudflare Access checks at the edge;
- `Authorization: Bearer <token>`, which the Worker checks against the bot's Worker secret.

`worker/bot-auth.ts` lists each bot, its secret name, and the tools it may call. `requireBot(request, env, "<slug>")` returns the bot's name or a 401 `Response`. A bot whose secret is unset can't authenticate, so a preview deployment without the secret rejects every bot. To add a bot, add a `BOTS` entry, declare its secret on `Env` in the same file, and set the secret with `bunx wrangler secret put <NAME>`.

`worker/mcp.ts` serves MCP as stateless Streamable HTTP with JSON responses, and no Durable Object is needed. `toolMcp` calls `requireBot` before it handles a request.

```ts
const mcp = toolMcp({
	name: "my-tool",
	tools: [
		defineMcpTool({
			name: "get_item",
			description: "One item by id.",
			input: z.object({ id: z.number().int() }),
			readOnly: true,
			run: async ({ id }, { db, bot }) => db(async (client) => (await client.query("select * from my_tool.items where id = $1", [id])).rows[0]),
		}),
	],
});

export default defineToolApi((request, context) => (context.path === "/mcp" ? mcp(request, context) : Response.json({ error: "Not found" }, { status: 404 })));
```

The endpoint is `POST /api/tools/<slug>/mcp`. Throw `McpToolError("message")` to send the bot an error it can act on. Any other error is logged, and the bot sees `Internal error`. `skills/tools-deploy/SKILL.md` covers creating the Access token and policy.

## Webhooks to bots

`worker/webhooks.ts` sends a tool's events to a bot and keeps retrying until the receiver returns a 2xx. Retries wait 1, 2, 4, 8, 16, and 32 minutes, then every 60 minutes, with no limit.

1. Add a deliveries table to the tool's schema. Extra columns are fine.

   ```sql
   create table deliveries (
   	delivery_id uuid primary key,
   	payload jsonb not null,
   	attempts integer not null default 0,
   	next_attempt_at timestamptz not null default now() + interval '1 minute',
   	delivered_at timestamptz,
   	last_status integer,
   	last_error text
   );
   ```

2. Export the webhook from `tools/<slug>/webhook.ts`. A `null` target means the secrets aren't set, as on previews and in local dev. Deliveries then wait in the table.

   ```ts
   export default defineWebhook({
   	table: "my_tool.deliveries",
   	target: (env) => (env.MY_WEBHOOK_URL && env.MY_WEBHOOK_KEY ? { url: env.MY_WEBHOOK_URL, authorization: env.MY_WEBHOOK_KEY, deliveryHeader: "X-My-Tool-Delivery" } : null),
   });
   ```

3. When the event happens, insert the row in the same transaction as the change. Put the `delivery_id` in the payload too. After the transaction, send the first attempt with `ctx.waitUntil(withRequestDb(env.DB, ctx, (db) => deliverDue(db, webhook, env, [deliveryId])))`. The request's own connection closes after the response, so the first attempt opens a fresh one.

Every minute, a cron trigger in `wrangler.jsonc` calls `deliverDue` for each `webhook.ts`. Each request sends `authorization` exactly as given, with no scheme added. The delivery header and the body's `deliveryId` stay the same across retries, so the receiver can drop duplicates. Each send first claims its row by setting `claim_id` and `claimed_until`, sends with no transaction open, and records the result only while `claim_id` still matches, so cron runs, first attempts and "Send again" never send one delivery at the same time. A tool with deliveries adds both claim columns to its deliveries table. A tool that requeues a delivery uses a plain `update` that leaves the claim alone. Before changing any of this, read `skills/tools-verify-webhooks/SKILL.md`.

## Debug rows

`tools/<slug>/debug.ts` adds plain-text rows under the tool's name in the Debug section of `/settings`. It runs in the Worker on each `GET /api/debug`, with the same `env` and `db` as `api.ts`, so keep it to a cheap query or two.

```ts
export default defineToolDebug(async ({ db }) => {
	const sync = await db(async (client) => (await client.query<{ sha: string }>("select sha from my_tool.syncs order by synced_at desc limit 1")).rows[0]);
	return [{ label: "Synced commit", value: sync?.sha.slice(0, 7) ?? "Never synced" }];
});
```

A thrown error shows as an Error row and doesn't break the page. A tool with `webhook.ts` already gets Webhook, Backlog, and Last error rows, so don't repeat them. The page shows every value as is, so never return a secret.

## Remove a tool

Delete `tools/<slug>/`. If it had migrations, run `drop schema <schema> cascade`.
