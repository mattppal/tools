import { type CSSProperties, type PointerEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../src/kit/button.tsx";
import { Input } from "../../src/kit/input.tsx";
import { Skeleton } from "../../src/kit/skeleton.tsx";
import { ToolLayout } from "../../src/shell/tool-layout.tsx";
import { addDays, dayNumber, isIsoDate, isoDate, today } from "./dates.ts";
import styles from "./nutrition.module.css";
import type { WeightRow } from "./types.ts";
import { dayLabel, tenths, useJson, VIEWS, whole } from "./ui.tsx";
import type { PhaseView } from "./store.ts";
import { type Average, changeTone, type DateRange, inRange, nearestIndex, type Tone, toneStrength, type Preset, presetRange, type Sort, type SortKey, sortEntries, summarize, type WeightEntry, withChanges } from "./weights.ts";

const PRESETS: { id: Preset; label: string }[] = [
	{ id: "90d", label: "90 days" },
	{ id: "1y", label: "1 year" },
	{ id: "all", label: "All" },
];

const AVERAGES: { id: Average; label: string }[] = [
	{ id: "rolling7d", label: "7-day" },
	{ id: "rolling14d", label: "14-day" },
	{ id: "rolling28d", label: "28-day" },
];

const averageLabel = (average: Average) => AVERAGES.find((option) => option.id === average)?.label ?? "";

const SOURCE_LABELS: Record<string, string> = { withings: "Withings", bot: "Bot", sheet: "Sheet", daily_file: "Daily file" };

const COLUMNS: { key: SortKey; label: string }[] = [
	{ key: "date", label: "Date" },
	{ key: "weight", label: "Weight" },
	{ key: "average", label: "Average" },
	{ key: "change", label: "Change" },
];

const PAGE_SIZE = 50;
const HEIGHT = 280;
const PAD = { top: 12, right: 8, bottom: 24, left: 40 };
const MIN_BRUSH_PX = 8;
const LABEL_GAP = 13;
const FLAT_CHANGE = 0.05;
const FLAT_RATE = 0.005;
const FULL_ENTRY_CHANGE = 2;
const FULL_RANGE_CHANGE = 3;
const FULL_WEEKLY_RATE = 1;

function tint(change: number, phaseKind: string | null, flatBelow: number, full: number): { "data-tone": Tone; style: CSSProperties } {
	return { "data-tone": changeTone(change, phaseKind, flatBelow), style: { "--tone-strength": `${Math.round(toneStrength(change, full) * 100)}%` } as CSSProperties };
}
const DATE_HALF_WIDTH = 40;

const signed = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: "exceptZero" });
const signedRate = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: "exceptZero" });
const signedTenths = (value: number) => signed.format(value).replace("-", "\u2212");
const signedHundredths = (value: number) => signedRate.format(value).replace("-", "\u2212");
const longDate = (date: string) => dayLabel(date, { month: "short", day: "numeric", year: "numeric" });

function useWidth() {
	const ref = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		const node = ref.current;
		if (node === null) return;
		setWidth(node.getBoundingClientRect().width);
		const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
		observer.observe(node);
		return () => observer.disconnect();
	}, []);
	return [ref, width] as const;
}

type ChartProps = { rows: WeightRow[]; average: Average; showPoints: boolean; showTrend: boolean; onBrush: (range: DateRange) => void };

