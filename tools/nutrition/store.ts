import type { Database } from "../../worker/db.ts";
import { addDays, today } from "./dates.ts";
import { type LoggedDay, type PhaseSummary, phaseSummary, type TrackerSettings, type WeightPoint } from "./phase.ts";
import type { DayUpdate, FoodChanges, FoodInput, TargetsInput } from "./schemas.ts";
import { parseSource } from "./sources.ts";
import { type DayView, type FoodEntry, type HistoryDay, macroProgress, type SourceKind, type Targets, type Totals, type WeightRow } from "./types.ts";

export class Rejected extends Error {}

type Actor = "ui" | "bot" | "import";

type Row = Record<string, unknown>;

const num = (value: unknown): number => Number(value);
const numOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

async function transaction<T>(client: Database, work: () => Promise<T>): Promise<T> {
	await client.query("begin");
	try {
		const result = await work();
		await client.query("commit");
		return result;
	} catch (error) {
		await client.query("rollback");
		throw error;
	}
}

function toEntry(row: Row): FoodEntry {
	return {
		id: num(row["id"]),
		food: String(row["food"]),
		qty: num(row["qty"]),
		unit: String(row["unit"]),
		kcal: num(row["kcal"]),
		protein_g: num(row["protein_g"]),
		carbs_g: num(row["carbs_g"]),
		fat_g: num(row["fat_g"]),
		fiber_g: numOrNull(row["fiber_g"]),
		sourceKind: row["source_kind"] as SourceKind,
		sourceRef: (row["source_ref"] as string | null) ?? null,
		sourceLabel: String(row["source_label"]),
	};
}

function toTargets(row: Row): Targets {
	return {
		effectiveFrom: String(row["effective_from"]),
		notes: String(row["notes"]),
		kcal: { min: num(row["kcal_min"]), max: num(row["kcal_max"]) },
		protein_g: { min: num(row["protein_min_g"]), max: num(row["protein_max_g"]) },
		fat_g: { min: num(row["fat_min_g"]), max: num(row["fat_max_g"]) },
		carbs_g: { min: num(row["carbs_min_g"]), max: num(row["carbs_max_g"]) },
	};
}

async function targetsOn(client: Database, date: string): Promise<Targets | null> {
	const { rows } = await client.query<Row>(
		"select effective_from::text, notes, kcal_min, kcal_max, protein_min_g, protein_max_g, fat_min_g, fat_max_g, carbs_min_g, carbs_max_g from nutrition.plan_versions where effective_from <= $1 order by effective_from desc limit 1",
		[date],
	);
	return rows[0] === undefined ? null : toTargets(rows[0]);
}

export async function getDay(client: Database, date: string): Promise<DayView> {
	const [day, entries, weight, phase, targets] = [
		(await client.query<Row>("select closed_at, steps, bloat_score, energy, sleep, stress, notes, totals_estimated from nutrition.days where day = $1", [date])).rows[0],
		(await client.query<Row>("select * from nutrition.food_entries where day = $1 order by id", [date])).rows.map(toEntry),
		(await client.query<Row>("select weight_lb from nutrition.daily_weights where measured_on = $1", [date])).rows[0],
		(await client.query<Row>("select kind from nutrition.phases where start_date <= $1 and (end_date is null or end_date >= $1) order by start_date desc limit 1", [date])).rows[0],
		await targetsOn(client, date),
	];
	const totals: Totals = { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 };
	for (const entry of entries) {
		totals.kcal += entry.kcal;
		totals.protein_g += entry.protein_g;
		totals.carbs_g += entry.carbs_g;
		totals.fat_g += entry.fat_g;
		totals.fiber_g += entry.fiber_g ?? 0;
	}
	for (const key of Object.keys(totals) as (keyof Totals)[]) totals[key] = Math.round(totals[key] * 10) / 10;
	return {
		date,
		closed: day?.["closed_at"] != null,
		estimated: day?.["totals_estimated"] === true,
		phase: (phase?.["kind"] as string | undefined) ?? null,
		entries,
		totals,
		targets,
		progress: targets === null ? null : macroProgress(totals, targets),
		checkIn: {
			bodyweightLb: numOrNull(weight?.["weight_lb"]),
			steps: numOrNull(day?.["steps"]),
			bloatScore: numOrNull(day?.["bloat_score"]),
			energy: numOrNull(day?.["energy"]),
			sleep: numOrNull(day?.["sleep"]),
			stress: numOrNull(day?.["stress"]),
			notes: (day?.["notes"] as string | undefined) ?? "",
		},
	};
}

