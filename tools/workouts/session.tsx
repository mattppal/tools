import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../src/kit/button.tsx";
import { Input } from "../../src/kit/input.tsx";
import { Skeleton } from "../../src/kit/skeleton.tsx";
import { cn } from "../../src/kit/utils.ts";
import { Icon } from "../../src/shell/icons.tsx";
import { ToolLayout } from "../../src/shell/tool-layout.tsx";
import { api, ApiError, asWrittenValues, describeSet, formatDate, type SessionDetail, type SessionSummary, type SetDraft } from "./client.ts";
import type { ExerciseRow } from "./log.ts";
import { formatLoad, formatVolume } from "./program.ts";
import styles from "./workouts.module.css";

const RIR_CHOICES = [0, 1, 2, 3, 4, 5, 6];

type SaveState = "idle" | "saving" | "saved" | "failed";

type Row = { draft: SetDraft; weightText: string; repsText: string; save: SaveState; error: string | null };

function emptyDraft(): SetDraft {
	return { weight: null, unit: null, reps: null, rir: null, asWritten: false, notes: null };
}

function rowFromSet(set: ExerciseRow["sets"][number] | undefined): Row {
	if (set === undefined) return { draft: emptyDraft(), weightText: "", repsText: "", save: "idle", error: null };
	const weight = set.weight === null ? null : Number(set.weight);
	return {
		draft: { weight, unit: set.unit, reps: set.reps, rir: set.rir, asWritten: set.as_written, notes: set.notes },
		weightText: weight === null ? "" : String(weight),
		repsText: set.reps === null ? "" : String(set.reps),
		save: "saved",
		error: null,
	};
}

function isEmpty(draft: SetDraft): boolean {
	return draft.weight === null && draft.reps === null && draft.rir === null && (draft.notes ?? "") === "";
}

function rowsFor(exercise: ExerciseRow): Row[] {
	const highest = exercise.sets.reduce((max, set) => Math.max(max, set.set_index + 1), 0);
	const count = Math.max(exercise.prescribed.sets ?? 1, highest, 1);
	return Array.from({ length: count }, (_, index) => rowFromSet(exercise.sets.find((set) => set.set_index === index)));
}

function parseNumber(text: string): number | null | "invalid" {
	const trimmed = text.trim();
	if (trimmed === "") return null;
	const value = Number(trimmed);
	return Number.isFinite(value) && value >= 0 ? value : "invalid";
}

export function DeliveryBadge({ delivery }: { delivery: SessionSummary["delivery"] }) {
	if (delivery === null) return null;
	if (delivery.deliveredAt !== null) return <span className={styles.stateTag} data-state="finished">Sent to coach</span>;
	if (delivery.attempts === 0) return <span className={styles.stateTag} data-state="open">Waiting to send</span>;
	return <span className={styles.stateTag} data-state="failed">Retrying</span>;
}

function SaveStatus({ row, onRetry }: { row: Row; onRetry: () => void }) {
	if (row.save === "saving") return <span className={styles.saveStatus}>Saving</span>;
	if (row.save === "failed")
		return (
			<button type="button" className={styles.saveFailed} onClick={onRetry} title={row.error ?? undefined}>
				Didn't save · Retry
			</button>
		);
	if (row.save === "saved") return <span className={styles.saveStatus}>Saved</span>;
	return null;
}

