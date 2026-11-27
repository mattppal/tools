import { defineToolCron } from "../../worker/tool-api.ts";
import { credentials } from "./reply.ts";
import { syncMentions } from "./mentions.ts";

export default defineToolCron(async ({ env, db }) => {
	const creds = credentials(env);
	if (creds) await syncMentions(db, { fetcher: (input, init) => fetch(input, init), creds, now: new Date() });
});
