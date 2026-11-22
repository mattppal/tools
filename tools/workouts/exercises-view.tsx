import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { Button } from "../../src/kit/button.tsx";
import { Skeleton } from "../../src/kit/skeleton.tsx";
import { Icon } from "../../src/shell/icons.tsx";
import { ToolLayout } from "../../src/shell/tool-layout.tsx";
import { api, ApiError, formatDate, modalityWords, type ExerciseHistory, type ExerciseList, type HistorySet, type RunHistory } from "./client.ts";
import styles from "./workouts.module.css";

export const RUNS_KEY = "runs";

type Load<T> = { status: "loading" } | { status: "error"; error: ApiError } | { status: "ready"; data: T };

export type ChartPoint = { date: string; value: number; label: string };

const HEIGHT = 168;
const PAD = { top: 12, right: 10, bottom: 22, left: 48 };
const DAY_MS = 86_400_000;

function toError(error: unknown): ApiError {
	return error instanceof ApiError ? error : new ApiError(error instanceof Error ? error.message : String(error), 0, null);
}

function plural(count: number, word: string): string {
	return `${count} ${count === 1 ? word : `${word}s`}`;
}

export function clock(seconds: number): string {
	const total = Math.round(seconds);
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const secs = String(total % 60).padStart(2, "0");
	return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}` : `${minutes}:${secs}`;
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

function dayNumber(date: string): number {
	return Date.parse(`${date}T00:00:00Z`) / DAY_MS;
}

export function LineChart({ title, points, axis, note }: { title: string; points: ChartPoint[]; axis: (value: number) => string; note?: string }) {
	const [ref, width] = useWidth();
	const [hover, setHover] = useState<number | null>(null);
	const sorted = points.toSorted((a, b) => a.date.localeCompare(b.date));
	const first = sorted[0];
	const last = sorted.at(-1);
	if (first === undefined || last === undefined) return null;
	const shown = sorted[hover ?? sorted.length - 1] ?? last;
	const startDay = dayNumber(first.date);
	const span = Math.max(dayNumber(last.date) - startDay, 1);
	const inner = Math.max(width - PAD.left - PAD.right, 1);
	const values = sorted.map((point) => point.value);
	const low = Math.min(...values);
	const high = Math.max(...values);
	const pad = high === low ? Math.max(Math.abs(high) * 0.1, 1) : (high - low) * 0.12;
	const x = (date: string) => PAD.left + (sorted.length === 1 ? inner / 2 : ((dayNumber(date) - startDay) / span) * inner);
	const y = (value: number) => PAD.top + ((high + pad - value) / (high - low + pad * 2)) * (HEIGHT - PAD.top - PAD.bottom);
	const line = sorted.map((point, index) => `${index === 0 ? "M" : "L"}${x(point.date).toFixed(1)},${y(point.value).toFixed(1)}`).join("");
	const move = (event: PointerEvent<SVGSVGElement>) => {
		const at = event.clientX - event.currentTarget.getBoundingClientRect().left;
		let best = 0;
		sorted.forEach((point, index) => {
			if (Math.abs(x(point.date) - at) < Math.abs(x(sorted[best]?.date ?? point.date) - at)) best = index;
		});
		setHover(best);
	};
	return (
		<figure className={styles.lineChart}>
			<figcaption className={styles.chartHead}>
				<span className={styles.exerciseName}>{title}</span>
				<span className={styles.loggedSets}>
					{shown.label} · {formatDate(shown.date)}
				</span>
			</figcaption>
			<div ref={ref} className={styles.chartBox}>
				{width === 0 ? null : (
					<svg width={width} height={HEIGHT} role="img" aria-label={`${title}: ${sorted.map((point) => `${formatDate(point.date)} ${point.label}`).join("; ")}`} onPointerMove={move} onPointerDown={move} onPointerLeave={() => setHover(null)}>
						{(high === low ? [high] : [low, high]).map((tick) => (
							<g key={tick}>
								<line x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} className={styles.gridLine} />
								<text x={PAD.left - 6} y={y(tick)} className={styles.axis} textAnchor="end" dominantBaseline="middle">
									{axis(tick)}
								</text>
							</g>
						))}
						<text x={PAD.left} y={HEIGHT - 6} className={styles.axis}>
							{formatDate(first.date)}
						</text>
						{sorted.length > 1 ? (
							<text x={width - PAD.right} y={HEIGHT - 6} className={styles.axis} textAnchor="end">
								{formatDate(last.date)}
							</text>
						) : null}
						{sorted.length > 1 ? <path d={line} className={styles.trend} /> : null}
						{sorted.map((point) => (
							<circle key={point.date} cx={x(point.date)} cy={y(point.value)} r={point === shown ? 3.5 : 2.5} className={point === shown ? styles.pointShown : styles.point} />
						))}
					</svg>
				)}
			</div>
			{note === undefined ? null : <p className={styles.syncLine}>{note}</p>}
		</figure>
	);
}

function useLoad<T>(load: () => Promise<T>): [Load<T>, () => void] {
	const [state, setState] = useState<Load<T>>({ status: "loading" });
	const run = useCallback(() => {
		setState({ status: "loading" });
		load().then(
			(data) => setState({ status: "ready", data }),
			(error: unknown) => setState({ status: "error", error: toError(error) }),
		);
	}, [load]);
	useEffect(run, [run]);
	return [state, run];
}

function Failed({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
	return (
		<div className={styles.notice} role="alert">
			<Icon name="alert" />
			<div className={styles.noticeBody}>
				<p>{error.message}</p>
				<Button size="sm" onClick={onRetry}>
					Try again
				</Button>
			</div>
		</div>
	);
}

function ListSkeleton() {
	return (
		<div className={styles.week} aria-busy="true">
			{[0, 1, 2, 3, 4, 5].map((row) => (
				<Skeleton key={row} className="h-10 w-full" />
			))}
		</div>
	);
}

export function ExerciseIndex({ onOpen }: { onOpen: (key: string) => void }) {
	const load = useCallback(() => api.exercises(), []);
	const [state, retry] = useLoad<ExerciseList>(load);
	if (state.status === "loading") return <ListSkeleton />;
	if (state.status === "error") return <Failed error={state.error} onRetry={retry} />;
	const { exercises, runs } = state.data;
	if (exercises.length === 0 && runs.sessions === 0) return <p className={styles.empty}>Exercises appear here after training-log syncs.</p>;
	const rows = [...(runs.sessions === 0 || runs.lastDate === null ? [] : [{ key: RUNS_KEY, name: "Runs", sessions: runs.sessions, lastDate: runs.lastDate }]), ...exercises];
	return (
		<ul className={styles.historyList} aria-label="Exercises">
			{rows.map((row) => (
				<li key={row.key}>
					<button type="button" className={styles.historyRow} onClick={() => onOpen(row.key)}>
						<span className={styles.historyMain}>
							<span className={styles.exerciseName}>{row.name}</span>
							<span className={styles.exerciseRx}>
								{plural(row.sessions, "session")} · last {formatDate(row.lastDate)}
							</span>
						</span>
						<Icon name="chevron-right" />
					</button>
				</li>
			))}
		</ul>
	);
}

function setText(set: HistorySet, unit: string | null): string {
	if (set.notes === "skipped" && set.reps === 0) return "skipped";
	const weight = set.weight === null ? null : set.unit === unit || set.unit === null ? `${set.weight}` : `${set.weight} ${set.unit}`;
	const head = [weight, set.reps === null ? null : `${set.reps}`].filter((part) => part !== null).join(" × ");
	const distance = set.distance === null ? null : `${set.distance} ${set.distanceUnit ?? ""}`.trim();
	const duration = set.durationSeconds === null ? null : clock(set.durationSeconds);
	const parts = [head === "" ? null : head, set.rir === null ? null : `@${set.rir}`, distance, duration].filter((part) => part !== null);
	return parts.length === 0 ? "not recorded" : parts.join(" ");
}

function number(value: number): string {
	return value.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

function ExerciseBody({ data }: { data: ExerciseHistory }) {
	const done = data.sessions.filter((session) => session.top !== null);
	const unit = data.unit ?? "";
	const otherUnit = data.sessions.some((session) => session.sets.some((set) => set.weight !== null && set.unit !== null && set.unit !== data.unit));
	const note = otherUnit ? `Sessions logged in another unit are in the list below, not the charts.` : undefined;
	const top = done.flatMap((session) => (session.top === null ? [] : [{ date: session.date, value: session.top.weight, label: `${number(session.top.weight)} ${unit}${session.top.reps === null ? "" : ` × ${session.top.reps}`}` }]));
	const volume = done.flatMap((session) => (session.volume === null ? [] : [{ date: session.date, value: session.volume, label: `${number(session.volume)} ${unit}` }]));
	const reps = done.flatMap((session) => (session.topReps === null ? [] : [{ date: session.date, value: session.topReps, label: plural(session.topReps, "rep") }]));
	return (
		<>
			{top.length === 0 ? <p className={styles.dayNote}>No loaded sets to chart. Every session is listed below.</p> : null}
			<LineChart title="Top set" points={top} axis={(value) => number(value)} note={note} />
			<LineChart title="Volume" points={volume} axis={(value) => number(value)} note="Working sets, weight × reps, in the top set's unit." />
			<LineChart title="Reps at the top weight" points={reps} axis={(value) => number(value)} />
			{data.prs.length === 0 ? null : (
				<section className={styles.block} aria-label="Rep records">
					<h3 className={styles.sectionTitle}>Rep records from training-log</h3>
					<ul className={styles.exerciseList}>
						{data.prs.map((pr) => (
							<li key={`${pr.reps}/${pr.date}`} className={styles.exerciseLine}>
								<span className={styles.exerciseName}>{plural(pr.reps, "rep")}</span>
								<span className={styles.exerciseRx}>
									{number(pr.weight)} {pr.unit} · {formatDate(pr.date)}
								</span>
							</li>
						))}
					</ul>
				</section>
			)}
			<section className={styles.block} aria-label="Sessions">
				<h3 className={styles.sectionTitle}>Sessions</h3>
				<ul className={styles.exerciseList}>
					{data.sessions.map((session) => (
						<li key={session.path} className={`${styles.exerciseLine} ${styles.loggedLine}`}>
							<span className={styles.exerciseName}>
								{formatDate(session.date)} · {session.name}
							</span>
							{session.prescribed === null ? null : <span className={styles.rxNote}>Prescribed {session.prescribed}</span>}
							<span className={styles.loggedSets}>{session.status === "skipped" ? "Skipped" : session.sets.length === 0 ? "Not recorded" : session.sets.map((set) => setText(set, data.unit)).join(", ")}</span>
						</li>
					))}
				</ul>
			</section>
		</>
	);
}

function RunsBody({ data }: { data: RunHistory }) {
	const distance = data.sessions.flatMap((run) => (run.miles === null || run.distance === null ? [] : [{ date: run.date, value: run.miles, label: `${run.distance} ${run.distanceUnit ?? ""}`.trim() }]));
	const duration = data.sessions.flatMap((run) => (run.durationSeconds === null ? [] : [{ date: run.date, value: run.durationSeconds, label: clock(run.durationSeconds) }]));
	const pace = data.sessions.flatMap((run) => (run.paceSecondsPerMile === null ? [] : [{ date: run.date, value: run.paceSecondsPerMile, label: `${clock(run.paceSecondsPerMile)} /mi` }]));
	return (
		<>
			<p className={styles.dayNote}>One point per run, from its longest effort. Pace needs both a distance and a duration, and skipped runs have no point.</p>
			<LineChart title="Distance" points={distance} axis={(value) => `${number(Math.round(value * 10) / 10)} mi`} />
			<LineChart title="Duration" points={duration} axis={(value) => clock(value)} />
			<LineChart title="Pace" points={pace} axis={(value) => clock(value)} />
			<section className={styles.block} aria-label="Runs">
				<h3 className={styles.sectionTitle}>Runs</h3>
				<ul className={styles.exerciseList}>
					{data.sessions.map((run) => {
						const parts = [run.distance === null ? null : `${run.distance} ${run.distanceUnit ?? ""}`.trim(), run.durationSeconds === null ? null : clock(run.durationSeconds), run.paceSecondsPerMile === null ? null : `${clock(run.paceSecondsPerMile)} /mi`].filter((part) => part !== null);
						return (
							<li key={run.path} className={`${styles.exerciseLine} ${styles.loggedLine}`}>
								<span className={styles.exerciseName}>
									{formatDate(run.date)} · {run.name}
								</span>
								<span className={styles.loggedSets}>
									{[run.modality === null ? null : modalityWords(run.modality), run.status === "skipped" ? "Skipped" : parts.length === 0 ? "Not recorded" : parts.join(" · ")].filter((part) => part !== null).join(" · ")}
								</span>
								{run.notes === null ? null : <span className={styles.rxNote}>{run.notes}</span>}
							</li>
						);
					})}
				</ul>
			</section>
		</>
	);
}

export function ExerciseScreen({ exerciseKey, onClose }: { exerciseKey: string; onClose: () => void }) {
	const load = useCallback(() => (exerciseKey === RUNS_KEY ? api.runs() : api.exerciseHistory(exerciseKey)), [exerciseKey]);
	const [state, retry] = useLoad<ExerciseHistory | RunHistory>(load);
	const title = state.status !== "ready" ? (exerciseKey === RUNS_KEY ? "Runs" : "Exercise") : "name" in state.data ? state.data.name : "Runs";
	const count = state.status === "ready" ? state.data.sessions.length : null;
	return (
		<ToolLayout title="Workouts">
			<div className={styles.page}>
				<div className={styles.weekNav}>
					<Button variant="quiet" aria-label="Back to history" onClick={onClose}>
						<Icon name="back" />
					</Button>
					<div className={styles.exerciseTitle}>
						<h2 className={styles.dayTitle}>{title}</h2>
						{count === null ? null : <p className={styles.loggedSets}>{plural(count, "session")} in training-log</p>}
					</div>
				</div>
				{state.status === "loading" ? <ListSkeleton /> : state.status === "error" ? <Failed error={state.error} onRetry={retry} /> : "name" in state.data ? <ExerciseBody data={state.data} /> : <RunsBody data={state.data} />}
			</div>
		</ToolLayout>
	);
}
