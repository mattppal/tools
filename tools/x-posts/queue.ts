import { z } from "zod";
import type { Database } from "../../worker/db.ts";
import { notice, readBlocklist } from "./ingest.ts";
import { handleOk, postUrl, rejectingFlags } from "./screen.ts";

export const BATCH_CAP = 10;
export const DAILY_CAP = 150;
export const MAX_HANDLES = 50;
export const CLAIM_MINUTES = 10;
export const MAX_TRIES = 3;
export const RETRY_AFTER_MINUTES = [1, 5] as const;
export const REVIEW_TIMEOUT_HOURS = 24;
const TIME_ZONE = "America/Los_Angeles";

export type Actor = "prints-review" | "prints-bridge" | "matt";

export class BadRequest extends Error {}

export class Conflict extends Error {}

export class NotFound extends Error {}

export const QUEUE_CLOSED = "The print queue is closed";
export class Closed extends Error {}

const postId = z.string().regex(/^[1-9]\d{0,18}$/, "Post ids are strings of 1 to 19 digits");
const reason = z.string().trim().min(1).max(200);

export const decisionsRequest = z.strictObject({
	approve: z.array(postId).max(500).default([]),
	reject: z.array(z.strictObject({ id: postId, reason })).max(500).default([]),
	overflow: z.array(z.strictObject({ id: postId, reason })).max(500).default([]),
});

export type DecisionsRequest = z.infer<typeof decisionsRequest>;

export const claimRequest = z.strictObject({ bridge: z.string().trim().min(1).max(50) });

export const ackRequest = z.strictObject({
	jobId: z.uuid(),
	claimId: z.uuid(),
	result: z.enum(["printed", "failed", "unconfirmed"]),
	error: z.string().trim().max(500).optional(),
});

export type AckRequest = z.infer<typeof ackRequest>;

export type JobPost = { id: string; handle: string; name: string; createdAt: string; text: string; url: string };

export type JobSummary = { count: number; from: string; to: string; handles: string[]; moreHandles: number };

export type Job = { jobId: string; kind: "posts" | "summary"; createdAt: string; posts: JobPost[]; summary: JobSummary | null };

export type JobState = Job & {
	status: string;
	result: string | null;
	failures: number;
	notBefore: string | null;
	claimedAt: string | null;
	claimExpiresAt: string | null;
	claimedBy: string | null;
	bridge: string | null;
	ackedAt: string | null;
	ackedBy: string | null;
	leaseExpired: boolean;
	error: string | null;
	requeuedFrom: string | null;
};

export type DecisionsResult = {
	approved: string[];
	rejected: string[];
	overflowed: string[];
	capped: string[];
	refused: string[];
	unknownIds: string[];
	notPending: string[];
	jobs: string[];
};

export function iso(value: Date | string): string {
	return (value instanceof Date ? value : new Date(value)).toISOString().replace(/\.000Z$/, "Z");
}

export function printDay(at: Date): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

function minutesAfter(at: Date, minutes: number): Date {
	return new Date(at.getTime() + minutes * 60_000);
}

async function transaction<T>(client: Database, work: () => Promise<T>): Promise<T> {
	await client.query("begin");
	try {
		const result = await work();
		await client.query("commit");
		return result;
	} catch (error) {
		await client.query("rollback");
		throw error;
	}
}

type Stamp = Date | string | null;

type JobRow = {
	job_id: string;
	kind: "posts" | "summary";
	status: string;
	payload: { posts: JobPost[]; summary: JobSummary | null };
	created_at: Date | string;
	ready_at: Stamp;
	claim_id: string | null;
	claimed_at: Stamp;
	claim_expires_at: Stamp;
	claimed_by: string | null;
	bridge: string | null;
	result: string | null;
	acked_at: Stamp;
	acked_by: string | null;
	lease_expired: boolean;
	error: string | null;
	failures: number;
	requeued_from: string | null;
};

const JOB_COLUMNS =
	"job_id::text, kind, status, payload, created_at, ready_at, claim_id::text, claimed_at, claim_expires_at, claimed_by, bridge, result, acked_at, acked_by, lease_expired, error, failures, requeued_from::text";

function stamp(value: Stamp): string | null {
	if (value === null) return null;
	const at = new Date(value);
	return Number.isFinite(at.getTime()) ? iso(at) : null;
}

