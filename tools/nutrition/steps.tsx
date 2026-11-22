import { type CSSProperties, useMemo, useState } from "react";
import { Button } from "../../src/kit/button.tsx";
import { Skeleton } from "../../src/kit/skeleton.tsx";
import { navigate, useSearchParam } from "../../src/router.tsx";
import { ToolLayout } from "../../src/shell/tool-layout.tsx";
import { today } from "./dates.ts";
import { type Bucket, type Bucketing, bucketDays, GROUPINGS, type Grouping, parseGrouping, snapRange } from "./groups.ts";
import styles from "./nutrition.module.css";
import { AverageControls, averageTrend, type Column, RangeControls, type SeriesStyle, SeriesChart, SeriesSummary, SeriesTable, seriesColumns, type SummaryItem, useSeriesRange } from "./series.tsx";
import type { StepsRow } from "./types.ts";
import { dayLabel, useJson, VIEWS, whole } from "./ui.tsx";
import { changeTone, type DateRange, inRange, previousRange, type SeriesRow, toneStrength, withChanges } from "./weights.ts";

const STEP_TICK = 2000;
const FLAT_SHARE = 0.02;
const FULL_SHARE = 0.25;

const GROUP_LABELS: Record<Grouping, string> = { day: "Day", week: "Week", month: "Month" };

const STEPS: SeriesStyle = {
	name: "Steps",
	unit: "steps",
	raw: "bars",
	empty: "No steps in this range.",
	format: whole,
	domain: (values) => [0, Math.max(Math.ceil(Math.max(...values) / STEP_TICK) * STEP_TICK, STEP_TICK)],
};

const plural = (count: number, word: string) => `${whole(count)} ${count === 1 ? word : `${word}s`}`;

function stepsDetail(targets: Map<string, number | null>) {
	return (row: SeriesRow): string[] => {
		const target = targets.get(row.date) ?? null;
		return [`Steps · ${dayLabel(row.date)}`, target === null ? whole(row.value) : `${whole(row.value)} of ${whole(target)}`];
	};
}

const noon = (date: string) => new Date(`${date}T12:00:00Z`);
const weekShort = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const weekLong = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const monthShort = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
const monthLong = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

function bucketLabel(bucket: Bucket, bucketing: Bucketing, long: boolean): string {
	switch (bucketing) {
		case "week":
			return (long ? weekLong : weekShort).formatRange(noon(bucket.date), noon(bucket.end));
		case "month":
			return (long ? monthLong : monthShort).format(noon(bucket.date));
		default: {
			const unknown: never = bucketing;
			throw new Error(`Unknown bucketing ${String(unknown)}`);
		}
	}
}

function bucketSeries(bucketing: Bucketing): SeriesStyle<Bucket> {
	return {
		...STEPS,
		name: `Average steps a day by ${bucketing}`,
		unit: "steps a day",
		label: (bucket) => bucketLabel(bucket, bucketing, false),
		detail: (bucket) => [
			`Steps · ${bucketLabel(bucket, bucketing, true)}`,
			`${whole(bucket.value)} a day`,
			...(bucket.targeted === 0 ? [] : [`${whole(bucket.met)} of ${plural(bucket.targeted, "day")} at target`]),
		],
	};
}

const signed = (value: number) => (Math.round(value) === 0 ? "0" : `${value > 0 ? "+" : "\u2212"}${whole(Math.abs(value))}`);

function bucketColumns(bucketing: Bucketing): Column<Bucket>[] {
	return [
		{
			key: "date",
			label: GROUP_LABELS[bucketing],
			kind: "head",
			sort: (bucket) => bucket.date,
			cell: (bucket) => (
				<>
					{bucketLabel(bucket, bucketing, true)}
					{bucket.partial ? <span className={styles.entryMeta}> {"\u00b7"} partial</span> : null}
				</>
			),
		},
		{
			key: "value",
			label: "Steps a day",
			kind: "value",
			sort: (bucket) => bucket.value,
			cell: (bucket) => (
				<>
					{whole(bucket.value)}
					<span className={styles.entryMeta}>
						{" "}
						avg {"\u00b7"} {plural(bucket.days, "day")}
					</span>
				</>
			),
		},
		{ key: "met", label: "At target", kind: "detail", sort: (bucket) => (bucket.targeted === 0 ? -1 : bucket.met / bucket.targeted), cell: (bucket) => (bucket.targeted === 0 ? "" : `${whole(bucket.met)} of ${whole(bucket.targeted)}`) },
		{ key: "change", label: "Change", kind: "detail", sort: (bucket) => bucket.change ?? Number.NEGATIVE_INFINITY, cell: (bucket) => (bucket.change === null ? "" : signed(bucket.change)) },
	];
}

type StepsPoint = SeriesRow & { target: number | null };

const mean = (rows: SeriesRow[]) => (rows.length === 0 ? null : rows.reduce((sum, row) => sum + row.value, 0) / rows.length);

