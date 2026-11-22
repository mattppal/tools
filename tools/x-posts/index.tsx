import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../src/kit/button.tsx";
import { useToolPath } from "../../src/router.tsx";
import { ToolLayout, type ToolSection } from "../../src/shell/tool-layout.tsx";
import type { OwnerPost, Status } from "./owner.ts";
import type { JobState } from "./queue.ts";
import styles from "./x-posts.module.css";

const API = "/api/tools/x-posts";

const SECTIONS: readonly ToolSection[] = [
	{ path: "/", label: "Live" },
	{ path: "/posts", label: "Posts" },
	{ path: "/queue", label: "Queue" },
	{ path: "/blocklist", label: "Blocklist" },
];

const FILTERS = [
	{ status: "pending", label: "Pending" },
	{ status: null, label: "All" },
	{ status: "queued", label: "Queued" },
	{ status: "printed", label: "Printed" },
	{ status: "overflow", label: "Overflow" },
	{ status: "summarized", label: "Summarized" },
	{ status: "rejected", label: "Rejected" },
	{ status: "unconfirmed", label: "Unconfirmed" },
	{ status: "failed", label: "Failed" },
] as const;

type Load<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: T };

function describe(error: unknown): string {
	if (error instanceof TypeError) return "Couldn't reach the server. Reload the page to sign in again.";
	return error instanceof Error ? error.message : String(error);
}

async function request<T>(path: string, init?: { method: string; body: unknown }): Promise<T> {
	let response: Response;
	try {
		response = await fetch(`${API}${path}`, init === undefined ? undefined : { method: init.method, headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) });
	} catch (error) {
		throw new Error(describe(error));
	}
	const json: unknown = await response.json().catch(() => null);
	if (!response.ok) throw new Error((json as { error?: string } | null)?.error ?? `Request failed with ${response.status}`);
	return json as T;
}

function useLoad<T>(path: string): [Load<T>, () => void] {
	const [load, setLoad] = useState<Load<T>>({ status: "loading" });
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		let live = true;
		request<T>(path).then(
			(data) => live && setLoad({ status: "ready", data }),
			(error: unknown) => live && setLoad({ status: "error", message: describe(error) }),
		);
		return () => {
			live = false;
		};
	}, [path, attempt]);
	return [load, useCallback(() => setAttempt((count) => count + 1), [])];
}

function when(iso: string | null): string {
	if (iso === null) return "never";
	return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" });
}

const LIVE_POLL_MS = 10_000;
const LIVE_LIMIT = 100;

function ago(iso: string, now: number): string {
	const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
	if (seconds < 60) return "just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	return hours < 24 ? `${hours}h ago` : when(iso);
}

function count(value: number | null, one: string, many: string): string | null {
	return value === null ? null : `${value.toLocaleString("en-US")} ${value === 1 ? one : many}`;
}

function useVisibleInterval(callback: () => void, ms: number): void {
	const saved = useRef(callback);
	saved.current = callback;
	useEffect(() => {
		const tick = () => {
			if (document.visibilityState === "visible") saved.current();
		};
		const timer = setInterval(tick, ms);
		document.addEventListener("visibilitychange", tick);
		return () => {
			clearInterval(timer);
			document.removeEventListener("visibilitychange", tick);
		};
	}, [ms]);
}

function LivePost({ post, now, fresh }: { post: OwnerPost; now: number; fresh: boolean }) {
	const metrics = [count(post.metrics.likes, "like", "likes"), count(post.metrics.reposts, "repost", "reposts"), count(post.metrics.replies, "reply", "replies"), count(post.metrics.quotes, "quote", "quotes"), count(post.metrics.impressions, "view", "views")].filter(
		(part): part is string => part !== null,
	);
	const state = [post.status, ...post.flags, post.reason].filter((part): part is string => part !== null && part !== "");
	return (
		<li className={styles.liveRow} data-fresh={fresh || undefined}>
			<p className={styles.liveHead}>
				<span className={styles.liveName}>{post.name || post.handle}</span>
				<span>@{post.handle}</span>
				<time dateTime={post.createdAt} title={when(post.createdAt)}>
					{ago(post.createdAt, now)}
				</time>
			</p>
			<p className={styles.text}>{post.text}</p>
			{post.cleanText !== post.text ? <p className={styles.clean}>Prints as: {post.cleanText}</p> : null}
			<p className={styles.meta}>
				{[...metrics, ...state].join(" · ")}
			</p>
			<p className={styles.meta}>
				<a href={post.url} target="_blank" rel="noreferrer">
					{post.url.replace("https://", "")}
				</a>
			</p>
		</li>
	);
}

