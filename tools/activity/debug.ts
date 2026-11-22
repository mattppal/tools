import { type DebugRow, defineToolDebug } from "../../worker/tool-debug.ts";
import { readStream } from "./health.ts";
import { readConnection } from "./store.ts";
import { credentials } from "./withings.ts";

function utc(iso: string): string {
	return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

export default defineToolDebug(async ({ env, db }) => {
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
});
