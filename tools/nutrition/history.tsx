import { useState } from "react";
import { Button } from "../../src/kit/button.tsx";
import { Skeleton } from "../../src/kit/skeleton.tsx";
import { Link } from "../../src/router.tsx";
import { ToolLayout } from "../../src/shell/tool-layout.tsx";
import styles from "./nutrition.module.css";
import { type HistoryDay, PARTIAL_DAY_SHARE } from "./types.ts";
import { dayLabel, useJson, VIEWS, whole } from "./ui.tsx";

const FILTERS = [
	{ id: "logged", label: "Logged" },
	{ id: "partial", label: "With partial" },
	{ id: "all", label: "All days" },
] as const;

type Filter = (typeof FILTERS)[number]["id"];

const STORAGE_KEY = "nutrition.history.filter";

function savedFilter(): Filter {
	const saved = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
	return FILTERS.find((filter) => filter.id === saved)?.id ?? "logged";
}

function shows(day: HistoryDay, filter: Filter): boolean {
	if (filter === "all") return true;
	if (day.entries === 0) return false;
	return filter === "partial" || !day.partial;
}

function hiddenNote(days: HistoryDay[], filter: Filter): string {
	const partial = filter === "logged" ? days.filter((day) => day.partial).length : 0;
	const empty = filter === "all" ? 0 : days.filter((day) => day.entries === 0).length;
	const parts = [partial > 0 ? `${partial} partial` : null, empty > 0 ? `${empty} with no entries` : null].filter((part) => part !== null);
	if (parts.length === 0) return "";
	return `${parts.join(" and ")} hidden. Partial means closed under ${PARTIAL_DAY_SHARE * 100}% of the day's kcal target.`;
}

function dayMeta(day: HistoryDay): string {
	const parts = [day.entries === 0 ? "Check-in only" : `${day.entries} ${day.entries === 1 ? "entry" : "entries"}`];
	if (day.partial && day.kcalTarget !== null) parts.push(`Partial, ${whole((day.kcal / day.kcalTarget) * 100)}% of target`);
	if (day.steps !== null && day.steps !== undefined) parts.push(`${whole(day.steps)} steps`);
	if (!day.closed) parts.push("Open");
	return parts.join(" · ");
}

export function History() {
	const [load, , reload] = useJson<HistoryDay[]>("/history");
	const [filter, setFilter] = useState<Filter>(savedFilter);
	const choose = (next: Filter) => {
		setFilter(next);
		localStorage.setItem(STORAGE_KEY, next);
	};
	const days = load.status === "ready" ? load.data : [];
	const visible = days.filter((day) => shows(day, filter));
	const note = hiddenNote(days, filter);
	return (
		<ToolLayout title="History" sections={VIEWS}>
			<div className={styles.page}>
				<div className={styles.segmented} role="group" aria-label="Days to show">
					{FILTERS.map((option) => (
						<Button key={option.id} size="sm" variant="quiet" aria-pressed={option.id === filter} onClick={() => choose(option.id)}>
							{option.label}
						</Button>
					))}
				</div>
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
				) : days.length === 0 ? (
					<p className={styles.empty}>No days logged yet.</p>
				) : (
					<>
						{visible.length === 0 ? (
							<p className={styles.empty}>No days match. Choose All days to see the rest.</p>
						) : (
							<ul className={styles.entries}>
								{visible.map((day) => (
									<li key={day.date}>
										<Link href={`/nutrition?date=${day.date}`} className={styles.entry}>
											<span className={styles.entryMain}>
												<span className={styles.entryFood}>{dayLabel(day.date, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}</span>
												<span className={styles.entryMeta}>{dayMeta(day)}</span>
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
						{note === "" ? null : <p className={styles.note}>{note}</p>}
					</>
				)}
			</div>
		</ToolLayout>
	);
}
