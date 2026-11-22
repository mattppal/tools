import type { Database } from "../../worker/db.ts";
import { queueForLiaison } from "../liaison/webhook.ts";
import { addDays, today } from "./dates.ts";
import { listAppleWorkouts } from "../activity/apple-health.ts";
import { listMeasures, listWorkouts } from "../activity/health.ts";
import { type BodyComp, estimateExpenditure, MEASURED_MIN_DAYS, type ExpenditureResult, type IntakeDay, type LoggedSession, type StepsDay, type TrackerDay, type WatchWorkout, type WeighIn } from "./expenditure.ts";
import { type LoggedDay, type PhaseSummary, phaseSummary, type TrackerSettings, type WeightPoint } from "./phase.ts";
import type { DayUpdate, FoodChanges, FoodInput, TargetsInput } from "./schemas.ts";
import { formatSource, parseSource } from "./sources.ts";
import { type DayView, type FoodEntry, type HistoryDay, isPartialDay, macroProgress, type SourceKind, type StepsRow, type Targets, type Totals, type WeightRow } from "./types.ts";

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
		source: formatSource(row["source_kind"] as SourceKind, (row["source_ref"] as string | null) ?? null, String(row["source_label"])),
		clientKey: String(row["client_key"]),
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
		stepsTarget: numOrNull(row["steps_target"]),
	};
}

async function targetsOn(client: Database, date: string): Promise<Targets | null> {
	const { rows } = await client.query<Row>(
		"select effective_from::text, notes, kcal_min, kcal_max, protein_min_g, protein_max_g, fat_min_g, fat_max_g, carbs_min_g, carbs_max_g, steps_target from nutrition.plan_versions where effective_from <= $1 order by effective_from desc limit 1",
		[date],
	);
	return rows[0] === undefined ? null : toTargets(rows[0]);
}

