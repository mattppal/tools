import type { WithDb } from "./db.ts";

type StringSecret = { [Name in keyof Env]-?: NonNullable<Env[Name]> extends string ? Name : never }[keyof Env];

export type Webhook = { table: string; urlSecret: StringSecret; keySecret: StringSecret; deliveryHeader: string };

export type WebhookTarget = { url: string; key: string; deliveryHeader: string };

type ClaimedDelivery = { delivery_id: string; payload: unknown; attempts: number };
type Attempt = { status: number | null; error: string | null };

const BACKOFF_MINUTES = [1, 2, 4, 8, 16, 32, 60] as const;
const CLAIM_SECONDS = 60;
const BATCH_SIZE = 20;
const SEND_TIMEOUT_MS = 10_000;
const ERROR_DETAIL_CHARS = 200;

export function defineWebhook(webhook: Webhook): Webhook {
	return webhook;
}

export function webhookTarget(webhook: Webhook, env: Env): WebhookTarget | null {
	const url = env[webhook.urlSecret];
	const key = env[webhook.keySecret];
	return url && key ? { url, key, deliveryHeader: webhook.deliveryHeader } : null;
}

export function retryDelayMinutes(attempts: number): number {
	return BACKOFF_MINUTES[Math.min(Math.max(attempts, 1), BACKOFF_MINUTES.length) - 1] ?? 60;
}

export async function sendWebhook(target: WebhookTarget, deliveryId: string, payload: unknown): Promise<Attempt> {
	try {
		const response = await fetch(target.url, {
			method: "POST",
			headers: { authorization: `Bearer ${target.key}`, [target.deliveryHeader]: deliveryId, "content-type": "application/json" },
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
		});
		if (response.ok) {
			await response.body?.cancel();
			return { status: response.status, error: null };
		}
		const detail = (await response.text().catch(() => "")).replaceAll(target.key, "[key]").replace(/\s+/g, " ").trim().slice(0, ERROR_DETAIL_CHARS);
		return { status: response.status, error: detail === "" ? `HTTP ${response.status}` : `HTTP ${response.status}: ${detail}` };
	} catch (error) {
		return { status: null, error: error instanceof Error ? error.message : String(error) };
	}
}

async function claimOne(db: WithDb, webhook: Webhook, claimId: string, only: readonly string[], tried: readonly string[]): Promise<ClaimedDelivery | undefined> {
	return db(
		async (client) =>
			(
				await client.query<ClaimedDelivery>(
					`update ${webhook.table} set claimed_until = now() + make_interval(secs => $4), claim_id = $3
					where delivery_id = (
						select delivery_id from ${webhook.table}
						where delivered_at is null
							and (claimed_until is null or claimed_until < now())
							and delivery_id <> all($2::uuid[])
							and (cardinality($1::uuid[]) = 0 and next_attempt_at <= now() or delivery_id = any($1::uuid[]))
						order by next_attempt_at
						limit 1
						for update skip locked
					)
					returning delivery_id, payload, attempts`,
					[only, tried, claimId, CLAIM_SECONDS],
				)
			).rows[0],
	);
}

export async function deliverDue(db: WithDb, webhook: Webhook, env: Env, only: readonly string[] = []): Promise<number> {
	const target = webhookTarget(webhook, env);
	if (target === null) return 0;
	const tried: string[] = [];
	let delivered = 0;
	while (tried.length < BATCH_SIZE) {
		const claimId = crypto.randomUUID();
		const delivery = await claimOne(db, webhook, claimId, only, tried);
		if (delivery === undefined) break;
		tried.push(delivery.delivery_id);
		const attempt = await sendWebhook(target, delivery.delivery_id, delivery.payload);
		const ok = attempt.error === null;
		const recorded = await db((client) =>
			client.query(
				`update ${webhook.table} set
					attempts = attempts + 1,
					last_status = $3,
					last_error = $4,
					delivered_at = case when $5 then now() end,
					next_attempt_at = case when $5 then next_attempt_at else now() + make_interval(mins => $6) end,
					claimed_until = null,
					claim_id = null
				where delivery_id = $1 and claim_id = $2`,
				[delivery.delivery_id, claimId, attempt.status, attempt.error, ok, retryDelayMinutes(delivery.attempts + 1)],
			),
		);
		if (ok && recorded.rowCount === 1) delivered++;
	}
	return delivered;
}
