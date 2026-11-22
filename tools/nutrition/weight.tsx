import { type CSSProperties, useMemo, useState } from "react";
import { Button } from "../../src/kit/button.tsx";
import { Skeleton } from "../../src/kit/skeleton.tsx";
import { ToolLayout } from "../../src/shell/tool-layout.tsx";
import styles from "./nutrition.module.css";
import { AverageControls, averageTrend, RangeControls, type SeriesStyle, SeriesChart, SeriesSummary, SeriesTable, seriesColumns, type SummaryItem, type Tint, useSeriesRange } from "./series.tsx";
import type { ExpenditureView, PhaseView } from "./store.ts";
import type { WeightRow } from "./types.ts";
import { dayLabel, tenths, useJson, VIEWS, whole } from "./ui.tsx";
import { type Average, changeTone, inRange, type SeriesRow, summarize, toneStrength, withChanges } from "./weights.ts";

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

const PART_LABELS: { key: keyof NonNullable<ExpenditureView["components"]>; label: string }[] = [
	{ key: "bmr", label: "Resting" },
	{ key: "living", label: "Daily living" },
	{ key: "steps", label: "Steps" },
	{ key: "training", label: "Training" },
	{ key: "tef", label: "Digesting food" },
];

const RECENT_DAYS = 28;

const capitalized = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

function shortSpan(from: string, to: string): string {
	const start = dayLabel(from, { month: "short", day: "numeric" });
	if (from === to) return start;
	if (from.slice(0, 7) === to.slice(0, 7)) return `${start}\u2013${Number(to.slice(8))}`;
	return `${start}\u2013${dayLabel(to, { month: "short", day: "numeric" })}`;
}

const MAX_LISTED_SPANS = 2;

function datedSpan(from: string, to: string): string {
	if (from.slice(0, 4) === to.slice(0, 4)) return `${shortSpan(from, to)}, ${from.slice(0, 4)}`;
	const dated = { month: "short", day: "numeric", year: "numeric" } as const;
	return `${dayLabel(from, dated)}\u2013${dayLabel(to, dated)}`;
}
function windowSource(window: ExpenditureView["scale"]["windows"][number]): string {
	if (window.kind === "tracker") return "Tracker export";
	return window.source === "logged" ? "Logged intake" : `${window.source} intake`;
}
function calibrationSpans(spent: ExpenditureView): string {
	const spans = [...new Set(spent.scale.windows.map((window) => shortSpan(window.from, window.to)))];
	if (spans.length <= MAX_LISTED_SPANS) return spans.join(", ");
	const years = spent.scale.windows.map((window) => window.from.slice(0, 4)).toSorted();
	const first = years[0];
	const last = years.at(-1);
	return `${whole(spent.scale.windows.length)} windows, ${first === last ? first : `${first}\u2013${last}`}`;
}

function margin(spent: ExpenditureView): string | undefined {
	return spent.plusMinus === null ? undefined : `\u00b1 ${whole(spent.plusMinus)}`;
}

function calibrationSentence(spent: ExpenditureView): string {
	if (new Set(spent.scale.windows.map((window) => shortSpan(window.from, window.to))).size > MAX_LISTED_SPANS) {
		return `Scaled by ${spent.scale.value} \u00b1 ${spent.scale.sd} to match ${whole(spent.scale.windows.length)} windows of intake against weight change and tracker exports. Windows further from this range count less.`;
	}
	const spans = new Set(spent.scale.windows.map((window) => shortSpan(window.from, window.to)));
	const clauses = spent.scale.windows.map((window) => {
		const source = window.kind === "logged" ? "logged intake and weight change gave" : "the tracker's export gave";
		const span = spans.size === 1 ? "" : ` for ${shortSpan(window.from, window.to)}`;
		return `${source} ${whole(window.tdee)} \u00b1 ${whole(window.plusMinus)}${span}`;
	});
	const lead = spans.size === 1 ? `On ${calibrationSpans(spent)}, ` : "";
	const joined = clauses.length > 1 ? `${clauses.slice(0, -1).join(", ")} and ${clauses.at(-1)}` : (clauses[0] ?? "");
	return `${capitalized(`${lead}${joined}.`)} The estimate is scaled by ${spent.scale.value} to match.`;
}

function dayDetail(day: ExpenditureView["days"][number]): string {
	const steps = day.stepsFrom === "active energy" ? "Active energy" : day.stepCount === null ? null : `${whole(day.stepCount)} steps`;
	const parts = [steps, ...day.sessions.map((item) => `${capitalized(item.name)} ${whole(item.kcal)}`)];
	if (day.intake !== null) parts.push(`ate ${whole(day.intake)}`);
	return parts.filter((part) => part !== null).join(" \u00b7 ");
}

