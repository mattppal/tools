import { type DebugRow, defineToolDebug } from "../../worker/tool-debug.ts";
import { readSyncState } from "./sync.ts";

function utc(iso: string): string {
	return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

export default defineToolDebug(async ({ db }) => {
	const sync = await db((client) => readSyncState(client));
	const rows: DebugRow[] = [
		{ label: "Training log", value: sync.headSha === null ? "Not synced yet" : `${sync.headSha.slice(0, 7)}, synced ${sync.syncedAt === null ? "at an unknown time" : utc(sync.syncedAt)}` },
		{ label: "Last check", value: sync.checkedAt === null ? "Never" : utc(sync.checkedAt) },
	];
	if (sync.lastError !== null) rows.push({ label: "Sync error", value: sync.lastError });
	return rows;
});
