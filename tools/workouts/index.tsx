import { useCallback, useEffect, useState } from "react";
import { Button } from "../../src/kit/button.tsx";
import { Skeleton } from "../../src/kit/skeleton.tsx";
import { cn } from "../../src/kit/utils.ts";
import { Icon } from "../../src/shell/icons.tsx";
import { ToolLayout } from "../../src/shell/tool-layout.tsx";
import { api, ApiError, formatAgo, formatDate, formatRange, type ProgramResponse, type ScheduleDay, type SessionSummary, type SyncState } from "./client.ts";
import { formatLoad, formatVolume } from "./program.ts";
import { deliveryWords, SessionScreen } from "./session.tsx";
import styles from "./workouts.module.css";

type Tab = "today" | "week" | "history";

type Load<T> = { status: "loading" } | { status: "error"; error: ApiError } | { status: "ready"; data: T };

const TABS: { id: Tab; label: string }[] = [
	{ id: "today", label: "Today" },
	{ id: "week", label: "Week" },
	{ id: "history", label: "History" },
];

function readSessionParam(): string | null {
	return new URLSearchParams(window.location.search).get("session");
}

function writeSessionParam(id: string | null) {
	const url = new URL(window.location.href);
	if (id === null) url.searchParams.delete("session");
	else url.searchParams.set("session", id);
	window.history.pushState(null, "", url);
}

function toError(error: unknown): ApiError {
	return error instanceof ApiError ? error : new ApiError(error instanceof Error ? error.message : String(error), 0, null);
}