function toJob(row: JobRow): Job {
	return { jobId: row.job_id, kind: row.kind, createdAt: iso(row.created_at), posts: row.payload.posts, summary: row.payload.summary };
}

function toJobState(row: JobRow): JobState {
	return {
		...toJob(row),
		status: row.status,
		result: row.result,
		failures: Number(row.failures),
		notBefore: stamp(row.ready_at),
		claimedAt: stamp(row.claimed_at),
		claimExpiresAt: stamp(row.claim_expires_at),
		claimedBy: row.claimed_by,
		bridge: row.bridge,
		ackedAt: stamp(row.acked_at),
		ackedBy: row.acked_by,
		leaseExpired: row.lease_expired,
		error: row.error,
		requeuedFrom: row.requeued_from,
	};
}

async function insertJob(client: Database, kind: "posts" | "summary", payload: { posts: JobPost[]; summary: JobSummary | null }, postCount: number, now: Date, requeuedFrom: string | null = null): Promise<string> {
	const row = (
		await client.query<{ job_id: string }>(
			"insert into x_posts.jobs (kind, payload, post_count, created_at, print_day, requeued_from) values ($1, $2::jsonb, $3, $4, $5::date, $6::uuid) returning job_id::text",
			[kind, JSON.stringify(payload), postCount, now, printDay(now), requeuedFrom],
		)
	).rows[0];
	if (row === undefined) throw new Error("Could not insert a print job");
	return row.job_id;
}

export async function postsInJobsToday(client: Database, now: Date): Promise<number> {
	const row = (await client.query<{ used: number }>("select coalesce(sum(post_count), 0)::int as used from x_posts.jobs where kind = 'posts' and print_day = $1::date", [printDay(now)])).rows[0];
	return Number(row?.used ?? 0);
}

export const CUTOVER_REASON = "matched before the bridge cutover";

export async function skipBacklog(client: Database, before: Date, now: Date): Promise<number> {
	if (before.getTime() > now.getTime()) throw new BadRequest("before can't be in the future");
	const result = await client.query(
		"update x_posts.posts set status = 'overflow', reason = $2, decided_by = 'matt', decided_at = $3, summarized_at = $3 where status = 'pending' and ingested_at < $1",
		[before, CUTOVER_REASON, now],
	);
	const skipped = result.rowCount ?? 0;
	console.log(JSON.stringify({ xPosts: "skip backlog", actor: "matt", before: iso(before), skipped }));
	return skipped;
}

export async function pendingTotal(client: Database): Promise<number> {
	return Number((await client.query<{ n: number }>("select count(*)::int as n from x_posts.posts where status = 'pending'")).rows[0]?.n ?? 0);
}

async function buildSummary(client: Database, now: Date): Promise<string | null> {
	const rows = (
		await client.query<{ id: string; handle: string; created_at: Date | string }>(
			"select id::text, handle, created_at from x_posts.posts where status = 'overflow' and summary_job_id is null and summarized_at is null order by id for update",
		)
	).rows;
	if (rows.length === 0) return null;
	const blocklist = await readBlocklist(client);
	const seen = new Set<string>();
	const handles: string[] = [];
	for (const row of rows) {
		const key = row.handle.toLowerCase();
		if (!handleOk(row.handle, blocklist) || seen.has(key)) continue;
		seen.add(key);
		handles.push(row.handle);
	}
	const times = rows.map((row) => new Date(row.created_at).getTime());
	const summary: JobSummary = {
		count: rows.length,
		from: iso(new Date(Math.min(...times))),
		to: iso(new Date(Math.max(...times))),
		handles: handles.slice(0, MAX_HANDLES),
		moreHandles: Math.max(handles.length - MAX_HANDLES, 0),
	};
	const jobId = await insertJob(client, "summary", { posts: [], summary }, 0, now);
	await client.query("update x_posts.posts set summary_job_id = $1::uuid where id = any($2::bigint[])", [
		jobId,
		rows.map((row) => row.id),
	]);
	return jobId;
}

