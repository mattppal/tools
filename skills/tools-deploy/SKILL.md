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
- Previews use the `previews` block in `wrangler.jsonc`, which binds `DB` to `tools-db-preview` (PlanetScale branch `preview`). Previews never touch production data. Any new binding or var needs a preview-safe value there too, or `wrangler preview` fails.
- `bun run deploy` and `bun run preview` do the same from a machine with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set.
- `vite build` writes `.wrangler/deploy/config.json`, which points wrangler at the built Worker in `dist/tools/`. That is why plain `wrangler deploy` works from the root after a build.

## Where it runs

| URL | Notes |
| --- | --- |
| https://tools.mattpalmer.io | Custom domain, set in `wrangler.jsonc` `routes`. |
| https://tools.mpal.workers.dev | workers.dev URL. |
| `https://<alias>-tools.mpal.workers.dev` | Preview URLs. |

All of them sit behind the Access app "tools - Cloudflare Workers".

## Verify through Access

Use the service token `tools-agent-verify`, which has a Service Auth policy on that app. Get its client ID and secret from whoever runs the task; never commit them.

```bash
curl -H "CF-Access-Client-Id: $CFA_ID" -H "CF-Access-Client-Secret: $CFA_SECRET" https://tools.mattpalmer.io/api/health
```

Playwright takes the same headers through `extraHTTPHeaders`. A 302 to `cloudflareaccess.com` means the headers were missing or wrong.

## Bot credentials

Each bot has its own Access service token, a Service Auth policy with the same name, and a bearer token stored as a Worker secret. `skills/tools-add-a-tool/SKILL.md` covers the Worker side.

1. Create the service token: `POST /accounts/$CLOUDFLARE_ACCOUNT_ID/access/service_tokens` with `{"name":"<bot>-bot","duration":"8760h"}`. The response is the only time the client secret is shown.
2. Find the app with `GET /accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps` and pick the one named "tools - Cloudflare Workers". Add the policy with `POST /accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps/<app id>/policies`, sending `{"name":"<bot>-bot","decision":"non_identity","include":[{"service_token":{"token_id":"<token id>"}}]}`. Its precedence goes after the existing policies, and those policies stay as they are.
3. Generate the bearer token with `openssl rand -base64 32` and set it with `bunx wrangler secret put BOT_TOKEN_<BOT>`.
4. Write all three values to a file only the owner can read (mode 0600), outside the repo and the Project store, and tell the user its path so the values go into 1Password. Never commit them.
5. Check that the bot's endpoint answers through Access with all three headers. It should answer 401 when the bearer token is missing.
