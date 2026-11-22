import { useEffect, useState } from "react";

export type Health =
	| { state: "checking" }
	| { state: "ok"; latencyMs: number; version: string | undefined }
	| { state: "down"; error: string };

type HealthBody = { ok: boolean; db?: { latencyMs?: number; version?: string; error?: string } };

export async function checkHealth(): Promise<Health> {
	try {
		const response = await fetch("/api/health", { cache: "no-store" });
		const body: HealthBody = await response.json();
		if (body.ok) return { state: "ok", latencyMs: body.db?.latencyMs ?? 0, version: body.db?.version };
		return { state: "down", error: body.db?.error ?? `HTTP ${response.status}` };
	} catch (error) {
		return { state: "down", error: error instanceof Error ? error.message : "Network error" };
	}
}

let shared: Promise<Health> | null = null;

export function useHealth(): Health {
	const [health, setHealth] = useState<Health>({ state: "checking" });
	useEffect(() => {
		let live = true;
		shared ??= checkHealth();
		void shared.then((next) => live && setHealth(next));
		return () => {
			live = false;
		};
	}, []);
	return health;
}
