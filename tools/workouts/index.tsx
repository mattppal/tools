import { useCallback, useEffect, useState } from "react";
import { Button } from "../../src/kit/button.tsx";
import { Skeleton } from "../../src/kit/skeleton.tsx";
import { cn } from "../../src/kit/utils.ts";
import { Icon } from "../../src/shell/icons.tsx";
import { ToolLayout } from "../../src/shell/tool-layout.tsx";
import { api, ApiError, formatDate, type ProgramResponse, type SessionSummary } from "./client.ts";
import { formatLoad, formatVolume } from "./program.ts";
import type { ScheduleDay } from "./schedule.ts";
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
	const message =
		error.code === "missing_token"
			? "TRAINING_LOG_TOKEN isn't set on the Worker, so the program can't be read."
			: error.code === "no_access"
				? "GitHub refused TRAINING_LOG_TOKEN. Check that it can read mattppal/training-log."
				: error.message;
	return (
		<div className={styles.notice} role="alert">
			<Icon name="alert" />
			<div className={styles.noticeBody}>
				<p>{message}</p>
				<Button size="sm" onClick={onRetry}>
					Try again
				</Button>
			</div>
		</div>
	);
}

function ExerciseList({ day }: { day: ScheduleDay }) {
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
	const [startError, setStartError] = useState<string | null>(null);

	const loadProgram = useCallback(() => {
		setProgram((current) => (current.status === "ready" ? current : { status: "loading" }));
		api.program().then(
			(data) => setProgram({ status: "ready", data }),
			(error: unknown) => setProgram({ status: "error", error: toError(error) }),
		);
	}, []);

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
		setStarting(`${day.weekId}/${day.dayId}`);
		setStartError(null);
		try {
			const { session } = await api.start(day.weekId, day.dayId);
			open(session.id);
		} catch (error) {
			setStartError(toError(error).message);
		} finally {
			setStarting(null);
		}
	};

	if (sessionId !== null) return <SessionScreen id={sessionId} onClose={() => open(null)} />;

	const schedule = program.status === "ready" ? program.data.schedule : null;
	const next = schedule?.next ?? null;

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
						next === null ? (
							<p className={styles.empty}>Every day in {program.data.schedule.block.name} is logged. The next block appears here once it's in training-log.</p>
						) : (
							<>
								{next.date > program.data.schedule.today ? <p className={styles.eyebrow}>Next up</p> : null}
								<DayCard day={next} today={program.data.schedule.today} busy={starting === `${next.weekId}/${next.dayId}`} onStart={(day) => void start(day)} onOpen={open} />
							</>
						)
					) : (
						program.data.schedule.weeks.map((week) => (
							<section key={week.weekId} className={styles.week}>
								<h2 className={styles.weekTitle}>
									{program.data.schedule.block.name} · {week.weekId.toUpperCase()}
									{week.weekId === program.data.schedule.currentWeek ? <span className={styles.exerciseRx}> · this week</span> : null}
								</h2>
								{week.days.map((day) => (
									<details key={day.dayId} className={cn(styles.weekDay)} open={day.weekId === next?.weekId && day.dayId === next.dayId}>
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
												<Button size="sm" loading={starting === `${day.weekId}/${day.dayId}`} onClick={() => void start(day)}>
													Start session
												</Button>
											)}
										</div>
									</details>
								))}
							</section>
						))
					)}
				</div>
			</div>
		</ToolLayout>
	);
}
