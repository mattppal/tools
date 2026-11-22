import { defineWebhook } from "../../worker/webhooks.ts";

declare global {
	interface Env {
		COACH_WEBHOOK_URL?: string;
		COACH_WEBHOOK_KEY?: string;
	}
}

export default defineWebhook({
	table: "workouts.deliveries",
	target: (env) => (env.COACH_WEBHOOK_URL && env.COACH_WEBHOOK_KEY ? { url: env.COACH_WEBHOOK_URL, authorization: env.COACH_WEBHOOK_KEY, deliveryHeader: "X-Workouts-Delivery" } : null),
});
