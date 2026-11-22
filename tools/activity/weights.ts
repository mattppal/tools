import type { Database } from "../../worker/db.ts";
import { addDays } from "./dates.ts";
import type { MeasureGroup } from "./withings.ts";

export const TIME_ZONE = "America/Los_Angeles";
export const KG_TO_LB = 2.20462262185;
export const TREND_SMOOTHING = 0.1;

const WEIGHT = 1;
const FAT_RATIO = 6;
const FAT_MASS = 8;
const REAL_MEASURE = 1;
const AMBIGUOUS_ATTRIB = 1;

export type Weighin = {
	grpid: number;
	timestamp: number;
	date: string;
	time: string;
	weightKg: number;
	weightLb: number;
	fatPct: number | null;
	fatMassLb: number | null;
	fatSource: "fat_ratio" | "derived_from_fat_mass" | null;
	attrib: number;
	model: string | null;
};

export type DailyWeight = { date: string; time: string; weight_lb: number; weight_kg: number; fat_pct: number | null; grpid: number; weighins_that_day: number };
export type TrendRow = { date: string; weight_lb: number | null; trend_lb: number | null };
export type TrendSummary = { start_date: string; end_date: string; start_trend: number | null; end_trend: number | null; delta_lb: number | null; days: number; lb_per_week: number | null; weigh_in_days: number };

export function round(value: number | null, dp = 2): number | null {
	if (value === null || Number.isNaN(value)) return null;
	const scale = 10 ** dp;
	return Math.round(value * scale) / scale;
}

function decode(value: number, unit: number): number {
	const decoded = value * 10 ** unit;
	return unit < 0 ? (round(decoded, -unit) as number) : decoded;
}

export function localParts(timestamp: number, timeZone = TIME_ZONE): { date: string; time: string } {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
			.formatToParts(new Date(timestamp * 1000))
			.map((part) => [part.type, part.value]),
	);
	const hour = parts["hour"] === "24" ? "00" : parts["hour"];
	return { date: `${parts["year"]}-${parts["month"]}-${parts["day"]}`, time: `${hour}:${parts["minute"]}` };
}

export function toWeighins(groups: readonly MeasureGroup[], timeZone = TIME_ZONE): Weighin[] {
	const merged = new Map<number, MeasureGroup>();
	for (const group of groups) {
		if (group.category !== undefined && group.category !== REAL_MEASURE) continue;
		const seen = merged.get(group.grpid);
		merged.set(group.grpid, seen === undefined ? { ...group, measures: [...group.measures] } : { ...seen, date: Math.min(seen.date, group.date), measures: [...seen.measures, ...group.measures] });
	}
	const weighins: Weighin[] = [];
	for (const group of merged.values()) {
		const value = (type: number) => {
			const measure = group.measures.find((candidate) => candidate.type === type);
			return measure === undefined ? null : decode(measure.value, measure.unit);
		};
		const kg = value(WEIGHT);
		if (kg === null) continue;
		const ratio = value(FAT_RATIO);
		const fatKg = value(FAT_MASS);
		const fatPct = ratio ?? (fatKg !== null && kg > 0 ? (fatKg / kg) * 100 : null);
		const { date, time } = localParts(group.date, timeZone);
		weighins.push({
			grpid: group.grpid,
			timestamp: group.date,
			date,
			time,
			weightKg: round(kg, 3) as number,
			weightLb: round(kg * KG_TO_LB) as number,
			fatPct: round(fatPct),
			fatMassLb: fatKg === null ? null : round(fatKg * KG_TO_LB),
			fatSource: ratio !== null ? "fat_ratio" : fatPct !== null ? "derived_from_fat_mass" : null,
			attrib: group.attrib,
			model: group.model ?? null,
		});
	}
	return weighins.toSorted((a, b) => a.timestamp - b.timestamp || String(a.grpid).localeCompare(String(b.grpid)));
}

export function dailyFirst(weighins: readonly Weighin[]): DailyWeight[] {
	const byDate = new Map<string, Weighin[]>();
	const sorted = weighins.toSorted((a, b) => a.timestamp - b.timestamp || String(a.grpid).localeCompare(String(b.grpid)));
	for (const weighin of sorted) byDate.set(weighin.date, [...(byDate.get(weighin.date) ?? []), weighin]);
	return [...byDate.values()].map((list) => {
		const pick = list.find((weighin) => weighin.attrib !== AMBIGUOUS_ATTRIB) ?? (list[0] as Weighin);
		return { date: pick.date, time: pick.time, weight_lb: pick.weightLb, weight_kg: pick.weightKg, fat_pct: pick.fatPct, grpid: pick.grpid, weighins_that_day: list.length };
	});
}

