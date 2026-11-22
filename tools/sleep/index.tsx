import { type PointerEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button, IconButton } from "../../src/kit/button.tsx";
import { Skeleton } from "../../src/kit/skeleton.tsx";
import { Icon } from "../../src/shell/icons.tsx";
import { ToolLayout } from "../../src/shell/tool-layout.tsx";
import { addDays, today } from "../activity/dates.ts";
import type { Night, TimelineStage } from "../activity/nights.ts";
import styles from "./sleep.module.css";

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; nights: Night[] };

const RANGES = [
	{ days: 30, label: "30 nights" },
	{ days: 90, label: "90 nights" },
	{ days: 365, label: "1 year" },
] as const;

const LANES: { stage: TimelineStage; label: string }[] = [
	{ stage: "awake", label: "Awake" },
	{ stage: "rem", label: "REM" },
	{ stage: "light", label: "Light" },
	{ stage: "deep", label: "Deep" },
	{ stage: "asleep", label: "Asleep" },
];

const CHART_HEIGHT = 168;
const CHART_PAD = { top: 22, right: 4, bottom: 20, left: 28 };
const LANE_HEIGHT = 18;
const LANE_GAP = 6;
const LANE_LABEL = 52;
const AVERAGE_NIGHTS = 7;

const minutesOf = (seconds: number) => Math.round(seconds / 60);

