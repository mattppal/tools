import { bind, type Post, type RenderOptions, type Theme, type Xeet } from "@xeet/core";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { call, instantiate, missing_packs, packs, register_font, upstream_version } from "virtual:xeet";
import type { OwnerPost } from "./owner.ts";
import { decodeEntities } from "./screen.ts";
import styles from "./x-posts.module.css";

const DARK = "(prefers-color-scheme: dark)";
const MIN_WIDTH = 100;
const MAX_DPR = 3;
const MINUTE_MS = 60_000;

type Card = { url: string; width: number; height: number };
type Pack = (typeof packs)[string];

let renderer: Promise<Xeet> | null = null;
const fonts = new Map<Pack, Promise<void>>();

async function fetchPack(pack: Pack): Promise<void> {
	const response = await fetch(pack.url);
	if (!response.ok) throw new Error(`xeet font pack answered ${response.status}`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	for (const { file, offset, length } of pack.files) register_font(file, bytes.subarray(offset, offset + length));
}

function loadPack(pack: Pack): Promise<void> {
	let pending = fonts.get(pack);
	if (pending === undefined) {
		pending = fetchPack(pack);
		fonts.set(pack, pending);
		pending.catch(() => fonts.delete(pack));
	}
	return pending;
}

async function renderCard(post: Post, options: RenderOptions): Promise<Card | null> {
	renderer ??= instantiate().then(
		() => bind({ call, upstream_version }),
		(error: unknown) => {
			renderer = null;
			throw error;
		},
	);
	const xeet = await renderer;
	const needed = (JSON.parse(missing_packs(JSON.stringify({ post }))) as string[]).map((name) => packs[name]);
	if (!needed.every((pack): pack is Pack => pack !== undefined)) return null;
	await Promise.all(needed.map(loadPack));
	const { png, report } = xeet.render(post, options);
	return { url: URL.createObjectURL(new Blob([png.slice()], { type: "image/png" })), ...report.size };
}

function xeetPost(post: OwnerPost, now: number): Post {
	return {
		text: decodeEntities(post.text),
		author: { name: decodeEntities(post.name || post.handle), handle: post.handle },
		counts: { replies: post.metrics.replies ?? undefined, reposts: post.metrics.reposts ?? undefined, likes: post.metrics.likes ?? undefined, views: post.metrics.impressions ?? undefined },
		createdAt: post.createdAt,
		now: new Date(Math.floor(now / MINUTE_MS) * MINUTE_MS).toISOString(),
	};
}

function subscribeTheme(onChange: () => void): () => void {
	const media = window.matchMedia(DARK);
	const observer = new MutationObserver(onChange);
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
	media.addEventListener("change", onChange);
	return () => {
		observer.disconnect();
		media.removeEventListener("change", onChange);
	};
}

function currentTheme(): Theme {
	const chosen = document.documentElement.dataset.theme;
	if (chosen === "light" || chosen === "dark") return chosen;
	return window.matchMedia(DARK).matches ? "dark" : "light";
}

function useWidth(ref: RefObject<HTMLElement | null>): number {
	const [width, setWidth] = useState(0);
	useEffect(() => {
		const element = ref.current;
		if (element === null) return;
		const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry?.contentRect.width ?? 0)));
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return width;
}

export function PostCard({ post, now, fallback }: { post: OwnerPost; now: number; fallback: ReactNode }) {
	const frame = useRef<HTMLDivElement>(null);
	const width = useWidth(frame);
	const theme = useSyncExternalStore(subscribeTheme, currentTheme);
	const [card, setCard] = useState<Card | null>(null);
	const input = xeetPost(post, now);
	const options: RenderOptions = { width, theme, dpr: Math.min(MAX_DPR, Math.max(1, window.devicePixelRatio)) };
	const key = JSON.stringify([input, options]);
	useEffect(() => {
		if (width < MIN_WIDTH) return;
		let live = true;
		renderCard(input, options).then(
			(next) => {
				if (live) setCard(next);
				else if (next !== null) URL.revokeObjectURL(next.url);
			},
			() => live && setCard(null),
		);
		return () => {
			live = false;
		};
	}, [key]);
	useEffect(() => (card === null ? undefined : () => URL.revokeObjectURL(card.url)), [card]);
	return (
		<div ref={frame} className={styles.card}>
			{card === null ? (
				fallback
			) : (
				<a href={post.url} target="_blank" rel="noreferrer" title="Open on X">
					<img src={card.url} width={card.width} height={card.height} alt={`${post.name || post.handle} @${post.handle}: ${post.text}`} />
				</a>
			)}
		</div>
	);
}