function LivePage({ checks, status, refreshStatus }: { checks: number; status: Load<Status>; refreshStatus: () => void }) {
	const [posts, retry] = useLoad<{ posts: OwnerPost[]; nextBefore: string | null }>(`/posts?limit=${LIVE_LIMIT}`);
	const seen = useRef<Set<string> | null>(null);
	const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
	const [now, setNow] = useState(Date.now());
	useVisibleInterval(() => {
		retry();
		setNow(Date.now());
	}, LIVE_POLL_MS);
	useVisibleInterval(refreshStatus, 30_000);
	useEffect(() => {
		if (checks > 0) retry();
	}, [checks, retry]);
	useEffect(() => {
		if (posts.status !== "ready") return;
		const ids = posts.data.posts.map((post) => post.id);
		if (seen.current !== null) {
			const known = seen.current;
			setFresh(new Set(ids.filter((id) => !known.has(id))));
		}
		seen.current = new Set(ids);
	}, [posts]);
	const sync = status.status === "ready" ? status.data.sync : null;
	return (
		<>
			<p className={styles.muted} aria-live="polite">
				{sync === null
					? "Watching for new posts."
					: `X checked ${sync.lastRunAt === null ? "never" : ago(sync.lastRunAt, now)}${sync.nextRunAt === null ? ", next check due now" : `, next check ${when(sync.nextRunAt)}`}. Every minute while posts are arriving, every 5 minutes otherwise.`}
			</p>
			{posts.status !== "ready" ? (
				<LoadState load={posts} retry={retry} />
			) : posts.data.posts.length === 0 ? (
				<p className={styles.muted}>No posts yet.</p>
			) : (
				<ul className={styles.list}>
					{posts.data.posts.map((post) => (
						<LivePost key={post.id} post={post} now={now} fresh={fresh.has(post.id)} />
					))}
				</ul>
			)}
		</>
	);
}

function CheckNow({ onChecked }: { onChecked: () => void }) {
	const [busy, setBusy] = useState(false);
	const [note, setNote] = useState<string | null>(null);
	async function check() {
		setBusy(true);
		setNote(null);
		try {
			const result = await request<{ status: string; inserted?: number }>("/check", { method: "POST", body: {} });
			setNote(result.status === "not due" ? "Checked moments ago" : `${result.inserted ?? 0} new`);
			onChecked();
		} catch (failure) {
			setNote(describe(failure));
		}
		setBusy(false);
	}
	return (
		<span className={styles.checkNow}>
			{note === null ? null : <span className={styles.muted}>{note}</span>}
			<Button size="sm" loading={busy} disabled={busy} onClick={() => void check()}>
				Check now
			</Button>
		</span>
	);
}

function LoadState({ load, retry }: { load: Exclude<Load<unknown>, { status: "ready" }>; retry: () => void }) {
	if (load.status === "loading") return <div className={styles.loading} aria-busy="true" aria-label="Loading" />;
	return (
		<div className={styles.empty}>
			<p>{load.message}</p>
			<Button onClick={retry}>Try again</Button>
		</div>
	);
}

