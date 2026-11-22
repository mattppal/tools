import { $ } from "bun";

export const QUEUE_PREFIX = "refs/land/queue/";

export type Ticket = { ref: string; enqueuedAt: number; pr: number };

export function parseTickets(lsRemote: string): Ticket[] {
	return lsRemote
		.split("\n")
		.map((line) => line.trim().split(/\s+/)[1] ?? "")
		.flatMap((ref) => {
			const match = /^refs\/land\/queue\/(\d+)-pr(\d+)$/.exec(ref);
			return match === null ? [] : [{ ref, enqueuedAt: Number(match[1]), pr: Number(match[2]) }];
		})
		.toSorted((a, b) => a.enqueuedAt - b.enqueuedAt || a.pr - b.pr);
}

export function ticketRef(pr: number, now: number): string {
	return `${QUEUE_PREFIX}${now}-pr${pr}`;
}

export async function listTickets(): Promise<Ticket[]> {
	return parseTickets(await $`git ls-remote origin ${`${QUEUE_PREFIX}*`}`.text());
}

export async function enqueue(pr: number, sha: string): Promise<Ticket> {
	const held = (await listTickets()).find((ticket) => ticket.pr === pr);
	if (held !== undefined) return held;
	const now = Date.now();
	const ticket = { ref: ticketRef(pr, now), enqueuedAt: now, pr };
	await $`git push --quiet origin ${sha}:${ticket.ref}`.quiet();
	return ticket;
}

export async function drop(ticket: Ticket): Promise<void> {
	await $`git push --quiet origin ${`:${ticket.ref}`}`.quiet().nothrow();
}

export function dropNow(ticket: Ticket): void {
	Bun.spawnSync(["git", "push", "--quiet", "origin", `:${ticket.ref}`]);
}
