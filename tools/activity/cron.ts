import { defineToolCron, onCadence } from "../../worker/tool-api.ts";
import { syncWithings } from "./sync.ts";
import { credentials } from "./withings.ts";

const SYNC_EVERY_MINUTES = 10;

export default defineToolCron(async ({ env, db, scheduledAt }) => {
	if (!onCadence(scheduledAt, SYNC_EVERY_MINUTES)) return;
	const creds = credentials(env);
	if (creds === null) return;
	const result = await db((client) => syncWithings(client, creds));
	if (result.status === "failed") throw new Error(`Withings sync failed: ${result.error}`);
});
