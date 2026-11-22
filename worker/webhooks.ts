import type { WithDb } from "./db.ts";

export type WebhookTarget = { url: string; authorization: string; deliveryHeader: string };

export type Webhook = { table: string; target: (env: Env) => WebhookTarget | null };

type ClaimedDelivery = { delivery_id: string; payload: unknown; attempts: number };
type Attempt = { status: number | null; error: string | null };

const BACKOFF_MINUTES = [1, 2, 4, 8, 16, 32, 60] as const;
const CLAIM_MINUTES = 5;
const BATCH_SIZE = 20;
const SEND_TIMEOUT_MS = 10_000;

export function defineWebhook(webhook: Webhook): Webhook {
	return webhook;
}

export function retryDelayMinutes(attempts: number): number {
	return BACKOFF_MINUTES[Math.min(Math.max(attempts, 1), BACKOFF_MINUTES.length) - 1] ?? 60;
}

export async function sendWebhook(target: WebhookTarget, deliveryId: string, payload: unknown): Promise<Attempt> {
	try {
		const response = await fetch(target.url, {
			method: "POST",
			headers: { authorization: target.authorization, [target.deliveryHeader]: deliveryId, "content-type": "application/json" },
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
		});
		await response.body?.cancel();
		return { status: response.status, error: response.ok ? null : `HTTP ${response.status}` };
	} catch (error) {
		return { status: null, error: error instanceof Error ? error.message : String(error) };
	}
}

export async function deliverDue(db: WithDb, webhook: Webhook, env: Env, only: readonly string[] = []): Promise<number> {
	const target = webhook.target(env);
	if (target === null) return 0;
	const claimed = await db(
		async (client) =>
			(
				await client.query<ClaimedDelivery>(
					`update ${webhook.table} set next_attempt_at = now() + make_interval(mins => $3)
					where delivery_id in (
						select delivery_id from ${webhook.table}
						where delivered_at is null and (cardinality($1::uuid[]) = 0 and next_attempt_at <= now() or delivery_id = any($1::uuid[]))
						order by next_attempt_at
						limit $2
						for update skip locked
					)
					returning delivery_id, payload, attempts`,
					[only, BATCH_SIZE, CLAIM_MINUTES],
				)
			).rows,
	);
	let delivered = 0;
	for (const delivery of claimed) {
		const attempt = await sendWebhook(target, delivery.delivery_id, delivery.payload);
		const ok = attempt.error === null;
		if (ok) delivered++;
		await db((client) =>
			client.query(
				`update ${webhook.table} set
					attempts = attempts + 1,
					last_status = $2,
					last_error = $3,
					delivered_at = case when $4 then now() end,
					next_attempt_at = case when $4 then next_attempt_at else now() + make_interval(mins => $5) end
				where delivery_id = $1`,
				[delivery.delivery_id, attempt.status, attempt.error, ok, retryDelayMinutes(delivery.attempts + 1)],
			),
		);
	}
	return delivered;
}
