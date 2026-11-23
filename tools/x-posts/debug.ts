import { type DebugRow, defineToolDebug } from "../../worker/tool-debug.ts";
import { readStatus } from "./owner.ts";

function utc(iso: string | null): string {
	return iso === null ? "Never" : `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

export default defineToolDebug(async ({ db }) => {
	const status = await db((client) => readStatus(client, new Date()));
	const rows: DebugRow[] = [
		{ label: "Ingest", value: status.live ? "On" : "Off" },
		{ label: "Print queue", value: status.queueOpen ? "Open" : "Closed" },
		{ label: "Last success", value: utc(status.sync.lastSuccessAt) },
		{ label: "Next run", value: status.sync.nextRunAt === null ? "Due" : utc(status.sync.nextRunAt) },
		{ label: "Reads this month", value: `${status.reads.used.toLocaleString("en-US")} of ${status.reads.budget.toLocaleString("en-US")}${status.reads.capped ? ", capped by X" : ""}` },
		{ label: "Pending review", value: String(status.counts.pending ?? 0) },
		{ label: "Printed or queued today", value: `${status.today.printedOrQueued} of ${status.today.dailyCap}` },
	];
	const shadow = status.shadow;
	rows.push(
		{ label: "Screen: matched", value: `${shadow.matched.toLocaleString("en-US")} since ${utc(shadow.since)}` },
		{ label: "Screen: auto-rejected", value: `${shadow.autoRejected.toLocaleString("en-US")}${Object.keys(shadow.rejectedByFlag).length === 0 ? "" : ` (${Object.entries(shadow.rejectedByFlag).map(([flag, n]) => `${flag} ${n}`).join(", ")})`}` },
		{ label: "Screen: addressed", value: `${shadow.addressed.toLocaleString("en-US")} (${(shadow.addressedRate * 100).toFixed(1)}%)` },
		{ label: "Screen: would print", value: `${shadow.wouldPrint.toLocaleString("en-US")} of ${shadow.passedScreen.toLocaleString("en-US")} that passed the screen, at ${status.today.dailyCap} a day` },
	);
	if (status.sync.lastError !== null) rows.push({ label: "Last error", value: status.sync.lastError });
	return rows;
});
