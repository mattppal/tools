import { defineToolCron } from "../../worker/tool-api.ts";
import { runIngest } from "./ingest.ts";
import { LIVE_INGEST, QUEUE_OPEN } from "./query.ts";
import { sweep } from "./queue.ts";
import { credentials } from "./reply.ts";
import { checkReplies } from "./reply-check.ts";
import { syncMentions } from "./mentions.ts";

export default defineToolCron(async ({ env, db }) => {
	await db((client) => sweep(client, new Date(), QUEUE_OPEN));
	if (!LIVE_INGEST) return;
	const token = env.X_BEARER_TOKEN?.trim();
	if (token) await runIngest(db, { fetch: (input, init) => fetch(input, init), token, now: new Date() });
	const creds = credentials(env);
	if (creds) await checkReplies(db, { fetcher: (input, init) => fetch(input, init), creds, now: new Date() });
	if (creds) await syncMentions(db, { fetcher: (input, init) => fetch(input, init), creds, now: new Date() });
});
