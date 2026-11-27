import { type DebugRow, defineToolDebug } from "../../worker/tool-debug.ts";
import { listMentions } from "./mentions.ts";

function utc(iso: string | null): string {
	return iso === null ? "Never" : `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

export default defineToolDebug(async ({ db }) => {
	const { sync, x } = await db((client) => listMentions(client, 1, new Date()));
	const rows: DebugRow[] = [
		{ label: "X account", value: x === null ? "Not connected" : `@${x.username}${x.lastError === null ? "" : `, ${x.lastError}`}` },
		{ label: "Last check", value: utc(sync.lastRunAt) },
		{ label: "Last success", value: utc(sync.lastSuccessAt) },
		{ label: "Spend this month", value: `$${(sync.spentMills / 1000).toFixed(2)} of $${(sync.capMills / 1000).toFixed(2)}${sync.paused === null ? "" : `, paused: ${sync.paused}`}` },
	];
	if (sync.lastError !== null) rows.push({ label: "Last error", value: sync.lastError });
	return rows;
});