function Chart({ rows, average, showPoints, showTrend, onBrush }: ChartProps) {
	const [ref, width] = useWidth();
	const [brush, setBrush] = useState<{ start: number; end: number } | null>(null);
	const [hover, setHover] = useState<number | null>(null);
	const first = rows[0];
	const last = rows.at(-1);
	if (first === undefined || last === undefined) return <p className={styles.empty}>No weigh-ins in this range.</p>;
	const startDay = dayNumber(first.date);
	const span = Math.max(dayNumber(last.date) - startDay, 1);
	const inner = width - PAD.left - PAD.right;
	const values = rows.flatMap((row) => (showPoints ? [row.weight, row[average]] : [row[average]]));
	const low = Math.floor(Math.min(...values) - 0.5);
	const high = Math.ceil(Math.max(...values) + 0.5);
	const x = (date: string) => PAD.left + ((dayNumber(date) - startDay) / span) * inner;
	const y = (value: number) => PAD.top + ((high - value) / (high - low)) * (HEIGHT - PAD.top - PAD.bottom);
	const dateAt = (px: number) => isoDate(startDay + Math.round((Math.min(Math.max(px - PAD.left, 0), inner) / inner) * span));
	const line = rows.map((row, index) => `${index === 0 ? "M" : "L"}${x(row.date).toFixed(1)},${y(row[average]).toFixed(1)}`).join("");
	const bottom = HEIGHT - PAD.bottom;
	const ticks = [low, (low + high) / 2, high];
	const local = (event: PointerEvent<SVGSVGElement>) => event.clientX - event.currentTarget.getBoundingClientRect().left;

	const snap = (px: number) => setHover(nearestIndex(rows, startDay + ((px - PAD.left) / inner) * span));

	const begin = (event: PointerEvent<SVGSVGElement>) => {
		if (event.pointerType === "touch") {
			snap(local(event));
			return;
		}
		if (event.button !== 0 || span < 2) return;
		event.currentTarget.setPointerCapture(event.pointerId);
		const at = local(event);
		setBrush({ start: at, end: at });
		setHover(null);
	};
	const move = (event: PointerEvent<SVGSVGElement>) => {
		if (brush !== null) setBrush({ ...brush, end: local(event) });
		else snap(local(event));
	};
	const leave = (event: PointerEvent<SVGSVGElement>) => {
		if (event.pointerType !== "touch") setHover(null);
	};
	const hovered = hover === null || brush !== null ? undefined : rows[hover];
	const hoverX = hovered === undefined ? 0 : x(hovered.date);
	const weightY = hovered === undefined ? 0 : y(hovered.weight);
	const trendY = hovered === undefined ? 0 : y(hovered[average]);
	const trendLabelY = Math.abs(trendY - weightY) >= LABEL_GAP ? trendY : weightY + (trendY >= weightY ? LABEL_GAP : -LABEL_GAP);
	const clearOf = (tickY: number) => hovered === undefined || (Math.abs(tickY - weightY) >= LABEL_GAP && Math.abs(tickY - trendLabelY) >= LABEL_GAP);
	const finish = () => {
		if (brush === null) return;
		setBrush(null);
		if (Math.abs(brush.end - brush.start) < MIN_BRUSH_PX) return;
		const from = dateAt(Math.min(brush.start, brush.end));
		const to = dateAt(Math.max(brush.start, brush.end));
		if (from < to) onBrush({ from, to });
	};

	return (
		<div ref={ref} className={styles.chart}>
			{width === 0 ? null : (
				<svg
					width={width}
					height={HEIGHT}
					role="img"
					aria-label={`Weight from ${longDate(first.date)} to ${longDate(last.date)}, latest ${averageLabel(average)} average ${tenths(last[average])} lb`}
					onPointerDown={begin}
					onPointerMove={move}
					onPointerUp={finish}
					onPointerLeave={leave}
					onPointerCancel={() => setBrush(null)}
				>
					{ticks.map((tick) => (
						<g key={tick}>
							<line x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} className={styles.gridLine} />
							{clearOf(y(tick)) ? (
								<text x={PAD.left - 6} y={y(tick)} className={styles.axis} textAnchor="end" dominantBaseline="middle">
									{tenths(tick)}
								</text>
							) : null}
						</g>
					))}
					{hovered === undefined ? (
						<>
							<text x={PAD.left} y={HEIGHT - 6} className={styles.axis}>
								{longDate(first.date)}
							</text>
							<text x={width - PAD.right} y={HEIGHT - 6} className={styles.axis} textAnchor="end">
								{longDate(last.date)}
							</text>
						</>
					) : null}
					{showPoints ? rows.map((row) => <circle key={row.date} cx={x(row.date)} cy={y(row.weight)} r={rows.length > 400 ? 1 : 1.75} className={styles.point} />) : null}
					{showTrend ? <path d={line} className={styles.trend} /> : null}
					{hovered === undefined ? null : (
						<g>
							<line x1={hoverX} x2={hoverX} y1={PAD.top} y2={bottom} className={styles.crosshair} />
							<line x1={PAD.left} x2={width - PAD.right} y1={weightY} y2={weightY} className={styles.crosshair} />
							<circle cx={hoverX} cy={weightY} r={3} className={styles.hoverWeight} />
							<circle cx={hoverX} cy={trendY} r={3} className={styles.hoverTrend} />
							<text x={PAD.left - 6} y={weightY} className={styles.axisWeight} textAnchor="end" dominantBaseline="middle">
								{tenths(hovered.weight)}
							</text>
							<text x={PAD.left - 6} y={trendLabelY} className={styles.axisTrend} textAnchor="end" dominantBaseline="middle">
								{tenths(hovered[average])}
							</text>
							<text x={Math.min(Math.max(hoverX, PAD.left + DATE_HALF_WIDTH), width - PAD.right - DATE_HALF_WIDTH)} y={HEIGHT - 6} className={styles.axisWeight} textAnchor="middle">
								{longDate(hovered.date)}
							</text>
						</g>
					)}
					{brush === null ? null : (
						<rect x={Math.min(brush.start, brush.end)} y={PAD.top} width={Math.abs(brush.end - brush.start)} height={bottom - PAD.top} className={styles.brush} />
					)}
				</svg>
			)}
		</div>
	);
}

