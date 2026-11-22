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
| `bun run migrate` | Apply pending `tools/<slug>/migrations/*.sql` to the database in `.env`. Add `--dry-run` to list them. A PlanetScale host (`preview`, `main`) only gets files from `origin/main` or `--ref <ref>` containing it, never from your working tree. |
| `bun run build` | Skill and style checks, then write `public/build.json` and build the Worker, client, and service worker into `dist/`. |
| `bun run typecheck` | `tsc --noEmit` over `src`, `worker`, `tools`, `scripts`. |
| `bun run test` | `bun test` over `worker`, `tools`, `src`, and `scripts`. Vendored skills keep their own tests, which this skips. |
| `bun run test:e2e` | Serve `dist/` with `vite preview` in workerd and check routing, cache headers, that every image the build references (the sidebar logo included) is served as that image, and that bot routes refuse a caller without the token. Run `bun run build` first. |
| `bun run new-tool <slug>` | Scaffold `tools/<slug>/`. See `tools-add-a-tool`. |
| `bun run check:skills` | Run the skill check alone. |
| `bun run check:style` | Fail on code comments, status dots and pills, and a tool that imports `withRequestDb`. `bun run build` runs it too. |
| `bun run check:borderless` | Fail on a border or shadow that doesn't read the style tokens, a style token set outside `src/styles/hairline.css`, and any border on the shell's panes. `bun run build` runs it too. |
| `bun run verify:webhooks` | Model-check webhook delivery with TLC. Needs Java 11 or newer. `skills/tools-verify-webhooks/SKILL.md` explains the results. |
| `bun run notify [<for>] <label> --subject <text>` | Send a coordinator notice to the tools liaison (for the liaison itself unless `<for>` names a bot or `all`), body from stdin or `--body-file`. `--list` shows recent liaison deliveries. See `tools/liaison/SKILL.md`. |
| `bun run icons` | Regenerate the favicons and app icons in `public/` from `src/assets/logo.png`. |
| `bun run land <pr>` | Merge a PR: fast-forward `main` to its head once it contains `main` and every check is green, then confirm GitHub shows it merged. When the PR changes a migration, land first applies the head's migrations to `preview` and then `main` with 15-minute PlanetScale roles, so it needs `PLANETSCALE_TOKEN_ID` and `PLANETSCALE_API_TOKEN`. |
| `bun run smoke` | Check the live app as the `tools-agent-verify` Access service token, read-only: `/build.json` (and `--sha <commit>`, with `--wait <seconds>` for a deploy to arrive), `/api/health` including migration drift, every read route, every image the shell references, 404s, the nutrition MCP refusing GET, `workouts/sync` refusing the smoke identity, a 302 without Access credentials, and the Worker's 403 for a token off its allowlist when `SMOKE_UNLISTED_CLIENT_ID`/`SECRET` are set. Needs `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`. `--target` takes production (the default) or a `https://<branch>-tools.mpal.workers.dev` preview, nothing else. `--branch <name>` targets that branch's preview. The `smoke` workflow runs it on every PR against the PR's preview (waiting for it to serve the head commit, with `--allow-pending-migrations` because `bun run land` applies a PR's migrations), after every push to `main` against production (waiting for that commit), hourly against production, and on demand (`workflow_dispatch` with `target`, `sha`). `bun run land` needs every check green, so a PR whose preview fails smoke can't land, and a failed run on `main` is the alert. |
| `bun run deploy` | Build and deploy to production. Workers Builds does this on push to `main`. |
| `bun run preview` | Build and upload a preview with `wrangler preview`. |
| `bunx wrangler types` | Regenerate `worker-configuration.d.ts` after editing `wrangler.jsonc`. |

Run `bun run build`, `bun run typecheck`, `bun run test`, and `bun run test:e2e` before you push. The `checks` workflow runs them on every PR and on `main`, along with `bun run verify:webhooks` and the Postgres tests. Set `TEST_DATABASE_URL` to run the Postgres tests locally; without it they skip.

Land a PR only with `bun run land <pr>`. Pushing anything else to `main`, such as a local squash, leaves GitHub showing the PR closed instead of merged.

## Database

The `env.DB` binding is Hyperdrive in front of the PlanetScale Postgres database `tools` (org `mattppalmer`). `docs/database.md` is the full reference. For Postgres itself (schema, indexes, query plans, connections), read PlanetScale's `skills/postgres/SKILL.md`. To review the database's safety settings, query load, or Traffic Control, read `skills/planetscale-postgres-safety-review/SKILL.md`. Where `postgres` says to send application traffic to PgBouncer on port 6432, ignore it here: Hyperdrive is the pool and connects on 5432. Tool APIs get `db(...)` in their context. Every API request gets one connection from `withRequestDb` in `worker/db.ts`, which closes it with `ctx.waitUntil(client.end())` after the response. Never create a `pg` client at module scope.

| Where | Branch | Hyperdrive config |
| --- | --- | --- |
| Production, `wrangler versions upload`, `wrangler dev --remote` | `main` | `tools-db` |
| `wrangler preview` | `preview` | `tools-db-preview` (the `previews` block in `wrangler.jsonc`) |
| `bun run dev` | whatever `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB` points at | none |

`bun run dev` starts with no setup. By default it connects to `postgresql://postgres:postgres@127.0.0.1:5432/postgres`, so a local Postgres with that password just works. Without one, the app still runs and `/api/health` reports the database as down.

For real data, run `bun run dev:db` once. It needs `PLANETSCALE_TOKEN_ID` and `PLANETSCALE_API_TOKEN`, creates a 7-day read-and-write role (no DDL) on the `preview` branch, and writes the connection string to `.env` (gitignored). To use another database, copy `.env.example` to `.env` and edit it. Never point local dev at `main`.

`GET /api/health` runs `select now()` through the binding and returns `latencyMs`, `connectMs`, `queryMs`, and `migrations` (`pending`, `changed`, `unknown` against the bundled files). It answers 503 with the error, or when a migration is pending or changed.

`GET /api/debug` feeds the Debug section of `/settings`: the deployed version and its time from the `CF_VERSION_METADATA` binding, the Access email from `Cf-Access-Authenticated-User-Email`, and each tool's webhook backlog and `debug.ts` rows. `bun run build` writes the commit SHA and branch to `public/build.json` (gitignored). On Workers Builds they come from `WORKERS_CI_COMMIT_SHA` and `WORKERS_CI_BRANCH`, and locally from git.

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

Hyperdrive keeps about 5 idle connections warm at rest, which is normal. Create PlanetScale roles only with `createRole` in `scripts/planetscale.ts`, never with `inherited_roles: ["postgres"]` by hand. The Roles section of `docs/database.md` has the recipe. If you create one for testing, name it `agent-<task>`, use the `read` kind unless you must write, give it a TTL of one day or less, connect on port 5432, and end its leftover idle sessions with `pg_terminate_backend`. `docs/database.md` has the query that shows who holds connections.
