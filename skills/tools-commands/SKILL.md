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
| `bun run build` | Skill check, then build the Worker, client, and service worker into `dist/`. |
| `bun run typecheck` | `tsc --noEmit` over `src`, `worker`, `tools`, `scripts`. |
| `bun run new-tool <slug>` | Scaffold `tools/<slug>/`. See `tools-add-a-tool`. |
| `bun run check:skills` | Run the skill check alone. |
| `bun run deploy` | Build and deploy to production. Workers Builds does this on push to `main`. |
| `bun run preview` | Build and upload a preview with `wrangler preview`. |
| `bunx wrangler types` | Regenerate `worker-configuration.d.ts` after editing `wrangler.jsonc`. |

Run `bun run build` and `bun run typecheck` before you push.

## Database

Production reaches the PlanetScale Postgres database `tools` (org `mattppalmer`, branch `main`) through the Hyperdrive config `tools-db`, bound as `env.DB`. Worker code calls `withDb(env, ...)` from `worker/db.ts`; tool APIs get `db(...)` in their context.

`bun run dev` needs a direct connection string for that binding. Put it in your shell, not in a file you commit:

```bash
export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB='postgres://USER:PASSWORD@HOST:5432/postgres?sslmode=require'
```

Get credentials by creating a role on the `main` branch in the PlanetScale dashboard, or with the API using `PLANETSCALE_TOKEN_ID` and `PLANETSCALE_API_TOKEN`. A local Postgres works too.

`GET /api/health` runs `select now()` through the binding and returns the latency.
