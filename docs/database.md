# Database

The Worker reaches PlanetScale Postgres (org `matt-palmer`, database `tools`) through the Hyperdrive binding `env.DB`.

| Where | PlanetScale branch | How it connects |
| --- | --- | --- |
| Production, `wrangler versions upload`, `wrangler dev --remote` | `main` | Hyperdrive `tools-db` |
| `wrangler preview` (Workers Builds on branches other than `main`) | `preview` | Hyperdrive `tools-db-preview`, from the `previews` block in `wrangler.jsonc` |
| `bun run dev` | whatever `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB` points at | Direct connection, no pool |

This page covers how this repo uses the database. For Postgres itself, read PlanetScale's skills, which are vendored in `skills/`:

| Skill | Use it for |
| --- | --- |
| `skills/postgres/SKILL.md` | Schema design, indexes, query plans, MVCC and vacuum, connections, and PlanetScale features such as Insights and the CLI |
| `skills/planetscale-postgres-safety-review/SKILL.md` | Reviewing the database's roles, backups, branches, query tags, and Traffic Control |
| `skills/planetscale-query-insights-and-tags/SKILL.md` | Finding which queries cause load, with Insights and SQLCommenter query tags |
| `skills/planetscale-traffic-control-recommendations/SKILL.md` | Planning Traffic Control budgets without applying them |

The `postgres` skill sends application traffic to PlanetScale's PgBouncer on port 6432. Here Hyperdrive is the Worker's pool, so Hyperdrive, local dev, and `bun run migrate` all connect on port 5432 and the connection budget below counts them there.

## Querying from a tool

`api.ts` gets `db` in its context. The first `db(...)` call in a request opens one connection. Every later call in that request reuses it, and queries run in the order you send them. The Worker closes the connection with `ctx.waitUntil(client.end())` after the response, so finish database work before the handler returns. A `db(...)` call after that throws `RequestDbClosed`. For a webhook's first attempt, use `deliverSoon`.

```ts
export default defineToolApi(async (request, { db }) => {
	const items = await db(async (client) => (await client.query("select id, label from notes.items order by id")).rows);
	return Response.json({ items });
});
```

- Connecting times out after 5 seconds and each query after 10. Pass `query_timeout` in a query config to change one query.
- For a transaction, send `begin` and `commit` inside one `db(...)` call, and don't run other `db(...)` calls in parallel with it.
- An error thrown from a tool API becomes a `500 {"error":"Internal error"}` response, and the Worker logs the cause.
- Never create a `pg` client at module scope. `worker/db.ts` owns the request's client.

## Health check

`GET /api/health` runs `select now()` on the request's connection. Hyperdrive never caches `now()`, so the check always reaches PlanetScale. The response has `cache-control: no-store`.

| Status | Body |
| --- | --- |
| 200 | `{"ok":true,"db":{"latencyMs":18,"connectMs":2,"queryMs":16}}` |
| 503 | `{"ok":false,"db":{"latencyMs":5004,"error":"Connection terminated unexpectedly"}}` |

Through Hyperdrive, `connectMs` is 1 to 3 ms and `queryMs` is the round trip to PlanetScale. Local dev shows about 60 ms of `connectMs`, because each request opens a fresh TLS connection.

## Migrations

Each tool owns one Postgres schema, named after its slug with `-` replaced by `_`, and its own migrations:

```
tools/<slug>/migrations/0001-create-items.sql
tools/<slug>/migrations/0002-add-done.sql
```

`bun run migrate` applies pending files in order. It runs each file in one transaction as the `postgres` role, with `search_path` set to the tool's schema, and records it in `<schema>._migrations`. Hyperdrive's `tools-app-rw` role reads and writes every table through `pg_read_all_data` and `pg_write_all_data`, so a migration needs no `grant`.

- Never edit or delete an applied file. The runner stops on a changed checksum or a missing file. Add a new migration instead.
- Don't put `begin` or `commit` in a file. Statements that can't run in a transaction, such as `create index concurrently`, are not supported.
- Qualify table names with the schema in queries (`notes.items`). Only migrations get the tool's `search_path`.
- `bun run migrate --dry-run` lists pending files without writing.
- To remove a tool's data, run `drop schema <schema> cascade`.

### Shared databases only get migrations from main

`preview` and `main` are shared by every branch. Their migrations come only from `origin/main`, or from the PR head that `bun run land` is landing:

