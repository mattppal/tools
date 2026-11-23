# tools

Small tools at [tools.mattpalmer.io](https://tools.mattpalmer.io). One Cloudflare Worker serves the homepage, every tool in `tools/<slug>/`, and their APIs. Data lives in PlanetScale Postgres through Hyperdrive.

```bash
bun install
bun run dev                     # http://127.0.0.1:5173, no setup needed
bun run dev:db                  # optional: real data from the PlanetScale preview branch, written to .env
bun run new-tool my-tool --name "My Tool" --description "What it does." --api
bun run build                   # skill check + production build
bun run deploy                  # Workers Builds also deploys main on push
```

Each tool is a folder with `tool.ts` (name, description, emoji), `index.tsx` (UI), `SKILL.md`, and an optional `api.ts`. The shell picks it up with no other edits.

Agents start at [`AGENTS.md`](AGENTS.md).
