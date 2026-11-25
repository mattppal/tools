import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "pg";
import { addDays, dayNumber, isoDate } from "./dates.ts";
import { parseSource } from "./sources.ts";

const CONNECTION_ENV = "CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB";
const SHEET_EPOCH = dayNumber("1899-12-30");
const OPEN_DAY = "2026-11-22";
const MACROS = ["kcal", "protein_g", "carbs_g", "fat_g"] as const;

type Food = { food: string; qty: number; unit: string; kcal: number; protein_g: number; carbs_g: number; fat_g: number; fiber_g?: number | null; source?: string; time?: string };
type DailyFile = {
	date: string;
	source?: string;
	totals: (Record<(typeof MACROS)[number], number> & { estimated?: boolean }) | null;
	foods: Food[] | null;
	bodyweight_lb?: number | null;
	steps?: number | null;
	bloat_score?: number | null;
	energy?: number | null;
	sleep?: number | null;
	stress?: number | null;
	notes?: string;
};
type PlanFile = {
	goal: string;
	rules: string[];
	pre_training: string;
	history: { date: string; change: string }[];
	previous_phases: { name: string; summary?: string; protocol?: string; schedule?: { group: string; dates: string; result: string }[] }[];
};
type SheetWeight = { date: string; weight: number; rolling: [number, number, number] | null };

const { values: args } = parseArgs({
	options: {
		"training-log": { type: "string" },
		weights: { type: "string" },
		cutover: { type: "string" },
		"dry-run": { type: "boolean", default: false },
	},
});

function usage(): never {
	throw new Error("Usage: bun tools/nutrition/import.ts --training-log <clone> --weights <weights.csv> [--cutover YYYY-MM-DD] [--dry-run]");
}

async function readDays(root: string): Promise<DailyFile[]> {
	const directory = join(root, "nutrition", "daily");
	const names = (await readdir(directory)).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).toSorted();
	return Promise.all(names.map(async (name) => JSON.parse(await readFile(join(directory, name), "utf8")) as DailyFile));
}

async function readWeights(path: string): Promise<SheetWeight[]> {
	const [header, ...lines] = (await readFile(path, "utf8")).trim().split(/\r?\n/);
	if (header !== "date_serial,weight_lb,rolling_7d,rolling_14d,rolling_28d") throw new Error(`Unexpected weights.csv header: ${header}`);
	return lines.map((line) => {
		const [serial, weight, r7, r14, r28] = line.split(",");
		const rolling = r7 && r14 && r28 ? ([Number(r7), Number(r14), Number(r28)] as [number, number, number]) : null;
		return { date: isoDate(SHEET_EPOCH + Number(serial)), weight: Number(weight), rolling };
	});
}

function phases(plan: PlanFile) {
	const reintroduction = plan.previous_phases.find((phase) => phase.name === "reintroduction");
	const elimination = plan.previous_phases.find((phase) => phase.name === "elimination" && phase.summary !== undefined);
	const results = reintroduction?.schedule?.map((test) => `${test.group} (${test.dates}): ${test.result}`).join("\n") ?? "";
	return [
		{ kind: "baseline", start: "2026-10-06", end: "2026-10-11", summary: "Normal eating, logged from the food tracker export." },
		{ kind: "elimination", start: "2026-10-12", end: "2026-10-25", summary: "" },
		{ kind: "reintroduction", start: "2026-10-26", end: "2026-11-01", summary: [reintroduction?.protocol ?? "", results].filter(Boolean).join("\n\n") },
		{ kind: "elimination", start: "2026-11-02", end: "2026-11-21", summary: elimination?.summary ?? "" },
		{ kind: "maintain", start: OPEN_DAY, end: null, summary: plan.goal },
	];
}

function sourceOf(day: DailyFile, food: Food) {
	if (food.source !== undefined) return parseSource(food.source);
	if (food.time !== undefined) return { kind: "tracker_export" as const, ref: null, label: day.source ?? "" };
	return parseSource(undefined);
}