- `bun run land <pr>` checks whether the PR adds or changes a migration file. If it does, land creates a 15-minute PlanetScale role on `preview` and then on `main` and runs `bun scripts/migrate.ts --ref <head>` on each. It deletes each role afterwards. Only then does it push. If a migration fails, main doesn't move. Land needs `PLANETSCALE_TOKEN_ID` and `PLANETSCALE_API_TOKEN` for such a PR.
- When the target host is `*.psdb.cloud`, `bun run migrate` reads files from `origin/main` (after fetching it), not from your working tree. `--ref <ref>` picks another commit, which must contain `origin/main`. So a branch can't put its migrations on `preview` where every other branch would then trip over them.
- Develop a new migration against a local Postgres (`docs/database.md` "Local development") or the PGlite tests. Apply it to `preview` by landing it.
- The runner leaves migrations it doesn't know about alone and names them. They come from a land that stopped after migrating but before main moved, or from a branch migrated before this rule existed. A changed checksum still stops it.
- `/api/health` compares the bundled migration files with each schema's `_migrations`. It answers 503 with `migrations.pending` or `migrations.changed` when the deployed code expects a migration the database doesn't have.

To apply main's migrations by hand, pass a connection string for a `migrate` role (see Roles), and delete the role when you're done:

```bash
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB="postgresql://...@us-west-3.pg.psdb.cloud:5432/postgres?sslmode=verify-full" bun run migrate
```

## Local development

`bun run dev` reads `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB` from `.env`. Without it, the binding's `localConnectionString` points at a local Postgres on `127.0.0.1:5432` as user `postgres` with password `postgres`, and `/api/health` reports the database as down if none is running. `bun run dev:db` creates a 7-day read-and-write role (no DDL) on the `preview` branch and writes its connection string to `.env`. Never point local dev at `main`.

Local dev has no pool. Each API request opens one direct connection and closes it after the response.

## Roles

Create PlanetScale roles only through `createRole` in `scripts/planetscale.ts`. `scripts/planetscale.test.ts` fails when any other file calls PlanetScale's roles API. Each kind inherits only what it needs:

| Kind | Inherits | Who uses it | TTL |
| --- | --- | --- | --- |
| `app` | `pg_read_all_data`, `pg_write_all_data` | Hyperdrive's `tools-app-rw` on each branch, `bun run dev:db` | none for Hyperdrive, 7 days for dev |
| `read` | `pg_read_all_data` | Agents checking data | 1 day or less |
| `migrate` | `postgres` | `bun run land` (15 minutes, deleted afterwards), migrating by hand | 1 hour at most |

An `app` role can't create, alter, drop or truncate anything, own an object, or `set role postgres`. Never give Hyperdrive, local dev or an agent's check a role that inherits `postgres`. To make one by hand in the PlanetScale dashboard, pick the same inherited roles and a TTL. When you're done with a role, delete it with `postgres` as the successor (`deleteRole` does), so nothing it owns is orphaned.

To rotate Hyperdrive's password:
1. Create a new `app` role and test it.
2. Set it with `bunx wrangler hyperdrive update <id> --origin-user=<username> --origin-password=<password>`, or with the API.
3. Confirm that `pg_stat_activity` shows Hyperdrive under the new user and that `/api/health` returns 200.
4. Delete the old role.

## Connection budget

Both branches allow 25 connections (`max_connections`). Postgres reserves 3 of them for superusers, which leaves 22 for everything else. Hyperdrive's origin connection limit is a soft limit, so each budget keeps spare slots for Hyperdrive going over it during network trouble.

| Consumer | `main` | `preview` |
| --- | --- | --- |
| PlanetScale Patroni, superuser in the reserved slots | 2 | 2 |
| PlanetScale metrics exporter | 1 | 1 |
| Hyperdrive origin connection limit | 12 (`tools-db`) | 8 (`tools-db-preview`) |
| Local dev servers, one connection per in-flight request | 0 | 6 |
| `bun run migrate` | 1 | 1 |
| Dashboard, Insights, ad hoc queries | 2 | 2 |
| Spare for Hyperdrive going over its limit | 6 | 4 |
| Total outside the reserved slots | 22 | 22 |

Hyperdrive keeps idle connections warm with no traffic, so expect about 5 open `tools-db` connections at rest. Change a limit with `bunx wrangler hyperdrive update <id> --origin-connection-limit=<n>`. Redo this table if the cluster size, and so `max_connections`, changes.

## Who holds connections

```sql
select usename, application_name, state, count(*)
from pg_stat_activity
where backend_type = 'client backend'
group by 1, 2, 3
order by 4 desc;
```

`application_name = 'Cloudflare Hyperdrive'` marks Hyperdrive pools. `pscale_admin` and `pscale_exporter` belong to PlanetScale. Match a `pscale_api_<id>` user to its role name in the branch's role list in PlanetScale. Agents that need their own role name it `agent-<task>`, use the `read` kind unless they must write, and give it a TTL of one day or less, so their sessions are easy to spot and end with `pg_terminate_backend(pid)`. Connect on port 5432. PlanetScale's PgBouncer on port 6432 keeps an idle server connection for each role for minutes after the client leaves.
