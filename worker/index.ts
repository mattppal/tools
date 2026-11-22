import { type WithDb, withRequestDb } from "./db.ts";
import type { ToolApi, ToolCron } from "./tool-api.ts";
import { deliverDue, type Webhook } from "./webhooks.ts";

const apis = import.meta.glob<{ default: ToolApi }>("../tools/*/api.ts", { eager: true });

const TOOL_APIS = new Map(
	Object.entries(apis).map(([file, module]) => {
		const slug = file.split("/").at(-2);
		if (slug === undefined) throw new Error(`Cannot read tool slug from ${file}`);
		return [slug, module.default];
	}),
);

const CRONS = Object.entries(import.meta.glob<{ default: ToolCron }>("../tools/*/cron.ts", { eager: true }));

const WEBHOOKS = Object.values(import.meta.glob<{ default: Webhook }>("../tools/*/webhook.ts", { eager: true })).map((module) => module.default);

const TOOL_API_PATH = /^\/api\/tools\/([a-z0-9-]+)(\/.*)?$/;

export type HealthReport =
	| { ok: true; db: { latencyMs: number; connectMs: number; queryMs: number } }
	| { ok: false; db: { latencyMs: number; error: string } };

async function checkDb(withDb: WithDb): Promise<HealthReport> {
	const started = Date.now();
	try {
		const [connected, queried] = await withDb(async (db): Promise<[number, number]> => {
			const connectedAt = Date.now();
			await db.query("select now()");
			return [connectedAt, Date.now()];
		});
		return { ok: true, db: { latencyMs: queried - started, connectMs: connected - started, queryMs: queried - connected } };
	} catch (error) {
		return { ok: false, db: { latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) } };
	}
}

async function handleApi(request: Request, env: Env, ctx: ExecutionContext, withDb: WithDb): Promise<Response> {
	const { pathname } = new URL(request.url);
	if (pathname === "/api/health") {
		const report = await checkDb(withDb);
		return Response.json(report, { status: report.ok ? 200 : 503, headers: { "cache-control": "no-store" } });
	}
	const match = TOOL_API_PATH.exec(pathname);
	if (match === null) return Response.json({ error: "Not found" }, { status: 404 });
	const [, slug = "", rest = "/"] = match;
	const api = TOOL_APIS.get(slug);
	if (api === undefined) return Response.json({ error: `No API for tool "${slug}"` }, { status: 404 });
	try {
		return await api(request, { env, ctx, path: rest, db: withDb });
	} catch (error) {
		console.error(`Tool API ${slug} failed on ${request.method} ${rest}`, error);
		return Response.json({ error: "Internal error" }, { status: 500 });
	}
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname.startsWith("/api/")) return withRequestDb(env.DB, ctx, (withDb) => handleApi(request, env, ctx, withDb));
		if (url.pathname.startsWith("/assets/")) return new Response("Not found", { status: 404 });
		return env.ASSETS.fetch(new Request(new URL("/", url), request));
	},
	async scheduled(_controller, env, ctx): Promise<void> {
		await withRequestDb(env.DB, ctx, async (withDb) => {
			for (const webhook of WEBHOOKS) {
				try {
					await deliverDue(withDb, webhook, env);
				} catch (error) {
					console.error(`Webhook retries for ${webhook.table} failed`, error);
				}
			}
			for (const [file, module] of CRONS) {
				try {
					await module.default({ env, ctx, db: withDb });
				} catch (error) {
					console.error(`Tool cron ${file} failed`, error);
				}
			}
		});
	},
} satisfies ExportedHandler<Env>;
