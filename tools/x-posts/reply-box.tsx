import { useState } from "react";
import { Button } from "../../src/kit/button.tsx";
import type { OwnerPost } from "./owner.ts";
import type { Reply } from "./reply.ts";
import { REPLY_MAX, replyLength } from "./reply-length.ts";
import styles from "./x-posts.module.css";

export const CONNECT_URL = "/api/tools/x-posts/x/connect";

type Send = (body: { id: string; text: string }) => Promise<Reply>;

function intentUrl(postId: string, text: string): string {
	return `https://x.com/intent/post?${new URLSearchParams({ in_reply_to: postId, text })}`;
}

export function ReplyBox({ post, send }: { post: OwnerPost; send: Send }) {
	const [draft, setDraft] = useState("");
	const [sending, setSending] = useState<string | null>(null);
	const [sent, setSent] = useState<Reply | null>(null);
	const [error, setError] = useState<{ message: string; connect: boolean; text: string } | null>(null);
	const reply = sent ?? post.reply;
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
	async function submit() {
		const text = draft.trim();
		setSending(text);
		setError(null);
		try {
			setSent(await send({ id: post.id, text }));
			setDraft("");
		} catch (failure) {
			const connect = failure instanceof ReplyFailure && failure.connect;
			setError({ message: failure instanceof Error ? failure.message : String(failure), connect, text });
		}
		setSending(null);
	}
	return (
		<div className={styles.replyBox}>
			<textarea
				className={styles.replyInput}
				rows={1}
				value={draft}
				placeholder="Reply"
				aria-label={`Reply to @${post.handle}`}
				onChange={(event) => {
					setDraft(event.target.value);
					setError(null);
				}}
			/>
			{draft.trim() === "" && error === null ? null : (
				<div className={styles.replyBar}>
					<span className={styles.count} data-over={over || undefined}>
						{length}/{REPLY_MAX}
					</span>
					<Button size="sm" variant="primary" disabled={over || draft.trim() === ""} onClick={() => void submit()}>
						Reply
					</Button>
				</div>
			)}
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
