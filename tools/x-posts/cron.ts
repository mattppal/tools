import { defineToolCron } from "../../worker/tool-api.ts";
import { runIngest } from "./ingest.ts";
import { LIVE_INGEST, QUEUE_OPEN } from "./query.ts";
import { sweep } from "./queue.ts";
import { credentials } from "./reply.ts";
import { checkReplies } from "./reply-check.ts";
import { syncMentions } from "./mentions.ts";

export async function runSteps(steps: readonly (() => Promise<unknown>)[]): Promise<void> {
	const failures: unknown[] = [];
	for (const step of steps) {
		try {
			await step();
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new Error(failures.map((error) => (error instanceof Error ? error.message : String(error))).join("; "));
}

export default defineToolCron(async ({ env, db }) => {
	const creds = credentials(env);
	const token = env.X_BEARER_TOKEN?.trim();
	const fetcher = (input: string, init?: RequestInit) => fetch(input, init);
	await runSteps([
		async () => {
			if (creds) await syncMentions(db, { fetcher, creds, now: new Date() });
		},
		() => db((client) => sweep(client, new Date(), QUEUE_OPEN)),
		async () => {
			if (LIVE_INGEST && token) await runIngest(db, { fetch: fetcher, token, now: new Date() });
		},
		async () => {
			if (LIVE_INGEST && creds) await checkReplies(db, { fetcher, creds, now: new Date() });
		},
	]);
});