function duration(seconds: number | null): string {
	if (seconds === null) return "—";
	const minutes = minutesOf(seconds);
	const hours = Math.floor(minutes / 60);
	return hours === 0 ? `${minutes}m` : `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function clock(hhmm: string): string {
	const [hours = 0, minutes = 0] = hhmm.split(":").map(Number);
	return `${((hours + 11) % 12) + 1}:${String(minutes).padStart(2, "0")} ${hours >= 12 ? "pm" : "am"}`;
}

function averageClock(times: string[]): string | null {
	if (times.length === 0) return null;
	const minutes = times.map((time) => {
		const [hours = 0, mins = 0] = time.split(":").map(Number);
		const value = hours * 60 + mins;
		return value < 12 * 60 ? value + 24 * 60 : value;
	});
	const mean = Math.round(minutes.reduce((sum, value) => sum + value, 0) / minutes.length) % (24 * 60);
	return clock(`${Math.floor(mean / 60)}:${mean % 60}`);
}

function mean(values: (number | null)[]): number | null {
	const present = values.filter((value) => value !== null);
	return present.length === 0 ? null : present.reduce((sum, value) => sum + value, 0) / present.length;
}

const dayLabel = (date: string, options: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" }) =>
	new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { ...options, timeZone: "UTC" });

const sourceName = (source: string) => source.replace(/^.*’s |^.*'s /, "");

function useNights(days: number): [Load, () => void] {
	const [load, setLoad] = useState<Load>({ status: "loading" });
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		let live = true;
		const to = today();
		setLoad((current) => (current.status === "ready" ? current : { status: "loading" }));
		fetch(`/api/tools/activity/nights?from=${addDays(to, -(days - 1))}&to=${to}`)
			.then(async (response) => {
				const json = (await response.json().catch(() => null)) as { nights?: Night[]; error?: string } | null;
				if (!response.ok || json?.nights === undefined) throw new Error(json?.error ?? `Request failed with ${response.status}`);
				return json.nights;
			})
			.then(
				(nights) => live && setLoad({ status: "ready", nights }),
				(error: unknown) =>
					live && setLoad({ status: "error", message: error instanceof TypeError ? "Couldn't reach the server. Reload the page to sign in again." : error instanceof Error ? error.message : String(error) }),
			);
		return () => {
			live = false;
		};
	}, [days, attempt]);
	return [load, () => setAttempt((count) => count + 1)];
}

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

function Hypnogram({ night }: { night: Night }) {
	const [ref, width] = useWidth();
	const lanes = LANES.filter((lane) => night.timeline.some((span) => span.stage === lane.stage));
	if (lanes.length === 0) return null;
	const span = Math.max(night.inBedS, ...night.timeline.map((stage) => stage.endS));
	const inner = Math.max(width - LANE_LABEL, 0);
	const height = lanes.length * (LANE_HEIGHT + LANE_GAP) + 16;
	const x = (seconds: number) => LANE_LABEL + (seconds / span) * inner;
	return (
		<div ref={ref} className={styles.hypnogram}>
			{width === 0 ? null : (
				<svg width={width} height={height} role="img" aria-label={`Sleep stages from ${clock(night.inBedFrom)} to ${clock(night.inBedTo)}`}>
					{lanes.map((lane, index) => {
						const top = index * (LANE_HEIGHT + LANE_GAP);
						return (
							<g key={lane.stage} data-stage={lane.stage}>
								<text x={0} y={top + LANE_HEIGHT / 2} dominantBaseline="middle" className={styles.laneLabel}>
									{lane.label}
								</text>
								<rect x={LANE_LABEL} y={top} width={inner} height={LANE_HEIGHT} rx={3} className={styles.laneTrack} />
								{night.timeline
									.filter((stage) => stage.stage === lane.stage)
									.map((stage) => (
										<rect key={stage.startS} x={x(stage.startS)} y={top} width={Math.max(x(stage.endS) - x(stage.startS), 1)} height={LANE_HEIGHT} rx={2} className={styles.stage} />
									))}
							</g>
						);
					})}
					<text x={LANE_LABEL} y={height - 2} className={styles.axis}>
						{clock(night.inBedFrom)}
					</text>
					<text x={width} y={height - 2} textAnchor="end" className={styles.axis}>
						{clock(night.inBedTo)}
					</text>
				</svg>
			)}
		</div>
	);
}

function NightView({ night, isLatest, onPrevious, onNext }: { night: Night; isLatest: boolean; onPrevious: (() => void) | null; onNext: (() => void) | null }) {
	const stages = [
		{ label: "Deep", value: night.deepS },
		{ label: "REM", value: night.remS },
		{ label: "Light", value: night.lightS },
		{ label: "Awake", value: night.awakeS },
	].filter((item) => item.value !== null);
	const vitals = [
		{ label: "Resting HR", value: night.restingHr === null ? null : `${night.restingHr} bpm` },
		{ label: "HRV", value: night.hrv === null ? null : `${night.hrv} ms` },
		{ label: "Breathing", value: night.respiratoryRate === null ? null : `${night.respiratoryRate} a minute` },
	].filter((item) => item.value !== null);
	return (
		<section className={styles.night} aria-label={`Night ending ${dayLabel(night.date)}`}>
			<div className={styles.nightHeader}>
				<p className={styles.eyebrow}>{isLatest && night.date === today() ? `Last night, ${dayLabel(night.date)}` : dayLabel(night.date, { weekday: "long", month: "short", day: "numeric" })}</p>
				<div className={styles.stepper}>
					<IconButton label="Earlier night" size="sm" disabled={onPrevious === null} onClick={onPrevious ?? undefined}>
						<Icon name="back" />
					</IconButton>
					<IconButton label="Later night" size="sm" disabled={onNext === null} onClick={onNext ?? undefined}>
						<Icon name="chevron-right" />
					</IconButton>
				</div>
			</div>
			<p className={styles.total}>{duration(night.asleepS)}</p>
			<p className={styles.span}>
				Asleep {clock(night.bedtime)} to {clock(night.wake)}, {duration(night.inBedS)} in bed. From {sourceName(night.source)}
				{night.alsoFrom.length === 0 ? "." : `, also recorded by ${night.alsoFrom.map(sourceName).join(" and ")}.`}
			</p>
			<Hypnogram night={night} />
			<dl className={styles.stats}>
				{[...stages.map((item) => ({ label: item.label, value: duration(item.value) })), ...vitals].map((item) => (
					<div key={item.label}>
						<dt>{item.label}</dt>
						<dd>{item.value}</dd>
					</div>
				))}
			</dl>
		</section>
	);
}

function NightsChart({ nights, selected, onSelect }: { nights: Night[]; selected: string; onSelect: (date: string) => void }) {
	const [ref, width] = useWidth();
	const [hover, setHover] = useState<number | null>(null);
	const hours = Math.max(9, Math.ceil(Math.max(...nights.map((night) => night.asleepS)) / 3600));
	const inner = Math.max(width - CHART_PAD.left - CHART_PAD.right, 0);
	const step = inner / Math.max(nights.length, 1);
	const barWidth = Math.max(Math.min(step * 0.68, 18), 1.5);
	const bottom = CHART_HEIGHT - CHART_PAD.bottom;
	const y = (seconds: number) => bottom - (seconds / (hours * 3600)) * (bottom - CHART_PAD.top);
	const center = (index: number) => CHART_PAD.left + step * index + step / 2;
	const averages = nights.map((_, index) => mean(nights.slice(Math.max(0, index - AVERAGE_NIGHTS + 1), index + 1).map((night) => night.asleepS)) ?? 0);
	const line = averages.map((value, index) => `${index === 0 ? "M" : "L"}${center(index).toFixed(1)},${y(value).toFixed(1)}`).join("");
	const indexAt = (event: PointerEvent<SVGSVGElement>) => {
		const px = event.clientX - event.currentTarget.getBoundingClientRect().left - CHART_PAD.left;
		return Math.min(Math.max(Math.floor(px / step), 0), nights.length - 1);
	};
	const shown = nights[hover ?? -1] ?? nights.find((night) => night.date === selected);
	const first = nights[0];
	const last = nights.at(-1);
	return (
		<div ref={ref} className={styles.chart}>
			{width === 0 || first === undefined || last === undefined ? null : (
				<svg
					width={width}
					height={CHART_HEIGHT}
					role="img"
					aria-label={`Time asleep each night from ${dayLabel(first.date)} to ${dayLabel(last.date)}, with the ${AVERAGE_NIGHTS}-night average`}
					onPointerMove={(event) => setHover(indexAt(event))}
					onPointerLeave={() => setHover(null)}
					onPointerUp={(event) => {
						const night = nights[indexAt(event)];
						if (night !== undefined) onSelect(night.date);
					}}
				>
					{[0, Math.round(hours / 2), hours].map((tick) => (
						<g key={tick}>
							<line x1={CHART_PAD.left} x2={width - CHART_PAD.right} y1={y(tick * 3600)} y2={y(tick * 3600)} className={styles.gridLine} />
							<text x={CHART_PAD.left - 6} y={y(tick * 3600)} textAnchor="end" dominantBaseline="middle" className={styles.axis}>
								{tick}h
							</text>
						</g>
					))}
					{nights.map((night, index) => (
						<rect
							key={night.date}
							x={center(index) - barWidth / 2}
							y={y(night.asleepS)}
							width={barWidth}
							height={bottom - y(night.asleepS)}
							rx={Math.min(barWidth / 2, 2)}
							className={styles.bar}
							data-selected={night.date === selected || undefined}
							data-hover={index === hover || undefined}
						/>
					))}
					{nights.length > 1 ? <path d={line} className={styles.average} /> : null}
					{shown === undefined ? null : (
						<text x={CHART_PAD.left} y={11} className={styles.chartLabel}>
							Asleep · {dayLabel(shown.date)} · {duration(shown.asleepS)}
						</text>
					)}
					<text x={CHART_PAD.left} y={CHART_HEIGHT - 4} className={styles.axis}>
						{dayLabel(first.date, { month: "short", day: "numeric" })}
					</text>
					<text x={width - CHART_PAD.right} y={CHART_HEIGHT - 4} textAnchor="end" className={styles.axis}>
						{dayLabel(last.date, { month: "short", day: "numeric" })}
					</text>
				</svg>
			)}
		</div>
	);
}

function RangeSummary({ nights }: { nights: Night[] }) {
	const asleep = mean(nights.map((night) => night.asleepS));
	const items = [
		{ label: "Average asleep", value: asleep === null ? null : duration(asleep) },
		{ label: "Bedtime", value: averageClock(nights.map((night) => night.bedtime)) },
		{ label: "Wake", value: averageClock(nights.map((night) => night.wake)) },
		{ label: "Resting HR", value: ((value) => (value === null ? null : `${Math.round(value)} bpm`))(mean(nights.map((night) => night.restingHr))) },
		{ label: "HRV", value: ((value) => (value === null ? null : `${Math.round(value)} ms`))(mean(nights.map((night) => night.hrv))) },
	].filter((item) => item.value !== null);
	return (
		<dl className={styles.summary}>
			{items.map((item) => (
				<div key={item.label}>
					<dt>{item.label}</dt>
					<dd>{item.value}</dd>
				</div>
			))}
		</dl>
	);
}

function NightsTable({ nights, selected, onSelect }: { nights: Night[]; selected: string; onSelect: (date: string) => void }) {
	return (
		<table className={styles.table}>
			<thead>
				<tr>
					<th>Night</th>
					<th>Asleep</th>
					<th data-optional>Deep</th>
					<th data-optional>REM</th>
					<th>Bedtime</th>
					<th data-optional>Wake</th>
					<th>RHR</th>
					<th>HRV</th>
				</tr>
			</thead>
			<tbody>
				{nights.toReversed().map((night) => (
					<tr key={night.date} data-selected={night.date === selected || undefined}>
						<td>
							<button type="button" className={styles.rowButton} aria-pressed={night.date === selected} onClick={() => onSelect(night.date)}>
								{dayLabel(night.date)}
							</button>
						</td>
						<td>{duration(night.asleepS)}</td>
						<td data-optional>{duration(night.deepS)}</td>
						<td data-optional>{duration(night.remS)}</td>
						<td>{clock(night.bedtime)}</td>
						<td data-optional>{clock(night.wake)}</td>
						<td>{night.restingHr ?? "—"}</td>
						<td>{night.hrv ?? "—"}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

export default function Sleep() {
	const [days, setDays] = useState<number>(30);
	const [load, reload] = useNights(days);
	const [picked, setPicked] = useState<string | null>(null);
	const nights = useMemo(() => (load.status === "ready" ? load.nights : []), [load]);
	const index = picked === null ? nights.length - 1 : nights.findIndex((night) => night.date === picked);
	const current = nights[index] ?? nights.at(-1);
	const select = (date: string) => setPicked(date === nights.at(-1)?.date ? null : date);
	const step = (delta: number) => {
		const next = nights[index + delta];
		return next === undefined ? null : () => select(next.date);
	};

	return (
		<ToolLayout title="Sleep">
			<div className={styles.page}>
				{load.status === "loading" ? (
					<>
						<Skeleton className={styles.heroSkeleton} />
						<Skeleton className={styles.chartSkeleton} />
					</>
				) : load.status === "error" ? (
					<div className={styles.empty}>
						<p>{load.message}</p>
						<Button onClick={reload}>Try again</Button>
					</div>
				) : current === undefined ? (
					<div className={styles.empty}>
						<p>No nights in the last {days} days.</p>
						<p className={styles.hint}>Nights arrive from Eight Sleep and Apple Watch through Health Auto Export on the iPhone, and from Withings.</p>
					</div>
				) : (
					<>
						<NightView night={current} isLatest={current === nights.at(-1)} onPrevious={step(-1)} onNext={step(1)} />
						<div className={styles.rangeHeader}>
							<h2 className={styles.rangeTitle}>Recent nights</h2>
							<div className={styles.segmented} role="group" aria-label="Range">
								{RANGES.map((range) => (
									<Button key={range.days} size="sm" variant="quiet" aria-pressed={range.days === days} onClick={() => setDays(range.days)}>
										{range.label}
									</Button>
								))}
							</div>
						</div>
						<RangeSummary nights={nights} />
						<NightsChart nights={nights} selected={current.date} onSelect={select} />
						<NightsTable nights={nights} selected={current.date} onSelect={select} />
					</>
				)}
			</div>
		</ToolLayout>
	);
}
