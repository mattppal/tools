import type { Database } from "../../worker/db.ts";
import { addDays, today } from "./dates.ts";
import { unseal } from "./secrets.ts";
import { claimConnection, releaseConnection, type SyncProgress, saveTokens, upsertWithingsDays } from "./store.ts";
import { type Credentials, type Fetch, getActivity, refreshTokens, WithingsError } from "./withings.ts";

export const BACKFILL_FLOOR = "2009-01-01";
const BACKFILL_WINDOW_DAYS = 180;
const RECENT_DAYS = 7;
const RECENT_EVERY_MS = 30 * 60_000;
const CALLS_PER_RUN = 3;
const REFRESH_MARGIN_MS = 5 * 60_000;

export type SyncResult = { status: "idle" } | { status: "synced"; calls: number; changed: number; backfillCursor: string | null } | { status: "failed"; error: string };

function message(error: unknown): string {
	if (error instanceof WithingsError && error.needsReconnect) return `${error.message}. Reconnect at /api/withings/connect.`;
	return error instanceof Error ? error.message : String(error);
}

export async function syncWithings(client: Database, creds: Credentials, fetcher: Fetch = fetch, now = new Date()): Promise<SyncResult> {
	const connection = await claimConnection(client);
	if (connection === null) return { status: "idle" };
	const progress: SyncProgress = {
		backfillCursor: connection.backfillCursor,
		backfillOffset: connection.backfillOffset,
		backfillDone: false,
		recentSynced: false,
		error: null,
	};
	let calls = 0;
	let changed = 0;
	try {
		let accessToken = await unseal(creds.clientSecret, connection.accessToken);
		if (connection.accessExpiresAt.getTime() - now.getTime() < REFRESH_MARGIN_MS) {
			const tokens = await refreshTokens(fetcher, creds, await unseal(creds.clientSecret, connection.refreshToken), now);
			await saveTokens(client, creds.clientSecret, tokens);
			accessToken = tokens.accessToken;
		}

		const day = today(now);
		const recentDue = connection.recentSyncedAt === null || now.getTime() - Date.parse(connection.recentSyncedAt) >= RECENT_EVERY_MS;
		if (recentDue) {
			let offset = 0;
			do {
				const page = await getActivity(fetcher, accessToken, addDays(day, 1 - RECENT_DAYS), day, offset);
				calls++;
				changed += await upsertWithingsDays(client, page.activities);
				offset = page.more ? page.offset : 0;
			} while (offset > 0 && calls < CALLS_PER_RUN);
			progress.recentSynced = offset === 0;
		}

		while (calls < CALLS_PER_RUN && progress.backfillCursor !== null) {
			const end = progress.backfillCursor;
			const start = addDays(end, 1 - BACKFILL_WINDOW_DAYS) < BACKFILL_FLOOR ? BACKFILL_FLOOR : addDays(end, 1 - BACKFILL_WINDOW_DAYS);
			const page = await getActivity(fetcher, accessToken, start, end, progress.backfillOffset);
			calls++;
			changed += await upsertWithingsDays(client, page.activities);
			if (page.more && page.offset > 0) {
				progress.backfillOffset = page.offset;
				continue;
			}
			progress.backfillOffset = 0;
			const next = addDays(start, -1);
			if (next < BACKFILL_FLOOR) {
				progress.backfillCursor = null;
				progress.backfillDone = true;
			} else progress.backfillCursor = next;
		}
		return { status: "synced", calls, changed, backfillCursor: progress.backfillCursor };
	} catch (error) {
		progress.error = message(error);
		return { status: "failed", error: progress.error };
	} finally {
		await releaseConnection(client, progress);
	}
}
