import { type KeyboardEvent, type MouseEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Button } from "../../src/kit/button.tsx";
import { useToolPath } from "../../src/router.tsx";
import { ToolLayout, type ToolSection } from "../../src/shell/tool-layout.tsx";
import type { OwnerPost, Status } from "./owner.ts";
import type { JobState } from "./queue.ts";
import type { Reply } from "./reply.ts";
import { MentionsPage } from "./mentions-view.tsx";
import { ConnectX, ReplyBox } from "./reply-box.tsx";
import { Avatar, ago, CopyLink, describe, type Load, LoadState, PostLink, replySender, request, useLoad, useNarrow, useVisibleInterval, when } from "./ui.tsx";
import styles from "./x-posts.module.css";

const SECTIONS: readonly ToolSection[] = [
	{ path: "/", label: "Live" },
	{ path: "/mentions", label: "Mentions" },
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

const sendReply = replySender("/reply");

function isConnected(status: Load<Status>): boolean {
	return status.status === "ready" && status.data.x !== null;
}

type Inbox = {
	posts: OwnerPost[];
	selected: OwnerPost | null;
	select: (id: string) => void;
	pane: ReactNode;
	paneFor: (id: string) => ReactNode;
	replyFor: (post: OwnerPost) => ReactNode;
};

function useInbox(load: Load<{ posts: OwnerPost[] }>, status: Load<Status>): Inbox {
	const [chosen, setChosen] = useState<string | null>(null);
	const input = useRef<HTMLTextAreaElement>(null);
	const narrow = useNarrow();
	const select = (id: string) => {
		flushSync(() => setChosen(id));
		input.current?.focus();
	};
	const [sent, setSent] = useState<ReadonlyMap<string, Reply>>(new Map());
	const [drafts, setDrafts] = useState<ReadonlyMap<string, string>>(new Map());
	const posts = (load.status === "ready" ? load.data.posts : []).map((post) => (post.reply === null && sent.has(post.id) ? { ...post, reply: sent.get(post.id) ?? null } : post));
	const selected = posts.find((post) => post.id === chosen) ?? posts.find((post) => post.reply === null) ?? posts[0] ?? null;
	const connected = isConnected(status);
	const pane = (
		<aside className={styles.replyPane} aria-label="Reply" data-inline={narrow || undefined}>
			{status.status === "ready" && !connected ? <ConnectX /> : null}
			{selected === null ? (
				<p className={styles.muted}>Pick a post to reply.</p>
			) : (
				<>
					<div className={styles.postFoot}>
						<p className={styles.meta}>{narrow ? "" : `@${selected.handle}`}</p>
						<CopyLink url={selected.url} />
					</div>
					{narrow ? null : <p className={styles.paneText}>{selected.text}</p>}
					{connected || selected.reply !== null ? (
						<ReplyBox
							key={selected.id}
							post={selected}
							send={sendReply}
							draft={drafts.get(selected.id) ?? ""}
							onDraft={(text) => setDrafts((all) => new Map(all).set(selected.id, text))}
							onSent={(reply) => setSent((all) => new Map(all).set(selected.id, reply))}
							inputRef={input}
						/>
					) : null}
				</>
			)}
		</aside>
	);
	return {
		posts,
		selected: narrow ? (posts.find((post) => post.id === chosen) ?? null) : selected,
		pane: narrow ? null : pane,
		paneFor: (id) => (narrow && chosen === id ? pane : null),
		replyFor: (post) =>
			post.reply !== null ? (
				<a className={styles.rowReplied} href={post.reply.url} target="_blank" rel="noreferrer" title={when(post.reply.at)}>
					Replied
				</a>
			) : narrow && chosen !== post.id ? (
				<Button size="sm" variant="quiet" className={styles.rowReply} onClick={() => select(post.id)}>
					Reply
				</Button>
			) : null,
		select,
	};
}

function selectable(id: string, inbox: Inbox) {
	return {
		tabIndex: 0,
		"aria-current": inbox.selected?.id === id || undefined,
		onClick: (event: MouseEvent<HTMLElement>) => {
			if ((event.target as HTMLElement).closest("a, button, textarea, aside")) return;
			inbox.select(id);
		},
		onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
			if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
			event.preventDefault();
			inbox.select(id);
		},
	};
}

const LIVE_POLL_MS = 10_000;
const LIVE_LIMIT = 100;

function PostBody({ post, time, action }: { post: OwnerPost; time: string; action: ReactNode }) {
	return (
		<>
			<p className={styles.liveHead}>
				<Avatar url={post.avatarUrl} />
				<span className={styles.liveName}>{post.name || post.handle}</span>
				<span>@{post.handle}</span>
				<PostLink url={post.url} createdAt={post.createdAt}>{time}</PostLink>
				{action}
			</p>
			<p className={styles.text}>{post.text}</p>
		</>
	);
}

function PostFoot({ post }: { post: OwnerPost }) {
	const meta = [post.status === "pending" ? null : post.status, post.replyHere === false && post.reply === null ? "Reply on X" : null, ...post.flags, post.reason].filter((part): part is string => part !== null && part !== "");
	return meta.length === 0 ? null : <p className={styles.meta}>{meta.join(" · ")}</p>;
}

