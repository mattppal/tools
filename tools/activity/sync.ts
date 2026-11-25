import type { Database } from "../../worker/db.ts";
import { addDays, today } from "./dates.ts";
import { dayStart, type FeedState, type IntradayState, readStream, readStreams, refreshWorkoutLinks, saveIntraday, saveMeasures, saveSleep, saveStream, saveWorkouts, type StreamRow, streamRow } from "./health.ts";
import { unseal } from "./secrets.ts";
import { claimConnection, readConnection, releaseConnection, type SyncProgress, saveTokens, upsertWithingsDays } from "./store.ts";
import { saveWeighins, toWeighins } from "./weights.ts";
import { type Credentials, type Feed, type Fetch, getActivity, getFeed, getIntraday, getWeights, refreshTokens, WithingsError } from "./withings.ts";

export const BACKFILL_FLOOR = "2009-01-01";
const BACKFILL_WINDOW_DAYS = 180;
const RECENT_DAYS = 7;
const RECENT_EVERY_MS = 30 * 60_000;
const DUE_SLACK_MS = 2 * 60_000;
export const CALLS_PER_RUN = 6;
const INTRADAY_EMPTY_STOP = 120;
const FEEDS: Feed[] = ["measures", "workouts", "sleep"];
const SAVE_FEED: Record<Feed, (client: Database, items: Record<string, unknown>[]) => Promise<number>> = { measures: saveMeasures, workouts: saveWorkouts, sleep: saveSleep };
const REFRESH_MARGIN_MS = 5 * 60_000;

const FEED_START: FeedState = { lastupdate: null, pending: null, offset: 0 };
const INTRADAY_START: IntradayStream = { cursor: null, empty: 0, recentAt: null };

type IntradayStream = IntradayState & { error?: string | null; failedAt?: string | null };

export type SyncResult = { status: "idle" } | { status: "synced"; calls: number; changed: number; backfillCursor: string | null } | { status: "failed"; error: string };

function due(syncedAt: string | null | undefined, now: Date): boolean {
	return syncedAt === null || syncedAt === undefined || now.getTime() - Date.parse(syncedAt) >= RECENT_EVERY_MS - DUE_SLACK_MS;
}

function feedDue(stream: StreamRow<FeedState>, now: Date): boolean {
	return stream.state.offset > 0 || due(stream.syncedAt, now);
}

function intradayPaused(state: IntradayStream, now: Date): boolean {
	return state.failedAt !== null && state.failedAt !== undefined && !due(state.failedAt, now);
}

export async function workDue(client: Database, now: Date): Promise<boolean> {
	const connection = await readConnection(client);
	if (connection === null) return false;
	if (connection.backfillCursor !== null || due(connection.recentSyncedAt, now) || connection.measOffset > 0 || due(connection.weightsSyncedAt, now)) return true;
	const streams = await readStreams(client);
	if (FEEDS.some((feed) => feedDue(streamRow(streams.get(feed), FEED_START), now))) return true;
	const intraday = streamRow(streams.get("intraday"), INTRADAY_START).state;
	return !intradayPaused(intraday, now) && (intraday.cursor !== null || due(intraday.recentAt, now));
}

function sameState(a: object, b: object): boolean {
	const entries = (state: object) => JSON.stringify(Object.entries(state).filter(([, value]) => value !== undefined).toSorted(([x], [y]) => x.localeCompare(y)));
	return entries(a) === entries(b);
}

function softError(error: unknown): string {
	if (error instanceof WithingsError && error.needsReconnect) throw error;
	return error instanceof Error ? error.message : String(error);
}

function message(error: unknown): string {
	if (error instanceof WithingsError && error.needsReconnect) return `${error.message}. Reconnect at /api/withings/connect.`;
	return error instanceof Error ? error.message : String(error);
}

