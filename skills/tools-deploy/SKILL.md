---
name: tools-deploy
description: How the tools Worker is deployed and protected - Workers Builds, previews, the tools.mattpalmer.io domain, Cloudflare Access, and verifying a deploy through Access. Use before deploying, debugging a deploy, or checking the live site.
---

# Deploy

## Who owns what

The user owns the custom domain, preview settings, and Cloudflare Access. Don't change them. If a task seems to need a change there, write down the exact dashboard steps and values and hand them to the user.

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