async function buildJobs(client: Database, approved: readonly string[], now: Date): Promise<{ jobs: string[]; queued: string[]; capped: string[] }> {
	const jobs: string[] = [];
	const used = await postsInJobsToday(client, now);
	const room = Math.max(0, Math.min(BATCH_CAP, DAILY_CAP - used));
	const queued = approved.slice(0, room);
	const capped = approved.slice(room);
	if (capped.length > 0) {
		const why = room < BATCH_CAP ? `daily cap of ${DAILY_CAP}` : `batch cap of ${BATCH_CAP}`;
		await client.query("update x_posts.posts set status = 'overflow', reason = $2, decided_by = 'caps', decided_at = $3 where id = any($1::bigint[])", [capped, why, now]);
	}
	if (queued.length > 0) {
		const rows = (
			await client.query<{ id: string; handle: string; clean_name: string; created_at: Date | string; clean_text: string }>(
				"select id::text, handle, clean_name, created_at, clean_text from x_posts.posts where id = any($1::bigint[]) order by id",
				[queued],
			)
		).rows;
		const posts: JobPost[] = rows.map((row) => ({ id: row.id, handle: row.handle, name: row.clean_name, createdAt: iso(row.created_at), text: row.clean_text, url: postUrl(row.handle, row.id) }));
		const jobId = await insertJob(client, "posts", { posts, summary: null }, posts.length, now);
		await client.query("update x_posts.posts set status = 'queued', job_id = $2::uuid where id = any($1::bigint[])", [queued, jobId]);
		jobs.push(jobId);
	}
	const summary = await buildSummary(client, now);
	if (summary !== null) jobs.push(summary);
	return { jobs, queued, capped };
}