async function ensureOpenDay(client: Database, date: string): Promise<void> {
	await client.query("insert into nutrition.days (day) values ($1) on conflict (day) do nothing", [date]);
	const { rows } = await client.query<Row>("select closed_at from nutrition.days where day = $1 for update", [date]);
	if (rows[0]?.["closed_at"] != null) throw new Rejected(`${date} is closed. Reopen it first.`);
}

function entryColumns(input: Partial<FoodInput>): Row {
	const columns: Row = {};
	for (const key of ["food", "qty", "unit", "kcal", "protein_g", "carbs_g", "fat_g", "fiber_g"] as const) if (input[key] !== undefined) columns[key] = input[key];
	if (input.source !== undefined) {
		const source = parseSource(input.source);
		columns["source_kind"] = source.kind;
		columns["source_ref"] = source.ref;
		columns["source_label"] = source.label;
	}
	return columns;
}

export async function changeFood(client: Database, date: string, changes: FoodChanges, actor: Actor): Promise<DayView> {
	return transaction(client, async () => {
		await ensureOpenDay(client, date);
		for (const id of changes.remove ?? []) {
			const { rowCount } = await client.query("delete from nutrition.food_entries where id = $1 and day = $2", [id, date]);
			if (rowCount === 0) throw new Rejected(`No entry ${id} on ${date}.`);
		}
		for (const edit of changes.edit ?? []) {
			const columns = Object.entries(entryColumns(edit));
			if (columns.length === 0) continue;
			const sets = columns.map(([column], index) => `${column} = $${index + 3}`).join(", ");
			const { rowCount } = await client.query(`update nutrition.food_entries set ${sets} where id = $1 and day = $2`, [edit.id, date, ...columns.map(([, value]) => value)]);
			if (rowCount === 0) throw new Rejected(`No entry ${edit.id} on ${date}.`);
		}
		for (const add of changes.add ?? []) {
			const columns = { source_kind: "estimate", source_ref: null, source_label: "", ...entryColumns(add), day: date, client_key: add.client_key ?? crypto.randomUUID(), created_by: actor };
			const names = Object.keys(columns);
			await client.query(
				`insert into nutrition.food_entries (${names.join(", ")}) values (${names.map((_, index) => `$${index + 1}`).join(", ")}) on conflict (client_key) do nothing`,
				Object.values(columns),
			);
		}
		return getDay(client, date);
	});
}

export async function updateDay(client: Database, date: string, update: DayUpdate): Promise<DayView> {
	if (Object.values(update).every((value) => value === undefined)) return getDay(client, date);
	return transaction(client, async () => {
		await client.query("insert into nutrition.days (day) values ($1) on conflict (day) do nothing", [date]);
		const fields: [string, unknown][] = [
			["steps", update.steps],
			["bloat_score", update.bloat_score],
			["energy", update.energy],
			["sleep", update.sleep],
			["stress", update.stress],
			["notes", update.notes],
			["totals_estimated", update.estimated],
		];
		const set = fields.filter(([, value]) => value !== undefined);
		if (update.closed !== undefined) set.push(["closed_at", update.closed ? new Date() : null]);
		if (set.length > 0) {
			await client.query(
				`update nutrition.days set ${set.map(([column], index) => `${column} = $${index + 2}`).join(", ")} where day = $1`,
				[date, ...set.map(([, value]) => value)],
			);
		}
		if (update.bodyweight_lb === null) await client.query("delete from nutrition.weigh_ins where measured_on = $1 and source = 'bot'", [date]);
		if (typeof update.bodyweight_lb === "number") {
			await client.query(
				"insert into nutrition.weigh_ins (measured_on, source, weight_lb) values ($1, 'bot', $2) on conflict (measured_on, source) do update set weight_lb = excluded.weight_lb",
				[date, update.bodyweight_lb],
			);
		}
		return getDay(client, date);
	});
}

type DayClosed = { day: DayView; deliveryId: string | null };

export async function closeDayFromUi(client: Database, date: string): Promise<DayClosed> {
	return transaction(client, async () => {
		await client.query("insert into nutrition.days (day) values ($1) on conflict (day) do nothing", [date]);
		const { rows } = await client.query<Row>("update nutrition.days set closed_at = now() where day = $1 and closed_at is null returning closed_at", [date]);
		const day = await getDay(client, date);
		const closedAt = rows[0]?.["closed_at"];
		if (closedAt === undefined) return { day, deliveryId: null };
		const deliveryId = crypto.randomUUID();
		const payload = {
			event: "day.closed",
			deliveryId,
			date,
			closedAt: new Date(closedAt as string | Date).toISOString(),
			estimated: day.estimated,
			entries: day.entries.length,
			totals: day.totals,
			targets: day.targets === null ? null : { kcal: day.targets.kcal, protein_g: day.targets.protein_g, carbs_g: day.targets.carbs_g, fat_g: day.targets.fat_g },
			progress: day.progress,
		};
		await client.query("insert into nutrition.deliveries (delivery_id, day, payload) values ($1, $2, $3)", [deliveryId, date, payload]);
		return { day, deliveryId };
	});
}

