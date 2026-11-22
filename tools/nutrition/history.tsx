import { Button } from "../../src/kit/button.tsx";
import { Skeleton } from "../../src/kit/skeleton.tsx";
import { Link } from "../../src/router.tsx";
import { ToolLayout } from "../../src/shell/tool-layout.tsx";
import styles from "./nutrition.module.css";
import type { HistoryDay } from "./types.ts";
import { dayLabel, useJson, VIEWS, whole } from "./ui.tsx";

export function History() {
	const [load, , reload] = useJson<HistoryDay[]>("/history");
	return (
		<ToolLayout title="History" sections={VIEWS}>
			<div className={styles.page}>
				{load.status === "loading" ? (
					<div className={styles.skeletonRows} aria-busy="true">
						{[0, 1, 2, 3, 4].map((row) => (
							<Skeleton key={row} className={styles.rowSkeleton} />
						))}
					</div>
				) : load.status === "error" ? (
					<div className={styles.empty}>
						<p>{load.message}</p>
						<Button onClick={reload}>Try again</Button>
					</div>
				) : load.data.length === 0 ? (
					<p className={styles.empty}>No days logged yet.</p>
				) : (
					<ul className={styles.entries}>
						{load.data.map((day) => (
							<li key={day.date}>
								<Link href={`/nutrition?date=${day.date}`} className={styles.entry}>
									<span className={styles.entryMain}>
										<span className={styles.entryFood}>{dayLabel(day.date, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}</span>
										<span className={styles.entryMeta}>
											{day.entries === 0 ? "Check-in only" : `${day.entries} ${day.entries === 1 ? "entry" : "entries"}`}
											{day.closed ? "" : " · Open"}
										</span>
									</span>
									{day.entries === 0 ? null : (
										<span className={styles.entryNumbers}>
											<span>{whole(day.kcal)} kcal</span>
											<span className={styles.entryMeta}>{whole(day.protein_g)} g protein</span>
										</span>
									)}
								</Link>
							</li>
						))}
					</ul>
				)}
			</div>
		</ToolLayout>
	);
}