export async function applyDecisions(client: Database, input: DecisionsRequest, actor: "prints-review" | "matt", now: Date, open: boolean): Promise<DecisionsResult> {
	if (!open) throw new Closed(QUEUE_CLOSED);
	const all = [...input.approve, ...input.reject.map((item) => item.id), ...input.overflow.map((item) => item.id)];
	const repeated = all.filter((id, index) => all.indexOf(id) !== index);
	if (repeated.length > 0) throw new BadRequest(`Each id may appear once across approve, reject and overflow: ${[...new Set(repeated)].join(", ")}`);
	return await transaction(client, async () => {
		const found = new Map(
			(await client.query<{ id: string; status: string; flags: string[] }>("select id::text, status, flags from x_posts.posts where id = any($1::bigint[]) for update", [all])).rows.map((row) => [row.id, row]),
		);
		const unknownIds = all.filter((id) => !found.has(id));
		const refused = input.approve.filter((id) => rejectingFlags(found.get(id)?.flags ?? []).length > 0);
		const notPending = all.filter((id) => found.has(id) && !refused.includes(id) && found.get(id)?.status !== "pending");
		const pending = (id: string) => found.get(id)?.status === "pending";
		const rejected = input.reject.filter((item) => pending(item.id));
		const overflowed = input.overflow.filter((item) => pending(item.id));
		const approved = input.approve.filter((id) => pending(id) && !refused.includes(id)).toSorted((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
		for (const [items, status] of [
			[rejected, "rejected"],
			[overflowed, "overflow"],
		] as const) {
			for (const item of items) {
				await client.query("update x_posts.posts set status = $2, reason = $3, decided_by = $4, decided_at = $5 where id = $1::bigint", [item.id, status, item.reason, actor, now]);
			}
		}
		if (approved.length > 0) await client.query("update x_posts.posts set status = 'approved', decided_by = $2, decided_at = $3 where id = any($1::bigint[])", [approved, actor, now]);
		const built = await buildJobs(client, approved, now);
		console.log(JSON.stringify({ xPosts: "decisions", actor, approved: built.queued.length, capped: built.capped.length, rejected: rejected.length, overflowed: overflowed.length, refused: refused.length }));
		return {
			approved: built.queued,
			rejected: rejected.map((item) => item.id),
			overflowed: overflowed.map((item) => item.id),
			capped: built.capped,
			refused,
			unknownIds,
			notPending,
			jobs: built.jobs,
		};
	});
}

async function settle(client: Database, row: Pick<JobRow, "job_id" | "kind">, result: "printed" | "unconfirmed" | "failed", now: Date): Promise<void> {
	if (row.kind === "posts") await client.query("update x_posts.posts set status = $2 where job_id = $1::uuid", [row.job_id, result]);
	else if (result === "printed") await client.query("update x_posts.posts set status = 'summarized', summarized_at = $2 where summary_job_id = $1::uuid", [row.job_id, now]);
}

export async function expireClaims(client: Database, now: Date): Promise<number> {
	const expired = (
		await client.query<Pick<JobRow, "job_id" | "kind">>(
			`update x_posts.jobs set status = 'unconfirmed', lease_expired = true, error = 'The claim expired before an ack; it may have printed'
			where status = 'claimed' and claim_expires_at <= $1
			returning job_id::text, kind`,
			[now],
		)
	).rows;
	for (const row of expired) await settle(client, row, "unconfirmed", now);
	return expired.length;
}

export async function claimJob(client: Database, { bridge, actor }: { bridge: string; actor: Actor }, now: Date, open: boolean): Promise<{ claimId: string; claimExpiresAt: string; job: Job } | null> {
	if (!open) throw new Closed(QUEUE_CLOSED);
	return await transaction(client, async () => {
		await expireClaims(client, now);
		const busy = (await client.query("select 1 from x_posts.jobs where status = 'claimed' limit 1")).rows.length > 0;
		if (busy) return null;
		const row = (
			await client.query<JobRow>(
				`update x_posts.jobs set status = 'claimed', claim_id = gen_random_uuid(), claimed_at = $1, claim_expires_at = $2, claimed_by = $3, bridge = $4, result = null, acked_at = null, acked_by = null
				where job_id = (select job_id from x_posts.jobs where status = 'ready' and ready_at <= $1 order by seq limit 1 for update skip locked)
				returning ${JOB_COLUMNS}`,
				[now, minutesAfter(now, CLAIM_MINUTES), actor, bridge],
			)
		).rows[0];
		if (row === undefined || row.claim_id === null || row.claim_expires_at === null) return null;
		console.log(JSON.stringify({ xPosts: "claim", actor, bridge, jobId: row.job_id }));
		return { claimId: row.claim_id, claimExpiresAt: iso(new Date(row.claim_expires_at)), job: toJob(row) };
	});
}

export async function ackJob(client: Database, ack: AckRequest, actor: Actor, now: Date): Promise<{ changed: boolean; job: JobState }> {
	await expireClaims(client, now);
	return await transaction(client, async () => {
		const row = (await client.query<JobRow>(`select ${JOB_COLUMNS} from x_posts.jobs where job_id = $1::uuid for update`, [ack.jobId])).rows[0];
		if (row === undefined) throw new NotFound(`No job ${ack.jobId}`);
		if (row.claim_id !== ack.claimId) throw new Conflict(`Claim ${ack.claimId} is not the current claim on job ${ack.jobId}`);
		if (row.lease_expired && row.acked_at === null) throw new Conflict(`Claim ${ack.claimId} expired at ${stamp(row.claim_expires_at)}; job ${ack.jobId} stays unconfirmed`);
		if (row.acked_at !== null) {
			if (row.result === ack.result) return { changed: false, job: toJobState(row) };
			throw new Conflict(`Job ${ack.jobId} was already acked as ${row.result} for this claim`);
		}
		const error = ack.error ?? null;
		if (ack.result === "failed") {
			const failures = Number(row.failures) + 1;
			const terminal = failures >= MAX_TRIES;
			const wait = RETRY_AFTER_MINUTES[failures - 1] ?? 0;
			await client.query("update x_posts.jobs set status = $2, result = 'failed', acked_at = $3, acked_by = $4, error = $5, failures = $6, ready_at = $7 where job_id = $1::uuid", [
				row.job_id,
				terminal ? "failed" : "ready",
				now,
				actor,
				error,
				failures,
				minutesAfter(now, wait),
			]);
			if (terminal) {
				await settle(client, row, "failed", now);
				await notice(
					client,
					`x-posts-job-failed:${row.job_id}`,
					"tools: receipt printing failed 3 times; Matt needs to check the printer",
					`Matt needs to check the receipt printer. Print job ${row.job_id} (${row.kind}) failed ${failures} times and stopped; the bridge reported that nothing reached paper each time. Last error from the bridge: ${error ?? "none given"}. Once the printer is fixed, Matt can send the job again from https://tools.mattpalmer.io/x-posts/queue. Please tell Matt.`,
				);
			}
		} else {
			await client.query("update x_posts.jobs set status = $2, result = $2, acked_at = $3, acked_by = $4, error = $5 where job_id = $1::uuid", [row.job_id, ack.result, now, actor, error]);
			await settle(client, row, ack.result, now);
		}
		console.log(JSON.stringify({ xPosts: "ack", actor, jobId: row.job_id, result: ack.result }));
		const updated = (await client.query<JobRow>(`select ${JOB_COLUMNS} from x_posts.jobs where job_id = $1::uuid`, [row.job_id])).rows[0];
		if (updated === undefined) throw new Error(`Job ${row.job_id} vanished`);
		return { changed: true, job: toJobState(updated) };
	});
}

export async function requeueJob(client: Database, jobId: string, now: Date): Promise<string> {
	return await transaction(client, async () => {
		const row = (await client.query<JobRow & { post_count: number }>(`select ${JOB_COLUMNS}, post_count from x_posts.jobs where job_id = $1::uuid for update`, [jobId])).rows[0];
		if (row === undefined) throw new NotFound(`No job ${jobId}`);
		if (row.status !== "unconfirmed" && row.status !== "failed") throw new Conflict(`Only unconfirmed or failed jobs can be printed again; this one is ${row.status}`);
		const already = (await client.query("select 1 from x_posts.jobs where requeued_from = $1::uuid limit 1", [jobId])).rows.length > 0;
		if (already) throw new Conflict(`Job ${jobId} was already sent again`);
		const next = await insertJob(client, row.kind, row.payload, Number(row.post_count), now, jobId);
		if (row.kind === "posts") await client.query("update x_posts.posts set status = 'queued', job_id = $2::uuid where job_id = $1::uuid", [jobId, next]);
		else await client.query("update x_posts.posts set summary_job_id = $2::uuid where summary_job_id = $1::uuid", [jobId, next]);
		console.log(JSON.stringify({ xPosts: "requeue", actor: "matt", jobId, next }));
		return next;
	});
}

export async function sweep(client: Database, now: Date, open: boolean): Promise<{ expired: number; overflowed: number; jobs: string[] }> {
	return await transaction(client, async () => {
		const expired = await expireClaims(client, now);
		const overflowed =
			(
				await client.query(
					`update x_posts.posts set status = 'overflow', reason = $3, decided_by = 'sweep', decided_at = $1, summarized_at = case when $4 then null else $1::timestamptz end
					where status = 'pending' and ingested_at < $1::timestamptz - make_interval(hours => $2)`,
					[now, REVIEW_TIMEOUT_HOURS, open ? "not reviewed" : "not reviewed (queue closed)", open],
				)
			).rowCount ?? 0;
		const jobs = open && overflowed > 0 ? (await buildJobs(client, [], now)).jobs : [];
		return { expired, overflowed, jobs };
	});
}

export async function listJobs(client: Database, limit = 50): Promise<JobState[]> {
	return (await client.query<JobRow>(`select ${JOB_COLUMNS} from x_posts.jobs order by seq desc limit $1`, [limit])).rows.map(toJobState);
}

export type ReviewPost = { id: string; handle: string; url: string; createdAt: string; flags: string[]; metrics: Record<string, number | null>; untrustedText: string };

export async function reviewQueue(client: Database, limit: number, idsOnly: boolean): Promise<{ pendingTotal: number; posts: ReviewPost[] | string[] }> {
	const total = await pendingTotal(client);
	if (idsOnly) {
		const ids = (await client.query<{ id: string }>("select id::text from x_posts.posts where status = 'pending' order by id")).rows.map((row) => row.id);
		return { pendingTotal: total, posts: ids };
	}
	const rows = (
		await client.query<{
			id: string;
			handle: string;
			created_at: Date | string;
			flags: string[];
			clean_text: string;
			likes: number | null;
			reposts: number | null;
			replies: number | null;
			quotes: number | null;
			bookmarks: number | null;
			impressions: number | null;
		}>("select id::text, handle, created_at, flags, clean_text, likes, reposts, replies, quotes, bookmarks, impressions from x_posts.posts where status = 'pending' order by id limit $1", [limit])
	).rows;
	return {
		pendingTotal: total,
		posts: rows.map((row) => ({
			id: row.id,
			handle: row.handle,
			url: postUrl(row.handle, row.id),
			createdAt: iso(row.created_at),
			flags: row.flags,
			metrics: { likes: row.likes, reposts: row.reposts, replies: row.replies, quotes: row.quotes, bookmarks: row.bookmarks, impressions: row.impressions },
			untrustedText: row.clean_text,
		})),
	};
}
