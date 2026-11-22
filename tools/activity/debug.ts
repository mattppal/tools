import { type DebugRow, defineToolDebug } from "../../worker/tool-debug.ts";
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
	];
	if (connection.lastError !== null) rows.push({ label: "Sync error", value: `${connection.lastError}${connection.lastErrorAt === null ? "" : ` (${utc(connection.lastErrorAt)})`}` });
	return rows;
});
