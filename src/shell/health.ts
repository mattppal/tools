import { useSyncExternalStore } from "react";
import type { HealthReport } from "../../worker/index.ts";

export type Health = { state: "checking" } | { state: "ok"; latencyMs: number; connectMs: number; queryMs: number } | { state: "down"; error: string };

const RECHECK_AFTER_MS = 30_000;

function isHealthReport(body: unknown): body is HealthReport {
	if (typeof body !== "object" || body === null || !("ok" in body) || !("db" in body)) return false;
	const { ok, db } = body;
	if (typeof db !== "object" || db === null) return false;
	return ok === true
		? "latencyMs" in db && typeof db.latencyMs === "number" && "connectMs" in db && typeof db.connectMs === "number" && "queryMs" in db && typeof db.queryMs === "number"
		: ok === false && "error" in db && typeof db.error === "string";
}

export async function checkHealth(): Promise<Health> {
	try {
		const response = await fetch("/api/health", { cache: "no-store" });
		const body: unknown = response.headers.get("content-type")?.includes("application/json") ? await response.json() : null;
		if (!isHealthReport(body)) return { state: "down", error: `Unexpected response (HTTP ${response.status})` };
		return body.ok ? { state: "ok", ...body.db } : { state: "down", error: body.db.error };
	} catch (error) {
		return { state: "down", error: error instanceof Error ? error.message : "Network error" };
	}
}

let current: Health = { state: "checking" };
let checkedAt = 0;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function recheck(): void {
	inflight ??= checkHealth().then((next) => {
		current = next;
		checkedAt = Date.now();
		inflight = null;
		for (const listener of listeners) listener();
	});
}

function recheckIfStale(): void {
	if (document.visibilityState === "visible" && Date.now() - checkedAt >= RECHECK_AFTER_MS) recheck();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	if (listeners.size === 1) {
		window.addEventListener("online", recheck);
		document.addEventListener("visibilitychange", recheckIfStale);
	}
	recheckIfStale();
	return () => {
		listeners.delete(listener);
		if (listeners.size > 0) return;
		window.removeEventListener("online", recheck);
		document.removeEventListener("visibilitychange", recheckIfStale);
	};
}

export function useHealth(): Health {
	return useSyncExternalStore(subscribe, () => current);
}
