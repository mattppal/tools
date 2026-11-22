import { type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../src/kit/button.tsx";
import { Input } from "../../src/kit/input.tsx";
import { addDays, dayNumber, isIsoDate, isoDate, today } from "./dates.ts";
import styles from "./nutrition.module.css";
import { dayLabel, whole } from "./ui.tsx";
import { type Average, type DateRange, nearestIndex, type Preset, presetRange, type SeriesEntry, type SeriesRow, type Sort, type SortKey, sortEntries, type Tone } from "./weights.ts";

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

export const averageLabel = (average: Average) => AVERAGES.find((option) => option.id === average)?.label ?? "";

export const longDate = (date: string) => dayLabel(date, { month: "short", day: "numeric", year: "numeric" });

export type Tint = { "data-tone": Tone; style: CSSProperties };

const PAGE_SIZE = 50;
const HEIGHT = 280;
const PAD = { top: 12, right: 8, bottom: 24, left: 40 };
const MIN_BRUSH_PX = 8;
const LABEL_GAP = 13;
const DATE_HALF_WIDTH = 40;
const BAR_SHARE = 0.7;

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

type Selection = { preset: Preset | null; range: DateRange | null };

export function useSeriesRange(rows: { date: string }[]) {
	const [selection, setSelection] = useState<Selection>({ preset: "90d", range: null });
	const [average, setAverage] = useState<Average>("rolling7d");
	const [sort, setSort] = useState<Sort>({ key: "date", descending: true });
	const [page, setPage] = useState(0);
	const range = selection.preset === null && selection.range !== null ? selection.range : presetRange(selection.preset ?? "90d", rows, today());
	const choose = (next: Selection) => {
		setSelection(next);
		setPage(0);
	};
	return {
		preset: selection.preset,
		range,
		first: rows[0]?.date,
		average,
		setAverage,
		sort,
		page,
		setPage,
		choosePreset: (preset: Preset) => choose({ preset, range: null }),
		chooseRange: (next: DateRange) => choose({ preset: null, range: next }),
		resetPage: () => setPage(0),
		sortBy: (key: SortKey) => {
			setSort((current) => (current.key === key ? { key, descending: !current.descending } : { key, descending: key === "date" }));
			setPage(0);
		},
	};
}

export type SeriesRange = ReturnType<typeof useSeriesRange>;

export function RangeControls({ state }: { state: SeriesRange }) {
	const { range, first } = state;
	const setDate = (edge: "from" | "to", value: string) => {
		if (!isIsoDate(value)) return;
		const next = { ...range, [edge]: value };
		state.chooseRange(next.from <= next.to ? next : { from: next.to, to: next.from });
	};
	return (
		<div className={styles.controls}>
			<div className={styles.segmented} role="group" aria-label="Range">
				{PRESETS.map((option) => (
					<Button key={option.id} size="sm" variant="quiet" aria-pressed={option.id === state.preset} onClick={() => state.choosePreset(option.id)}>
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
	);
}

export function AverageControls({ state, children }: { state: SeriesRange; children?: ReactNode }) {
	return (
		<div className={styles.controls}>
			<div className={styles.segmented} role="group" aria-label="Average">
				{AVERAGES.map((option) => (
					<Button key={option.id} size="sm" variant="quiet" aria-pressed={option.id === state.average} onClick={() => state.setAverage(option.id)}>
						{option.label}
					</Button>
				))}
			</div>
			{children}
		</div>
	);
}

export type SeriesStyle = {
	name: string;
	unit: string;
	raw: "points" | "bars";
	empty: string;
	format: (value: number) => string;
	domain: (values: number[]) => [low: number, high: number];
	detail?: (row: SeriesRow) => string[];
};

const STEP_KEYS: Record<string, (index: number, last: number) => number> = {
	ArrowLeft: (index) => index - 1,
	ArrowRight: (index) => index + 1,
	PageUp: (index) => index - 7,
	PageDown: (index) => index + 7,
	Home: () => 0,
	End: (_, last) => last,
};
const TIP_HALF_WIDTH = 88;

type ChartProps = { rows: SeriesRow[]; series: SeriesStyle; average: Average; showRaw: boolean; showTrend: boolean; onBrush: (range: DateRange) => void };

export function SeriesChart({ rows, series, average, showRaw, showTrend, onBrush }: ChartProps) {
	const [ref, width] = useWidth();
	const [brush, setBrush] = useState<{ start: number; end: number } | null>(null);
	const [hover, setHover] = useState<number | null>(null);
	const first = rows[0];
	const last = rows.at(-1);
	if (first === undefined || last === undefined) return <p className={styles.empty}>{series.empty}</p>;
	const edge = series.raw === "bars" ? 0.5 : 0;
	const startDay = dayNumber(first.date) - edge;
	const span = Math.max(dayNumber(last.date) + edge - startDay, 1);
	const inner = width - PAD.left - PAD.right;
	const [low, high] = series.domain(rows.flatMap((row) => (showRaw ? [row.value, row[average]] : [row[average]])));
	const x = (date: string) => PAD.left + ((dayNumber(date) - startDay) / span) * inner;
	const y = (value: number) => PAD.top + ((high - value) / (high - low)) * (HEIGHT - PAD.top - PAD.bottom);
	const dateAt = (px: number) => isoDate(Math.round(startDay + (Math.min(Math.max(px - PAD.left, 0), inner) / inner) * span));
	const line = rows.map((row, index) => `${index === 0 ? "M" : "L"}${x(row.date).toFixed(1)},${y(row[average]).toFixed(1)}`).join("");
	const bottom = HEIGHT - PAD.bottom;
	const barWidth = Math.max((inner / span) * BAR_SHARE, 1);
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
	const valueY = hovered === undefined ? 0 : y(hovered.value);
	const trendY = hovered === undefined ? 0 : y(hovered[average]);
	const trendLabelY = Math.abs(trendY - valueY) >= LABEL_GAP ? trendY : valueY + (trendY >= valueY ? LABEL_GAP : -LABEL_GAP);
	const clearOf = (tickY: number) => hovered === undefined || (Math.abs(tickY - valueY) >= LABEL_GAP && Math.abs(tickY - trendLabelY) >= LABEL_GAP);
	const unit = series.unit === "" ? "" : ` ${series.unit}`;
	const keyDown = (event: KeyboardEvent<SVGSVGElement>) => {
		const step = STEP_KEYS[event.key];
		if (event.key === "Escape") setHover(null);
		if (step === undefined) return;
		event.preventDefault();
		const last = rows.length - 1;
		setHover(Math.min(Math.max(step(hover ?? last, last), 0), last));
	};
	const tipLines = hovered === undefined ? [] : (series.detail?.(hovered) ?? []);
	const readout = hovered === undefined ? "" : `${longDate(hovered.date)}, ${series.format(hovered.value)}${unit}, ${averageLabel(average)} average ${series.format(hovered[average])}`;
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
					aria-label={`${series.name} from ${longDate(first.date)} to ${longDate(last.date)}, latest ${averageLabel(average)} average ${series.format(last[average])}${unit}`}
					onPointerDown={begin}
					onPointerMove={move}
					onPointerUp={finish}
					onPointerLeave={leave}
					onPointerCancel={() => setBrush(null)}
					tabIndex={0}
					onFocus={() => setHover((current) => current ?? rows.length - 1)}
					onBlur={() => setHover(null)}
					onKeyDown={keyDown}
				>
					{ticks.map((tick) => (
						<g key={tick}>
							<line x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} className={styles.gridLine} />
							{clearOf(y(tick)) ? (
								<text x={PAD.left - 6} y={y(tick)} className={styles.axis} textAnchor="end" dominantBaseline="middle">
									{series.format(tick)}
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
					{showRaw && series.raw === "points"
						? rows.map((row) => <circle key={row.date} cx={x(row.date)} cy={y(row.value)} r={rows.length > 400 ? 1 : 1.75} className={styles.point} />)
						: null}
					{showRaw && series.raw === "bars"
						? rows.map((row) => (
								<rect
									key={row.date}
									x={x(row.date) - barWidth / 2}
									y={y(row.value)}
									width={barWidth}
									height={Math.max(bottom - y(row.value), 0)}
									className={styles.dayBar}
									data-hovered={row === hovered ? "" : undefined}
								/>
							))
						: null}
					{showTrend ? <path d={line} className={styles.trend} /> : null}
					{hovered === undefined ? null : (
						<g>
							<line x1={hoverX} x2={hoverX} y1={PAD.top} y2={bottom} className={styles.crosshair} />
							<line x1={PAD.left} x2={width - PAD.right} y1={valueY} y2={valueY} className={styles.crosshair} />
							{series.raw === "points" ? <circle cx={hoverX} cy={valueY} r={3} className={styles.hoverValue} /> : null}
							<circle cx={hoverX} cy={trendY} r={3} className={styles.hoverTrend} />
							<text x={PAD.left - 6} y={valueY} className={styles.axisValue} textAnchor="end" dominantBaseline="middle">
								{series.format(hovered.value)}
							</text>
							<text x={PAD.left - 6} y={trendLabelY} className={styles.axisTrend} textAnchor="end" dominantBaseline="middle">
								{series.format(hovered[average])}
							</text>
							<text x={Math.min(Math.max(hoverX, PAD.left + DATE_HALF_WIDTH), width - PAD.right - DATE_HALF_WIDTH)} y={HEIGHT - 6} className={styles.axisValue} textAnchor="middle">
								{longDate(hovered.date)}
							</text>
						</g>
					)}
					{brush === null ? null : (
						<rect x={Math.min(brush.start, brush.end)} y={PAD.top} width={Math.abs(brush.end - brush.start)} height={bottom - PAD.top} className={styles.brush} />
					)}
				</svg>
			)}
			{tipLines.length === 0 || hovered === undefined ? null : (
				<div className={styles.chartTip} style={{ left: Math.min(Math.max(hoverX, TIP_HALF_WIDTH), width - TIP_HALF_WIDTH) }} aria-hidden="true">
					{tipLines.map((line, index) => (
						<span key={line} className={index === 0 ? styles.tipHead : undefined}>
							{line}
						</span>
					))}
				</div>
			)}
			<p className="sr-only" aria-live="polite">
				{readout}
			</p>
		</div>
	);
}

export type SummaryItem = { label: string; value: string; note?: string; tone?: Tint };

export function SeriesSummary({ items }: { items: SummaryItem[] }) {
	return (
		<dl className={styles.summary}>
			{items.map((item) => (
				<div key={item.label}>
					<dt>{item.label}</dt>
					<dd {...item.tone}>{item.value}</dd>
					{item.note === undefined ? null : <dd className={styles.summaryNote}>{item.note}</dd>}
				</div>
			))}
		</dl>
	);
}

type TableProps<T extends SeriesEntry> = { rows: T[]; series: SeriesStyle; state: SeriesRange; tint?: (change: number) => Tint };

export function SeriesTable<T extends SeriesEntry>({ rows, series, state, tint }: TableProps<T>) {
	const { average, sort, page } = state;
	const sorted = useMemo(() => sortEntries(rows, sort, average), [rows, sort, average]);
	const pages = Math.max(Math.ceil(rows.length / PAGE_SIZE), 1);
	const current = Math.min(page, pages - 1);
	const visible = sorted.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
	const label = averageLabel(average);
	const columns: { key: SortKey; label: string }[] = [
		{ key: "date", label: "Date" },
		{ key: "value", label: series.name },
		{ key: "average", label },
		{ key: "change", label: "Change" },
	];
	const signed = (value: number) => {
		const text = series.format(Math.abs(value));
		return text === series.format(0) ? text : `${value > 0 ? "+" : "\u2212"}${text}`;
	};
	if (rows.length === 0) return null;
	return (
		<div className={styles.weightTable}>
			<table className={styles.table}>
				<thead>
					<tr>
						{columns.map((column) => (
							<th key={column.key} aria-sort={sort.key === column.key ? (sort.descending ? "descending" : "ascending") : undefined}>
								<button type="button" className={styles.sortButton} onClick={() => state.sortBy(column.key)}>
									{column.label}
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
							<td className={styles.weightCell}>{series.format(row.value)}</td>
							<td data-label={label}>{series.format(row[average])}</td>
							<td data-label="Change">{row.change === null ? "" : <span {...tint?.(row.change)}>{signed(row.change)}</span>}</td>
						</tr>
					))}
				</tbody>
			</table>
			<div className={styles.pager}>
				<span className={styles.entryMeta}>
					{whole(current * PAGE_SIZE + 1)}–{whole(current * PAGE_SIZE + visible.length)} of {whole(rows.length)}
				</span>
				<div className={styles.segmented}>
					<Button size="sm" variant="quiet" disabled={current === 0} onClick={() => state.setPage(current - 1)}>
						Previous
					</Button>
					<Button size="sm" variant="quiet" disabled={current >= pages - 1} onClick={() => state.setPage(current + 1)}>
						Next
					</Button>
				</div>
			</div>
		</div>
	);
}
