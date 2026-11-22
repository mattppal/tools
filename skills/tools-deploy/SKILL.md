---
name: tools-deploy
description: How the tools Worker is deployed and protected - Workers Builds, previews, the tools.mattpalmer.io domain, Cloudflare Access, and verifying a deploy through Access. Use before deploying, debugging a deploy, or checking the live site.
---

# Deploy

## Who owns what

The user owns the custom domain, preview settings, and Cloudflare Access. Don't change them. If a task seems to need a change there, write down the exact dashboard steps and values and hand them to the user.

There is one exception, for bots. An agent may create a bot's Access service token and add one Service Auth policy for it to the Access app, following "Bot credentials" below. Never edit or delete the existing policies.

## How deploys happen

- Workers Builds is connected to this repo. Build command `bun run build`, deploy command `bunx wrangler deploy`, preview command `bunx wrangler preview`, run from the repo root.
- Push to `main` deploys production. Other branches get preview deployments.
- Previews use the `previews` block in `wrangler.jsonc`, which binds `DB` to `tools-db-preview` (PlanetScale branch `preview`). Previews never touch production data. Any new binding or var needs a preview-safe value there too. `wrangler preview` only warns about a missing one, and the preview then throws error 1101 wherever the code reads it, so `scripts/wrangler.test.ts` fails `bun run test` instead.
- `bun run deploy` and `bun run preview` do the same from a machine with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set.
- `vite build` writes `.wrangler/deploy/config.json`, which points wrangler at the built Worker in `dist/tools/`. That is why plain `wrangler deploy` works from the root after a build.

## Routing

Built files in `dist/client` are served as they are. Every other request reaches `worker/index.ts`: `/api/*` goes to the API, a missing `/assets/*` file gets a 404, and any other path gets `index.html` for the client router. Don't add `not_found_handling` to `wrangler.jsonc`. It would answer missing assets with `index.html`, which `public/_headers` marks immutable under `/assets/*`.

## Where it runs

| URL | Notes |
| --- | --- |
| https://tools.mattpalmer.io | Custom domain, set in `wrangler.jsonc` `routes`. |
| https://tools.mpal.workers.dev | workers.dev URL. |
| `https://<alias>-tools.mpal.workers.dev` | Preview URLs. |

All of them sit behind the Access app "tools - Cloudflare Workers".

## The Worker checks Access too

`worker/access.ts` verifies the `Cf-Access-Jwt-Assertion` header on every `/api/*` request against the team's signing keys, then admits only the identities in `ACCESS`: Matt's email and the service tokens listed by name and client ID. A token Access lets through but `ACCESS` doesn't list gets a 403 that says "not on the tools allowlist". Writes from another site (an `Origin` or `Sec-Fetch-Site` that isn't this origin) get a 403 too. The only routes without a token are the ones in `ACCESS.publicRoutes`, which must match an Access bypass app. Requests to `localhost` and `127.0.0.1` skip the check so dev and e2e work.

## Verify through Access

Use the service token `tools-agent-verify`, which has a Service Auth policy on that app. Get its client ID and secret from whoever runs the task; never commit them.

```bash
curl -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" https://tools.mattpalmer.io/api/health
```

A 302 to `cloudflareaccess.com` means the headers were missing or wrong. A 403 with Cloudflare error 1010 means Browser Integrity Check blocked the client's default User-Agent, such as Python urllib's; send an explicit `User-Agent`.

To see the live site in a browser, either open https://tools.mattpalmer.io directly with the same headers (Playwright `extraHTTPHeaders`, Puppeteer `setExtraHTTPHeaders`), or run `bun scripts/live-proxy.ts` with `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` set and open http://127.0.0.1:8788. Pass `--target https://<alias>-tools.mpal.workers.dev` for a preview.

Don't write your own proxy. The `mattpalmer.io` zone has Hotlink Protection on, so any image request whose `Referer` is another host gets a 403 before it reaches Access. A proxy that passes on the browser's `http://127.0.0.1` `Referer` shows a broken sidebar logo and favicons while pages, scripts, and APIs work, which looks like a broken deploy. `scripts/live-proxy.ts` rewrites `Referer` and `Origin` to the target. Hotlink Protection is the user's zone setting; leave it on.

## Bot credentials

Each bot has its own Access service token, a Service Auth policy with the same name, and a bearer token stored as a Worker secret. `skills/tools-add-a-tool/SKILL.md` covers the Worker side.

1. Create the service token: `POST /accounts/$CLOUDFLARE_ACCOUNT_ID/access/service_tokens` with `{"name":"<bot>-bot","duration":"8760h"}`. The response is the only time the client secret is shown.
2. Find the app with `GET /accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps` and pick the one named "tools - Cloudflare Workers". Add the policy with `POST /accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps/<app id>/policies`, sending `{"name":"<bot>-bot","decision":"non_identity","include":[{"service_token":{"token_id":"<token id>"}}]}`. Its precedence goes after the existing policies, and those policies stay as they are.
3. Generate the bearer token with `openssl rand -base64 32` and set it with `bunx wrangler secret put BOT_TOKEN_<BOT>`.
4. Write all three values to a file only the owner can read (mode 0600), outside the repo and the Project store, and tell the user its path so the values go into 1Password. Never commit them.
5. Add the token's name and client ID to `ACCESS.serviceTokens` in `worker/access.ts` and land it. Until then the Worker answers 403.
6. Check that the bot's endpoint answers through Access with all three headers and an explicit `User-Agent`. It should answer 401 when the bearer token is missing.