async function run(client: Client, plan: PlanFile, days: DailyFile[], weights: SheetWeight[]): Promise<string[]> {
	const problems: string[] = [];

	for (const phase of phases(plan)) {
		await client.query(
			`insert into nutrition.phases (kind, start_date, end_date, summary) values ($1, $2, $3, $4)
			on conflict (start_date) do update set kind = excluded.kind, end_date = excluded.end_date, summary = excluded.summary`,
			[phase.kind, phase.start, phase.end, phase.summary],
		);
	}
	await client.query(
		`insert into nutrition.phase_trackers (phase_id, target_rate_per_week, weeks, tolerance_lb, max_weekly_kcal_change, min_logged_days, current_kcal_target)
		select id, 0, 12, 0.5, 150, 5, 2750 from nutrition.phases where start_date = $1
		on conflict (phase_id) do nothing`,
		[OPEN_DAY],
	);

	const notes = [`Goal: ${plan.goal}`, ...plan.rules.map((rule) => `- ${rule}`), `Pre-training: ${plan.pre_training}`].join("\n");
	for (const effectiveFrom of ["2026-11-02", "2026-11-22"]) {
		const change = plan.history.find((entry) => entry.date === (effectiveFrom === "2026-11-22" ? "2026-11-21" : effectiveFrom))?.change ?? "Imported from plan.json";
		await client.query(
			`insert into nutrition.plan_versions (effective_from, kcal_min, kcal_max, protein_min_g, protein_max_g, fat_min_g, fat_max_g, carbs_min_g, carbs_max_g, notes, change, created_by)
			values ($1, 2600, 2900, 170, 200, 55, 70, 330, 380, $2, $3, 'import')
			on conflict (effective_from) do update set notes = excluded.notes, change = excluded.change`,
			[effectiveFrom, notes, change],
		);
	}

	for (const day of days) {
		await client.query(
			`insert into nutrition.days (day, closed_at, steps, bloat_score, energy, sleep, stress, notes, totals_estimated, imported)
			values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
			on conflict (day) do update set closed_at = coalesce(nutrition.days.closed_at, excluded.closed_at), steps = excluded.steps, bloat_score = excluded.bloat_score,
				energy = excluded.energy, sleep = excluded.sleep, stress = excluded.stress, notes = excluded.notes, totals_estimated = excluded.totals_estimated, imported = excluded.imported`,
			[
				day.date,
				day.date < OPEN_DAY ? `${addDays(day.date, 1)}T07:59:00Z` : null,
				day.steps ?? null,
				day.bloat_score ?? null,
				day.energy ?? null,
				day.sleep ?? null,
				day.stress ?? null,
				day.notes ?? "",
				day.totals?.estimated === true,
				day,
			],
		);
		const foods = day.foods ?? [];
		for (const [index, food] of foods.entries()) {
			const source = sourceOf(day, food);
			await client.query(
				`insert into nutrition.food_entries (day, food, qty, unit, kcal, protein_g, carbs_g, fat_g, fiber_g, source_kind, source_ref, source_label, client_key, created_by, logged_at)
				values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'import', null)
				on conflict (client_key) do update set food = excluded.food, qty = excluded.qty, unit = excluded.unit, kcal = excluded.kcal, protein_g = excluded.protein_g,
					carbs_g = excluded.carbs_g, fat_g = excluded.fat_g, fiber_g = excluded.fiber_g, source_kind = excluded.source_kind, source_ref = excluded.source_ref, source_label = excluded.source_label`,
				[day.date, food.food, food.qty, food.unit, food.kcal, food.protein_g, food.carbs_g, food.fat_g, food.fiber_g ?? null, source.kind, source.ref, source.label, `import:${day.date}:${index}`],
			);
		}
		await client.query("delete from nutrition.food_entries where day = $1 and client_key like 'import:%' and split_part(client_key, ':', 3)::int >= $2", [day.date, foods.length]);
		if (typeof day.bodyweight_lb === "number") {
			await client.query(
				"insert into nutrition.weigh_ins (measured_on, source, weight_lb) values ($1, 'daily_file', $2) on conflict (measured_on, source) do update set weight_lb = excluded.weight_lb",
				[day.date, day.bodyweight_lb],
			);
		}
	}

	for (let start = 0; start < weights.length; start += 500) {
		const batch = weights.slice(start, start + 500);
		await client.query(
			`insert into nutrition.weigh_ins (measured_on, source, weight_lb)
			select measured_on, 'sheet', weight_lb from unnest($1::date[], $2::numeric[]) as rows (measured_on, weight_lb)
			on conflict (measured_on, source) do update set weight_lb = excluded.weight_lb`,
			[batch.map((row) => row.date), batch.map((row) => row.weight)],
		);
	}

	const totals = new Map(
		(await client.query<Record<string, string>>("select day::text as day, kcal, protein_g, carbs_g, fat_g from nutrition.day_totals")).rows.map((row) => [row["day"], row]),
	);
	for (const day of days) {
		if (day.totals === null) continue;
		const exported = (day.foods ?? []).filter((food) => food.source === undefined && food.time !== undefined).length;
		const tolerance = Math.max(1, exported * 0.5);
		for (const macro of MACROS) {
			const stored = Number(totals.get(day.date)?.[macro] ?? 0);
			if (Math.abs(stored - day.totals[macro]) > tolerance) problems.push(`${day.date} ${macro}: entries add to ${stored}, file says ${day.totals[macro]}`);
		}
	}

	const trend = new Map(
		(await client.query<Record<string, string>>("select measured_on::text as day, rolling_7d, rolling_14d, rolling_28d from nutrition.weight_trend")).rows.map((row) => [row["day"], row]),
	);
	for (const weight of weights) {
		if (weight.rolling === null) continue;
		const row = trend.get(weight.date);
		const stored = [Number(row?.["rolling_7d"]), Number(row?.["rolling_14d"]), Number(row?.["rolling_28d"])];
		for (const [index, label] of ["7d", "14d", "28d"].entries()) {
			const expected = weight.rolling[index] ?? Number.NaN;
			if (!(Math.abs((stored[index] ?? Number.NaN) - expected) <= 0.01)) problems.push(`${weight.date} rolling ${label}: view has ${stored[index]}, sheet has ${expected}`);
		}
	}
	return problems;
}

