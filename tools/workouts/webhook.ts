import { defineWebhook } from "../../worker/webhooks.ts";

declare global {
	interface Env {
		COACH_WEBHOOK_URL?: string;
		COACH_WEBHOOK_KEY?: string;
	}
}

export default defineWebhook({
	table: "workouts.deliveries",
	urlSecret: "COACH_WEBHOOK_URL",
	keySecret: "COACH_WEBHOOK_KEY",
	deliveryHeader: "X-Workouts-Delivery",
});
