import { useEffect, useState } from "react";
import { Skeleton } from "../../src/kit/skeleton.tsx";
import { ToolLayout } from "../../src/shell/tool-layout.tsx";
import styles from "./activity.module.css";
import type { ActivityDay } from "./store.ts";

type DaysResponse = { days: ActivityDay[]; withings: { connectedAt: string; backfillDone: boolean; lastError: string | null } | null };
type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: DaysResponse };

const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const tenths = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function dayLabel(date: string): string {
	return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function status(withings: DaysResponse["withings"]): string {
	if (withings === null) return "Withings is not connected.";
	if (withings.lastError !== null) return withings.lastError;
	return withings.backfillDone ? "From Withings, updated every 30 minutes." : "From Withings. Older days are still loading.";
}

export default function Activity() {
	const [load, setLoad] = useState<Load>({ status: "loading" });
	useEffect(() => {
		let live = true;
		fetch("/api/tools/activity/days")
			.then(async (response) => {
				if (!response.ok) throw new Error(`Request failed with ${response.status}`);
				return (await response.json()) as DaysResponse;
			})
			.then(
				(data) => live && setLoad({ status: "ready", data }),
				(error: unknown) => live && setLoad({ status: "error", message: error instanceof Error ? error.message : String(error) }),
			);
		return () => {
			live = false;
		};
	}, []);
	return (
		<ToolLayout title="Activity">
			<div className={styles.page}>
				{load.status === "loading" ? (
					<div className={styles.skeletonRows} aria-busy="true">
						{[0, 1, 2, 3, 4].map((row) => (
							<Skeleton key={row} className={styles.rowSkeleton} />
						))}
					</div>
				) : load.status === "error" ? (
					<p className={styles.empty}>{load.message}</p>
				) : (
					<>
						<p className={styles.note}>{status(load.data.withings)}</p>
						{load.data.days.length === 0 ? (
							<p className={styles.empty}>No activity in the last 90 days.</p>
						) : (
							<ul className={styles.days}>
								{load.data.days.map((day) => (
									<li key={day.date} className={styles.day}>
										<span className={styles.main}>
											<span>{dayLabel(day.date)}</span>
											<span className={styles.meta}>{day.distanceM === null ? "No distance" : `${tenths.format(day.distanceM / 1609.344)} mi`}</span>
										</span>
										<span className={styles.numbers}>
											<span>{day.steps === null ? "No steps" : `${whole.format(day.steps)} steps`}</span>
											<span className={styles.meta}>{day.activeKcal === null ? "No active kcal" : `${whole.format(day.activeKcal)} active kcal`}</span>
										</span>
									</li>
								))}
							</ul>
						)}
					</>
				)}
			</div>
		</ToolLayout>
	);
}
