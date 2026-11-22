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

`api.ts` receives `(request, { env, ctx, path, db })`. `path` is the part after `/api/tools/<slug>`. `db(async (client) => ...)` opens a Postgres connection through Hyperdrive and closes it afterwards.

Only add tables a tool needs. Prefix them with the slug (`<slug>_items`) so tools don't collide. Write the DDL as `create table if not exists` in `tools/<slug>/schema.sql`, apply it with `psql` against the `tools` database, and document each table in the tool's `SKILL.md`.

## Remove a tool

Delete `tools/<slug>/`. Drop its tables if it had any.