function Details({ status }: { status: Load<Status> }) {
	if (status.status !== "ready") return <p className={styles.muted}>{status.status === "error" ? status.message : "Loading"}</p>;
	const data = status.data;
	const rows: [string, string][] = [
		["Query", data.query],
		["Ingest", data.live ? "On" : "Off"],
		["Print queue", data.queueOpen ? "Open" : "Closed, shadow mode"],
		["Matched", `${data.shadow.matched.toLocaleString("en-US")} since ${when(data.shadow.since)}`],
		["Auto-rejected", `${data.shadow.autoRejected.toLocaleString("en-US")}${Object.keys(data.shadow.rejectedByFlag).length === 0 ? "" : ` (${Object.entries(data.shadow.rejectedByFlag).map(([flag, n]) => `${flag} ${n}`).join(", ")})`}`],
		["Addressed", `${data.shadow.addressed.toLocaleString("en-US")}, ${(data.shadow.addressedRate * 100).toFixed(1)}%`],
		["Would print", `${data.shadow.wouldPrint.toLocaleString("en-US")} of ${data.shadow.passedScreen.toLocaleString("en-US")} that passed the screen`],
		["Last success", when(data.sync.lastSuccessAt)],
		["Next run", data.sync.nextRunAt === null ? "Due" : when(data.sync.nextRunAt)],
		["Reads this month", `${data.reads.used.toLocaleString("en-US")} of ${data.reads.budget.toLocaleString("en-US")}${data.reads.capped ? ", capped by X" : ""}`],
		["Printed or queued today", `${data.today.printedOrQueued} of ${data.today.dailyCap}`],
		["Batch size", `Up to ${data.today.batchCap} posts`],
		...Object.entries(data.counts).map(([key, value]): [string, string] => [key[0]?.toUpperCase() + key.slice(1), value.toLocaleString("en-US")]),
	];
	if (data.sync.lastError !== null) rows.push(["Last error", data.sync.lastError]);
	return (
		<dl className={styles.details}>
			{rows.map(([label, value]) => (
				<div key={label} className={styles.detailRow}>
					<dt>{label}</dt>
					<dd>{value}</dd>
				</div>
			))}
		</dl>
	);
}

function PostItem({ post, canDecide, onDecided }: { post: OwnerPost; canDecide: boolean; onDecided: () => void }) {
	const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
	const [error, setError] = useState<string | null>(null);
	async function decide(kind: "approve" | "reject") {
		setBusy(kind);
		setError(null);
		try {
			await request("/decide", { method: "POST", body: kind === "approve" ? { approve: [post.id] } : { reject: [{ id: post.id, reason: "Matt rejected it" }] } });
			onDecided();
		} catch (failure) {
			setError(describe(failure));
			setBusy(null);
		}
	}
	const meta = [`@${post.handle}`, when(post.createdAt), post.status, ...post.flags, post.reason].filter((part): part is string => part !== null && part !== "");
	return (
		<li className={styles.postRow}>
			<p className={styles.meta}>
				<a href={post.url} target="_blank" rel="noreferrer">
					{post.name}
				</a>{" "}
				{meta.join(" · ")}
			</p>
			<p className={styles.text}>{post.text}</p>
			{post.cleanText !== post.text ? <p className={styles.clean}>Prints as: {post.cleanText}</p> : null}
			{post.status === "pending" && canDecide ? (
				<div className={styles.actions}>
					<Button size="sm" loading={busy === "approve"} disabled={busy !== null} onClick={() => void decide("approve")}>
						Approve
					</Button>
					<Button size="sm" variant="quiet" loading={busy === "reject"} disabled={busy !== null} onClick={() => void decide("reject")}>
						Reject
					</Button>
				</div>
			) : null}
			{error === null ? null : <p className={styles.error}>{error}</p>}
		</li>
	);
}

function PostsPage({ status, refreshStatus }: { status: Load<Status>; refreshStatus: () => void }) {
	const canDecide = status.status === "ready" && status.data.queueOpen;
	const [filter, setFilter] = useState<string | null>("pending");
	const [posts, retry] = useLoad<{ posts: OwnerPost[]; nextBefore: string | null }>(`/posts${filter === null ? "" : `?status=${filter}`}`);
	return (
		<>
			<div className={styles.filters} role="group" aria-label="Status">
				{FILTERS.map((option) => (
					<Button key={option.label} size="sm" variant="quiet" aria-pressed={filter === option.status} onClick={() => setFilter(option.status)}>
						{option.label}
					</Button>
				))}
			</div>
			{posts.status !== "ready" ? (
				<LoadState load={posts} retry={retry} />
			) : posts.data.posts.length === 0 ? (
				<p className={styles.muted}>No posts here.</p>
			) : (
				<ul className={styles.list}>
					{posts.data.posts.map((post) => (
						<PostItem
							key={post.id}
							post={post}
							canDecide={canDecide}
							onDecided={() => {
								retry();
								refreshStatus();
							}}
						/>
					))}
				</ul>
			)}
		</>
	);
}

function jobLine(job: JobState): string {
	const what = job.kind === "posts" ? `${job.posts.length} ${job.posts.length === 1 ? "post" : "posts"}` : `Summary of ${job.summary?.count ?? 0} more`;
	const tries = job.failures > 0 ? `${job.failures} failed ${job.failures === 1 ? "try" : "tries"}` : null;
	return [what, job.status, when(job.createdAt), tries, job.error].filter((part): part is string => part !== null).join(" · ");
}

