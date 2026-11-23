import { type RefObject, useState } from "react";
import { Button, buttonVariants } from "../../src/kit/button.tsx";
import type { OwnerPost } from "./owner.ts";
import type { Reply } from "./reply.ts";
import { isSendKey, REPLY_MAX, replyLength } from "./reply-length.ts";
import styles from "./x-posts.module.css";

export const CONNECT_URL = "/api/tools/x-posts/x/connect";

type Send = (body: { id: string; text: string }) => Promise<Reply>;

function intentUrl(postId: string, text: string): string {
	return `https://x.com/intent/post?${new URLSearchParams({ in_reply_to: postId, text })}`;
}

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function ReplyBox({ post, send, draft, onDraft, onSent, inputRef }: { post: OwnerPost; send: Send; draft: string; onDraft: (text: string) => void; onSent: (reply: Reply) => void; inputRef: RefObject<HTMLTextAreaElement | null> }) {
	const [sending, setSending] = useState<string | null>(null);
	const [error, setError] = useState<{ message: string; connect: boolean; text: string } | null>(null);
	const [refused, setRefused] = useState(false);
	const onX = post.replyHere === false || refused;
	const reply = post.reply;
	if (reply !== null)
		return (
			<div className={styles.reply}>
				<p className={styles.replyText}>{reply.text}</p>
				<p className={styles.meta}>
					Replied ·{" "}
					<a href={reply.url} target="_blank" rel="noreferrer">
						{reply.url.replace("https://", "")}
					</a>
				</p>
			</div>
		);
	if (sending !== null)
		return (
			<div className={styles.reply} aria-busy="true">
				<p className={styles.replyText}>{sending}</p>
				<p className={styles.meta}>Sending</p>
			</div>
		);
	const length = replyLength(draft);
	const over = length > REPLY_MAX;
	const ready = !over && draft.trim() !== "";
	async function submit() {
		const text = draft.trim();
		setSending(text);
		setError(null);
		try {
			const sent = await send({ id: post.id, text });
			onDraft("");
			onSent(sent);
		} catch (failure) {
			if (failure instanceof ReplyFailure && failure.onX) {
				setRefused(true);
				setSending(null);
				return;
			}
			const connect = failure instanceof ReplyFailure && failure.connect;
			setError({ message: failure instanceof Error ? failure.message : String(failure), connect, text });
		}
		setSending(null);
	}
	return (
		<div className={styles.replyBox}>
			<textarea
				ref={inputRef}
				className={styles.replyInput}
				rows={3}
				value={draft}
				placeholder="Reply"
				aria-label={`Reply to @${post.handle}`}
				onChange={(event) => {
					onDraft(event.target.value);
					setError(null);
				}}
				onKeyDown={(event) => {
					if (!isSendKey(event, MAC)) return;
					event.preventDefault();
					if (onX) window.open(intentUrl(post.id, draft.trim()), "_blank", "noreferrer");
					else if (ready) void submit();
				}}
			/>
			<div className={styles.replyBar}>
				<span className={styles.count} data-over={over || undefined}>
					{length}/{REPLY_MAX}
				</span>
				{onX ? (
					<a className={buttonVariants({ size: "sm", variant: "primary" })} href={intentUrl(post.id, draft.trim())} target="_blank" rel="noreferrer" title={MAC ? "⌘ Enter" : "Ctrl Enter"}>
						Reply on X
					</a>
				) : (
					<Button size="sm" variant="primary" disabled={!ready} title={MAC ? "⌘ Enter" : "Ctrl Enter"} onClick={() => void submit()}>
						Reply
					</Button>
				)}
			</div>
			{onX ? <p className={styles.muted}>No @mention, so X only takes this reply on X. Your draft goes with it.</p> : null}
			{error === null ? null : (
				<p className={styles.error}>
					{error.message}{" "}
					{error.connect ? (
						<a href={CONNECT_URL}>Connect X</a>
					) : (
						<a href={intentUrl(post.id, error.text)} target="_blank" rel="noreferrer">
							Reply on X
						</a>
					)}
				</p>
			)}
		</div>
	);
}

export class ReplyFailure extends Error {
	constructor(
		message: string,
		readonly connect: boolean,
		readonly onX: boolean,
	) {
		super(message);
	}
}

export function ConnectX() {
	return (
		<p className={styles.muted}>
			<a href={CONNECT_URL}>Connect X</a> to reply from here.
		</p>
	);
}
