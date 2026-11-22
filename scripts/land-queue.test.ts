import { expect, test } from "bun:test";
import { parseTickets, ticketRef } from "./land-queue.ts";

test("tickets come back in the order they were taken, whatever ls-remote prints", () => {
	const sha = "a".repeat(40);
	const listing = [ticketRef(64, 3000), ticketRef(59, 1000), "refs/land/queue/junk", ticketRef(70, 1000), "refs/heads/main"].map((ref) => `${sha}\t${ref}`).join("\n");
	expect(parseTickets(listing).map((ticket) => [ticket.enqueuedAt, ticket.pr])).toEqual([
		[1000, 59],
		[1000, 70],
		[3000, 64],
	]);
});

test("an empty queue has no tickets", () => {
	expect(parseTickets("")).toEqual([]);
});