function QueuePage({ status, refresh }: { status: Load<Status>; refresh: () => void }) {
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	if (status.status !== "ready") return <LoadState load={status} retry={refresh} />;
	async function again(jobId: string) {
		setBusy(jobId);
		setError(null);
		try {
			await request("/jobs/requeue", { method: "POST", body: { jobId } });
			refresh();
		} catch (failure) {
			setError(describe(failure));
		}
		setBusy(null);
	}
	const jobs = status.data.jobs;
	return (
		<>
			<p className={styles.muted}>
				{status.data.today.printedOrQueued} of {status.data.today.dailyCap} posts printed or queued today. A job that may have printed is never sent again on its own.
			</p>
			{error === null ? null : <p className={styles.error}>{error}</p>}
			{jobs.length === 0 ? (
				<p className={styles.muted}>No print jobs yet.</p>
			) : (
				<ul className={styles.list}>
					{jobs.map((job) => (
						<li key={job.jobId} className={styles.jobRow}>
							<p className={styles.meta}>{jobLine(job)}</p>
							{job.kind === "posts" ? <p className={styles.text}>{job.posts.map((post) => `@${post.handle}`).join(", ")}</p> : <p className={styles.text}>{job.summary?.handles.map((handle) => `@${handle}`).join(", ")}</p>}
							{(job.status === "unconfirmed" || job.status === "failed") && !jobs.some((other) => other.requeuedFrom === job.jobId) ? (
								<div className={styles.actions}>
									<Button size="sm" loading={busy === job.jobId} disabled={busy !== null} onClick={() => void again(job.jobId)}>
										Print again
									</Button>
								</div>
							) : null}
						</li>
					))}
				</ul>
			)}
		</>
	);
}

function BlocklistPage({ status, refresh }: { status: Load<Status>; refresh: () => void }) {
	const [draft, setDraft] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [note, setNote] = useState<string | null>(null);
	if (status.status !== "ready") return <LoadState load={status} retry={refresh} />;
	const value = draft ?? status.data.blocklist.join("\n");
	async function save() {
		setSaving(true);
		setNote(null);
		try {
			const saved = await request<{ terms: string[]; rescreened: number }>("/blocklist", { method: "PUT", body: { terms: value.split("\n") } });
			setDraft(null);
			setNote(`Saved ${saved.terms.length} ${saved.terms.length === 1 ? "term" : "terms"} and rescreened ${saved.rescreened} pending ${saved.rescreened === 1 ? "post" : "posts"}.`);
			refresh();
		} catch (failure) {
			setNote(describe(failure));
		}
		setSaving(false);
	}
	return (
		<>
			<p className={styles.muted}>One word or phrase per line. A pending post that matches is rejected, and a handle that contains a term is left out of summaries. Bots can't read this list.</p>
			<textarea className={styles.textarea} rows={12} value={value} aria-label="Blocklist" onChange={(event) => setDraft(event.target.value)} />
			<div className={styles.actions}>
				<Button loading={saving} disabled={draft === null || saving} onClick={() => void save()}>
					Save
				</Button>
			</div>
			{note === null ? null : <p className={styles.muted}>{note}</p>}
		</>
	);
}

export default function XPosts() {
	const path = useToolPath();
	const [status, refresh] = useLoad<Status>("/status");
	const [checks, setChecks] = useState(0);
	const page =
		path === "/queue" ? (
			<QueuePage status={status} refresh={refresh} />
		) : path === "/blocklist" ? (
			<BlocklistPage status={status} refresh={refresh} />
		) : path === "/posts" ? (
			<PostsPage status={status} refreshStatus={refresh} />
		) : (
			<LivePage checks={checks} status={status} refreshStatus={refresh} />
		);
	const actions =
		path === "/" && status.status === "ready" && status.data.live ? (
			<CheckNow
				onChecked={() => {
					refresh();
					setChecks((count) => count + 1);
				}}
			/>
		) : undefined;
	return (
		<ToolLayout title="X posts" actions={actions} sections={SECTIONS} panel={{ label: "Details", content: <Details status={status} /> }}>
			<div className={styles.page}>{page}</div>
		</ToolLayout>
	);
}
