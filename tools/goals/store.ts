import type { Database } from "../../worker/db.ts";
import type { AddCheckin, BulkImport, ImportGoal, LinkTodoist, ListGoals, UpsertGoal } from "./schemas.ts";
import { type Checkin, compareGoals, type Goal, type GoalYear, type Overview, type Source, type Status, type YearView } from "./types.ts";

export class Rejected extends Error {}

type Row = Record<string, unknown>;

type Fields = {
	year: number;
	horizon: Goal["horizon"];
	quarter: Goal["quarter"];
	area: Goal["area"];
	title: string;
	description: string;
	metric: string | null;
	target: string | null;
	status: Status;
	parent_id: string | null;
	source_url: string | null;
};

const FIELDS = ["year", "horizon", "quarter", "area", "title", "description", "metric", "target", "status", "parent_id", "source_url"] as const satisfies readonly (keyof Fields)[];

const NEW_GOAL = { description: "", metric: null, target: null, status: "unknown", parent_id: null, source_url: null } as const satisfies Partial<Fields>;

const TIME_ZONE = "America/Los_Angeles";

export function today(now = new Date()): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

const iso = (value: unknown): string => new Date(value as string | Date).toISOString();

const GOAL_SELECT = `select g.*, (
	select to_jsonb(c) from (
		select id, goal_id, date::text as date, note, progress, status_at_checkin, source, created_at
		from goals.goal_checkins where goal_id = g.id order by date desc, created_at desc limit 1
	) c
) as latest
from goals.goals g`;

function toCheckin(row: Row): Checkin {
	return {
		id: String(row["id"]),
		goalId: String(row["goal_id"]),
		date: String(row["date"]),
		note: String(row["note"]),
		progress: row["progress"] === null ? null : Number(row["progress"]),
		statusAtCheckin: row["status_at_checkin"] as Status,
		source: row["source"] as Source,
		createdAt: iso(row["created_at"]),
	};
}

function toGoal(row: Row): Goal {
	const latest = row["latest"] as Row | null;
	return {
		id: String(row["id"]),
		year: Number(row["year"]),
		horizon: row["horizon"] as Goal["horizon"],
		quarter: row["quarter"] === null ? null : (Number(row["quarter"]) as Goal["quarter"]),
		area: row["area"] as Goal["area"],
		title: String(row["title"]),
		description: String(row["description"]),
		metric: (row["metric"] as string | null) ?? null,
		target: (row["target"] as string | null) ?? null,
		status: row["status"] as Status,
		parentId: (row["parent_id"] as string | null) ?? null,
		sourceUrl: (row["source_url"] as string | null) ?? null,
		todoistProjectId: (row["todoist_project_id"] as string | null) ?? null,
		todoistTaskIds: (row["todoist_task_ids"] as string[] | null) ?? [],
		createdAt: iso(row["created_at"]),
		updatedAt: iso(row["updated_at"]),
		latestCheckin: latest === null ? null : toCheckin(latest),
	};
}

function fieldsOf(goal: Goal): Fields {
	return {
		year: goal.year,
		horizon: goal.horizon,
		quarter: goal.quarter,
		area: goal.area,
		title: goal.title,
		description: goal.description,
		metric: goal.metric,
		target: goal.target,
		status: goal.status,
		parent_id: goal.parentId,
		source_url: goal.sourceUrl,
	};
}

async function transaction<T>(client: Database, work: () => Promise<T>): Promise<T> {
	await client.query("begin");
	try {
		const result = await work();
		await client.query("commit");
		return result;
	} catch (error) {
		await client.query("rollback");
		if ((error as { code?: unknown }).code === "23505") throw new Rejected("Another goal already has that year, horizon, quarter and title");
		throw error;
	}
}

async function goalWhere(client: Database, where: string, values: unknown[], lock = false): Promise<Goal[]> {
	const { rows } = await client.query<Row>(`${GOAL_SELECT} where ${where}${lock ? " for update of g" : ""}`, values);
	return rows.map(toGoal).toSorted(compareGoals);
}

async function goalById(client: Database, id: string, lock = false): Promise<Goal> {
	const [goal] = await goalWhere(client, "g.id = $1", [id], lock);
	if (goal === undefined) throw new Rejected(`No goal ${id}`);
	return goal;
}

