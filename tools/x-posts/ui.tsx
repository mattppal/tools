import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "../../src/kit/button.tsx";
import type { Reply } from "./reply.ts";
import { ReplyFailure } from "./reply-box.tsx";
import styles from "./x-posts.module.css";

export const API = "/api/tools/x-posts";

type Load<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: T };

export function describe(error: unknown): string {
	if (error instanceof TypeError) return "Couldn't reach the server. Reload the page to sign in again.";
	return error instanceof Error ? error.message : String(error);
}

export async function request<T>(path: string, init?: { method: string; body: unknown }): Promise<T> {
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

export function replySender(path: string): (body: { id: string; text: string }) => Promise<Reply> {
	return async (body) => {
		let response: Response;
		try {
			response = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		} catch (error) {
			throw new ReplyFailure(describe(error), false, false);
		}
		const json = (await response.json().catch(() => null)) as (Reply & { error?: string; connect?: boolean; onX?: boolean }) | null;
		if (!response.ok || json === null) throw new ReplyFailure(json?.error ?? `Request failed with ${response.status}`, json?.connect === true, json?.onX === true);
		return json;
	};
}

const NARROW = "(max-width: 900px)";

function subscribeNarrow(onChange: () => void): () => void {
	const media = window.matchMedia(NARROW);
	media.addEventListener("change", onChange);
	return () => media.removeEventListener("change", onChange);
}

export function useNarrow(): boolean {
	return useSyncExternalStore(subscribeNarrow, () => window.matchMedia(NARROW).matches);
}

export function useLoad<T>(path: string): [Load<T>, () => void] {
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

export function when(iso: string | null): string {
	if (iso === null) return "never";
	return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" });
}

export function ago(iso: string, now: number): string {
	const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
	if (seconds < 60) return "just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	return hours < 24 ? `${hours}h ago` : when(iso);
}

export function useVisibleInterval(callback: () => void, ms: number): void {
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

export function LoadState({ load, retry }: { load: Exclude<Load<unknown>, { status: "ready" }>; retry: () => void }) {
	if (load.status === "loading") return <div className={styles.loading} aria-busy="true" aria-label="Loading" />;
	return (
		<div className={styles.empty}>
			<p>{load.message}</p>
			<Button onClick={retry}>Try again</Button>
		</div>
	);
}

export function Avatar({ url }: { url: string | null }) {
	return url === null ? <span className={styles.avatar} aria-hidden="true" /> : <img className={styles.avatar} src={url} alt="" width={20} height={20} loading="lazy" referrerPolicy="no-referrer" />;
}

export function PostLink({ url, createdAt, children }: { url: string; createdAt: string; children: string }) {
	return (
		<a className={styles.postLink} href={url} target="_blank" rel="noopener noreferrer" title={`${when(createdAt)}, open on X`}>
			<time dateTime={createdAt}>{children}</time>
		</a>
	);
}