function Summary({ rows, average, phaseKind }: { rows: WeightRow[]; average: Average; phaseKind: string | null }) {
	const summary = summarize(rows, average);
	if (summary === null) return null;
	const items: { label: string; value: string; tone?: ReturnType<typeof tint> }[] = [
		{ label: "Start", value: `${tenths(summary.start)} lb` },
		{ label: "End", value: `${tenths(summary.end)} lb` },
		{ label: "Change", value: `${signedTenths(summary.change)} lb`, tone: tint(summary.change, phaseKind, FLAT_CHANGE, FULL_RANGE_CHANGE) },
		{ label: "Average", value: `${tenths(summary.average)} lb` },
		summary.days < 7
			? { label: "Weekly rate", value: "Under a week" }
			: { label: "Weekly rate", value: `${signedHundredths(summary.weeklyRate)} lb a week`, tone: tint(summary.weeklyRate, phaseKind, FLAT_RATE, FULL_WEEKLY_RATE) },
	];
	return (
		<dl className={styles.summary}>
			{items.map((item) => (
				<div key={item.label}>
					<dt>{item.label}</dt>
					<dd {...item.tone}>{item.value}</dd>
				</div>
			))}
		</dl>
	);
}

type TableProps = { rows: WeightEntry[]; average: Average; phaseKind: string | null; sort: Sort; onSort: (key: SortKey) => void; page: number; onPage: (page: number) => void };

