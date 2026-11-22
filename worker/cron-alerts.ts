import { queueNotice, Refused } from "../tools/liaison/notices.ts";
import type { WithDb } from "./db.ts";

async function hourlyId(source: string, at: Date): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`cron-failure:${source}:${at.toISOString().slice(0, 13)}`)));
	const hex = [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function noticeCronFailure(withDb: WithDb, source: string, error: unknown, at = new Date()): Promise<"queued" | "already noticed this hour"> {
	const message = error instanceof Error ? error.message : String(error);
	const noticeId = await hourlyId(source, at);
	try {
		await withDb((client) =>
			queueNotice(client, {
				for: "liaison",
				label: "action needed",
				noticeId,
				subject: `tools: ${source} is failing`,
				body: `${source} failed in the Worker's scheduled run at ${at.toISOString()}: ${message}\n\nThis is the first failure this UTC hour; later ones this hour only reach the Worker logs. Please tell Matt.`,
				refs: ["https://tools.mattpalmer.io/settings"],
				test: false,
			}),
		);
		return "queued";
	} catch (failure) {
		if (failure instanceof Refused && failure.status === 409) return "already noticed this hour";
		throw failure;
	}
}
