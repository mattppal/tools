import { defineToolCron, onCadence } from "../../worker/tool-api.ts";
import { syncTrainingLog } from "./sync.ts";

const SYNC_EVERY_MINUTES = 5;

export default defineToolCron(async ({ env, db, scheduledAt }) => {
	if (!onCadence(scheduledAt, SYNC_EVERY_MINUTES)) return;
	const result = await db((client) => syncTrainingLog(client, env));
	if (result.status === "failed") throw new Error(`training-log sync failed: ${result.error}`);
});
