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
	wire: liaisonWire,
});

export type LiaisonEvent = { app: "nutrition" | "workouts" | "tools"; event: string; ref: string | null; test: boolean; data: unknown };

export function liaisonEnvelope(event: LiaisonEvent, deliveryId: string): Record<string, unknown> {
	return { app: event.app, event: event.event, deliveryId, ...(event.test ? { test: true } : {}), data: event.data };
}

export const LIAISON_RECEIVER_CHARS = 4_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function liaisonWire(payload: unknown): unknown {
	if (!isRecord(payload)) return payload;
	const { app, event, deliveryId, test, data, ...rest } = payload;
	const ordered = isRecord(data) && "body" in data ? (({ body, ...fields }) => ({ ...fields, body }))(data) : data;
	return { app, event, deliveryId, ...(test === undefined ? {} : { test }), ...rest, data: ordered };
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
