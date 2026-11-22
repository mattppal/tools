import { withDb } from "./db.ts";
import type { ToolApi } from "./tool-api.ts";

const apis = import.meta.glob<{ default: ToolApi }>("../tools/*/api.ts", { eager: true });

const TOOL_APIS = new Map(
	Object.entries(apis).map(([file, module]) => {
		const slug = file.split("/").at(-2);
		if (slug === undefined) throw new Error(`Cannot read tool slug from ${file}`);
		return [slug, module.default];
	}),
);

const TOOL_API_PATH = /^\/api\/tools\/([a-z0-9-]+)(\/.*)?$/;

async function health(env: Env): Promise<Response> {
	const started = Date.now();
	try {
		const row = await withDb(env, async (db) => {
			const result = await db.query<{ now: Date; version: string }>("select now() as now, current_setting('server_version') as version");
			return result.rows[0];
		});
		return Response.json({ ok: true, db: { ok: true, latencyMs: Date.now() - started, now: row?.now, version: row?.version } });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return Response.json({ ok: false, db: { ok: false, latencyMs: Date.now() - started, error: message } }, { status: 503 });
	}
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/api/health") return health(env);
		const match = TOOL_API_PATH.exec(url.pathname);
		if (match !== null) {
			const [, slug = "", rest = "/"] = match;
			const api = TOOL_APIS.get(slug);
			if (api === undefined) return Response.json({ error: `No API for tool "${slug}"` }, { status: 404 });
			return api(request, { env, ctx, path: rest, db: (work) => withDb(env, work) });
		}
		if (url.pathname.startsWith("/api/")) return Response.json({ error: "Not found" }, { status: 404 });
		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;
