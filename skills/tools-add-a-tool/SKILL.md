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

## Folder contract

| File | Required | Purpose |
| --- | --- | --- |
| `tool.ts` | yes | `export default defineTool({ name, description, icon?, order?, hidden? })`. Icons are the names in `src/shell/icons.tsx`. |
| `index.tsx` | yes | Default-exported React component. Loaded lazily. Render `ToolLayout` at the top. |
| `SKILL.md` | yes | The tool's skill. `name: tool-<slug>`. The build fails without it. |
| `api.ts` | no | `export default defineToolApi(handler)`. Served at `/api/tools/<slug>/*`. |
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

## Remove a tool

Delete `tools/<slug>/`. If it had migrations, run `drop schema <schema> cascade`.