function SetRowEditor({
	index,
	row,
	unit,
	asWritten,
	onChange,
	onCommit,
	onClear,
}: {
	index: number;
	row: Row;
	unit: "lb" | "kg";
	asWritten: SetDraft | null;
	onChange: (row: Row) => void;
	onCommit: (row: Row) => void;
	onClear: () => void;
}) {
	const repsInput = useRef<HTMLInputElement>(null);
	const weightValue = parseNumber(row.weightText);
	const repsValue = parseNumber(row.repsText);
	const repsInvalid = repsValue === "invalid" || (typeof repsValue === "number" && !Number.isInteger(repsValue));
	const commitText = () => {
		if (weightValue === "invalid" || repsInvalid) return;
		const draft: SetDraft = { ...row.draft, weight: weightValue, unit: weightValue === null ? null : unit, reps: repsValue as number | null, asWritten: row.draft.asWritten && weightValue === row.draft.weight && (row.draft.reps === null || repsValue === row.draft.reps) };
		if (draft.weight === row.draft.weight && draft.reps === row.draft.reps) return;
		onCommit({ ...row, draft });
	};
	return (
		<li className={styles.setRow}>
			<div className={styles.setHead}>
				<span className={styles.setLabel}>Set {index + 1}</span>
				<SaveStatus row={row} onRetry={() => onCommit(row)} />
				{isEmpty(row.draft) ? null : (
					<button type="button" className={styles.clearSet} onClick={onClear} aria-label={`Clear set ${index + 1}`}>
						<Icon name="close" size={12} />
					</button>
				)}
			</div>
			<div className={styles.setFields}>
				<label className={styles.field}>
					<span className={styles.fieldLabel}>{unit}</span>
					<Input
						inputMode="decimal"
						enterKeyHint="next"
						autoComplete="off"
						aria-label={`Set ${index + 1} weight in ${unit}`}
						aria-invalid={weightValue === "invalid" || undefined}
						className={styles.numberInput}
						value={row.weightText}
						onChange={(event) => onChange({ ...row, weightText: event.target.value })}
						onBlur={commitText}
					/>
				</label>
				<label className={styles.field}>
					<span className={styles.fieldLabel}>reps</span>
					<Input
						inputMode="numeric"
						enterKeyHint="done"
						autoComplete="off"
						ref={repsInput}
						aria-label={`Set ${index + 1} reps`}
						placeholder={row.draft.asWritten && row.repsText === "" ? "?" : undefined}
						aria-invalid={repsInvalid || undefined}
						className={styles.numberInput}
						value={row.repsText}
						onChange={(event) => onChange({ ...row, repsText: event.target.value })}
						onBlur={commitText}
					/>
				</label>
				{asWritten === null ? null : (
					<Button
						size="sm"
						variant="secondary"
						aria-pressed={row.draft.asWritten}
						className={styles.asWritten}
						onClick={() => {
							onCommit({ ...row, draft: { ...asWritten, notes: row.draft.notes }, weightText: asWritten.weight === null ? row.weightText : String(asWritten.weight), repsText: asWritten.reps === null ? row.repsText : String(asWritten.reps) });
							if (asWritten.reps === null && row.repsText === "") repsInput.current?.focus();
						}}
					>
						{row.draft.asWritten ? <Icon name="success" size={12} /> : null}
						As written · {describeSet(asWritten)}
					</Button>
				)}
			</div>
			<div className={styles.rirRow} role="radiogroup" aria-label={`Set ${index + 1} reps in reserve`}>
				<span className={styles.fieldLabel}>RIR</span>
				{RIR_CHOICES.map((value) => (
					<button
						key={value}
						type="button"
						role="radio"
						aria-checked={row.draft.rir === value}
						className={styles.rirChip}
						onClick={() => onCommit({ ...row, draft: { ...row.draft, rir: row.draft.rir === value ? null : value, asWritten: false } })}
					>
						{value}
					</button>
				))}
			</div>
		</li>
	);
}

type SetChange = (position: number, index: number, draft: SetDraft | null) => void;

function applySet(session: SessionDetail, position: number, index: number, draft: SetDraft | null): SessionDetail {
	return {
		...session,
		exercises: session.exercises.map((exercise) => {
			if (exercise.position !== position) return exercise;
			const others = exercise.sets.filter((set) => set.set_index !== index);
			const sets =
				draft === null
					? others
					: [...others, { set_index: index, weight: draft.weight === null ? null : String(draft.weight), unit: draft.unit, reps: draft.reps, rir: draft.rir, as_written: draft.asWritten, notes: draft.notes }].toSorted((a, b) => a.set_index - b.set_index);
			return { ...exercise, status: draft !== null && exercise.status === "planned" ? "completed" : exercise.status, sets };
		}),
	};
}

