import { ToolLayout } from "../../src/shell/tool-layout.tsx";
import styles from "./goals.module.css";
import { AREA_LABELS, AREAS, type Overview, STATUS_LABELS } from "./types.ts";
import { LoadState, useOverview, VIEWS } from "./ui.tsx";

function Themes({ overview }: { overview: Overview }) {
	const goals = overview.goals.filter((goal) => goal.horizon === "year");
	const years = [...new Set(goals.map((goal) => goal.year))].toSorted((a, b) => b - a);
	const areas = AREAS.filter((area) => goals.some((goal) => goal.area === area));
	if (areas.length === 0) return <p className={styles.empty}>Year goals show up here, by area, across years.</p>;
	return (
		<>
			<p className={styles.meta}>Each area's year goals, newest year first.</p>
			{areas.map((area) => (
				<section key={area} className={styles.area} aria-labelledby={`theme-${area}`}>
					<h2 id={`theme-${area}`} className={styles.areaTitle}>
						{AREA_LABELS[area]}
					</h2>
					<dl className={styles.themeYears}>
						{years.map((year) => {
							const inYear = goals.filter((goal) => goal.area === area && goal.year === year);
							return (
								<div key={year} className={styles.themeRow}>
									<dt>{year}</dt>
									<dd>
										{inYear.length === 0 ? (
											<span className={styles.meta}>Nothing set</span>
										) : (
											inYear.map((goal) => (
												<span key={goal.id} className={styles.themeGoal}>
													{goal.title} <span className={styles.meta}>{STATUS_LABELS[goal.status]}</span>
												</span>
											))
										)}
									</dd>
								</div>
							);
						})}
					</dl>
				</section>
			))}
		</>
	);
}

export function ThemesPage() {
	const [load, , retry] = useOverview();
	return (
		<ToolLayout title="Themes" sections={VIEWS}>
			<div className={styles.page}>{load.status === "ready" ? <Themes overview={load.data} /> : <LoadState load={load} retry={retry} />}</div>
		</ToolLayout>
	);
}