async function main(): Promise<void> {
	const root = args["training-log"] ?? usage();
	const weightsPath = args.weights ?? usage();
	const connectionString = process.env[CONNECTION_ENV];
	if (!connectionString) throw new Error(`Set ${CONNECTION_ENV} first. See docs/database.md.`);

	const plan = JSON.parse(await readFile(join(root, "nutrition", "plan.json"), "utf8")) as PlanFile;
	const days = await readDays(root);
	const weights = await readWeights(weightsPath);
	if (args.cutover !== undefined) {
		const late = days.filter((day) => day.date >= (args.cutover as string)).map((day) => day.date);
		if (late.length > 0) throw new Error(`The bot writes days from ${args.cutover} on through MCP. Remove these files from the import: ${late.join(", ")}`);
	}

	const target = new URL(connectionString);
	console.log(`${args["dry-run"] ? "Checking" : "Importing"} into ${target.pathname.slice(1)} on ${target.host}`);
	const client = new Client({ connectionString });
	await client.connect();
	try {
		await client.query("begin");
		const problems = await run(client, plan, days, weights);
		const counts = (
			await client.query<Record<string, string>>(
				`select (select count(*) from nutrition.phases) as phases, (select count(*) from nutrition.plan_versions) as plan_versions, (select count(*) from nutrition.days) as days,
				(select count(*) from nutrition.food_entries) as food_entries, (select count(*) from nutrition.weigh_ins) as weigh_ins`,
			)
		).rows[0];
		console.log(`Read ${days.length} daily files and ${weights.length} weigh-ins, ${weights.filter((weight) => weight.rolling !== null).length} with sheet averages to check.`);
		console.log("Rows after import:", counts);
		if (problems.length > 0) {
			await client.query("rollback");
			throw new Error(`Rolled back. ${problems.length} checks failed:\n${problems.join("\n")}`);
		}
		await client.query(args["dry-run"] ? "rollback" : "commit");
		console.log(args["dry-run"] ? "All checks passed. Dry run, nothing written." : "All checks passed. Committed.");
	} catch (error) {
		await client.query("rollback").catch(() => {});
		throw error;
	} finally {
		await client.end();
	}
}

try {
	await main();
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
}