function WeightTable({ rows, average, phaseKind, sort, onSort, page, onPage }: TableProps) {
	const pages = Math.max(Math.ceil(rows.length / PAGE_SIZE), 1);
	const current = Math.min(page, pages - 1);
	const visible = sortEntries(rows, sort, average).slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
	const label = averageLabel(average);
	if (rows.length === 0) return null;
	return (
		<div className={styles.weightTable}>
			<table className={styles.table}>
				<thead>
					<tr>
						{COLUMNS.map((column) => (
							<th key={column.key} aria-sort={sort.key === column.key ? (sort.descending ? "descending" : "ascending") : undefined}>
								<button type="button" className={styles.sortButton} onClick={() => onSort(column.key)}>
									{column.key === "average" ? label : column.label}
									<span className={styles.sortMark} aria-hidden="true">
										{sort.key === column.key ? (sort.descending ? "\u2193" : "\u2191") : ""}
									</span>
								</button>
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{visible.map((row) => (
						<tr key={row.date}>
							<td>{longDate(row.date)}</td>
							<td className={styles.weightCell}>{tenths(row.weight)}</td>
							<td data-label={label}>{tenths(row[average])}</td>
							<td data-label="Change">{row.change === null ? "" : <span {...tint(row.change, phaseKind, FLAT_CHANGE, FULL_ENTRY_CHANGE)}>{signedTenths(row.change)}</span>}</td>
						</tr>
					))}
				</tbody>
			</table>
			<div className={styles.pager}>
				<span className={styles.entryMeta}>
					{whole(current * PAGE_SIZE + 1)}–{whole(current * PAGE_SIZE + visible.length)} of {whole(rows.length)}
				</span>
				<div className={styles.segmented}>
					<Button size="sm" variant="quiet" disabled={current === 0} onClick={() => onPage(current - 1)}>
						Previous
					</Button>
					<Button size="sm" variant="quiet" disabled={current >= pages - 1} onClick={() => onPage(current + 1)}>
						Next
					</Button>
				</div>
			</div>
		</div>
	);
}

type Selection = { preset: Preset | null; range: DateRange | null };

export function Weight() {
	const [load, , reload] = useJson<WeightRow[]>("/weights");
	const [phase] = useJson<PhaseView>("/phase");
	const phaseKind = phase.status === "ready" ? (phase.data?.kind ?? null) : null;
	const [selection, setSelection] = useState<Selection>({ preset: "90d", range: null });
	const [average, setAverage] = useState<Average>("rolling7d");
	const [showPoints, setShowPoints] = useState(true);
	const [showTrend, setShowTrend] = useState(true);
	const [source, setSource] = useState<string | null>(null);
	const [sort, setSort] = useState<Sort>({ key: "date", descending: true });
	const [page, setPage] = useState(0);

	const all = useMemo(() => (load.status === "ready" ? load.data : []), [load]);
	const entries = useMemo(() => withChanges(all), [all]);
	const sources = useMemo(() => [...new Set(all.map((row) => row.source))], [all]);
	const range = selection.preset === null && selection.range !== null ? selection.range : presetRange(selection.preset ?? "90d", all, today());
	const selected = inRange(entries, range, sources.length > 1 ? source : null);

	const choose = (next: Selection) => {
		setSelection(next);
		setPage(0);
	};
	const setDate = (edge: "from" | "to", value: string) => {
		if (!isIsoDate(value)) return;
		const next = { ...range, [edge]: value };
		choose({ preset: null, range: next.from <= next.to ? next : { from: next.to, to: next.from } });
	};
	const filterSource = (next: string | null) => {
		setSource(next);
		setPage(0);
	};
	const sortBy = (key: SortKey) => {
		setSort((current) => (current.key === key ? { key, descending: !current.descending } : { key, descending: key === "date" }));
		setPage(0);
	};
	const first = all[0]?.date;

	return (
		<ToolLayout title="Weight" sections={VIEWS}>
			<div className={styles.page}>
				<div className={styles.controls}>
					<div className={styles.segmented} role="group" aria-label="Range">
						{PRESETS.map((option) => (
							<Button key={option.id} size="sm" variant="quiet" aria-pressed={option.id === selection.preset} onClick={() => choose({ preset: option.id, range: null })}>
								{option.label}
							</Button>
						))}
					</div>
					<div className={styles.dates}>
						<label className={styles.dateField}>
							<span>From</span>
							<Input size="sm" type="date" value={range.from} min={first} max={range.to} onChange={(event) => setDate("from", event.target.value)} />
						</label>
						<label className={styles.dateField}>
							<span>To</span>
							<Input size="sm" type="date" value={range.to} min={range.from} max={addDays(today(), 1)} onChange={(event) => setDate("to", event.target.value)} />
						</label>
					</div>
				</div>
				<div className={styles.controls}>
					<div className={styles.segmented} role="group" aria-label="Average">
						{AVERAGES.map((option) => (
							<Button key={option.id} size="sm" variant="quiet" aria-pressed={option.id === average} onClick={() => setAverage(option.id)}>
								{option.label}
							</Button>
						))}
					</div>
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
				</div>
				{load.status === "loading" ? (
					<Skeleton className={styles.chartSkeleton} />
				) : load.status === "error" ? (
					<div className={styles.empty}>
						<p>{load.message}</p>
						<Button onClick={reload}>Try again</Button>
					</div>
				) : (
					<>
						<Summary rows={selected} average={average} phaseKind={phaseKind} />
						<Chart rows={selected} average={average} showPoints={showPoints} showTrend={showTrend} onBrush={(next) => choose({ preset: null, range: next })} />
						<p className={styles.hint}>Drag across the chart to zoom in.</p>
						<WeightTable rows={selected} average={average} phaseKind={phaseKind} sort={sort} onSort={sortBy} page={page} onPage={setPage} />
					</>
				)}
			</div>
		</ToolLayout>
	);
}
