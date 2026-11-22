import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "../../src/kit/button.tsx";
import { Skeleton } from "../../src/kit/skeleton.tsx";
import { ToolLayout } from "../../src/shell/tool-layout.tsx";
import styles from "./nutrition.module.css";
import type { WeightRow } from "./types.ts";
import { dayLabel, tenths, useJson, viewsSidebar } from "./ui.tsx";

const RANGES = [
	{ id: "90d", label: "90 days" },
	{ id: "1y", label: "1 year" },
	{ id: "all", label: "All" },
] as const;

const HEIGHT = 280;
const PAD = { top: 12, right: 8, bottom: 24, left: 40 };

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

function Chart({ rows }: { rows: WeightRow[] }) {
	const [ref, width] = useWidth();
	const first = rows[0];
	const last = rows.at(-1);
	if (first === undefined || last === undefined) return <p className={styles.empty}>No weigh-ins in this range.</p>;
	const start = Date.parse(first.date);
	const span = Math.max(Date.parse(last.date) - start, 1);
	const values = rows.flatMap((row) => [row.weight, row.rolling7d]);
	const low = Math.floor(Math.min(...values) - 0.5);
	const high = Math.ceil(Math.max(...values) + 0.5);
	const x = (date: string) => PAD.left + ((Date.parse(date) - start) / span) * (width - PAD.left - PAD.right);
	const y = (value: number) => PAD.top + ((high - value) / (high - low)) * (HEIGHT - PAD.top - PAD.bottom);
	const line = (key: "rolling7d" | "rolling14d" | "rolling28d") => rows.map((row, index) => `${index === 0 ? "M" : "L"}${x(row.date).toFixed(1)},${y(row[key]).toFixed(1)}`).join("");
	const ticks = [low, (low + high) / 2, high];
	return (
		<div ref={ref} className={styles.chart}>
			{width === 0 ? null : (
				<svg width={width} height={HEIGHT} role="img" aria-label={`Weight from ${dayLabel(first.date)} to ${dayLabel(last.date)}, latest 7-day average ${tenths(last.rolling7d)} lb`}>
					{ticks.map((tick) => (
						<g key={tick}>
							<line x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} className={styles.gridLine} />
							<text x={PAD.left - 6} y={y(tick)} className={styles.axis} textAnchor="end" dominantBaseline="middle">
								{tenths(tick)}
							</text>
						</g>
					))}
					<text x={PAD.left} y={HEIGHT - 6} className={styles.axis}>
						{dayLabel(first.date, { month: "short", day: "numeric", year: "numeric" })}
					</text>
					<text x={width - PAD.right} y={HEIGHT - 6} className={styles.axis} textAnchor="end">
						{dayLabel(last.date, { month: "short", day: "numeric", year: "numeric" })}
					</text>
					{rows.map((row) => (
						<circle key={row.date} cx={x(row.date)} cy={y(row.weight)} r={rows.length > 400 ? 1 : 1.75} className={styles.point} />
					))}
					<path d={line("rolling28d")} className={styles.trend28} />
					<path d={line("rolling14d")} className={styles.trend14} />
					<path d={line("rolling7d")} className={styles.trend7} />
				</svg>
			)}
		</div>
	);
}

export function Weight() {
	const [range, setRange] = useState<(typeof RANGES)[number]["id"]>("90d");
	const [load, , reload] = useJson<WeightRow[]>(`/weights?range=${range}`);
	const last = load.status === "ready" ? load.data.at(-1) : undefined;
	return (
		<ToolLayout title="Weight" sidebar={viewsSidebar("/weight")}>
			<div className={styles.page}>
				<div className={styles.weightHead}>
					<div>
						{last === undefined ? null : (
							<>
								<div className={styles.barValue}>
									{tenths(last.rolling7d)}
									<span className={styles.barTarget}> lb, 7-day average</span>
								</div>
								<div className={styles.entryMeta}>
									{tenths(last.weight)} lb on {dayLabel(last.date)} · 14-day {tenths(last.rolling14d)} · 28-day {tenths(last.rolling28d)}
								</div>
							</>
						)}
					</div>
					<div className={styles.segmented} role="group" aria-label="Range">
						{RANGES.map((option) => (
							<Button key={option.id} size="sm" variant="quiet" aria-pressed={option.id === range} onClick={() => setRange(option.id)}>
								{option.label}
							</Button>
						))}
					</div>
				</div>
				{load.status === "loading" ? (
					<Skeleton className={styles.chartSkeleton} />
				) : load.status === "error" ? (
					<div className={styles.empty}>
						<p>{load.message}</p>
						<Button onClick={reload}>Try again</Button>
					</div>
				) : (
					<Chart rows={load.data} />
				)}
			</div>
		</ToolLayout>
	);
}