export async function addTargets(client: Database, input: TargetsInput, actor: Actor): Promise<Targets> {
	return transaction(client, async () => {
		const previous = await targetsOn(client, input.effective_from);
		const { rowCount } = await client.query(
			`insert into nutrition.plan_versions (effective_from, kcal_min, kcal_max, protein_min_g, protein_max_g, fat_min_g, fat_max_g, carbs_min_g, carbs_max_g, notes, change, created_by)
			values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) on conflict (effective_from) do nothing`,
			[
				input.effective_from,
				input.kcal.min,
				input.kcal.max,
				input.protein_g.min,
				input.protein_g.max,
				input.fat_g.min,
				input.fat_g.max,
				input.carbs_g.min,
				input.carbs_g.max,
				input.notes ?? previous?.notes ?? "",
				input.change,
				actor,
			],
		);
		if (rowCount === 0) throw new Rejected(`Targets already start on ${input.effective_from}. Versions are never edited, so pick another date.`);
		if (input.current_kcal_target !== undefined) {
			const { rowCount: trackers } = await client.query(
				"update nutrition.phase_trackers set current_kcal_target = $1 where phase_id = (select id from nutrition.phases where end_date is null)",
				[input.current_kcal_target],
			);
			if (trackers === 0) throw new Rejected("No open phase has a tracker.");
		}
		const targets = await targetsOn(client, input.effective_from);
		if (targets === null) throw new Error("The new plan version did not read back");
		return targets;
	});
}

export type PhaseView = { kind: string; startDate: string; settings: TrackerSettings; summary: PhaseSummary } | null;

export async function getPhase(client: Database, date = today()): Promise<PhaseView> {
	const { rows } = await client.query<Row>(
		`select p.kind, p.start_date::text as start_date, t.*
		from nutrition.phases p join nutrition.phase_trackers t on t.phase_id = p.id
		where p.end_date is null`,
	);
	const row = rows[0];
	if (row === undefined) return null;
	const settings: TrackerSettings = {
		kind: String(row["kind"]),
		startDate: String(row["start_date"]),
		startWeightOverrideLb: numOrNull(row["start_weight_override_lb"]),
		targetRatePerWeek: num(row["target_rate_per_week"]),
		weeks: num(row["weeks"]),
		toleranceLb: num(row["tolerance_lb"]),
		maxWeeklyKcalChange: num(row["max_weekly_kcal_change"]),
		minLoggedDays: num(row["min_logged_days"]),
		currentKcalTarget: num(row["current_kcal_target"]),
	};
	const since = addDays(settings.startDate, -35);
	const weights: WeightPoint[] = (
		await client.query<Row>("select measured_on::text as date, rolling_7d, rolling_14d from nutrition.weight_trend where measured_on >= $1 order by measured_on", [addDays(since, -28)])
	).rows.map((weight) => ({ date: String(weight["date"]), rolling7d: num(weight["rolling_7d"]), rolling14d: num(weight["rolling_14d"]) }));
	const days: LoggedDay[] = (await client.query<Row>("select day::text as date, kcal from nutrition.day_totals where closed and kcal > 0 and day >= $1", [since])).rows.map((day) => ({
		date: String(day["date"]),
		kcal: num(day["kcal"]),
	}));
	return { kind: settings.kind, startDate: settings.startDate, settings, summary: phaseSummary(settings, weights, days, date) };
}

export async function getHistory(client: Database): Promise<HistoryDay[]> {
	const { rows } = await client.query<Row>("select day::text as date, closed, entries, kcal, protein_g, carbs_g, fat_g from nutrition.day_totals order by day desc limit 400");
	return rows.map((row) => ({
		date: String(row["date"]),
		closed: row["closed"] === true,
		entries: num(row["entries"]),
		kcal: num(row["kcal"]),
		protein_g: num(row["protein_g"]),
		carbs_g: num(row["carbs_g"]),
		fat_g: num(row["fat_g"]),
	}));
}

export async function getWeights(client: Database): Promise<WeightRow[]> {
	const { rows } = await client.query<Row>(
		"select t.measured_on::text as date, t.weight_lb, t.rolling_7d, t.rolling_14d, d.source from nutrition.weight_trend t join nutrition.daily_weights d using (measured_on) order by t.measured_on",
	);
	return rows.map((row) => ({
		date: String(row["date"]),
		weight: num(row["weight_lb"]),
		rolling7d: num(row["rolling_7d"]),
		rolling14d: num(row["rolling_14d"]),
		source: String(row["source"]),
	}));
}
