import { defineWebhook } from "../../worker/webhooks.ts";

declare global {
	interface Env {
		NUTRITION_WEBHOOK_URL?: string;
		NUTRITION_WEBHOOK_KEY?: string;
	}
}

export default defineWebhook({
	table: "nutrition.deliveries",
	urlSecret: "NUTRITION_WEBHOOK_URL",
	keySecret: "NUTRITION_WEBHOOK_KEY",
	deliveryHeader: "X-Nutrition-Delivery",
});
