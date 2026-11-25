import type { FoodEntry } from "./types.ts";

export const LOG_GAP_MS = 5 * 60_000;

export type Log = { at: string | null; entries: FoodEntry[] };

const messageOf = (clientKey: string): string | null => /^(.+):\d+$/.exec(clientKey)?.[1] ?? null;

export function groupLogs(entries: readonly FoodEntry[]): Log[] {
	const untimed = entries.filter((entry) => entry.loggedAt === null);
	const timed = entries
		.flatMap((entry) => (entry.loggedAt === null ? [] : [{ entry, time: Date.parse(entry.loggedAt) }]))
		.toSorted((a, b) => a.time - b.time || a.entry.id - b.entry.id);
	const logs: Log[] = untimed.length === 0 ? [] : [{ at: null, entries: untimed }];
	let last = Number.NEGATIVE_INFINITY;
	let messages = new Set<string>();
	for (const { entry, time } of timed) {
		const message = messageOf(entry.clientKey);
		const current = logs.at(-1);
		if (current !== undefined && current.at !== null && (time - last <= LOG_GAP_MS || (message !== null && messages.has(message)))) {
			current.entries.push(entry);
		} else {
			logs.push({ at: entry.loggedAt, entries: [entry] });
			messages = new Set();
		}
		if (message !== null) messages.add(message);
		last = time;
	}
	return logs;
}
