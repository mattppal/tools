import type { WithDb } from "./db.ts";
import type { DebugRow, ToolDebug } from "./tool-debug.ts";
import { type Webhook, webhookTarget } from "./webhooks.ts";

export type ToolDebugReport = { slug: string; rows: readonly DebugRow[] };

export type DebugReport = {
	version: { id: string; deployedAt: string };
	access: string | null;
	tools: readonly ToolDebugReport[];
};

type Backlog = { waiting: number; attempts: number; last_error: string | null };

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function targetHost(url: string): string {
	try {
		return `Sends to ${new URL(url).host}`;
	} catch {
		return "Target URL is not valid";
	}
}

export async function webhookRows(db: WithDb, webhook: Webhook, env: Env): Promise<DebugRow[]> {
	const target = webhookTarget(webhook, env);
	const backlog = await db(
		async (client) =>
			(
				await client.query<Backlog>(
					`select count(*)::int as waiting, coalesce(max(attempts), 0)::int as attempts,
					(select last_error from ${webhook.table} where delivered_at is null and last_error is not null order by attempts desc, next_attempt_at limit 1) as last_error
					from ${webhook.table} where delivered_at is null`,
				)
			).rows[0],
	);
	const rows: DebugRow[] = [
		{ label: "Webhook", value: target === null ? "No target set, so deliveries wait" : targetHost(target.url) },
		{ label: "Backlog", value: backlog === undefined || backlog.waiting === 0 ? "Nothing waiting" : `${backlog.waiting} waiting, oldest tried ${backlog.attempts} ${backlog.attempts === 1 ? "time" : "times"}` },
	];
	if (backlog?.last_error) rows.push({ label: "Last error", value: backlog.last_error });
	return rows;
}

async function toolRows(slug: string, failedLabel: string, work: () => Promise<readonly DebugRow[]>): Promise<readonly DebugRow[]> {
	try {
		return await work();
	} catch (error) {
		console.error(`Debug rows for ${slug} failed`, error);
		return [{ label: failedLabel, value: `Could not read: ${errorMessage(error)}` }];
	}
}

export async function debugReport(request: Request, env: Env, db: WithDb, webhooks: ReadonlyMap<string, Webhook>, debugs: ReadonlyMap<string, ToolDebug>): Promise<DebugReport> {
	const slugs = [...new Set([...webhooks.keys(), ...debugs.keys()])].sort();
	const tools = await Promise.all(
		slugs.map(async (slug) => {
			const webhook = webhooks.get(slug);
			const debug = debugs.get(slug);
			const rows = [...(webhook === undefined ? [] : await toolRows(slug, "Backlog", () => webhookRows(db, webhook, env))), ...(debug === undefined ? [] : await toolRows(slug, "Error", () => debug({ env, db })))];
			return { slug, rows };
		}),
	);
	return {
		version: { id: env.CF_VERSION_METADATA.id, deployedAt: env.CF_VERSION_METADATA.timestamp },
		access: request.headers.get("cf-access-authenticated-user-email"),
		tools,
	};
}