function ReadError({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
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

function SyncLine({ sync }: { sync: SyncState }) {
	const synced = sync.headSha === null || sync.syncedAt === null ? "training-log hasn't synced yet" : `Synced ${sync.headSha.slice(0, 7)} · ${formatAgo(sync.syncedAt)}`;
	return (
		<p className={styles.syncLine}>
			{synced}
			{sync.lastError === null ? null : ` · last check failed: ${sync.lastError}`}
		</p>
	);
}

function ExerciseList({ day }: { day: ScheduleDay }) {
	if (day.logged !== null)
		return (
			<ol className={styles.exerciseList}>
				{day.logged.map((exercise, index) => (
					<li key={index} className={cn(styles.exerciseLine, styles.loggedLine)}>
						<span className={styles.exerciseName}>{exercise.name}</span>
						<span className={styles.loggedSets}>{exercise.summary}</span>
					</li>
				))}
			</ol>
		);
	return (
		<ol className={styles.exerciseList}>
			{day.exercises.map((exercise) => (
				<li key={exercise.position} className={styles.exerciseLine}>
					<span className={styles.exerciseName}>{exercise.name}</span>
					<span className={styles.exerciseRx}>{[formatLoad(exercise), formatVolume(exercise)].filter(Boolean).join(" · ")}</span>
				</li>
			))}
		</ol>
	);
}

function DayCard({ day, today, busy, onStart, onOpen }: { day: ScheduleDay; today: string; busy: boolean; onStart: (day: ScheduleDay) => void; onOpen: (id: string) => void }) {
	const when = day.date === today ? "Today" : formatDate(day.date);
	return (
		<section className={styles.dayCard} aria-label={`${day.weekId.toUpperCase()} ${day.title}`}>
			<header className={styles.dayHead}>
				<div>
					<p className={styles.eyebrow}>
						{day.weekId.toUpperCase()} · {when}
					</p>
					<h2 className={styles.dayTitle}>{day.title}</h2>
				</div>
			</header>
			<ExerciseList day={day} />
			{day.state === "logged" ? null : day.sessionId !== null ? (
				<Button variant={day.state === "open" ? "primary" : "secondary"} className={styles.cta} onClick={() => day.sessionId !== null && onOpen(day.sessionId)}>
					{day.state === "open" ? "Continue logging" : "View session"}
				</Button>
			) : (
				<Button variant="primary" className={styles.cta} loading={busy} onClick={() => onStart(day)}>
					Start session
				</Button>
			)}
		</section>
	);
}

function TodaySkeleton() {
	return (
		<div className={styles.dayCard} aria-busy="true">
			<Skeleton className="h-3 w-24" />
			<Skeleton className="h-6 w-40" />
			{[0, 1, 2, 3, 4].map((row) => (
				<Skeleton key={row} className="h-4 w-full" />
			))}
		</div>
	);
}

function HistoryList({ sessions, onOpen }: { sessions: SessionSummary[]; onOpen: (id: string) => void }) {
	if (sessions.length === 0) return <p className={styles.empty}>Sessions you log here show up in this list.</p>;
	return (
		<ul className={styles.historyList}>
			{sessions.map((session) => (
				<li key={session.id}>
					<button type="button" className={styles.historyRow} onClick={() => onOpen(session.id)}>
						<span className={styles.historyMain}>
							<span className={styles.exerciseName}>
								{session.test ? <span className={styles.testTag}>Test · </span> : null}
								{session.weekId.toUpperCase()} {session.title}
							</span>
							<span className={styles.exerciseRx}>{formatDate(session.date)}</span>
						</span>
						<span className={styles.stateText}>{session.status === "open" ? "In progress" : deliveryWords(session.delivery)}</span>
						<Icon name="chevron-right" />
					</button>
				</li>
			))}
		</ul>
	);
}

export default function Workouts() {
	const [tab, setTab] = useState<Tab>("today");
	const [sessionId, setSessionId] = useState<string | null>(readSessionParam);
	const [program, setProgram] = useState<Load<ProgramResponse>>({ status: "loading" });
	const [history, setHistory] = useState<Load<SessionSummary[]>>({ status: "loading" });
	const [starting, setStarting] = useState<string | null>(null);
	const [weekKey, setWeekKey] = useState<string | null>(null);
	const [startError, setStartError] = useState<string | null>(null);

	const loadProgram = useCallback(() => {
		setProgram((current) => (current.status === "ready" ? current : { status: "loading" }));
		api.program(weekKey ?? undefined).then(
			(data) => setProgram({ status: "ready", data }),
			(error: unknown) => setProgram({ status: "error", error: toError(error) }),
		);
	}, [weekKey]);

	const loadHistory = useCallback(() => {
		api.sessions().then(
			({ sessions }) => setHistory({ status: "ready", data: sessions }),
			(error: unknown) => setHistory({ status: "error", error: toError(error) }),
		);
	}, []);

	useEffect(() => {
		const onPop = () => setSessionId(readSessionParam());
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, []);

	useEffect(() => {
		if (sessionId !== null) return;
		loadProgram();
		loadHistory();
	}, [sessionId, loadProgram, loadHistory]);

	const open = (id: string | null) => {
		writeSessionParam(id);
		setSessionId(id);
	};

	const start = async (day: ScheduleDay) => {
		setStarting(`${day.blockId}/${day.weekId}/${day.dayId}`);
		setStartError(null);
		try {
			const { session } = await api.start(day.blockId, day.weekId, day.dayId);
			open(session.id);
		} catch (error) {
			setStartError(toError(error).message);
		} finally {
			setStarting(null);
		}
	};

	if (sessionId !== null) return <SessionScreen id={sessionId} onClose={() => open(null)} />;

	const data = program.status === "ready" ? program.data : null;
	const next = data?.next ?? null;
	const weekIndex = data === null || data.week === null ? -1 : data.weeks.findIndex((week) => week.key === data.week?.key);
	const previousWeek = data === null || weekIndex <= 0 ? null : (data.weeks[weekIndex - 1] ?? null);
	const followingWeek = data === null || weekIndex === -1 ? null : (data.weeks[weekIndex + 1] ?? null);
	const busyKey = (day: ScheduleDay) => `${day.blockId}/${day.weekId}/${day.dayId}`;

	return (
		<ToolLayout title="Workouts">
			<div className={styles.page}>
				<div className={styles.tabs} role="tablist" aria-label="Views">
					{TABS.map((item) => (
						<button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={styles.tab} onClick={() => setTab(item.id)}>
							{item.label}
						</button>
					))}
				</div>

				{program.status === "ready" && !program.data.webhookReady ? (
					<div className={styles.notice} data-tone="quiet">
						<Icon name="info" />
						<p>Coach's webhook isn't configured. Finished sessions wait here and send once it is.</p>
					</div>
				) : null}
				{startError === null ? null : (
					<div className={styles.notice} role="alert">
						<Icon name="alert" />
						<p>{startError}</p>
					</div>
				)}

				<div key={tab} className={styles.view}>
					{tab === "history" ? (
						history.status === "loading" ? (
							<TodaySkeleton />
						) : history.status === "error" ? (
							<ReadError error={history.error} onRetry={loadHistory} />
						) : (
							<HistoryList sessions={history.data} onOpen={open} />
						)
					) : program.status === "loading" ? (
						<TodaySkeleton />
					) : program.status === "error" ? (
						<ReadError error={program.error} onRetry={loadProgram} />
					) : tab === "today" ? (
						<>
							{next === null ? (
								<p className={styles.empty}>{program.data.weeks.length === 0 ? "No program yet. It appears here after training-log syncs." : "Every planned day is logged. The next week appears here once it's in training-log."}</p>
							) : (
								<>
									{next.date > program.data.today ? <p className={styles.eyebrow}>Next up</p> : null}
									<DayCard day={next} today={program.data.today} busy={starting === busyKey(next)} onStart={(day) => void start(day)} onOpen={open} />
								</>
							)}
							<SyncLine sync={program.data.sync} />
						</>
					) : (
						<>
							{program.data.week === null ? (
								<p className={styles.empty}>No program yet. It appears here after training-log syncs.</p>
							) : (
								<section className={styles.week}>
									<div className={styles.weekNav}>
										<Button variant="quiet" disabled={previousWeek === null} aria-label="Previous week" onClick={() => previousWeek !== null && setWeekKey(previousWeek.key)}>
											<Icon name="back" />
										</Button>
										<div className={styles.weekHeading}>
											<h2 className={styles.weekTitle}>
												{program.data.week.blockName} · {program.data.week.weekId.toUpperCase()}
											</h2>
											<p className={styles.exerciseRx}>
												{formatRange(program.data.week.start, program.data.week.end)}
												{program.data.week.key === program.data.currentWeek ? " · this week" : null}
											</p>
										</div>
										<Button variant="quiet" disabled={followingWeek === null} aria-label="Next week" onClick={() => followingWeek !== null && setWeekKey(followingWeek.key)}>
											<Icon name="chevron-right" />
										</Button>
									</div>
									{program.data.week.key === program.data.currentWeek ? null : (
										<Button size="sm" variant="quiet" className={styles.thisWeek} onClick={() => setWeekKey(program.data.currentWeek)}>
											Back to this week
										</Button>
									)}
									{program.data.week.days.map((day) => (
										<details key={day.dayId} className={styles.weekDay} open={day.dayId === next?.dayId && day.weekId === next.weekId && day.blockId === next.blockId}>
											<summary className={styles.weekSummary}>
												<span className={styles.historyMain}>
													<span className={styles.exerciseName}>{day.title}</span>
													<span className={styles.exerciseRx}>{formatDate(day.date)}</span>
												</span>
											</summary>
											<div className={styles.weekBody}>
												<ExerciseList day={day} />
												{day.state === "logged" ? null : day.sessionId !== null ? (
													<Button size="sm" onClick={() => day.sessionId !== null && open(day.sessionId)}>
														{day.state === "open" ? "Continue logging" : "View session"}
													</Button>
												) : (
													<Button size="sm" loading={starting === busyKey(day)} onClick={() => void start(day)}>
														Start session
													</Button>
												)}
											</div>
										</details>
									))}
								</section>
							)}
							<SyncLine sync={program.data.sync} />
						</>
					)}
				</div>
			</div>
		</ToolLayout>
	);
}
