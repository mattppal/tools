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
| `bun run build` | Skill check, then build the Worker, client, and service worker into `dist/`. |
| `bun run typecheck` | `tsc --noEmit` over `src`, `worker`, `tools`, `scripts`. |
| `bun run new-tool <slug>` | Scaffold `tools/<slug>/`. See `tools-add-a-tool`. |
| `bun run check:skills` | Run the skill check alone. |
| `bun run deploy` | Build and deploy to production. Workers Builds does this on push to `main`. |
| `bun run preview` | Build and upload a preview with `wrangler preview`. |
| `bunx wrangler types` | Regenerate `worker-configuration.d.ts` after editing `wrangler.jsonc`. |

Run `bun run build` and `bun run typecheck` before you push.

## Database

The `env.DB` binding is Hyperdrive in front of the PlanetScale Postgres database `tools` (org `mattppalmer`). Worker code calls `withDb(env, ...)` from `worker/db.ts`; tool APIs get `db(...)` in their context.

| Where | Branch | Hyperdrive config |
| --- | --- | --- |
| Production | `main` | `tools-db` |
| Previews | `preview` | `tools-db-preview` (the `previews` block in `wrangler.jsonc`) |
| `bun run dev` | whatever `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB` points at | none |

`bun run dev` starts with no setup. By default it connects to `postgresql://postgres@127.0.0.1:5432/postgres`, so a local Postgres just works. Without one, the app still runs and `/api/health` reports the database as down.

For real data, run `bun run dev:db` once. It needs `PLANETSCALE_TOKEN_ID` and `PLANETSCALE_API_TOKEN`, creates a 7-day role on the `preview` branch, and writes the connection string to `.env` (gitignored). To use another database, copy `.env.example` to `.env` and edit it. Never point local dev at `main`.

`GET /api/health` runs `select now()` through the binding and returns the latency.
