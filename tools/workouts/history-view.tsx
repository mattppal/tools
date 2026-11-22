import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
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

function RecoveryCard({ data, onOpenWeek }: { data: HistoryTimeline; onOpenWeek: (key: string) => void }) {
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
			<Strip data={data} onOpenWeek={onOpenWeek} />
		</section>
	);
}

type StripWeek = TimelineWeek & { label: string; blockName: string };
type Active = { key: string; via: "hover" | "focus" | "touch" };

function sessionsValue(week: TimelineWeek): string {
	return week.planned === 0 ? plural(week.done, "session") : `${week.done} of ${plural(week.planned, "session")}`;
}

function Strip({ data, onOpenWeek }: { data: HistoryTimeline; onOpenWeek: (key: string) => void }) {
	const box = useRef<HTMLDivElement>(null);
	const tip = useRef<HTMLDivElement>(null);
	const bars = useRef(new Map<string, HTMLButtonElement>());
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const pointer = useRef<string>("mouse");
	const armed = useRef<string | null>(null);
	const [active, setActive] = useState<Active | null>(null);
	const [left, setLeft] = useState(0);
	const weeks: StripWeek[] = data.blocks.flatMap((block) => block.weeks.map((week, index) => ({ ...week, label: weekLabel(week, index), blockName: block.name })));
	const shown = active === null ? undefined : weeks.find((week) => week.key === active.key);
	const max = Math.max(1, ...weeks.map((week) => (week.start > data.today ? Math.max(week.done, week.planned) : week.done)));
	const rover = active?.key ?? data.currentWeek ?? weeks[0]?.key;

	useLayoutEffect(() => {
		const bar = shown === undefined ? undefined : bars.current.get(shown.key);
		if (bar === undefined || box.current === null || tip.current === null) return;
		const frame = box.current.getBoundingClientRect();
		const rect = bar.getBoundingClientRect();
		const half = tip.current.offsetWidth / 2;
		setLeft(Math.min(Math.max(rect.left - frame.left + rect.width / 2, half), frame.width - half));
	}, [shown]);

	useEffect(() => () => clearTimeout(timer.current), []);

	const show = (key: string, via: Active["via"]) => {
		clearTimeout(timer.current);
		if (via === "hover" && active === null) timer.current = setTimeout(() => setActive({ key, via }), 120);
		else setActive({ key, via });
	};
	const hide = () => {
		armed.current = null;
		clearTimeout(timer.current);
		timer.current = setTimeout(() => setActive(null), 80);
	};
	const move = (from: string, step: number | "first" | "last") => {
		const index = weeks.findIndex((week) => week.key === from);
		const next = step === "first" ? weeks[0] : step === "last" ? weeks.at(-1) : weeks[Math.min(Math.max(index + step, 0), weeks.length - 1)];
		if (next !== undefined) bars.current.get(next.key)?.focus();
	};

	return (
		<div ref={box} className={styles.strip} onPointerLeave={() => active?.via === "hover" && hide()}>
			<div className={styles.stripBlocks} role="group" aria-label="Weeks by block">
				{data.blocks.map((block) => (
					<div key={block.blockId} className={styles.stripBlock} style={{ flexGrow: Math.max(block.weeks.length, 1) }} data-active={shown?.blockId === block.blockId ? "" : undefined}>
						<div className={styles.stripBars}>
							{block.weeks.map((timelineWeek) => {
								const week = weeks.find((candidate) => candidate.key === timelineWeek.key) as StripWeek;
								const ahead = week.start > data.today;
								return (
									<button
										key={week.key}
										ref={(node) => {
											if (node === null) bars.current.delete(week.key);
											else bars.current.set(week.key, node);
										}}
										type="button"
										tabIndex={week.key === rover ? 0 : -1}
										className={styles.stripWeek}
										aria-label={`${week.blockName}, ${week.label}, ${formatRange(week.start, week.end)}: ${sessionsValue(week)}`}
										data-ahead={ahead ? "" : undefined}
										data-recovery={week.deload || week.recovery ? "" : undefined}
										data-current={week.key === data.currentWeek ? "" : undefined}
										data-active={shown?.key === week.key ? "" : undefined}
										onPointerDown={(event) => {
											pointer.current = event.pointerType;
										}}
										onPointerEnter={(event) => event.pointerType === "mouse" && show(week.key, "hover")}
										onFocus={() => show(week.key, pointer.current === "touch" ? "touch" : "focus")}
										onBlur={hide}
										onKeyDown={(event) => {
											pointer.current = "keyboard";
											const step = { ArrowLeft: -1, ArrowRight: 1, Home: "first", End: "last" }[event.key] as number | "first" | "last" | undefined;
											if (step !== undefined) {
												event.preventDefault();
												move(week.key, step);
											} else if (event.key === "Escape") setActive(null);
										}}
										onClick={() => {
											if (pointer.current === "touch" && armed.current !== week.key) {
												armed.current = week.key;
												show(week.key, "touch");
												return;
											}
											onOpenWeek(week.key);
										}}
									>
										<span className={styles.stripFill} style={{ "--fill": `${((ahead ? Math.max(week.done, week.planned) : week.done) / max) * 100}%` } as CSSProperties} />
									</button>
								);
							})}
						</div>
						<span className={styles.stripLabel}>{block.name}</span>
					</div>
				))}
			</div>
			{shown === undefined ? null : (
				<div ref={tip} role="tooltip" className={styles.stripTip} style={{ left }}>
					<span className={styles.stripTipBlock}>{shown.blockName}</span>
					<span className={styles.stripTipTitle}>
						{shown.label} · {formatRange(shown.start, shown.end)}
					</span>
					<span>{sessionsValue(shown)}</span>
				</div>
			)}
		</div>
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
			<RecoveryCard data={data} onOpenWeek={onOpenWeek} />
			{data.blocks.toReversed().map((block) => (
				<BlockSection key={block.blockId} block={block} data={data} onOpenWeek={onOpenWeek} />
			))}
		</>
	);
}
