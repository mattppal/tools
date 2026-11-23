import { type MouseEvent, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Button } from "../../src/kit/button.tsx";
import type { Mention, MentionSync } from "./mentions.ts";
import type { Reply } from "./reply.ts";
import { ConnectX, ReplyBox } from "./reply-box.tsx";
import { ago, Avatar, describe, LoadState, PostLink, replySender, request, useLoad, useNarrow, useVisibleInterval } from "./ui.tsx";
import styles from "./x-posts.module.css";

const POLL_MS = 10_000;
const sendMention = replySender("/mentions/reply");

function typing(target: EventTarget | null): boolean {
	return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

function nextMonth(now: number): string {
	const date = new Date(now);
	return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function SyncLine({ sync, now }: { sync: MentionSync; now: number }) {
	if (sync.paused === "budget") return <p className={styles.muted}>Paused: budget. Resumes {nextMonth(now)}.</p>;
	if (sync.paused === "capped") return <p className={styles.muted}>Paused: X usage cap. Resumes {nextMonth(now)}.</p>;
	return (
		<p className={styles.muted} aria-live="polite">
			Checked {sync.lastRunAt === null ? "never" : ago(sync.lastRunAt, now)}.{sync.lastError === null ? "" : ` ${sync.lastError}`}
		</p>
	);
}

export function MentionsPage({ connected }: { connected: boolean | null }) {
	const [load, retry] = useLoad<{ mentions: Mention[]; sync: MentionSync }>("/mentions");
	const [now, setNow] = useState(Date.now());
	const [chosen, setChosen] = useState<string | null>(null);
	const [drafts, setDrafts] = useState<ReadonlyMap<string, string>>(new Map());
	const [sent, setSent] = useState<ReadonlyMap<string, Reply>>(new Map());
	const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
	const [error, setError] = useState<string | null>(null);
	const input = useRef<HTMLTextAreaElement>(null);
	const rows = useRef(new Map<string, HTMLLIElement>());
	const narrow = useNarrow();
	useVisibleInterval(() => {
		retry();
		setNow(Date.now());
	}, POLL_MS);
	const mentions = (load.status === "ready" ? load.data.mentions : []).filter((item) => !dismissed.has(item.id)).map((item) => (item.reply === null && sent.has(item.id) ? { ...item, reply: sent.get(item.id) ?? null } : item));
	const selected = mentions.find((item) => item.id === chosen) ?? (narrow ? null : (mentions.find((item) => item.reply === null) ?? null));
	const select = (id: string | undefined, focus: "box" | "row") => {
		if (id === undefined) return;
		flushSync(() => setChosen(id));
		if (focus === "box" && input.current !== null) input.current.focus();
		else rows.current.get(id)?.focus();
		rows.current.get(id)?.scrollIntoView({ block: "nearest" });
	};
	const nextOpen = (after: string, skip: ReadonlySet<string> = new Set()) => {
		const index = mentions.findIndex((item) => item.id === after);
		const open = (item: Mention) => item.reply === null && item.id !== after && !skip.has(item.id);
		return mentions.slice(index + 1).find(open) ?? mentions.find(open);
	};
	async function dismiss(id: string) {
		const next = nextOpen(id);
		setDismissed((all) => new Set(all).add(id));
		setError(null);
		if (next !== undefined) select(next.id, "row");
		try {
			await request("/mentions/dismiss", { method: "POST", body: { id } });
		} catch (failure) {
			setDismissed((all) => {
				const kept = new Set(all);
				kept.delete(id);
				return kept;
			});
			setError(describe(failure));
		}
	}
	const keys = useRef<(event: KeyboardEvent) => void>(() => {});
	keys.current = (event) => {
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		if (typing(event.target)) {
			if (event.key === "Escape" && selected !== null) {
				event.preventDefault();
				rows.current.get(selected.id)?.focus();
			}
			return;
		}
		const index = selected === null ? -1 : mentions.findIndex((item) => item.id === selected.id);
		if (event.key === "j") select(mentions[Math.min(index + 1, mentions.length - 1)]?.id, "row");
		else if (event.key === "k") select(mentions[Math.max(index - 1, 0)]?.id, "row");
		else if ((event.key === "r" || event.key === "Enter") && selected !== null && selected.reply === null) select(selected.id, "box");
		else if (event.key === "d" && selected !== null) void dismiss(selected.id);
		else return;
		event.preventDefault();
	};
	useEffect(() => {
		const listener = (event: KeyboardEvent) => keys.current(event);
		document.addEventListener("keydown", listener);
		return () => document.removeEventListener("keydown", listener);
	}, []);
	if (load.status !== "ready") return <LoadState load={load} retry={retry} />;
	return (
		<>
			<SyncLine sync={load.data.sync} now={now} />
			{connected === false ? <ConnectX /> : null}
			{error === null ? null : <p className={styles.error}>{error}</p>}
			{mentions.length === 0 ? (
				<p className={styles.muted}>No mentions yet.</p>
			) : (
				<ul className={`${styles.list} ${styles.mentions}`}>
					{mentions.map((item) => {
						const current = selected?.id === item.id;
						return (
							<li
								key={item.id}
								ref={(node) => {
									if (node === null) rows.current.delete(item.id);
									else rows.current.set(item.id, node);
								}}
								className={styles.liveRow}
								tabIndex={-1}
								aria-current={current || undefined}
								onClick={(event: MouseEvent<HTMLElement>) => {
									if ((event.target as HTMLElement).closest("a, button, textarea, [data-box]")) return;
									select(item.id, item.reply === null ? "box" : "row");
								}}
							>
								<p className={styles.liveHead}>
									<Avatar url={item.avatarUrl} />
									<span className={styles.liveName}>{item.name || item.handle}</span>
									{item.handle === "" ? null : <span>@{item.handle}</span>}
									<PostLink url={item.url} createdAt={item.createdAt}>
										{ago(item.createdAt, now)}
									</PostLink>
									{item.reply !== null ? (
										<a className={styles.rowReplied} href={item.reply.url} target="_blank" rel="noreferrer">
											Replied
										</a>
									) : narrow && !current ? (
										<Button size="sm" variant="quiet" className={styles.rowReply} onClick={() => select(item.id, "box")}>
											Reply
										</Button>
									) : null}
								</p>
								<p className={styles.text}>{item.text}</p>
								{current ? (
									<div className={styles.inlineReply} data-box>
										{item.reply === null && connected ? (
											<ReplyBox
												key={item.id}
												post={item}
												send={sendMention}
												draft={drafts.get(item.id) ?? ""}
												onDraft={(text) => setDrafts((all) => new Map(all).set(item.id, text))}
												onSent={(reply) => {
													const next = nextOpen(item.id, new Set([item.id]));
													setSent((all) => new Map(all).set(item.id, reply));
													if (next !== undefined) select(next.id, "box");
												}}
												inputRef={input}
											/>
										) : null}
										<div className={styles.rowTools}>
											{narrow ? null : <span className={styles.meta}>j k move · r reply · d dismiss · Esc leaves the box</span>}
											<Button size="sm" variant="quiet" onClick={() => void dismiss(item.id)}>
												Dismiss
											</Button>
										</div>
									</div>
								) : null}
							</li>
						);
					})}
				</ul>
			)}
		</>
	);
}