function LivePost({ post, now, fresh, inbox }: { post: OwnerPost; now: number; fresh: boolean; inbox: Inbox }) {
	return (
		<li className={styles.liveRow} data-fresh={fresh || undefined} {...selectable(post.id, inbox)}>
			<PostBody post={post} time={ago(post.createdAt, now)} action={inbox.replyFor(post)} />
			<PostFoot post={post} />
			{inbox.paneFor(post.id)}
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
	const inbox = useInbox(posts, status);
	return (
		<>
			<p className={styles.muted} aria-live="polite">
				{sync === null
					? "Watching for new posts."
					: `Checked ${sync.lastRunAt === null ? "never" : ago(sync.lastRunAt, now)}.`}
			</p>
			{posts.status !== "ready" ? (
				<LoadState load={posts} retry={retry} />
			) : posts.data.posts.length === 0 ? (
				<p className={styles.muted}>No posts yet.</p>
			) : (
				<div className={styles.inbox}>
					<ul className={styles.list}>
						{inbox.posts.map((post) => (
							<LivePost key={post.id} post={post} now={now} fresh={fresh.has(post.id)} inbox={inbox} />
						))}
					</ul>
					{inbox.pane}
				</div>
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

function Details({ status }: { status: Load<Status> }) {
	if (status.status !== "ready") return <p className={styles.muted}>{status.status === "error" ? status.message : "Loading"}</p>;
	const data = status.data;
	const rows: [string, string][] = [
		["Query", data.query],
		["Ingest", data.live ? "On" : "Off"],
		["Print queue", data.queueOpen ? "Open" : "Closed"],
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
	rows.push(["Replies as", data.x === null ? "Not connected" : `@${data.x.username}${data.x.lastError === null ? "" : `, ${data.x.lastError}`}`]);
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

function PostItem({ post, canDecide, onDecided, inbox }: { post: OwnerPost; canDecide: boolean; onDecided: () => void; inbox: Inbox }) {
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
	return (
		<li className={styles.postRow} {...selectable(post.id, inbox)}>
			<PostBody post={post} time={when(post.createdAt)} action={inbox.replyFor(post)} />
			<PostFoot post={post} />
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
			{inbox.paneFor(post.id)}
		</li>
	);
}

function PostsPage({ status, refreshStatus }: { status: Load<Status>; refreshStatus: () => void }) {
	const canDecide = status.status === "ready" && status.data.queueOpen;
	const [filter, setFilter] = useState<string | null>("pending");
	const [posts, retry] = useLoad<{ posts: OwnerPost[]; nextBefore: string | null }>(`/posts${filter === null ? "" : `?status=${filter}`}`);
	const inbox = useInbox(posts, status);
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
				<div className={styles.inbox}>
					<ul className={styles.list}>
						{inbox.posts.map((post) => (
							<PostItem
								key={post.id}
								post={post}
								canDecide={canDecide}
								inbox={inbox}
								onDecided={() => {
									retry();
									refreshStatus();
								}}
							/>
						))}
					</ul>
					{inbox.pane}
				</div>
			)}
		</>
	);
}

function jobLine(job: JobState): string {
	const what = job.kind === "posts" ? `${job.posts.length} ${job.posts.length === 1 ? "post" : "posts"}` : `Summary of ${job.summary?.count ?? 0} more`;
	const tries = job.failures > 0 ? `${job.failures} failed ${job.failures === 1 ? "try" : "tries"}` : null;
	return [what, job.status, when(job.createdAt), tries, job.error].filter((part): part is string => part !== null).join(" · ");
}

function SkipBacklog({ pending, refresh }: { pending: number; refresh: () => void }) {
	const [cutover, setCutover] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	async function skip(before: string) {
		setBusy(true);
		setError(null);
		try {
			const { skipped } = await request<{ skipped: number }>("/backlog/skip", { method: "POST", body: { before } });
			setResult(`Skipped ${skipped.toLocaleString("en-US")} ${skipped === 1 ? "post" : "posts"} matched before ${when(before)}.`);
			setCutover(null);
			refresh();
		} catch (failure) {
			setError(describe(failure));
		}
		setBusy(false);
	}
	if (cutover !== null) {
		return (
			<div className={styles.skip}>
				<p className={styles.muted}>Skip every pending post matched before {when(cutover)}? They go to overflow and never print, not even in a summary.</p>
				{error === null ? null : <p className={styles.error}>{error}</p>}
				<div className={styles.actions}>
					<Button size="sm" variant="destructive" loading={busy} disabled={busy} onClick={() => void skip(cutover)}>
						Skip them
					</Button>
					<Button size="sm" variant="quiet" disabled={busy} onClick={() => setCutover(null)}>
						Cancel
					</Button>
				</div>
			</div>
		);
	}
	return (
		<div className={styles.skip}>
			<p className={styles.muted}>
				{result ?? `${pending.toLocaleString("en-US")} ${pending === 1 ? "post is" : "posts are"} waiting for review.`} At the bridge cutover, skip the backlog so only posts matched after it print.
			</p>
			<div className={styles.actions}>
				<Button size="sm" variant="quiet" disabled={pending === 0} onClick={() => setCutover(new Date().toISOString())}>
					Skip backlog
				</Button>
			</div>
		</div>
	);
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
			<SkipBacklog pending={status.data.counts.pending ?? 0} refresh={refresh} />
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
		) : path === "/mentions" ? (
			<MentionsPage connected={status.status === "ready" ? status.data.x !== null : null} />
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
			<div className={styles.page} data-wide={path === "/" || path === "/posts" || undefined}>
				{page}
			</div>
		</ToolLayout>
	);
}