function ExpenditurePanel({ spent }: { spent: ExpenditureView }) {
	const [showAll, setShowAll] = useState(false);
	const newest = spent.days.toReversed();
	const days = showAll ? newest : newest.slice(0, RECENT_DAYS);
	const method = newest[0]?.bmrMethod === "katch-mcardle" ? "from fat-free mass" : "from weight, height, and age";
	if (spent.tdee === null || spent.components === null) return null;
	const components = spent.components;
	return (
		<div className={styles.spent}>
			<div>
				<p className={styles.spentValue}>
					{whole(spent.tdee)} <span className={styles.spentUnit}>kcal a day</span>
				</p>
				{spent.plusMinus === null ? null : <p className={styles.spentNote}>{margin(spent)}</p>}
			</div>
			<p className={styles.spentBasis}>
				{spent.basis === "calibrated"
					? calibrationSentence(spent)
					: "Nothing to calibrate against yet. Seven fully logged days with five weigh-ins will calibrate it."}
				{spent.measured === null ? null : ` Logged intake and weight change alone give ${whole(spent.measured.tdee)} \u00b1 ${whole(spent.measured.plusMinus)} over ${whole(spent.measured.loggedDays)} days.`}
			</p>
			<dl className={styles.spentParts}>
				{PART_LABELS.map((part) => (
					<div key={part.key} className={styles.spentPart}>
						<dt>{part.key === "bmr" ? `Resting, ${method}` : part.label}</dt>
						<dd>{whole(components[part.key])}</dd>
						<div className={styles.track} aria-hidden="true">
							<div className={styles.spentFill} style={{ transform: `scaleX(${Math.min(components[part.key] / (spent.tdee ?? 1), 1)})` }} />
						</div>
					</div>
				))}
			</dl>
			{spent.scale.windows.length > MAX_LISTED_SPANS ? (
				<section className={styles.spentDays} aria-label="Calibration windows">
					<h2 className={styles.spentHeading}>Calibration</h2>
					<ol>
						{spent.scale.windows.toReversed().map((window) => (
							<li key={`${window.kind}-${window.from}`}>
								<div className={styles.spentDayTop}>
									<span>{datedSpan(window.from, window.to)}</span>
									<span className={styles.spentDayTotal}>
										{`${whole(window.tdee)} \u00b1 ${whole(window.plusMinus)}`}
									</span>
								</div>
								<p className={styles.spentNote}>
									{`${windowSource(window)} \u00b7 ${whole(window.days)} days \u00b7 scale ${window.scale} \u00b7 ${Math.round(window.weight * 100)}% of the fit`}
								</p>
							</li>
						))}
					</ol>
				</section>
			) : null}
			<section className={styles.spentDays} aria-label="Each day">
				<h2 className={styles.spentHeading}>Each day</h2>
				<ol>
					{days.map((day) => (
						<li key={day.date}>
							<div className={styles.spentDayTop}>
								<span>{dayLabel(day.date)}</span>
								<span className={styles.spentDayTotal}>{whole(day.total)}</span>
							</div>
							<p className={styles.spentNote}>{dayDetail(day)}</p>
						</li>
					))}
				</ol>
				{newest.length > RECENT_DAYS ? (
					<Button size="sm" variant="quiet" onClick={() => setShowAll(!showAll)}>
						{showAll ? `Show the last ${RECENT_DAYS} days` : `Show all ${whole(newest.length)} days`}
					</Button>
				) : null}
			</section>
		</div>
	);
}

function Summary({ rows, average, phaseKind, spent, onBreakdown }: { rows: SeriesRow[]; average: Average; phaseKind: string | null; spent: ExpenditureView | null; onBreakdown: () => void }) {
	const summary = summarize(rows, average);
	if (summary === null) return null;
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
					spent.tdee === null
						? { label: "Expenditure", value: "No recent weigh-ins" }
						: { label: "Expenditure", value: `${whole(spent.tdee)} kcal a day`, note: margin(spent), onClick: onBreakdown },
					...(spent.measured === null
						? []
						: [{ label: "Measured", value: `${whole(spent.measured.tdee)} kcal a day`, note: `\u00b1 ${whole(spent.measured.plusMinus)}` }]),
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
	const [energy] = useJson<ExpenditureView>(`/expenditure?from=${state.range.from}&to=${state.range.to}`);
	const spent = energy.status === "ready" ? energy.data : null;
	const [breakdownOpen, setBreakdownOpen] = useState(false);

	const filterSource = (next: string | null) => {
		setSource(next);
		state.resetPage();
	};

	return (
		<ToolLayout
			title="Weight"
			sections={VIEWS}
			panel={spent === null || spent.tdee === null ? undefined : { label: "Expenditure", open: breakdownOpen, onOpenChange: setBreakdownOpen, content: <ExpenditurePanel spent={spent} /> }}
		>
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
						<Summary rows={selected} average={state.average} phaseKind={phaseKind} spent={spent} onBreakdown={() => setBreakdownOpen(true)} />
						<SeriesChart rows={selected} series={WEIGHT} trend={averageTrend(state.average)} showRaw={showPoints} showTrend={showTrend} onBrush={state.chooseRange} />
						<p className={styles.hint}>Drag across the chart to zoom in.</p>
						<SeriesTable rows={selected} columns={seriesColumns(WEIGHT, state.average, (change) => tint(change, phaseKind, FLAT_CHANGE, FULL_ENTRY_CHANGE))} state={state} />
					</>
				)}
			</div>
		</ToolLayout>
	);
}