function Summary({ rows, all, range }: { rows: StepsPoint[]; all: StepsPoint[]; range: DateRange }) {
	const average = mean(rows);
	if (average === null) return null;
	const before = mean(inRange(all, previousRange(range), null));
	const targeted = rows.filter((row) => row.target !== null);
	const items: SummaryItem[] = [
		{ label: "Average", value: `${whole(average)} a day`, note: `over ${plural(rows.length, "day")}` },
		{ label: "Total", value: whole(rows.reduce((sum, row) => sum + row.value, 0)) },
	];
	if (before !== null) {
		const change = average - before;
		const share = change / before;
		const sign = Math.round(change) === 0 ? "" : change > 0 ? "+" : "\u2212";
		items.push({
			label: "Change",
			value: `${sign}${whole(Math.abs(change))} a day`,
			note: "vs prior period",
			tone: { "data-tone": changeTone(share, "gain", FLAT_SHARE), style: { "--tone-strength": `${Math.round(toneStrength(share, FULL_SHARE) * 100)}%` } as CSSProperties },
		});
	}
	if (targeted.length > 0) {
		const met = targeted.filter((row) => row.value >= (row.target ?? Number.POSITIVE_INFINITY)).length;
		items.push({ label: "At target", value: `${whole(met)} of ${plural(targeted.length, "day")}` });
	}
	return <SeriesSummary items={items} />;
}

export function Steps() {
	const [load, , reload] = useJson<StepsRow[]>("/steps");
	const [showDays, setShowDays] = useState(true);
	const [showTrend, setShowTrend] = useState(true);
	const grouping = parseGrouping(useSearchParam("group"));
	const bucketing = grouping === "day" ? null : grouping;
	const all = useMemo<StepsPoint[]>(() => (load.status === "ready" ? load.data.map((row) => ({ ...row, value: row.steps })) : []), [load]);
	const state = useSeriesRange(all);
	const range = bucketing === null ? state.range : snapRange(state.range, bucketing);
	const entries = useMemo(() => withChanges(all), [all]);
	const buckets = useMemo(() => (bucketing === null ? [] : bucketDays(all, bucketing, today())), [all, bucketing]);
	const selected = inRange(entries, range, null);
	const latest = all.at(-1);
	const series = useMemo<SeriesStyle>(() => ({ ...STEPS, detail: stepsDetail(new Map(all.map((row) => [row.date, row.target]))) }), [all]);

	const chooseGrouping = (next: Grouping) => {
		navigate(next === "day" ? window.location.pathname : `${window.location.pathname}?group=${next}`, { replace: true });
		state.resetPage();
	};
	const groupingControl = (
		<div className={styles.segmented} role="group" aria-label="Group by">
			{GROUPINGS.map((option) => (
				<Button key={option} size="sm" variant="quiet" aria-pressed={option === grouping} onClick={() => chooseGrouping(option)}>
					{GROUP_LABELS[option]}
				</Button>
			))}
		</div>
	);

	return (
		<ToolLayout title="Steps" sections={VIEWS}>
			<div className={styles.page}>
				<RangeControls state={state} />
				{bucketing === null ? (
					<AverageControls state={state} lead={groupingControl}>
						<div className={styles.segmented} role="group" aria-label="Show on chart">
							<Button size="sm" variant="quiet" aria-pressed={showTrend} onClick={() => setShowTrend(!showTrend)}>
								Trend
							</Button>
							<Button size="sm" variant="quiet" aria-pressed={showDays} onClick={() => setShowDays(!showDays)}>
								Days
							</Button>
						</div>
					</AverageControls>
				) : (
					<div className={styles.controls}>{groupingControl}</div>
				)}
				{load.status === "loading" ? (
					<Skeleton className={styles.chartSkeleton} />
				) : load.status === "error" ? (
					<div className={styles.empty}>
						<p>{load.message}</p>
						<Button onClick={reload}>Try again</Button>
					</div>
				) : latest === undefined ? (
					<p className={styles.empty}>No steps yet. Connect Withings from Settings.</p>
				) : (
					<>
						<Summary rows={selected} all={all} range={range} />
						{bucketing === null ? (
							<SeriesChart rows={selected} series={series} trend={averageTrend(state.average)} showRaw={showDays} showTrend={showTrend} onBrush={state.chooseRange} />
						) : (
							<SeriesChart rows={inRange(buckets, range, null)} series={bucketSeries(bucketing)} trend={null} showRaw showTrend={false} onBrush={state.chooseRange} />
						)}
						<p className={styles.hint}>Drag across the chart to zoom in.</p>
						{bucketing === null ? (
							<SeriesTable rows={selected} columns={seriesColumns(series, state.average)} state={state} />
						) : (
							<SeriesTable rows={inRange(buckets, range, null)} columns={bucketColumns(bucketing)} state={state} />
						)}
					</>
				)}
			</div>
		</ToolLayout>
	);
}
