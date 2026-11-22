---
name: tools-commands
description: Standard commands for the tools repo - install, dev server, build, typecheck, deploy, preview, and connecting to the PlanetScale database locally through Hyperdrive. Use when running or verifying anything in this repo.
---

# Commands

The repo uses bun. Install it with `curl -fsSL https://bun.sh/install | bash` if `bun` is missing.

| Command | What it does |
| --- | --- |
| `bun install` | Install dependencies from `bun.lock`. |
| `bun run dev` | Vite dev server with the Worker at http://127.0.0.1:5173. |
| `bun run dev:db` | Point local dev at the PlanetScale `preview` branch. Writes `.env`. |
| `bun run migrate` | Apply pending `tools/<slug>/migrations/*.sql` to the database in `.env`. Add `--dry-run` to list them. |
| `bun run build` | Skill check, then build the Worker, client, and service worker into `dist/`. |
| `bun run typecheck` | `tsc --noEmit` over `src`, `worker`, `tools`, `scripts`. |
| `bun run new-tool <slug>` | Scaffold `tools/<slug>/`. See `tools-add-a-tool`. |
| `bun run check:skills` | Run the skill check alone. |
| `bun run deploy` | Build and deploy to production. Workers Builds does this on push to `main`. |
| `bun run preview` | Build and upload a preview with `wrangler preview`. |
| `bunx wrangler types` | Regenerate `worker-configuration.d.ts` after editing `wrangler.jsonc`. |

Run `bun run build` and `bun run typecheck` before you push.

## Database

The `env.DB` binding is Hyperdrive in front of the PlanetScale Postgres database `tools` (org `mattppalmer`). `docs/database.md` is the full reference. For Postgres itself (schema, indexes, query plans, connections), read PlanetScale's `skills/postgres/SKILL.md`. To review the database's safety settings, query load, or Traffic Control, read `skills/planetscale-postgres-safety-review/SKILL.md`. Where `postgres` says to send application traffic to PgBouncer on port 6432, ignore it here: Hyperdrive is the pool and connects on 5432. Tool APIs get `db(...)` in their context. Every API request gets one connection from `withRequestDb` in `worker/db.ts`, which closes it with `ctx.waitUntil(client.end())` after the response. Never create a `pg` client at module scope.

| Where | Branch | Hyperdrive config |
| --- | --- | --- |
| Production, `wrangler versions upload`, `wrangler dev --remote` | `main` | `tools-db` |
| `wrangler preview` | `preview` | `tools-db-preview` (the `previews` block in `wrangler.jsonc`) |
| `bun run dev` | whatever `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB` points at | none |

`bun run dev` starts with no setup. By default it connects to `postgresql://postgres:postgres@127.0.0.1:5432/postgres`, so a local Postgres with that password just works. Without one, the app still runs and `/api/health` reports the database as down.

For real data, run `bun run dev:db` once. It needs `PLANETSCALE_TOKEN_ID` and `PLANETSCALE_API_TOKEN`, creates a 7-day role on the `preview` branch, and writes the connection string to `.env` (gitignored). To use another database, copy `.env.example` to `.env` and edit it. Never point local dev at `main`.

`GET /api/health` runs `select now()` through the binding and returns `latencyMs`, `connectMs`, and `queryMs`, or a 503 with the error.

## Connection budget

Each PlanetScale branch allows 25 connections. Postgres reserves 3 for superusers, so everything else shares 22. Hyperdrive's limit is soft, so the budget keeps spare slots.

| Consumer | `main` | `preview` |
| --- | --- | --- |
| PlanetScale exporter | 1 | 1 |
| Hyperdrive origin connection limit | 12 (`tools-db`) | 8 (`tools-db-preview`) |
| Local dev servers, one connection per in-flight request | 0 | 6 |
| `bun run migrate` | 1 | 1 |
| Dashboard and ad hoc queries | 2 | 2 |
| Spare for Hyperdrive going over its limit | 6 | 4 |

Hyperdrive keeps about 5 idle connections warm at rest, which is normal. If you create a PlanetScale role for testing, name it `agent-<task>` with a TTL of one day or less, connect on port 5432, and end its leftover idle sessions with `pg_terminate_backend`. `docs/database.md` has the query that shows who holds connections.