function ExerciseEditor({ session, exercise, onSession, onSet }: { session: SessionDetail; exercise: ExerciseRow; onSession: (session: SessionDetail) => void; onSet: SetChange }) {
	const [rows, setRows] = useState<Row[]>(() => rowsFor(exercise));
	const [noteOpen, setNoteOpen] = useState(exercise.notes !== null);
	const [note, setNote] = useState(exercise.notes ?? "");
	const [busy, setBusy] = useState(false);
	const prescribed = exercise.prescribed;
	const asWritten = asWrittenValues(prescribed);
	const skipped = exercise.status === "skipped";

	const save = async (index: number, row: Row) => {
		setRows((current) => current.map((candidate, at) => (at === index ? { ...row, save: "saving", error: null } : candidate)));
		try {
			if (isEmpty(row.draft)) await api.deleteSet(session.id, exercise.position, index);
			else await api.putSet(session.id, exercise.position, index, row.draft);
			onSet(exercise.position, index, isEmpty(row.draft) ? null : row.draft);
			setRows((current) => current.map((candidate, at) => (at === index ? { ...candidate, save: isEmpty(row.draft) ? "idle" : "saved" } : candidate)));
		} catch (error) {
			setRows((current) => current.map((candidate, at) => (at === index ? { ...candidate, save: "failed", error: error instanceof Error ? error.message : String(error) } : candidate)));
		}
	};

	const patch = async (change: { status?: "planned" | "skipped"; notes?: string | null }) => {
		setBusy(true);
		try {
			onSession((await api.exercise(session.id, exercise.position, change)).session);
		} finally {
			setBusy(false);
		}
	};

	return (
		<article className={styles.exercise} data-skipped={skipped || undefined}>
			<header className={styles.exerciseHead}>
				<h2 className={styles.dayTitle}>{exercise.name}</h2>
				<p className={styles.rxLine}>{[formatLoad(prescribed), formatVolume(prescribed)].filter(Boolean).join(" · ")}</p>
				{prescribed.notes.map((line) => (
					<p key={line} className={styles.rxNote}>
						{line}
					</p>
				))}
				{prescribed.targetRir !== null && !Number.isInteger(prescribed.targetRir) ? <p className={styles.rxNote}>RIR is logged in whole numbers. Put a half in the set's note.</p> : null}
			</header>

			{skipped ? (
				<p className={styles.empty}>Skipped. It's sent to coach as a skipped exercise.</p>
			) : (
				<ol className={styles.setList}>
					{rows.map((row, index) => (
						<SetRowEditor
							key={index}
							index={index}
							row={row}
							unit={prescribed.unit}
							asWritten={asWritten}
							onChange={(next) => setRows((current) => current.map((candidate, at) => (at === index ? next : candidate)))}
							onCommit={(next) => void save(index, next)}
							onClear={() => void save(index, { draft: emptyDraft(), weightText: "", repsText: "", save: "idle", error: null })}
						/>
					))}
				</ol>
			)}

			{noteOpen ? (
				<label className={styles.noteField}>
					<span className={styles.fieldLabel}>Note</span>
					<textarea
						className={styles.textarea}
						rows={2}
						value={note}
						placeholder="Half RIR, swaps, how it felt"
						onChange={(event) => setNote(event.target.value)}
						onBlur={() => {
							if (note.trim() !== (exercise.notes ?? "")) void patch({ notes: note });
						}}
					/>
				</label>
			) : null}

			<div className={styles.exerciseActions}>
				{skipped ? null : (
					<Button size="sm" variant="quiet" onClick={() => setRows((current) => [...current, rowFromSet(undefined)])}>
						<Icon name="plus" size={12} />
						Add set
					</Button>
				)}
				{noteOpen ? null : (
					<Button size="sm" variant="quiet" onClick={() => setNoteOpen(true)}>
						<Icon name="note" size={12} />
						Note
					</Button>
				)}
				<Button size="sm" variant="quiet" loading={busy} onClick={() => void patch({ status: skipped ? "planned" : "skipped" })}>
					{skipped ? "Unskip" : "Skip exercise"}
				</Button>
			</div>
		</article>
	);
}

function exerciseSummary(exercise: ExerciseRow): string {
	if (exercise.status === "skipped") return "Skipped";
	const logged = exercise.sets.filter((set) => !(set.weight === null && set.reps === null && set.rir === null && (set.notes ?? "") === ""));
	if (logged.length === 0) return "Nothing logged · sent as skipped";
	return logged.map((set) => describeSet({ weight: set.weight === null ? null : Number(set.weight), unit: set.unit, reps: set.reps, rir: set.rir })).join(", ");
}

function DeliveryPanel({ session, onSession }: { session: SessionDetail; onSession: (session: SessionDetail) => void }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const delivery = session.delivery;
	if (delivery === null) return null;
	const resend = async () => {
		setBusy(true);
		setError(null);
		try {
			onSession((await api.redeliver(session.id)).session);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setBusy(false);
		}
	};
	const status =
		delivery.deliveredAt !== null
			? `Coach received it${delivery.lastStatus === null ? "" : ` (HTTP ${delivery.lastStatus})`}.`
			: delivery.attempts === 0
				? "Waiting to send to coach."
				: `Not delivered yet after ${delivery.attempts} ${delivery.attempts === 1 ? "try" : "tries"}${delivery.lastError === null ? "" : ` (${delivery.lastError})`}. It keeps retrying.`;
	return (
		<div className={styles.delivery}>
			<p>{status}</p>
			<p className={styles.rxNote}>Delivery {delivery.deliveryId}</p>
			{error === null ? null : <p className={styles.errorText}>{error}</p>}
			<Button size="sm" loading={busy} onClick={() => void resend()}>
				Send again
			</Button>
		</div>
	);
}

function Review({ session, onSession, onClose }: { session: SessionDetail; onSession: (session: SessionDetail) => void; onClose: () => void }) {
	const [notes, setNotes] = useState(session.notes ?? "");
	const [finishing, setFinishing] = useState(false);
	const [discarding, setDiscarding] = useState(false);
	const [confirmDiscard, setConfirmDiscard] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const open = session.status === "open";

	const finish = async () => {
		setFinishing(true);
		setError(null);
		try {
			if (notes.trim() !== (session.notes ?? "")) await api.notes(session.id, notes);
			onSession((await api.finish(session.id)).session);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setFinishing(false);
		}
	};

	const discard = async () => {
		setDiscarding(true);
		try {
			await api.discard(session.id);
			onClose();
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
			setDiscarding(false);
		}
	};

	return (
		<div className={styles.review}>
			{open ? (
				<ul className={styles.reviewList}>
					{session.exercises.map((exercise) => (
						<li key={exercise.position}>
								<span className={styles.exerciseName}>{exercise.name}</span>
								<span className={cn(styles.exerciseRx, exercise.status !== "skipped" && exercise.sets.length === 0 && styles.warnText)}>{exerciseSummary(exercise)}</span>
						</li>
					))}
				</ul>
			) : null}
			{open ? (
				<>
					<label className={styles.noteField}>
						<span className={styles.fieldLabel}>Session note</span>
						<textarea className={styles.textarea} rows={3} value={notes} placeholder="Sleep, energy, anything coach should know" onChange={(event) => setNotes(event.target.value)} />
					</label>
					{error === null ? null : <p className={styles.errorText}>{error}</p>}
					<Button variant="primary" loading={finishing} onClick={() => void finish()}>
						Finish and send to coach
					</Button>
					{confirmDiscard ? (
						<div className={styles.exerciseActions}>
							<Button variant="destructive" loading={discarding} onClick={() => void discard()}>
								Discard this session
							</Button>
							<Button variant="quiet" onClick={() => setConfirmDiscard(false)}>
								Keep it
							</Button>
						</div>
					) : (
						<Button variant="quiet" onClick={() => setConfirmDiscard(true)}>
							Discard session
						</Button>
					)}
				</>
			) : (
				<>
					{session.notes === null ? null : <p className={styles.rxNote}>{session.notes}</p>}
					<DeliveryPanel session={session} onSession={onSession} />
				</>
			)}
		</div>
	);
}

export function SessionScreen({ id, onClose }: { id: string; onClose: () => void }) {
	const [session, setSession] = useState<SessionDetail | null>(null);
	const [error, setError] = useState<ApiError | null>(null);
	const [index, setIndex] = useState(0);
	const [panelOpen, setPanelOpen] = useState(false);
	const body = useRef<HTMLDivElement>(null);

	const load = useCallback(() => {
		setError(null);
		api.session(id).then(
			({ session: loaded }) => {
				setSession(loaded);
				const firstOpen = loaded.exercises.findIndex((exercise) => exercise.status === "planned");
				setIndex(firstOpen === -1 ? 0 : firstOpen);
			},
			(caught: unknown) => setError(caught instanceof ApiError ? caught : new ApiError(String(caught), 0, null)),
		);
	}, [id]);

	useEffect(load, [load]);

	useEffect(() => {
		body.current?.closest("[data-scrollbar]")?.scrollTo({ top: 0 });
	}, [index]);

	const closeAfterPanel = () => {
		setPanelOpen(false);
		window.setTimeout(onClose, 250);
	};

	const title = session === null ? "Session" : `${session.test ? "Test · " : ""}${session.weekId.toUpperCase()} ${session.title}`;
	const back = (
		<Button size="sm" variant="quiet" onClick={onClose}>
			<Icon name="back" size={12} />
			Back
		</Button>
	);

	if (error !== null)
		return (
			<ToolLayout title={title} actions={back}>
				<div className={styles.page}>
					<div className={styles.notice} role="alert">
						<Icon name="alert" />
						<div className={styles.noticeBody}>
							<p>{error.message}</p>
							<Button size="sm" onClick={load}>
								Try again
							</Button>
						</div>
					</div>
				</div>
			</ToolLayout>
		);

	if (session === null)
		return (
			<ToolLayout title={title} actions={back}>
				<div className={styles.page} aria-busy="true">
					<Skeleton className="h-6 w-48" />
					<Skeleton className="h-4 w-32" />
					{[0, 1, 2].map((row) => (
						<Skeleton key={row} className="h-24 w-full" />
					))}
				</div>
			</ToolLayout>
		);

	const exercises = session.exercises;
	const current = exercises[Math.min(index, exercises.length - 1)];
	const last = index >= exercises.length - 1;
	const finished = session.status === "finished";

	return (
		<ToolLayout
			title={title}
			actions={back}
			panel={finished ? undefined : { label: "Review", open: panelOpen, onOpenChange: setPanelOpen, icon: "note", content: <Review session={session} onSession={setSession} onClose={closeAfterPanel} /> }}
		>
			<div ref={body} className={styles.page}>
				<p className={styles.eyebrow}>
					{formatDate(session.date)}
					{finished ? " · Finished" : ` · Exercise ${index + 1} of ${exercises.length}`}
				</p>
				{finished ? (
					<div className={styles.finishedList}>
						{exercises.map((exercise) => (
							<section key={exercise.position} className={styles.dayCard}>
								<h2 className={styles.exerciseName}>{exercise.name}</h2>
								<p className={styles.exerciseRx}>{exerciseSummary(exercise)}</p>
								{exercise.notes === null ? null : <p className={styles.rxNote}>{exercise.notes}</p>}
							</section>
						))}
						<Review session={session} onSession={setSession} onClose={onClose} />
					</div>
				) : current === undefined ? (
					<p className={styles.empty}>This day has no exercises in the program.</p>
				) : (
					<div key={current.position} className={styles.view}>
						<ExerciseEditor session={session} exercise={current} onSession={setSession} onSet={(position, at, draft) => setSession((existing) => (existing === null ? existing : applySet(existing, position, at, draft)))} />
					</div>
				)}
			</div>
			{finished ? null : (
				<nav className={styles.bottomBar} aria-label="Exercises">
					<Button variant="secondary" disabled={index === 0} onClick={() => setIndex(index - 1)} aria-label="Previous exercise">
						<Icon name="back" />
					</Button>
					<span className={styles.bottomLabel}>{exercises[index + 1] === undefined ? "Last exercise" : `Next: ${exercises[index + 1]?.name}`}</span>
					{last ? (
						<Button variant="primary" onClick={() => setPanelOpen(true)}>
							Review
						</Button>
					) : (
						<Button variant="primary" onClick={() => setIndex(index + 1)} aria-label="Next exercise">
							<Icon name="chevron-right" />
						</Button>
					)}
				</nav>
			)}
		</ToolLayout>
	);
}