export async function syncWithings(client: Database, creds: Credentials, fetcher: Fetch = fetch, now = new Date()): Promise<SyncResult> {
	if (!(await workDue(client, now))) return { status: "idle" };
	const connection = await claimConnection(client);
	if (connection === null) return { status: "idle" };
	const progress: SyncProgress = {
		backfillCursor: connection.backfillCursor,
		backfillOffset: connection.backfillOffset,
		backfillDone: false,
		recentSynced: false,
		measLastupdate: connection.measLastupdate,
		measPendingLastupdate: connection.measPendingLastupdate,
		measOffset: connection.measOffset,
		weightsSynced: false,
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
		if (due(connection.recentSyncedAt, now)) {
			let offset = 0;
			do {
				const page = await getActivity(fetcher, accessToken, addDays(day, 1 - RECENT_DAYS), day, offset);
				calls++;
				changed += await upsertWithingsDays(client, page.activities);
				offset = page.more ? page.offset : 0;
			} while (offset > 0 && calls < CALLS_PER_RUN);
			progress.recentSynced = offset === 0;
		}

		const weightsDue = progress.measOffset > 0 || due(connection.weightsSyncedAt, now);
		while (weightsDue && calls < CALLS_PER_RUN && !progress.weightsSynced) {
			const page = await getWeights(fetcher, accessToken, progress.measLastupdate ?? 0, progress.measOffset);
			calls++;
			changed += await saveWeighins(client, toWeighins(page.groups));
			progress.measPendingLastupdate ??= page.updatetime;
			if (page.more && page.offset > 0) {
				progress.measOffset = page.offset;
				continue;
			}
			progress.measLastupdate = progress.measPendingLastupdate;
			progress.measPendingLastupdate = null;
			progress.measOffset = 0;
			progress.weightsSynced = true;
		}

		for (const feed of FEEDS) {
			if (calls >= CALLS_PER_RUN) break;
			const stream = await readStream(client, feed, FEED_START);
			if (!feedDue(stream, now)) continue;
			const state: FeedState & { error?: string | null } = { ...stream.state, error: null };
			let synced = false;
			try {
				while (calls < CALLS_PER_RUN && !synced) {
					const page = await getFeed(fetcher, accessToken, feed, state.lastupdate ?? 0, state.offset);
					calls++;
					changed += await SAVE_FEED[feed](client, page.items);
					state.pending ??= page.updatetime ?? Math.floor(now.getTime() / 1000);
					if (page.more && page.offset > 0) {
						state.offset = page.offset;
						continue;
					}
					state.lastupdate = state.pending;
					state.pending = null;
					state.offset = 0;
					synced = true;
				}
			} catch (error) {
				state.error = softError(error);
				progress.error = `${feed}: ${state.error}`;
				await saveStream(client, feed, state, true);
				continue;
			}
			await saveStream(client, feed, state, synced, synced);
			if (synced && feed === "workouts") await refreshWorkoutLinks(client);
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
		if (calls < CALLS_PER_RUN) {
			const stream = await readStream(client, "intraday", INTRADAY_START);
			const state: IntradayStream = { ...stream.state, error: null };
			const paused = intradayPaused(state, now);
			let done = false;
			const pull = async (date: string): Promise<number> => {
				const start = dayStart(date);
				const series = await getIntraday(fetcher, accessToken, start, dayStart(addDays(date, 1)) - 1);
				calls++;
				const saved = await saveIntraday(client, date, series);
				changed += saved.changed;
				return saved.samples;
			};
			try {
				if (!paused && due(state.recentAt, now) && calls + 2 <= CALLS_PER_RUN) {
					await pull(addDays(day, -1));
					await pull(day);
					state.recentAt = now.toISOString();
					if (state.cursor === null && stream.doneAt === null) state.cursor = addDays(day, -2);
				}
				while (!paused && calls < CALLS_PER_RUN && state.cursor !== null) {
					state.empty = (await pull(state.cursor)) === 0 ? state.empty + 1 : 0;
					state.cursor = addDays(state.cursor, -1);
					if (state.empty >= INTRADAY_EMPTY_STOP || state.cursor < BACKFILL_FLOOR) {
						state.cursor = null;
						done = true;
					}
				}
			} catch (error) {
				state.error = softError(error);
				state.failedAt = now.toISOString();
				progress.error = `intraday: ${state.error}`;
			}
			if (state.error === null && !paused) state.failedAt = null;
			const pulled = state.recentAt !== stream.state.recentAt;
			if (pulled || done || !sameState(state, stream.state)) await saveStream(client, "intraday", state, pulled, done);
		}

		return { status: "synced", calls, changed, backfillCursor: progress.backfillCursor };
	} catch (error) {
		progress.error = message(error);
		return { status: "failed", error: progress.error };
	} finally {
		await releaseConnection(client, progress);
	}
}