async function ensureYear(client: Database, year: number): Promise<void> {
	await client.query("insert into goals.goal_years (year) values ($1) on conflict (year) do nothing", [year]);
}

type Written = { goal: Goal; result: "created" | "updated" | "unchanged" };

async function writeGoal(client: Database, existing: Goal | null, changes: Partial<Fields>): Promise<Written> {
	const base = existing === null ? null : fieldsOf(existing);
	const horizon = changes.horizon ?? base?.horizon;
	const quarter = changes.quarter !== undefined ? changes.quarter : horizon === "year" ? null : (base?.quarter ?? null);
	const next = { ...NEW_GOAL, ...base, ...stripUndefined(changes), quarter } as Fields;
	if ((next.horizon === "quarter") !== (next.quarter !== null)) throw new Rejected("A quarter goal needs quarter 1-4, and a year goal has no quarter");
	if (next.parent_id !== null) {
		if (existing !== null && next.parent_id === existing.id) throw new Rejected("A goal can't be its own parent");
		const { rows } = await client.query<Row>("select year from goals.goals where id = $1", [next.parent_id]);
		if (rows[0] === undefined || Number(rows[0]["year"]) !== next.year) throw new Rejected(`Parent ${next.parent_id} is not a goal in ${next.year}`);
	}
	if (existing !== null && base !== null && FIELDS.every((field) => next[field] === base[field])) return { goal: existing, result: "unchanged" };
	await ensureYear(client, next.year);
	const values = FIELDS.map((field) => next[field]);
	if (existing === null) {
		const { rows } = await client.query<Row>(`insert into goals.goals (${FIELDS.join(", ")}) values (${FIELDS.map((_, index) => `$${index + 1}`).join(", ")}) returning id`, values);
		return { goal: await goalById(client, String(rows[0]?.["id"])), result: "created" };
	}
	await client.query(`update goals.goals set ${FIELDS.map((field, index) => `${field} = $${index + 1}`).join(", ")}, updated_at = now() where id = $${FIELDS.length + 1}`, [...values, existing.id]);
	return { goal: await goalById(client, existing.id), result: "updated" };
}

function stripUndefined<T extends object>(value: T): Partial<T> {
	return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as Partial<T>;
}

async function byNaturalKey(client: Database, goal: { year: number; horizon: string; quarter?: number | null | undefined; title: string }): Promise<Goal | null> {
	const [found] = await goalWhere(client, "g.year = $1 and g.horizon = $2 and coalesce(g.quarter, 0) = $3 and lower(g.title) = lower($4)", [goal.year, goal.horizon, goal.quarter ?? 0, goal.title], true);
	return found ?? null;
}

export async function upsertGoal(client: Database, input: UpsertGoal): Promise<{ goal: Goal; created: boolean }> {
	const { id, ...changes } = input;
	return transaction(client, async () => {
		const existing = id !== undefined ? await goalById(client, id, true) : await byNaturalKey(client, changes as Required<Pick<UpsertGoal, "year" | "horizon" | "title">>);
		const { goal, result } = await writeGoal(client, existing, changes);
		return { goal, created: result === "created" };
	});
}

type ImportResult = { id: string; year: number; horizon: Goal["horizon"]; quarter: Goal["quarter"]; title: string; result: Written["result"] };

export async function bulkImport(client: Database, input: BulkImport): Promise<{ created: number; updated: number; unchanged: number; goals: ImportResult[] }> {
	return transaction(client, async () => {
		for (const { year, north_star } of input.years ?? []) await writeNorthStar(client, year, north_star);
		const ordered = input.goals.map((goal, index) => ({ goal, index })).toSorted((a, b) => Number(a.goal.horizon === "quarter") - Number(b.goal.horizon === "quarter"));
		const results: ImportResult[] = [];
		for (const { goal, index } of ordered) {
			try {
				results[index] = await importOne(client, goal);
			} catch (error) {
				if (error instanceof Rejected) throw new Rejected(`goals[${index}]: ${error.message}`);
				throw error;
			}
		}
		const count = (result: Written["result"]) => results.filter((item) => item.result === result).length;
		return { created: count("created"), updated: count("updated"), unchanged: count("unchanged"), goals: results };
	});
}

