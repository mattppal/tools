import type { WithDb } from "../../worker/db.ts";
import { type DebugRow, defineToolDebug } from "../../worker/tool-debug.ts";
import { listPushes } from "./apple-health.ts";
import { readStream } from "./health.ts";
import { readConnection } from "./store.ts";
import { credentials } from "./withings.ts";

function utc(iso: string): string {
	return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

async function withingsRows(env: Env, db: WithDb): Promise<DebugRow[]> {
	if (credentials(env) === null) return [{ label: "Withings", value: "WITHINGS_CLIENT_ID and WITHINGS_CLIENT_SECRET are not set" }];
	const connection = await db((client) => readConnection(client));
	if (connection === null) return [{ label: "Withings", value: "Not connected. Open /api/withings/connect to connect." }];
	const rows: DebugRow[] = [
		{ label: "Withings", value: `Connected ${utc(connection.connectedAt)}, user ${connection.userid}` },
		{ label: "Scope", value: connection.scope },
		{ label: "Token", value: connection.refreshedAt === null ? "Not refreshed yet" : `Refreshed ${utc(connection.refreshedAt)}` },
		{ label: "Last 7 days", value: connection.recentSyncedAt === null ? "Not synced yet" : `Synced ${utc(connection.recentSyncedAt)}` },
		{
			label: "Backfill",
			value: connection.backfillCursor === null ? `Done${connection.backfillDoneAt === null ? "" : ` ${utc(connection.backfillDoneAt)}`}` : `In progress, next window ends ${connection.backfillCursor}`,
		},
		{
			label: "Weights",
			value:
				connection.weightsSyncedAt === null
					? connection.measOffset > 0
						? "History in progress"
						: "Not synced yet"
					: `Synced ${utc(connection.weightsSyncedAt)}${connection.measOffset > 0 ? ", history in progress" : ""}`,
		},
	];
	const streams = await db((client) =>
		Promise.all(
			(["measures", "workouts", "sleep", "intraday"] as const).map(async (name) => ({ name, row: await readStream<{ offset?: number; cursor?: string | null; error?: string | null }>(client, name, {}) })),
		),
	);
	for (const { name, row } of streams) {
		const label = { measures: "Body measures", workouts: "Workouts", sleep: "Sleep", intraday: "Intraday" }[name];
		if (row.syncedAt === null) rows.push({ label, value: "Not synced yet" });
		else {
			const history = name === "intraday" ? (row.state.cursor ? `, history back to ${row.state.cursor}` : row.doneAt === null ? "" : ", history done") : row.state.offset ? ", history in progress" : "";
			rows.push({ label, value: `Synced ${utc(row.syncedAt)}${history}${row.state.error ? `. Last error: ${row.state.error}` : ""}` });
		}
	}
	if (connection.lastError !== null) rows.push({ label: "Sync error", value: `${connection.lastError}${connection.lastErrorAt === null ? "" : ` (${utc(connection.lastErrorAt)})`}` });
	return rows;
}

async function appleHealthRows(db: WithDb): Promise<DebugRow[]> {
	const pushes = await db((client) => listPushes(client));
	if (pushes.length === 0) return [{ label: "Apple Health", value: "No pushes yet. Set up Health Auto Export from tools/activity/SKILL.md." }];
	return pushes.map(({ automation, receivedAt, counts: { received, changed, skipped } }) => ({
		label: `Apple Health: ${automation}`,
		value: `Last push ${utc(receivedAt)}. ${received.sleep} sleep segments, ${received.samples} samples, ${received.workouts} workouts; ${changed.sleep + changed.samples + changed.workouts} new or changed. Skipped ${skipped.withings} from Withings, ${skipped.invalid} unreadable.`,
	}));
}

export default defineToolDebug(async ({ env, db }) => [...(await withingsRows(env, db)), ...(await appleHealthRows(db))]);