export async function getDay(client: Database, date: string): Promise<DayView> {
	const [day, entries, weight, phase, targets] = [
		(
			await client.query<Row>(
				`select d.closed_at, coalesce(a.steps, d.steps) as steps, d.bloat_score, d.energy, d.sleep, d.stress, d.notes, d.totals_estimated
				from (select $1::date as day) w
				left join nutrition.days d on d.day = w.day
				left join activity.daily_activity a on a.day = w.day`,
				[date],
			)
		).rows[0],
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

const keyColumn = (target: number | string): "id" | "client_key" => (typeof target === "number" ? "id" : "client_key");

const entryName = (target: number | string): string => (typeof target === "number" ? String(target) : `with client_key ${target}`);

export async function changeFood(client: Database, date: string, changes: FoodChanges, actor: Actor): Promise<DayView> {
	return transaction(client, async () => {
		await ensureOpenDay(client, date);
		for (const target of changes.remove ?? []) {
			const key = keyColumn(target);
			const { rowCount } = await client.query(`delete from nutrition.food_entries where ${key} = $1 and day = $2`, [target, date]);
			if (rowCount !== 0) continue;
			const { rows } = await client.query<Row>(`select day::text as day from nutrition.food_entries where ${key} = $1`, [target]);
			if (rows[0] !== undefined) throw new Rejected(`Entry ${entryName(target)} is on ${String(rows[0]["day"])}, not ${date}.`);
		}
		for (const edit of changes.edit ?? []) {
			const target = edit.id ?? edit.client_key ?? "";
			const columns = Object.entries(entryColumns(edit));
			if (columns.length === 0) continue;
			const sets = columns.map(([column], index) => `${column} = $${index + 3}`).join(", ");
			const { rowCount } = await client.query(`update nutrition.food_entries set ${sets} where ${keyColumn(target)} = $1 and day = $2`, [target, date, ...columns.map(([, value]) => value)]);
			if (rowCount === 0) throw new Rejected(`No entry ${entryName(target)} on ${date}.`);
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

export async function closeDayFromUi(client: Database, date: string, test = false): Promise<DayClosed> {
	return transaction(client, async () => {
		await client.query("insert into nutrition.days (day) values ($1) on conflict (day) do nothing", [date]);
		const { rows } = await client.query<Row>("update nutrition.days set closed_at = now() where day = $1 and closed_at is null returning closed_at", [date]);
		const day = await getDay(client, date);
		const closedAt = rows[0]?.["closed_at"];
		if (closedAt === undefined) return { day, deliveryId: null };
		const deliveryId = crypto.randomUUID();
		const data = {
			date,
			closedAt: new Date(closedAt as string | Date).toISOString(),
			estimated: day.estimated,
			entries: day.entries.length,
			totals: day.totals,
			targets: day.targets === null ? null : { kcal: day.targets.kcal, protein_g: day.targets.protein_g, carbs_g: day.targets.carbs_g, fat_g: day.targets.fat_g },
			progress: day.progress,
		};
		const payload = { event: "day.closed", deliveryId, ...data, ...(test ? { test: true } : {}) };
		await client.query("insert into nutrition.deliveries (delivery_id, day, payload) values ($1, $2, $3)", [deliveryId, date, payload]);
		await queueForLiaison(client, { app: "nutrition", event: "day.closed", ref: date, test, data }, deliveryId);
		return { day, deliveryId };
	});
}

export async function addTargets(client: Database, input: TargetsInput, actor: Actor): Promise<Targets> {
	return transaction(client, async () => {
		const previous = await targetsOn(client, input.effective_from);
		const { rowCount } = await client.query(
			`insert into nutrition.plan_versions (effective_from, kcal_min, kcal_max, protein_min_g, protein_max_g, fat_min_g, fat_max_g, carbs_min_g, carbs_max_g, steps_target, notes, change, created_by)
			values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) on conflict (effective_from) do nothing`,
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
				input.steps_target === undefined ? (previous?.stepsTarget ?? null) : input.steps_target,
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
	const days = await fullDays(client, since, date);
	return { kind: settings.kind, startDate: settings.startDate, settings, summary: phaseSummary(settings, weights, days, date) };
}

const dayKcal = (plan: string) => `coalesce(
	(select ${plan} from nutrition.plan_versions v where v.effective_from <= t.day order by v.effective_from desc limit 1),
	(select k.current_kcal_target from nutrition.phases p join nutrition.phase_trackers k on k.phase_id = p.id where p.start_date <= t.day and (p.end_date is null or p.end_date >= t.day))
)`;

const DAY_KCAL_TARGET = dayKcal("(v.kcal_min + v.kcal_max) / 2.0");

async function fullDays(client: Database, from: string, to: string): Promise<LoggedDay[]> {
	const { rows } = await client.query<Row>(
		`select t.day::text as date, t.entries, t.kcal, ${DAY_KCAL_TARGET} as kcal_target from nutrition.day_totals t where t.closed and t.kcal > 0 and t.day >= $1 and t.day <= $2`,
		[from, to],
	);
	return rows
		.filter((day) => !isPartialDay({ closed: true, entries: num(day["entries"]), kcal: num(day["kcal"]), kcalTarget: numOrNull(day["kcal_target"]) }))
		.map((day) => ({ date: String(day["date"]), kcal: num(day["kcal"]) }));
}

export type ExpenditureView = ExpenditureResult & { minDays: number; avgSteps: number | null; stepDays: number };

const LOOKBACK_DAYS = 35;
const MEASURE_HEIGHT = 4;
const MEASURE_FFM = 5;
const MEASURE_FAT = 6;

async function loggedSessions(client: Database, from: string, to: string): Promise<LoggedSession[]> {
	const present = (await client.query<Row>("select to_regclass('workouts.history_sessions') is not null as history, to_regclass('workouts.sessions') is not null as live")).rows[0];
	const sessions: LoggedSession[] = [];
	if (present?.["history"] === true) {
		const { rows } = await client.query<Row>(
			`select s.session_date::text as date, s.kind, s.name, s.modality, s.duration_seconds,
				(select count(*) from workouts.history_sets x join workouts.history_exercises e on e.path = x.path and e.position = x.position
					where x.path = s.path and coalesce(x.type, 'working') = 'working' and coalesce(e.status, 'completed') <> 'skipped')::integer as working_sets,
				(select sum(case x.distance_unit when 'mi' then x.distance * 1.609344 when 'km' then x.distance when 'm' then x.distance / 1000 end)
					from workouts.history_sets x where x.path = s.path)::float8 as km
			from workouts.history_sessions s
			where s.session_date between $1 and $2 and s.kind in ('lift', 'conditioning') and coalesce(s.status, 'completed') <> 'skipped'`,
			[from, to],
		);
		for (const row of rows)
			sessions.push({ date: String(row["date"]), kind: row["kind"] as LoggedSession["kind"], name: String(row["name"]), modality: (row["modality"] as string | null) ?? null, workingSets: num(row["working_sets"]), km: numOrNull(row["km"]), durationS: numOrNull(row["duration_seconds"]) });
	}
	if (present?.["live"] === true) {
		const { rows } = await client.query<Row>(
			`select s.session_date::text as date, s.day_title as name,
				(select count(*) from workouts.sets x join workouts.exercises e on e.session_id = x.session_id and e.position = x.position
					where x.session_id = s.id and x.reps > 0 and e.status <> 'skipped')::integer as working_sets
			from workouts.sessions s where s.status = 'finished' and not s.test and s.session_date between $1 and $2`,
			[from, to],
		);
		const historyLifts = new Set(sessions.filter((session) => session.kind === "lift").map((session) => session.date));
		for (const row of rows) {
			if (historyLifts.has(String(row["date"]))) continue;
			sessions.push({ date: String(row["date"]), kind: "lift", name: String(row["name"]), modality: null, workingSets: num(row["working_sets"]), km: null, durationS: null });
		}
	}
	return sessions;
}

function bodyComposition(measures: Awaited<ReturnType<typeof listMeasures>>): { heightM: number | null; bodyComp: BodyComp[] } {
	const groups = new Map<string, { date: string; ffm?: number; fat?: number }>();
	let heightM: number | null = null;
	for (const measure of measures) {
		const type = num(measure["type"]);
		const value = num(measure["value"]);
		if (type === MEASURE_HEIGHT) heightM = value;
		if (type !== MEASURE_FFM && type !== MEASURE_FAT) continue;
		const grpid = String(measure["grpid"]);
		const group = groups.get(grpid) ?? { date: today(new Date(measure["measured_at"] as string | Date)) };
		if (type === MEASURE_FFM) group.ffm = value;
		else group.fat = value;
		groups.set(grpid, group);
	}
	const bodyComp = [...groups.values()].flatMap((group) => (group.ffm === undefined || group.fat === undefined ? [] : [{ date: group.date, ffmKg: group.ffm, fatPct: group.fat }]));
	return { heightM, bodyComp };
}

const APPLE_CATEGORIES: Record<string, number> = {
	"outdoor walk": 1,
	walk: 1,
	"indoor walk": 306,
	"outdoor run": 2,
	run: 2,
	"indoor run": 307,
	hiking: 3,
	"outdoor cycling": 6,
	"indoor cycling": 308,
	swimming: 7,
	"pool swim": 7,
	"open water swim": 7,
	elliptical: 18,
	rowing: 187,
	"traditional strength training": 16,
	"functional strength training": 16,
	yoga: 28,
	pilates: 19,
	"cross country skiing": 34,
	"downhill skiing": 34,
	snowboarding: 35,
	"stair stepper": 491,
	"stair climbing": 491,
};
const OTHER_CATEGORY = 36;

async function appleIntake(client: Database, to: string, logged: ReadonlySet<string>): Promise<IntakeDay[]> {
	const { rows } = await client.query<Row>(
		`select (measured_at at time zone 'UTC' + make_interval(mins => utc_offset_min))::date::text as date, source,
			sum(qty * case units when 'kJ' then 0.239006 else 1 end)::float8 as kcal
		from activity.apple_health_samples where metric = 'dietary_energy' and measured_at < $1::date + 2
		group by 1, 2 order by 1, 3 desc`,
		[to],
	);
	const byDay = new Map<string, IntakeDay>();
	for (const row of rows) {
		const date = String(row["date"]);
		if (date > to || logged.has(date) || byDay.has(date)) continue;
		byDay.set(date, { date, kcal: num(row["kcal"]), source: String(row["source"]) });
	}
	return [...byDay.values()];
}

async function watchWorkouts(client: Database, start: string, to: string, hasApple: boolean): Promise<WatchWorkout[]> {
	const apple = hasApple ? await listAppleWorkouts(client, start, to) : [];
	const twinKcal = new Map(apple.flatMap((workout) => (workout.withingsId === null || workout.activeKcal === null ? [] : [[workout.withingsId, workout.activeKcal] as const])));
	const withings = (await listWorkouts(client, start, to)).map((workout) => ({
		date: workout.date,
		category: workout.category,
		activity: workout.activity,
		durationS: workout.durationS,
		activeKcal: workout.activeKcal ?? twinKcal.get(String(workout.id)) ?? null,
		steps: workout.steps,
		distanceM: workout.distanceM,
		hrAvg: workout.hr.avg,
	}));
	const appleOnly = apple
		.filter((workout) => workout.withingsId === null)
		.map((workout) => ({
			date: workout.date,
			category: APPLE_CATEGORIES[workout.name.toLowerCase()] ?? OTHER_CATEGORY,
			activity: workout.name.toLowerCase(),
			durationS: workout.durationS,
			activeKcal: workout.activeKcal,
			steps: null,
			distanceM: workout.distanceM,
			hrAvg: workout.hr.avg,
		}));
	return [...withings, ...appleOnly];
}

export async function getExpenditure(client: Database, from: string, to: string): Promise<ExpenditureView> {
	const present = (await client.query<Row>("select to_regclass('nutrition.profile') is not null as profile, to_regclass('activity.apple_health_samples') is not null as apple")).rows[0];
	const logged: IntakeDay[] = await fullDays(client, "1900-01-01", to);
	const external = present?.["apple"] === true ? await appleIntake(client, to, new Set(logged.map((day) => day.date))) : [];
	const intake = [...logged, ...external].toSorted((a, b) => a.date.localeCompare(b.date));
	const tracker: TrackerDay[] = (
		await client.query<Row>(
			"select day::text as date, (imported->>'expenditure_kcal')::float8 as kcal from nutrition.days where day <= $1 and jsonb_typeof(imported->'expenditure_kcal') = 'number' order by day",
			[to],
		)
	).rows.map((row) => ({ date: String(row["date"]), kcal: num(row["kcal"]) }));
	const earliest = [from, intake[0]?.date, tracker[0]?.date].filter((date) => date !== undefined).toSorted()[0] as string;
	const start = addDays(earliest, -LOOKBACK_DAYS);
	const profile = present?.["profile"] === true ? (await client.query<Row>("select birth_date::text as birth_date from nutrition.profile")).rows[0] : undefined;
	const weighIns: WeighIn[] = (
		await client.query<Row>("select measured_on::text as date, weight_lb from nutrition.daily_weights where measured_on between $1 and $2 order by measured_on", [start, to])
	).rows.map((row) => ({ date: String(row["date"]), lb: num(row["weight_lb"]) }));
	const steps: StepsDay[] = (
		await client.query<Row>(
			`select coalesce(a.day, d.day)::text as date, coalesce(a.steps, d.steps) as steps,
				(select x.active_kcal::float8 from activity.days x where x.day = coalesce(a.day, d.day) and x.source = 'apple_health') as active_kcal
			from activity.daily_activity a full join nutrition.days d on d.day = a.day
			where coalesce(a.day, d.day) between $1 and $2 order by 1`,
			[start, to],
		)
	).rows.map((row) => ({ date: String(row["date"]), steps: numOrNull(row["steps"]), activeKcal: numOrNull(row["active_kcal"]) }));
	const { heightM, bodyComp } = bodyComposition(await listMeasures(client, "1900-01-01", to, [MEASURE_HEIGHT, MEASURE_FFM, MEASURE_FAT]));
	const workouts = await watchWorkouts(client, start, to, present?.["apple"] === true);
	const sessions = await loggedSessions(client, start, to);
	const result = estimateExpenditure({ profile: { birthDate: (profile?.["birth_date"] as string | null) ?? null, heightM }, weighIns, intake, tracker, steps, bodyComp, workouts, sessions }, from, to);
	const { rows } = await client.query<Row>(
		`select avg(steps)::float as avg_steps, count(steps)::integer as step_days from (
			select coalesce(a.steps, d.steps) as steps
			from activity.daily_activity a full join nutrition.days d on d.day = a.day
			where coalesce(a.day, d.day) between $1 and $2 and coalesce(a.steps, d.steps) > 0
		) s`,
		[from, to],
	);
	const avg = numOrNull(rows[0]?.["avg_steps"]);
	return { ...result, minDays: MEASURED_MIN_DAYS, avgSteps: avg === null ? null : Math.round(avg), stepDays: num(rows[0]?.["step_days"] ?? 0) };
}

export async function getHistory(client: Database): Promise<HistoryDay[]> {
	const { rows } = await client.query<Row>(
		`select t.day::text as date, t.closed, t.entries, t.kcal, t.protein_g, t.carbs_g, t.fat_g, ${DAY_KCAL_TARGET} as kcal_target, ${dayKcal("v.kcal_min")} as kcal_min, ${dayKcal("v.kcal_max")} as kcal_max, nullif(coalesce(a.steps, d.steps), 0) as steps
		from nutrition.day_totals t join nutrition.days d on d.day = t.day left join activity.daily_activity a on a.day = t.day
		order by t.day desc limit 400`,
	);
	return rows.map((row) => {
		const day = {
			date: String(row["date"]),
			closed: row["closed"] === true,
			entries: num(row["entries"]),
			kcal: num(row["kcal"]),
			protein_g: num(row["protein_g"]),
			carbs_g: num(row["carbs_g"]),
			fat_g: num(row["fat_g"]),
			kcalTarget: numOrNull(row["kcal_target"]),
		};
		const min = numOrNull(row["kcal_min"]);
		const max = numOrNull(row["kcal_max"]);
		return { ...day, partial: isPartialDay(day), steps: numOrNull(row["steps"]), kcalRange: min === null || max === null ? null : { min, max } };
	});
}

export async function getWeights(client: Database): Promise<WeightRow[]> {
	const { rows } = await client.query<Row>(
		"select t.measured_on::text as date, t.weight_lb, t.rolling_7d, t.rolling_14d, t.rolling_28d, d.source from nutrition.weight_trend t join nutrition.daily_weights d using (measured_on) order by t.measured_on",
	);
	return rows.map((row) => ({
		date: String(row["date"]),
		weight: num(row["weight_lb"]),
		rolling7d: num(row["rolling_7d"]),
		rolling14d: num(row["rolling_14d"]),
		rolling28d: num(row["rolling_28d"]),
		source: String(row["source"]),
	}));
}

export async function getSteps(client: Database): Promise<StepsRow[]> {
	const { rows } = await client.query<Row>(
		`with s as (
			select coalesce(a.day, d.day) as day, coalesce(a.steps, d.steps) as steps
			from activity.daily_activity a full join nutrition.days d on d.day = a.day
			where coalesce(a.steps, d.steps) > 0
		)
		select s.day::text as date, s.steps,
			avg(s.steps) over (order by s.day range between interval '6 days' preceding and current row)::float as rolling_7d,
			avg(s.steps) over (order by s.day range between interval '13 days' preceding and current row)::float as rolling_14d,
			avg(s.steps) over (order by s.day range between interval '27 days' preceding and current row)::float as rolling_28d,
			(select v.steps_target from nutrition.plan_versions v where v.effective_from <= s.day order by v.effective_from desc limit 1) as target
		from s order by s.day`,
	);
	return rows.map((row) => ({
		date: String(row["date"]),
		steps: num(row["steps"]),
		rolling7d: num(row["rolling_7d"]),
		rolling14d: num(row["rolling_14d"]),
		rolling28d: num(row["rolling_28d"]),
		target: numOrNull(row["target"]),
	}));
}

export const TEST_DAYS_FROM = "2099-01-01";

export type Discarded = { date: string; liaisonDeliveries: number; deliveries: number; entries: number; weighIns: number; days: number };

export async function discardTestDay(client: Database, date: string): Promise<Discarded> {
	if (date < TEST_DAYS_FROM) throw new Rejected(`Only test days (${TEST_DAYS_FROM} or later) can be discarded, not ${date}.`);
	return transaction(client, async () => {
		const liaison = await client.query("delete from liaison.deliveries where delivery_id in (select delivery_id from nutrition.deliveries where day = $1)", [date]);
		const deliveries = await client.query("delete from nutrition.deliveries where day = $1", [date]);
		const entries = await client.query("delete from nutrition.food_entries where day = $1", [date]);
		const weighIns = await client.query("delete from nutrition.weigh_ins where measured_on = $1", [date]);
		const days = await client.query("delete from nutrition.days where day = $1", [date]);
		return { date, liaisonDeliveries: liaison.rowCount ?? 0, deliveries: deliveries.rowCount ?? 0, entries: entries.rowCount ?? 0, weighIns: weighIns.rowCount ?? 0, days: days.rowCount ?? 0 };
	});
}
