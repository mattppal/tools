import { defineToolCron } from "../../worker/tool-api.ts";
import { syncWithings } from "./sync.ts";
import { credentials } from "./withings.ts";

export default defineToolCron(async ({ env, db }) => {
	const creds = credentials(env);
	if (creds === null) return;
	const result = await db((client) => syncWithings(client, creds));
	if (result.status === "failed") throw new Error(`Withings sync failed: ${result.error}`);
});