async function importOne(client: Database, input: ImportGoal): Promise<ImportResult> {
	const { parent_title, ...changes } = input;
	let parentId = changes.parent_id;
	if (parent_title !== undefined) {
		const parent = await byNaturalKey(client, { year: input.year, horizon: "year", title: parent_title });
		if (parent === null) throw new Rejected(`no year goal titled "${parent_title}" in ${input.year}`);
		parentId = parent.id;
	}
	const { goal, result } = await writeGoal(client, await byNaturalKey(client, input), { ...changes, parent_id: parentId });
	return { id: goal.id, year: goal.year, horizon: goal.horizon, quarter: goal.quarter, title: goal.title, result };
}

export async function listGoals(client: Database, filter: ListGoals = {}): Promise<{ goals: Goal[] }> {
	const clauses: string[] = ["true"];
	const values: unknown[] = [];
	for (const [column, value] of [
		["year", filter.year],
		["area", filter.area],
		["status", filter.status],
	] as const) {
		if (value === undefined) continue;
		values.push(value);
		clauses.push(`g.${column} = $${values.length}`);
	}
	return { goals: await goalWhere(client, clauses.join(" and "), values) };
}

async function insertCheckin(client: Database, goal: Goal, input: { note: string; progress?: number | null | undefined; date?: string | undefined }, source: Source): Promise<Checkin> {
	const { rows } = await client.query<Row>(
		`insert into goals.goal_checkins (goal_id, date, note, progress, status_at_checkin, source) values ($1, $2, $3, $4, $5, $6)
		returning id, goal_id, date::text as date, note, progress, status_at_checkin, source, created_at`,
		[goal.id, input.date ?? today(), input.note, input.progress ?? null, goal.status, source],
	);
	return toCheckin(rows[0] as Row);
}

async function changeStatus(client: Database, goal: Goal, status: Status): Promise<Goal> {
	if (goal.status === status) return goal;
	await client.query("update goals.goals set status = $1, updated_at = now() where id = $2", [status, goal.id]);
	return { ...goal, status };
}

export async function setStatus(client: Database, id: string, status: Status, note: string, source: Source): Promise<{ goal: Goal; checkin: Checkin }> {
	return transaction(client, async () => {
		const goal = await changeStatus(client, await goalById(client, id, true), status);
		const checkin = await insertCheckin(client, goal, { note }, source);
		return { goal: await goalById(client, id), checkin };
	});
}

export async function addCheckin(client: Database, input: AddCheckin, source: Source): Promise<{ goal: Goal; checkin: Checkin }> {
	return transaction(client, async () => {
		const found = await goalById(client, input.goal_id, true);
		const goal = input.status === undefined ? found : await changeStatus(client, found, input.status);
		const checkin = await insertCheckin(client, goal, input, source);
		return { goal: await goalById(client, goal.id), checkin };
	});
}

export async function linkTodoist(client: Database, input: LinkTodoist): Promise<{ goal: Goal }> {
	return transaction(client, async () => {
		const goal = await goalById(client, input.goal_id, true);
		const project = input.project_id === undefined ? goal.todoistProjectId : input.project_id;
		await client.query("update goals.goals set todoist_project_id = $1, todoist_task_ids = $2, updated_at = now() where id = $3", [project, [...new Set(input.task_ids)], goal.id]);
		return { goal: await goalById(client, goal.id) };
	});
}

async function writeNorthStar(client: Database, year: number, northStar: string): Promise<GoalYear> {
	await client.query(
		`insert into goals.goal_years (year, north_star) values ($1, $2)
		on conflict (year) do update set north_star = excluded.north_star, updated_at = now() where goal_years.north_star is distinct from excluded.north_star`,
		[year, northStar.trim()],
	);
	return { year, northStar: northStar.trim() };
}

export async function setNorthStar(client: Database, year: number, northStar: string): Promise<GoalYear> {
	return writeNorthStar(client, year, northStar);
}

export async function getYear(client: Database, year: number): Promise<YearView> {
	const { rows } = await client.query<Row>("select north_star from goals.goal_years where year = $1", [year]);
	return { year, northStar: String(rows[0]?.["north_star"] ?? ""), goals: await goalWhere(client, "g.year = $1", [year]) };
}

export async function getOverview(client: Database): Promise<Overview> {
	const { rows } = await client.query<Row>("select year, north_star from goals.goal_years order by year desc");
	return { years: rows.map((row) => ({ year: Number(row["year"]), northStar: String(row["north_star"]) })), goals: (await listGoals(client)).goals };
}