export function trend(daily: readonly { date: string; weight_lb: number }[], start: string, end: string, smoothing = TREND_SMOOTHING): { daily: TrendRow[]; summary: TrendSummary } {
	const weights = new Map(daily.map((row) => [row.date, row.weight_lb]));
	const rows: TrendRow[] = [];
	const raw: (number | null)[] = [];
	let current: number | null = null;
	let days = 0;
	for (let date = start; date <= end; date = addDays(date, 1)) {
		const weight = weights.get(date) ?? null;
		if (weight !== null) current = current === null ? weight : current + smoothing * (weight - current);
		raw.push(current);
		rows.push({ date, weight_lb: weight, trend_lb: round(current) });
		days++;
	}
	const first = raw.find((value) => value !== null) ?? null;
	const last = raw.at(-1) ?? null;
	const delta = first === null || last === null ? null : last - first;
	const span = days - 1;
	return {
		daily: rows,
		summary: {
			start_date: start,
			end_date: end,
			start_trend: round(first),
			end_trend: round(last),
			delta_lb: round(delta),
			days: span,
			lb_per_week: delta === null || span === 0 ? null : round((delta / span) * 7),
			weigh_in_days: rows.filter((row) => row.weight_lb !== null).length,
		},
	};
}

export async function saveWeighins(client: Database, weighins: readonly Weighin[]): Promise<number> {
	if (weighins.length === 0) return 0;
	const rows = weighins.map((weighin) => ({
		grpid: weighin.grpid,
		measured_ts: weighin.timestamp,
		local_date: weighin.date,
		local_time: weighin.time,
		weight_kg: weighin.weightKg,
		weight_lb: weighin.weightLb,
		fat_pct: weighin.fatPct,
		fat_mass_lb: weighin.fatMassLb,
		fat_source: weighin.fatSource,
		attrib: weighin.attrib,
		model: weighin.model,
	}));
	await client.query(
		`insert into activity.withings_weighins (grpid, measured_ts, local_date, local_time, weight_kg, weight_lb, fat_pct, fat_mass_lb, fat_source, attrib, model)
		select r.grpid, r.measured_ts, r.local_date, r.local_time, r.weight_kg, r.weight_lb, r.fat_pct, r.fat_mass_lb, r.fat_source, r.attrib, r.model
		from jsonb_to_recordset($1::jsonb) as r (grpid bigint, measured_ts bigint, local_date date, local_time text, weight_kg numeric, weight_lb numeric,
			fat_pct numeric, fat_mass_lb numeric, fat_source text, attrib integer, model text)
		on conflict (grpid) do update set
			measured_ts = excluded.measured_ts, local_date = excluded.local_date, local_time = excluded.local_time, weight_kg = excluded.weight_kg,
			weight_lb = excluded.weight_lb, fat_pct = excluded.fat_pct, fat_mass_lb = excluded.fat_mass_lb, fat_source = excluded.fat_source,
			attrib = excluded.attrib, model = excluded.model, updated_at = now()`,
		[JSON.stringify(rows)],
	);
	const dates = [...new Set(weighins.map((weighin) => weighin.date))];
	const { rowCount } = await client.query(
		`insert into nutrition.weigh_ins (measured_on, source, weight_lb, measured_at, grpid, fat_pct)
		select local_date, 'withings', weight_lb, to_timestamp(measured_ts), grpid, fat_pct
		from (
			select distinct on (local_date) local_date, weight_lb, measured_ts, grpid, fat_pct
			from activity.withings_weighins
			where local_date = any($1::date[])
			order by local_date, attrib = ${AMBIGUOUS_ATTRIB}, measured_ts, grpid::text
		) picked
		on conflict (measured_on, source) do update set
			weight_lb = excluded.weight_lb, measured_at = excluded.measured_at, grpid = excluded.grpid, fat_pct = excluded.fat_pct
		where (nutrition.weigh_ins.weight_lb, nutrition.weigh_ins.measured_at, nutrition.weigh_ins.grpid, nutrition.weigh_ins.fat_pct)
			is distinct from (excluded.weight_lb, excluded.measured_at, excluded.grpid, excluded.fat_pct)`,
		[dates],
	);
	return rowCount ?? 0;
}

type Row = Record<string, unknown>;
const numOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

export async function readWeighins(client: Database, from: string, to: string): Promise<Weighin[]> {
	const { rows } = await client.query<Row>(
		`select grpid::text, measured_ts::text, local_date::text, local_time, weight_kg, weight_lb, fat_pct, fat_mass_lb, fat_source, attrib, model
		from activity.withings_weighins where local_date between $1 and $2 order by measured_ts, grpid::text`,
		[from, to],
	);
	return rows.map((row) => ({
		grpid: Number(row["grpid"]),
		timestamp: Number(row["measured_ts"]),
		date: String(row["local_date"]),
		time: String(row["local_time"]),
		weightKg: Number(row["weight_kg"]),
		weightLb: Number(row["weight_lb"]),
		fatPct: numOrNull(row["fat_pct"]),
		fatMassLb: numOrNull(row["fat_mass_lb"]),
		fatSource: (row["fat_source"] as Weighin["fatSource"]) ?? null,
		attrib: Number(row["attrib"]),
		model: (row["model"] as string | null) ?? null,
	}));
}

export async function weightReport(client: Database, from: string, to: string, smoothing = TREND_SMOOTHING) {
	const daily = dailyFirst(await readWeighins(client, from, to));
	return { daily, trend: trend(daily, from, to, smoothing) };
}
