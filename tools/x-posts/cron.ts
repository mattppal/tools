import { defineToolCron } from "../../worker/tool-api.ts";
import { runIngest } from "./ingest.ts";
import { LIVE_INGEST, QUEUE_OPEN } from "./query.ts";
import { sweep } from "./queue.ts";

export default defineToolCron(async ({ env, db }) => {
	await db((client) => sweep(client, new Date(), QUEUE_OPEN));
	if (!LIVE_INGEST) return;
	const token = env.X_BEARER_TOKEN?.trim();
	if (!token) return;
	await runIngest(db, { fetch: (input, init) => fetch(input, init), token, now: new Date() });
});
