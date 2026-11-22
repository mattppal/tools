import { ToolLayout } from "../../src/shell/tool-layout.tsx";
import styles from "./goals.module.css";
import { AREA_LABELS, type Overview, type Quarter } from "./types.ts";
import { checkinText, goalMeta, LoadState, useOverview, useYear, VIEWS, YearSwitcher } from "./ui.tsx";

const QUARTERS: { quarter: Quarter; months: string }[] = [
	{ quarter: 1, months: "Jan to Mar" },
	{ quarter: 2, months: "Apr to Jun" },
	{ quarter: 3, months: "Jul to Sep" },
	{ quarter: 4, months: "Oct to Dec" },
];

function Board({ overview }: { overview: Overview }) {
	const year = useYear(overview);
	const goals = overview.goals.filter((goal) => goal.year === year && goal.horizon === "quarter");
	return (
		<>
			<YearSwitcher overview={overview} year={year} />
			<div className={styles.quarters}>
				{QUARTERS.map(({ quarter, months }) => {
					const inQuarter = goals.filter((goal) => goal.quarter === quarter);
					return (
						<section key={quarter} className={styles.quarter} aria-labelledby={`q${quarter}`}>
							<h2 id={`q${quarter}`} className={styles.quarterTitle}>
								Q{quarter} <span className={styles.meta}>{months}</span>
							</h2>
							{inQuarter.length === 0 ? (
								<p className={styles.meta}>No Q{quarter} goals.</p>
							) : (
								<ul className={styles.goals}>
									{inQuarter.map((goal) => (
										<li key={goal.id} className={styles.goal}>
											<div className={styles.goalMain}>
												<span className={styles.goalTitle}>{goal.title}</span>
												<span className={styles.meta}>{goalMeta({ ...goal, quarter: null }, { area: AREA_LABELS[goal.area] })}</span>
												<span className={styles.checkin} data-empty={goal.latestCheckin === null ? "" : undefined}>
													{checkinText(goal.latestCheckin)}
												</span>
											</div>
										</li>
									))}
								</ul>
							)}
						</section>
					);
				})}
			</div>
		</>
	);
}

export function QuartersPage() {
	const [load, , retry] = useOverview();
	return (
		<ToolLayout title="Quarters" sections={VIEWS}>
			<div className={styles.wide}>{load.status === "ready" ? <Board overview={load.data} /> : <LoadState load={load} retry={retry} />}</div>
		</ToolLayout>
	);
}
