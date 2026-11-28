import { Button } from "../../src/kit/button.tsx";
import { Skeleton } from "../../src/kit/skeleton.tsx";
import { ToolLayout } from "../../src/shell/tool-layout.tsx";
import styles from "./nutrition.module.css";
import type { PhaseWeek } from "./phase.ts";
import type { PhaseView as Phase } from "./store.ts";
import { dayLabel, tenths, useJson, VIEWS, whole } from "./ui.tsx";

const short = (date: string) => dayLabel(date, { month: "short", day: "numeric" });
const maybe = (value: number | null, format: (value: number) => string) => (value === null ? "–" : format(value));
const signed = (value: number) => `${value > 0 ? "+" : ""}${tenths(value)}`;

function Suggestion({ phase, week }: { phase: NonNullable<Phase>; week: PhaseWeek }) {
	if (week.nextWeekKcal === null) {
		const missing = phase.settings.minLoggedDays - week.daysLogged;
		return <p className={styles.entryMeta}>{missing > 0 ? `Log ${missing} more closed ${missing === 1 ? "day" : "days"} this week for a kcal suggestion.` : "Needs two weeks of weigh-ins for a kcal suggestion."}</p>;
	}
	return (
		<p className={styles.entryMeta}>
			Next week: {whole(week.nextWeekKcal)} kcal ({week.kcalChange === null || week.kcalChange === 0 ? "no change" : `${week.kcalChange > 0 ? "+" : ""}${whole(week.kcalChange)}`}) from a measured TDEE of {maybe(week.measuredTdee, whole)}.
		</p>
	);
}

function Body({ phase }: { phase: Phase }) {
	if (phase === null) return <p className={styles.empty}>No open phase has a tracker.</p>;
	const { summary, settings } = phase;
	const current = summary.current;
	return (
		<>
			<section className={styles.card}>
				<div className={styles.entryMeta}>
					{phase.kind[0]?.toUpperCase()}
					{phase.kind.slice(1)} since {short(phase.startDate)} · {settings.weeks} weeks · {whole(settings.currentKcalTarget)} kcal target
				</div>
				{current === null ? (
					<div className={styles.barValue}>Starts {short(phase.startDate)}</div>
				) : (
					<>
						<div className={styles.barValue}>
							Week {current.week + 1}: {current.verdict ?? "waiting on weigh-ins"}
						</div>
						<Suggestion phase={phase} week={current} />
					</>
				)}
			</section>
			<div className={styles.tableScroll}>
				<table className={styles.table}>
					<thead>
						<tr>
							<th>Week</th>
							<th>Planned</th>
							<th>7-day</th>
							<th>Change</th>
							<th>Avg kcal</th>
							<th>Days</th>
							<th>TDEE</th>
							<th>Verdict</th>
						</tr>
					</thead>
					<tbody>
						{summary.weeks.map((week) => (
							<tr key={week.week} data-future={week.started ? undefined : ""}>
								<td>{short(week.weekStart)}</td>
								<td>{maybe(week.plannedWeight, tenths)}</td>
								<td>{maybe(week.actual7d, tenths)}</td>
								<td>{maybe(week.weeklyChange, signed)}</td>
								<td>{maybe(week.avgLoggedKcal, whole)}</td>
								<td>
									{week.started ? week.daysLogged : "–"}
									{week.partialDays > 0 ? <span className={styles.entryMeta}> · {week.partialDays} partial</span> : null}
								</td>
								<td>{maybe(week.measuredTdee, whole)}</td>
								<td>{week.verdict ?? "–"}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</>
	);
}

export function PhaseView() {
	const [load, , reload] = useJson<Phase>("/phase");
	return (
		<ToolLayout title="Phase" sections={VIEWS}>
			<div className={styles.page}>
				{load.status === "loading" ? (
					<Skeleton className={styles.chartSkeleton} />
				) : load.status === "error" ? (
					<div className={styles.empty}>
						<p>{load.message}</p>
						<Button onClick={reload}>Try again</Button>
					</div>
				) : (
					<Body phase={load.data} />
				)}
			</div>
		</ToolLayout>
	);
}
