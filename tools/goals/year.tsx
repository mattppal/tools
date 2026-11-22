import { useState } from "react";
import { Button } from "../../src/kit/button.tsx";
import { ToolLayout } from "../../src/shell/tool-layout.tsx";
import { CheckinForm } from "./checkin-form.tsx";
import styles from "./goals.module.css";
import { AREA_LABELS, AREAS, type Goal, type Overview } from "./types.ts";
import { checkinText, goalMeta, LoadState, useOverview, useYear, VIEWS, YearSwitcher } from "./ui.tsx";

function GoalRow({ goal, open, onOpen, onClose, onSaved }: { goal: Goal; open: boolean; onOpen: () => void; onClose: () => void; onSaved: (goal: Goal) => void }) {
	return (
		<li className={styles.goal}>
			<div className={styles.goalRow}>
				<div className={styles.goalMain}>
					<span className={styles.goalTitle}>{goal.title}</span>
					<span className={styles.meta}>{goalMeta(goal)}</span>
					<span className={styles.checkin} data-empty={goal.latestCheckin === null ? "" : undefined}>
						{checkinText(goal.latestCheckin)}
					</span>
				</div>
				{open ? null : (
					<Button size="sm" variant="quiet" onClick={onOpen}>
						Check in
					</Button>
				)}
			</div>
			{open ? <CheckinForm goal={goal} onCancel={onClose} onSaved={onSaved} /> : null}
		</li>
	);
}

function YearBody({ overview, year, replace }: { overview: Overview; year: number; replace: (goal: Goal) => void }) {
	const [open, setOpen] = useState<string | null>(null);
	const northStar = overview.years.find((item) => item.year === year)?.northStar ?? "";
	const goals = overview.goals.filter((goal) => goal.year === year);
	const areas = AREAS.filter((area) => goals.some((goal) => goal.area === area));
	return (
		<>
			<section className={styles.northStar} aria-label="North star">
				<span className={styles.eyebrow}>North star · {year}</span>
				{northStar === "" ? <p className={styles.northStarEmpty}>No north star for {year} yet.</p> : <p className={styles.northStarText}>{northStar}</p>}
			</section>
			{goals.length === 0 ? (
				<p className={styles.empty}>No goals for {year} yet. gtd bot adds them.</p>
			) : (
				areas.map((area) => (
					<section key={area} className={styles.area} aria-labelledby={`area-${area}`}>
						<h2 id={`area-${area}`} className={styles.areaTitle}>
							{AREA_LABELS[area]}
						</h2>
						<ul className={styles.goals}>
							{goals
								.filter((goal) => goal.area === area)
								.map((goal) => (
									<GoalRow
										key={goal.id}
										goal={goal}
										open={open === goal.id}
										onOpen={() => setOpen(goal.id)}
										onClose={() => setOpen(null)}
										onSaved={(saved) => {
											replace(saved);
											setOpen(null);
										}}
									/>
								))}
						</ul>
					</section>
				))
			)}
		</>
	);
}

export function YearPage() {
	const [load, replace, retry] = useOverview();
	return (
		<ToolLayout title="Goals" sections={VIEWS}>
			<div className={styles.page}>{load.status === "ready" ? <WithYear overview={load.data} replace={replace} /> : <LoadState load={load} retry={retry} />}</div>
		</ToolLayout>
	);
}

function WithYear({ overview, replace }: { overview: Overview; replace: (goal: Goal) => void }) {
	const year = useYear(overview);
	return (
		<>
			<YearSwitcher overview={overview} year={year} />
			<YearBody key={year} overview={overview} year={year} replace={replace} />
		</>
	);
}
