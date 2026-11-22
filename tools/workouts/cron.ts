import { defineToolCron } from "../../worker/tool-api.ts";
import { syncTrainingLog } from "./sync.ts";

export default defineToolCron(async ({ env, db }) => {
	const result = await db((client) => syncTrainingLog(client, env));
	if (result.status === "failed") console.error(`training-log sync failed: ${result.error}`);
});
