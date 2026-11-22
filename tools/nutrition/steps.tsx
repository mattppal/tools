import { type CSSProperties, useMemo, useState } from "react";
import { Button } from "../../src/kit/button.tsx";
import { Skeleton } from "../../src/kit/skeleton.tsx";
import { ToolLayout } from "../../src/shell/tool-layout.tsx";
import styles from "./nutrition.module.css";
import { AverageControls, longDate, RangeControls, type SeriesStyle, SeriesChart, SeriesSummary, SeriesTable, type SummaryItem, useSeriesRange } from "./series.tsx";
import type { StepsRow } from "./types.ts";
import { useJson, VIEWS, whole } from "./ui.tsx";
import { changeTone, type DateRange, inRange, previousRange, type SeriesRow, toneStrength, withChanges } from "./weights.ts";

const STEP_TICK = 2000;
const FLAT_SHARE = 0.02;
const FULL_SHARE = 0.25;

const STEPS: SeriesStyle = {
	name: "Steps",
	unit: "steps",
	raw: "bars",
	empty: "No steps in this range.",
	format: whole,
	domain: (values) => [0, Math.max(Math.ceil(Math.max(...values) / STEP_TICK) * STEP_TICK, STEP_TICK)],
};

function stepsDetail(targets: Map<string, number | null>) {
	return (row: SeriesRow): string[] => {
		const target = targets.get(row.date) ?? null;
		return [
			longDate(row.date),
			`${whole(row.value)} steps`,
			target === null ? "No target that day" : row.value >= target ? `Met the ${whole(target)} target` : `${whole(target - row.value)} short of ${whole(target)}`,
		];
	};
}

type StepsPoint = SeriesRow & { target: number | null };

const mean = (rows: SeriesRow[]) => (rows.length === 0 ? null : rows.reduce((sum, row) => sum + row.value, 0) / rows.length);

function Summary({ rows, all, range }: { rows: StepsPoint[]; all: StepsPoint[]; range: DateRange }) {
	const average = mean(rows);
	if (average === null) return null;
	const before = mean(inRange(all, previousRange(range), null));
	const targeted = rows.filter((row) => row.target !== null);
	const items: SummaryItem[] = [
		{ label: "Average", value: `${whole(average)} a day`, note: `over ${whole(rows.length)} ${rows.length === 1 ? "day" : "days"}` },
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
		items.push({ label: "At target", value: `${whole(met)} of ${whole(targeted.length)} days` });
	}
	return <SeriesSummary items={items} />;
}

export function Steps() {
	const [load, , reload] = useJson<StepsRow[]>("/steps");
	const [showDays, setShowDays] = useState(true);
	const [showTrend, setShowTrend] = useState(true);
	const all = useMemo<StepsPoint[]>(() => (load.status === "ready" ? load.data.map((row) => ({ ...row, value: row.steps })) : []), [load]);
	const state = useSeriesRange(all);
	const entries = useMemo(() => withChanges(all), [all]);
	const selected = inRange(entries, state.range, null);
	const latest = all.at(-1);
	const series = useMemo<SeriesStyle>(() => ({ ...STEPS, detail: stepsDetail(new Map(all.map((row) => [row.date, row.target]))) }), [all]);

	return (
		<ToolLayout title="Steps" sections={VIEWS}>
			<div className={styles.page}>
				<RangeControls state={state} />
				<AverageControls state={state}>
					<div className={styles.segmented} role="group" aria-label="Show on chart">
						<Button size="sm" variant="quiet" aria-pressed={showTrend} onClick={() => setShowTrend(!showTrend)}>
							Trend
						</Button>
						<Button size="sm" variant="quiet" aria-pressed={showDays} onClick={() => setShowDays(!showDays)}>
							Days
						</Button>
					</div>
				</AverageControls>
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
						<Summary rows={selected} all={all} range={state.range} />
						<SeriesChart rows={selected} series={series} average={state.average} showRaw={showDays} showTrend={showTrend} onBrush={state.chooseRange} />
						<p className={styles.hint}>Drag across the chart to zoom in.</p>
						<SeriesTable rows={selected} series={series} state={state} />
					</>
				)}
			</div>
		</ToolLayout>
	);
}
