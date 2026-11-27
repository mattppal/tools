import { useEffect, useState } from "react";
import type { Context, ContextPost } from "./context.ts";
import type { Mention } from "./mentions.ts";
import { ago, Avatar, describe, PostLink, request } from "./ui.tsx";
import styles from "./x-posts.module.css";

const SETTLE_MS = 400;

type State = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; context: Context };

const cache = new Map<string, Context>();

const NONE: Context = { kind: "none", post: null };

function known(mention: Mention): Context | undefined {
	return mention.context === "none" ? NONE : cache.get(mention.id);
}

function useReplyContext(mention: Mention): State {
	const [state, setState] = useState<State>(() => {
		const hit = known(mention);
		return hit === undefined ? { status: "loading" } : { status: "ready", context: hit };
	});
	useEffect(() => {
		const hit = known(mention);
		if (hit !== undefined) {
			setState({ status: "ready", context: hit });
			return;
		}
		setState({ status: "loading" });
		let live = true;
		const timer = setTimeout(() => {
			request<Context>(`/mentions/context?id=${mention.id}`).then(
				(context) => {
					if (context.kind !== "paused") cache.set(mention.id, context);
					if (live) setState({ status: "ready", context });
				},
				(error: unknown) => live && setState({ status: "error", message: describe(error) }),
			);
		}, SETTLE_MS);
		return () => {
			live = false;
			clearTimeout(timer);
		};
	}, [mention.id, mention.context]);
	return state;
}

function external(href: string) {
	return { href, target: "_blank", rel: "noopener noreferrer" } as const;
}

function PostCard({ post, now, quoted = false }: { post: ContextPost; now: number; quoted?: boolean }) {
	return (
		<article className={quoted ? styles.ctxQuote : styles.ctxPost}>
			<p className={styles.liveHead}>
				<Avatar url={post.avatarUrl} />
				<span className={styles.liveName}>{post.name || post.handle || "Unknown"}</span>
				{post.handle === "" ? null : <span>@{post.handle}</span>}
				{post.createdAt === null ? null : (
					<PostLink url={post.url} createdAt={post.createdAt}>
						{ago(post.createdAt, now)}
					</PostLink>
				)}
			</p>
			{post.segments.length === 0 ? null : (
				<p className={styles.text}>
					{post.segments.map((segment, index) =>
						segment.href === undefined ? (
							<span key={index}>{segment.text}</span>
						) : (
							<a key={index} className={styles.ctxLink} {...external(segment.href)}>
								{segment.text}
							</a>
						),
					)}
				</p>
			)}
			{post.media.length === 0 ? null : (
				<div className={styles.ctxMedia} data-count={Math.min(post.media.length, 4)}>
					{post.media.slice(0, 4).map((item) =>
						item.videoUrl === null ? (
							<a key={item.url} {...external(post.url)}>
								<img src={item.url} alt={item.alt ?? ""} loading="lazy" referrerPolicy="no-referrer" width={item.width ?? undefined} height={item.height ?? undefined} />
							</a>
						) : (
							<video key={item.url} src={item.videoUrl} poster={item.url} controls playsInline preload="none" loop={item.type === "animated_gif"} aria-label={item.alt ?? undefined} />
						),
					)}
				</div>
			)}
			{post.quoted === null ? null : <PostCard post={post.quoted} now={now} quoted />}
			{quoted ? null : (
				<p className={styles.rowFoot}>
					<a className={styles.openOnX} {...external(post.url)}>
						Open on X
					</a>
				</p>
			)}
		</article>
	);
}

export function ReplyContext({ mention, now }: { mention: Mention; now: number }) {
	const state = useReplyContext(mention);
	if (state.status === "loading") return <div className={styles.ctxLoading} aria-busy="true" aria-label="Loading the post it replies to" />;
	if (state.status === "error") return <p className={styles.muted}>{state.message}</p>;
	const { context } = state;
	if (context.kind === "paused") return <p className={styles.muted}>Paused: budget.</p>;
	if (context.kind === "none") return <p className={styles.muted}>Not a reply.</p>;
	return (
		<section className={styles.ctx} aria-label={context.kind === "reply" ? "Replying to" : "Quoting"}>
			<p className={styles.meta}>{context.kind === "reply" ? "Replying to" : "Quoting"}</p>
			{context.post === null ? <p className={styles.muted}>This post isn't available.</p> : <PostCard post={context.post} now={now} />}
		</section>
	);
}
