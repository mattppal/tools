import type { CSSProperties } from "react";
import { Icon } from "../../src/shell/icons.tsx";
import { formatRange, type HistoryTimeline, type TimelineBlock, type TimelineMark, type TimelineWeek } from "./client.ts";
import styles from "./workouts.module.css";

function plural(count: number, word: string, many = `${word}s`): string {
	return `${count} ${count === 1 ? word : many}`;
}

export function weekLabel(week: TimelineWeek, index: number): string {
	const number = `W${index + 1}`;
	return week.weekId.toLowerCase() === number.toLowerCase() ? number : `${number} · ${week.weekId}`;
}

function labelFor(data: HistoryTimeline, key: string): string | null {
	for (const block of data.blocks) {
		const index = block.weeks.findIndex((week) => week.key === key);
		const week = block.weeks[index];
		if (week !== undefined) return weekLabel(week, index);
	}
	return null;
}

function weekWords(week: TimelineWeek, today: string): string {
	const kind = week.deload ? "Deload" : week.recovery ? "Recovery" : null;
	const counts = [week.lift > 0 ? plural(week.lift, "lift") : null, week.conditioning > 0 ? `${week.conditioning} conditioning` : null, week.skipped > 0 ? `${week.skipped} skipped` : null].filter((part) => part !== null);
	const fallback = week.start > today ? "Planned" : week.end < today ? "Nothing logged" : null;
	return [kind, ...(counts.length > 0 ? counts : [fallback])].filter((part) => part !== null).join(" · ");
}

function ago(weeks: number, ahead: boolean): string {
	if (weeks === 0) return "this week";
	return ahead ? `in ${plural(weeks, "week")}` : `${plural(weeks, "week")} ago`;
}

function markLine(data: HistoryTimeline, mark: TimelineMark): string {
	return `${formatRange(mark.start, mark.end)} · ${mark.blockName}, ${labelFor(data, mark.key) ?? mark.weekId.toUpperCase()}`;
}

function RecoveryCard({ data }: { data: HistoryTimeline }) {
	const last = data.lastRecovery;
	const when = last === null ? "" : ago(last.weeks, false);
	return (
		<section className={styles.dayCard} aria-label="Recovery weeks">
			<div>
				<p className={styles.eyebrow}>Last recovery week</p>
				{last === null ? (
					<h2 className={styles.dayTitle}>None yet</h2>
				) : (
					<>
						<h2 className={styles.dayTitle}>{when.charAt(0).toUpperCase() + when.slice(1)}</h2>
						<p className={styles.loggedSets}>
							{markLine(data, last)}
						</p>
					</>
				)}
			</div>
			<p className={styles.dayNote}>
				{data.nextDeload === null ? (
					"No deload is planned in training-log yet."
				) : (
					<>
						Next planned deload {ago(data.nextDeload.weeks, true)}: {markLine(data, data.nextDeload)}
					</>
				)}
			</p>
		</section>
	);
}

function Strip({ data }: { data: HistoryTimeline }) {
	const max = Math.max(1, ...data.blocks.flatMap((block) => block.weeks.map((week) => week.done)));
	const summary = data.blocks.map((block) => `${block.name}, ${plural(block.weeks.length, "week")}`).join("; ");
	return (
		<figure className={styles.strip} role="img" aria-label={`Weeks by block: ${summary}`}>
			<div className={styles.stripBlocks}>
				{data.blocks.map((block) => (
					<div key={block.blockId} className={styles.stripBlock} style={{ flexGrow: Math.max(block.weeks.length, 1) }}>
						<div className={styles.stripBars}>
							{block.weeks.map((week) => (
								<span
									key={week.key}
									className={styles.stripWeek}
									data-ahead={week.start > data.today ? "" : undefined}
									data-recovery={week.deload || week.recovery ? "" : undefined}
									data-current={week.key === data.currentWeek ? "" : undefined}
								>
									<span className={styles.stripFill} style={{ "--fill": `${(week.done / max) * 100}%` } as CSSProperties} />
								</span>
							))}
						</div>
						<span className={styles.stripLabel}>{block.name}</span>
					</div>
				))}
			</div>
			<figcaption className={styles.syncLine}>Bar height is sessions logged that week. Blue marks deload and recovery weeks, the outlined bar is this week, and dashed bars are still ahead.</figcaption>
		</figure>
	);
}

function BlockSection({ block, data, onOpenWeek }: { block: TimelineBlock; data: HistoryTimeline; onOpenWeek: (key: string) => void }) {
	const current = block.starts <= data.today && data.today <= block.ends;
	return (
		<section className={styles.block} aria-label={block.name}>
			<header className={styles.blockHead}>
				<h3 className={styles.weekTitle}>{block.name}</h3>
				<p className={styles.loggedSets}>
					{formatRange(block.starts, block.ends)} · {plural(block.weeks.length, "week")} · {plural(block.sessions, "session")}
					{current ? " · this block" : null}
				</p>
				{block.goal === null ? null : <p className={styles.rxNote}>{block.goal}</p>}
			</header>
			<ul className={styles.historyList}>
				{block.weeks.map((week, index) => (
					<li key={week.key}>
						<button type="button" className={styles.historyRow} onClick={() => onOpenWeek(week.key)}>
							<span className={styles.historyMain}>
								<span className={styles.exerciseName}>{weekLabel(week, index)}</span>
								<span className={styles.exerciseRx}>
									{formatRange(week.start, week.end)}
									{week.key === data.currentWeek ? " · this week" : null}
								</span>
							</span>
							<span className={styles.stateText}>{weekWords(week, data.today)}</span>
							<Icon name="chevron-right" />
						</button>
					</li>
				))}
			</ul>
		</section>
	);
}

export function Timeline({ data, onOpenWeek }: { data: HistoryTimeline; onOpenWeek: (key: string) => void }) {
	if (data.blocks.length === 0) return <p className={styles.empty}>Blocks appear here after training-log syncs.</p>;
	return (
		<>
			<RecoveryCard data={data} />
			<Strip data={data} />
			{data.blocks.toReversed().map((block) => (
				<BlockSection key={block.blockId} block={block} data={data} onOpenWeek={onOpenWeek} />
			))}
		</>
	);
}
