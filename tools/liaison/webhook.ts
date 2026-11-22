import type { Database } from "../../worker/db.ts";
import { defineWebhook } from "../../worker/webhooks.ts";

declare global {
	interface Env {
		LIAISON_WEBHOOK_URL?: string;
		LIAISON_WEBHOOK_KEY?: string;
	}
}

export default defineWebhook({
	table: "liaison.deliveries",
	urlSecret: "LIAISON_WEBHOOK_URL",
	keySecret: "LIAISON_WEBHOOK_KEY",
	deliveryHeader: "X-Tools-Delivery",
});

export type LiaisonEvent = { app: "nutrition" | "workouts" | "tools"; event: string; ref: string | null; test: boolean; data: unknown };

export function liaisonEnvelope(event: LiaisonEvent, deliveryId: string): Record<string, unknown> {
	return { app: event.app, event: event.event, deliveryId, ...(event.test ? { test: true } : {}), data: event.data };
}

export async function queueForLiaison(client: Database, event: LiaisonEvent, deliveryId: string): Promise<void> {
	await client.query("insert into liaison.deliveries (delivery_id, app, event, ref, payload) values ($1, $2, $3, $4, $5)", [
		deliveryId,
		event.app,
		event.event,
		event.ref,
		JSON.stringify(liaisonEnvelope(event, deliveryId)),
	]);
}
