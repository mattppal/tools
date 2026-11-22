import { type CSSProperties, useMemo, useState } from "react";
import { Button } from "../../src/kit/button.tsx";
import { Skeleton } from "../../src/kit/skeleton.tsx";
import { ToolLayout } from "../../src/shell/tool-layout.tsx";
import styles from "./nutrition.module.css";
import { AverageControls, RangeControls, type SeriesStyle, SeriesChart, SeriesSummary, SeriesTable, type SummaryItem, type Tint, useSeriesRange } from "./series.tsx";
import type { ExpenditureView, PhaseView } from "./store.ts";
import type { WeightRow } from "./types.ts";
import { tenths, useJson, VIEWS, whole } from "./ui.tsx";
import { type Average, changeTone, type DateRange, inRange, type SeriesRow, summarize, toneStrength, withChanges } from "./weights.ts";

const SOURCE_LABELS: Record<string, string> = { withings: "Withings", bot: "Bot", sheet: "Sheet", daily_file: "Daily file" };

const FLAT_CHANGE = 0.05;
const FLAT_RATE = 0.005;
const FULL_ENTRY_CHANGE = 2;
const FULL_RANGE_CHANGE = 3;
const FULL_WEEKLY_RATE = 1;

const WEIGHT: SeriesStyle = {
	name: "Weight",
	unit: "lb",
	raw: "points",
	empty: "No weigh-ins in this range.",
	format: tenths,
	domain: (values) => [Math.floor(Math.min(...values) - 0.5), Math.ceil(Math.max(...values) + 0.5)],
};

function tint(change: number, phaseKind: string | null, flatBelow: number, full: number): Tint {
	return { "data-tone": changeTone(change, phaseKind, flatBelow), style: { "--tone-strength": `${Math.round(toneStrength(change, full) * 100)}%` } as CSSProperties };
}

const signed = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: "exceptZero" });
const signedRate = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: "exceptZero" });
const signedTenths = (value: number) => signed.format(value).replace("-", "\u2212");
const signedHundredths = (value: number) => signedRate.format(value).replace("-", "\u2212");

function Summary({ rows, average, phaseKind, range }: { rows: SeriesRow[]; average: Average; phaseKind: string | null; range: DateRange }) {
	const summary = summarize(rows, average);
	const [energy] = useJson<ExpenditureView>(`/expenditure?from=${range.from}&to=${range.to}`);
	if (summary === null) return null;
	const spent = energy.status === "ready" ? energy.data : null;
	const items: SummaryItem[] = [
		{ label: "Start", value: `${tenths(summary.start)} lb` },
		{ label: "End", value: `${tenths(summary.end)} lb` },
		{ label: "Change", value: `${signedTenths(summary.change)} lb`, tone: tint(summary.change, phaseKind, FLAT_CHANGE, FULL_RANGE_CHANGE) },
		{ label: "Average", value: `${tenths(summary.average)} lb` },
		summary.days < 7
			? { label: "Weekly rate", value: "Under a week" }
			: { label: "Weekly rate", value: `${signedHundredths(summary.weeklyRate)} lb a week`, tone: tint(summary.weeklyRate, phaseKind, FLAT_RATE, FULL_WEEKLY_RATE) },
	];
	const energyItems: SummaryItem[] =
		spent === null
			? []
			: [
					{
						label: "Expenditure",
						value: spent.tdee === null ? "Not enough logged days" : `${whole(spent.tdee)} kcal a day`,
						note: `from ${whole(spent.loggedDays)} logged ${spent.loggedDays === 1 ? "day" : "days"}`,
					},
					...(spent.avgSteps === null ? [] : [{ label: "Steps", value: `${whole(spent.avgSteps)} a day` }]),
				];
	return (
		<>
			<SeriesSummary items={items} />
			{energyItems.length === 0 ? null : <SeriesSummary items={energyItems} />}
		</>
	);
}

export function Weight() {
	const [load, , reload] = useJson<WeightRow[]>("/weights");
	const [phase] = useJson<PhaseView>("/phase");
	const phaseKind = phase.status === "ready" ? (phase.data?.kind ?? null) : null;
	const [showPoints, setShowPoints] = useState(true);
	const [showTrend, setShowTrend] = useState(true);
	const [source, setSource] = useState<string | null>(null);

	const all = useMemo(() => (load.status === "ready" ? load.data.map((row) => ({ ...row, value: row.weight })) : []), [load]);
	const state = useSeriesRange(all);
	const entries = useMemo(() => withChanges(all), [all]);
	const sources = useMemo(() => [...new Set(all.map((row) => row.source))], [all]);
	const selected = inRange(entries, state.range, sources.length > 1 ? source : null);

	const filterSource = (next: string | null) => {
		setSource(next);
		state.resetPage();
	};

	return (
		<ToolLayout title="Weight" sections={VIEWS}>
			<div className={styles.page}>
				<RangeControls state={state} />
				<AverageControls state={state}>
					<div className={styles.segmented} role="group" aria-label="Show on chart">
						<Button size="sm" variant="quiet" aria-pressed={showTrend} onClick={() => setShowTrend(!showTrend)}>
							Trend
						</Button>
						<Button size="sm" variant="quiet" aria-pressed={showPoints} onClick={() => setShowPoints(!showPoints)}>
							Weigh-ins
						</Button>
					</div>
					{sources.length > 1 ? (
						<div className={styles.segmented} role="group" aria-label="Source">
							<Button size="sm" variant="quiet" aria-pressed={source === null} onClick={() => filterSource(null)}>
								All sources
							</Button>
							{sources.map((name) => (
								<Button key={name} size="sm" variant="quiet" aria-pressed={source === name} onClick={() => filterSource(name)}>
									{SOURCE_LABELS[name] ?? name}
								</Button>
							))}
						</div>
					) : null}
				</AverageControls>
				{load.status === "loading" ? (
					<Skeleton className={styles.chartSkeleton} />
				) : load.status === "error" ? (
					<div className={styles.empty}>
						<p>{load.message}</p>
						<Button onClick={reload}>Try again</Button>
					</div>
				) : (
					<>
						<Summary rows={selected} average={state.average} phaseKind={phaseKind} range={state.range} />
						<SeriesChart rows={selected} series={WEIGHT} average={state.average} showRaw={showPoints} showTrend={showTrend} onBrush={state.chooseRange} />
						<p className={styles.hint}>Drag across the chart to zoom in.</p>
						<SeriesTable rows={selected} series={WEIGHT} state={state} tint={(change) => tint(change, phaseKind, FLAT_CHANGE, FULL_ENTRY_CHANGE)} />
					</>
				)}
			</div>
		</ToolLayout>
	);
}
