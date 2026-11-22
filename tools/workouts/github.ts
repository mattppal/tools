import { parseProgram, type Program } from "./program.ts";

declare global {
	interface Env {
		TRAINING_LOG_TOKEN?: string;
	}
}

const REPO = "https://api.github.com/repos/mattppal/training-log/contents";

export class TrainingLogError extends Error {
	constructor(
		message: string,
		readonly status: number | null,
	) {
		super(message);
	}
}

type Entry = { name: string; type: string };

export type RepoSession = { file: string; date: string; weekId: string; dayId: string };

export type TrainingLog = { program: Program; repoSessions: RepoSession[] };

async function get(env: Env, path: string, raw: boolean): Promise<unknown> {
	const token = env.TRAINING_LOG_TOKEN;
	if (!token) throw new TrainingLogError("TRAINING_LOG_TOKEN is not set", null);
	const response = await fetch(`${REPO}/${path}`, {
		headers: {
			accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
			authorization: `Bearer ${token}`,
			"user-agent": "tools-workouts",
			"x-github-api-version": "2022-11-28",
		},
	});
	if (!response.ok) throw new TrainingLogError(`GitHub returned ${response.status} for ${path}`, response.status);
	return response.json();
}

function entries(value: unknown): Entry[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is Entry => typeof entry === "object" && entry !== null && typeof entry.name === "string" && typeof entry.type === "string");
}

const SESSION_FILE = /^(\d{4}-\d{2}-\d{2})-.*-w(\d+)-d(\d+)\.json$/;

export function repoSessions(names: string[], program: Program): RepoSession[] {
	return names.flatMap((file) => {
		const match = SESSION_FILE.exec(file);
		if (match === null) return [];
		const [, date = "", week = "", day = ""] = match;
		if (date < program.starts || date > program.ends) return [];
		return [{ file, date, weekId: `w${week}`, dayId: `day-${day}` }];
	});
}

export function pickBlock(files: string[], today: string, blocks: Map<string, Program>): Program | null {
	const candidates = files.map((file) => blocks.get(file)).filter((program) => program !== undefined);
	return (
		candidates.find((program) => program.starts <= today && today <= program.ends) ??
		candidates.filter((program) => program.starts <= today).toSorted((a, b) => b.starts.localeCompare(a.starts))[0] ??
		candidates.toSorted((a, b) => a.starts.localeCompare(b.starts))[0] ??
		null
	);
}

const BLOCK_FILE = /^block-[a-z0-9-]+\.json$/;

export async function readTrainingLog(env: Env, today: string): Promise<TrainingLog> {
	const [programDir, sessionsDir] = await Promise.all([get(env, "program", false), get(env, "sessions", false)]);
	const files = entries(programDir)
		.filter((entry) => entry.type === "file" && BLOCK_FILE.test(entry.name))
		.map((entry) => entry.name)
		.toSorted()
		.toReversed();
	const blocks = new Map<string, Program>();
	for (const file of files) {
		const program = parseProgram(await get(env, `program/${file}`, true));
		if (program === null) continue;
		blocks.set(file, program);
		if (program.starts <= today && today <= program.ends) break;
	}
	const program = pickBlock(files, today, blocks);
	if (program === null) throw new TrainingLogError("No block file in program/ could be read", null);
	const names = entries(sessionsDir)
		.filter((entry) => entry.type === "file")
		.map((entry) => entry.name);
	return { program, repoSessions: repoSessions(names, program) };
}
