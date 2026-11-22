import type { Database } from "../../worker/db.ts";

declare global {
	interface Env {
		TRAINING_LOG_TOKEN?: string;
	}
}

const API = "https://api.github.com/repos/mattppal/training-log";
const BRANCH = "main";
const MIRRORED = /^(program|sessions)\/[^/]+\.json$/;
export const BLOB_BATCH = 40;
const BLOB_CONCURRENCY = 6;

export type SyncResult =
	| { status: "unchanged"; headSha: string | null }
	| { status: "synced"; headSha: string; changed: number; removed: number }
	| { status: "partial"; headSha: string; changed: number; remaining: number }
	| { status: "failed"; error: string };

export type SyncState = { headSha: string | null; syncedAt: string | null; checkedAt: string | null; lastError: string | null };

type TreeEntry = { path: string; type: string; sha: string };

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

class SyncError extends Error {}

function headers(env: Env, extra: Record<string, string> = {}): Record<string, string> {
	const token = env.TRAINING_LOG_TOKEN;
	if (!token) throw new SyncError("TRAINING_LOG_TOKEN is not set");
	return { authorization: `Bearer ${token}`, "user-agent": "tools-workouts", "x-github-api-version": "2022-11-28", ...extra };
}

async function github<T>(fetcher: Fetcher, env: Env, path: string, accept = "application/vnd.github+json"): Promise<T> {
	const response = await fetcher(`${API}${path}`, { headers: headers(env, { accept }) });
	if (!response.ok) throw new SyncError(`GitHub returned ${response.status} for ${path}`);
	return (await response.json()) as T;
}

export function mirroredEntries(tree: TreeEntry[]): TreeEntry[] {
	return tree.filter((entry) => entry.type === "blob" && MIRRORED.test(entry.path));
}

function kindOf(path: string): "program" | "session" {
	return path.startsWith("program/") ? "program" : "session";
}

async function pool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) {
				const index = next++;
				results[index] = await work(items[index] as T);
			}
		}),
	);
	return results;
}

function decode(base64: string): string {
	const bytes = Uint8Array.from(atob(base64.replace(/\n/g, "")), (char) => char.charCodeAt(0));
	return new TextDecoder().decode(bytes);
}

type Blob = { path: string; sha: string; content: unknown; parseError: string | null };

async function fetchBlob(fetcher: Fetcher, env: Env, entry: TreeEntry): Promise<Blob> {
	const blob = await github<{ content: string; encoding: string }>(fetcher, env, `/git/blobs/${entry.sha}`);
	const text = blob.encoding === "base64" ? decode(blob.content) : blob.content;
	try {
		return { path: entry.path, sha: entry.sha, content: JSON.parse(text), parseError: null };
	} catch (error) {
		return { path: entry.path, sha: entry.sha, content: null, parseError: error instanceof Error ? error.message : String(error) };
	}
}

export async function readSyncState(db: Database): Promise<SyncState> {
	const { rows } = await db.query<{ head_sha: string | null; synced_at: Date | null; checked_at: Date | null; last_error: string | null }>("select head_sha, synced_at, checked_at, last_error from workouts.repo_sync");
	const row = rows[0];
	return { headSha: row?.head_sha ?? null, syncedAt: row?.synced_at?.toISOString() ?? null, checkedAt: row?.checked_at?.toISOString() ?? null, lastError: row?.last_error ?? null };
}

export async function syncTrainingLog(db: Database, env: Env, { force = false, fetcher = fetch }: { force?: boolean; fetcher?: Fetcher } = {}): Promise<SyncResult> {
	try {
		const { rows } = await db.query<{ head_sha: string | null; head_etag: string | null }>("select head_sha, head_etag from workouts.repo_sync");
		const stored = rows[0] ?? { head_sha: null, head_etag: null };
		const extra: Record<string, string> = { accept: "application/vnd.github.sha" };
		if (!force && stored.head_etag !== null) extra["if-none-match"] = stored.head_etag;
		const head = await fetcher(`${API}/commits/${BRANCH}`, { headers: headers(env, extra) });
		if (head.status === 304) {
			await db.query("update workouts.repo_sync set checked_at = now(), last_error = null");
			return { status: "unchanged", headSha: stored.head_sha };
		}
		if (!head.ok) throw new SyncError(`GitHub returned ${head.status} for the ${BRANCH} head`);
		const headSha = (await head.text()).trim();
		const etag = head.headers.get("etag");
		if (!force && headSha === stored.head_sha) {
			await db.query("update workouts.repo_sync set head_etag = $1, checked_at = now(), last_error = null", [etag]);
			return { status: "unchanged", headSha };
		}

		const tree = await github<{ tree: TreeEntry[]; truncated: boolean }>(fetcher, env, `/git/trees/${headSha}?recursive=1`);
		if (tree.truncated) throw new SyncError("GitHub truncated the training-log tree");
		const wanted = mirroredEntries(tree.tree);
		const existing = new Map((await db.query<{ path: string; sha: string }>("select path, sha from workouts.repo_files")).rows.map((row) => [row.path, row.sha]));
		const changed = wanted.filter((entry) => existing.get(entry.path) !== entry.sha);
		const keep = new Set(wanted.map((entry) => entry.path));
		const removed = [...existing.keys()].filter((path) => !keep.has(path));
		const batch = changed.slice(0, BLOB_BATCH);
		const blobs = await pool(batch, BLOB_CONCURRENCY, (entry) => fetchBlob(fetcher, env, entry));
		const complete = batch.length === changed.length;

		await db.query("begin");
		try {
			await db.query("select pg_advisory_xact_lock(hashtext('workouts.repo_sync'))");
			for (const blob of blobs) {
				await db.query(
					`insert into workouts.repo_files (path, sha, kind, content, parse_error, synced_at) values ($1, $2, $3, $4, $5, now())
					on conflict (path) do update set sha = excluded.sha, kind = excluded.kind, content = excluded.content, parse_error = excluded.parse_error, synced_at = now()`,
					[blob.path, blob.sha, kindOf(blob.path), blob.content === null ? null : JSON.stringify(blob.content), blob.parseError],
				);
			}
			if (complete) {
				if (removed.length > 0) await db.query("delete from workouts.repo_files where path = any($1::text[])", [removed]);
				await db.query("update workouts.repo_sync set head_sha = $1, head_etag = $2, synced_at = now(), checked_at = now(), last_error = null", [headSha, etag]);
			} else {
				await db.query("update workouts.repo_sync set head_etag = null, checked_at = now(), last_error = null");
			}
			await db.query("commit");
		} catch (error) {
			await db.query("rollback");
			throw error;
		}
		return complete ? { status: "synced", headSha, changed: blobs.length, removed: removed.length } : { status: "partial", headSha, changed: blobs.length, remaining: changed.length - blobs.length };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await db.query("update workouts.repo_sync set checked_at = now(), last_error = $1", [message]).catch(() => undefined);
		return { status: "failed", error: message };
	}
}

export type MirroredFile = { path: string; content: unknown };

export async function readMirror(db: Database): Promise<{ programs: MirroredFile[]; sessions: MirroredFile[] }> {
	const { rows } = await db.query<{ path: string; kind: "program" | "session"; content: unknown }>("select path, kind, content from workouts.repo_files where content is not null order by path");
	return {
		programs: rows.filter((row) => row.kind === "program").map(({ path, content }) => ({ path, content })),
		sessions: rows.filter((row) => row.kind === "session").map(({ path, content }) => ({ path, content })),
	};
}
