import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button, IconButton } from "../../src/kit/button.tsx";
import { Input } from "../../src/kit/input.tsx";
import { Skeleton } from "../../src/kit/skeleton.tsx";
import { navigate, useSearchParam } from "../../src/router.tsx";
import { Icon } from "../../src/shell/icons.tsx";
import { ToolLayout } from "../../src/shell/tool-layout.tsx";
import { addDays, today } from "./dates.ts";
import { Inspect, TipLines } from "./inspect.tsx";
import styles from "./nutrition.module.css";
import type { CheckIn, DayView, FoodEntry, Macro, MacroProgress } from "./types.ts";
import { dayLabel, request, SOURCE_TAGS, tenths, useJson, VIEWS, whole, withEntries } from "./ui.tsx";

const FIELDS = [
	{ key: "food", label: "Food", span: 4, numeric: false },
	{ key: "qty", label: "Qty", span: 2, numeric: true },
	{ key: "unit", label: "Unit", span: 2, numeric: false },
	{ key: "kcal", label: "Kcal", span: 1, numeric: true },
	{ key: "protein_g", label: "Protein", span: 1, numeric: true },
	{ key: "carbs_g", label: "Carbs", span: 1, numeric: true },
	{ key: "fat_g", label: "Fat", span: 1, numeric: true },
] as const;

type Field = (typeof FIELDS)[number]["key"];
type Draft = Record<Field, string>;
type Editor = { id: number | null; clientKey: string; draft: Draft; error: string | null };
type Parsed = { food: string; qty: number; unit: string } & Record<Macro, number>;

const BARS: { macro: Macro; label: string; unit: string }[] = [
	{ macro: "kcal", label: "Kcal", unit: "" },
	{ macro: "protein_g", label: "Protein", unit: "g" },
	{ macro: "fat_g", label: "Fat", unit: "g" },
	{ macro: "carbs_g", label: "Carbs", unit: "g" },
];

function blankEditor(): Editor {
	return { id: null, clientKey: crypto.randomUUID(), draft: { food: "", qty: "", unit: "g", kcal: "", protein_g: "", carbs_g: "", fat_g: "" }, error: null };
}

function entryEditor(entry: FoodEntry): Editor {
	const draft = {} as Draft;
	for (const { key } of FIELDS) draft[key] = String(entry[key]);
	return { id: entry.id, clientKey: crypto.randomUUID(), draft, error: null };
}

function parse(draft: Draft): Parsed | string {
	const food = draft.food.trim();
	const unit = draft.unit.trim();
	if (food === "") return "Enter a food.";
	if (unit === "") return "Enter a unit.";
	const values = {} as Record<"qty" | Macro, number>;
	for (const field of FIELDS) {
		if (!field.numeric) continue;
		const value = Number(draft[field.key].trim() === "" ? Number.NaN : draft[field.key]);
		if (!Number.isFinite(value) || value < 0 || (field.key === "qty" && value === 0)) return `${field.label} needs a number${field.key === "qty" ? " above 0" : ""}.`;
		values[field.key as "qty" | Macro] = value;
	}
	return { food, unit, ...values };
}

function goTo(date: string) {
	navigate(date === today() ? "/nutrition" : `/nutrition?date=${date}`);
}

function dayState(day: DayView): string {
	return [day.closed ? "Closed" : "Open", day.estimated ? "estimated totals" : null].filter(Boolean).join(", ");
}

function stepsTip(day: DayView, steps: number): (string | null)[] {
	const target = day.targets?.stepsTarget ?? null;
	return [
		`Steps · ${dayLabel(day.date)}`,
		`${whole(steps)} steps`,
		target === null ? "No steps target in the plan" : steps < target ? `${whole(target - steps)} short of ${whole(target)}` : `${whole(steps - target)} over the ${whole(target)} target`,
	];
}

function StepsLine({ day }: { day: DayView }) {
	const { steps } = day.checkIn;
	if (steps === null) return null;
	const target = day.targets?.stepsTarget ?? null;
	const text = target === null ? `${whole(steps)} steps` : `${whole(steps)} steps · ${steps < target ? `${whole(target - steps)} to go` : "target met"}`;
	return (
		<Inspect className={styles.barFootnote} tip={<TipLines lines={stepsTip(day, steps)} />}>
			{text}
		</Inspect>
	);
}

function macroTip(day: DayView, label: string, unit: string, progress: MacroProgress): (string | null)[] {
	const { total, min, max, status } = progress;
	const suffix = unit === "" ? "" : ` ${unit}`;
	return [
		`${label} · ${dayLabel(day.date)}`,
		`${whole(total)} of ${whole(min)}–${whole(max)}${suffix}`,
		status === "under" ? `${whole(min - total)}${suffix} to the low end` : status === "over" ? `${whole(total - max)}${suffix} over the top` : `In range, ${whole(max - total)}${suffix} below the top`,
		dayState(day),
	];
}

type BarProps = { day: DayView; label: string; unit: string; progress: MacroProgress; children?: ReactNode };

function Bar({ day, label, unit, progress, children }: BarProps) {
	const { total, min, max, status } = progress;
	const scale = Math.max(max * 1.15, total, 1);
	const at = (value: number) => Math.min(value / scale, 1);
	const suffix = unit === "" ? "" : ` ${unit}`;
	const text = status === "under" ? `${whole(min - total)}${suffix} to go` : status === "over" ? `+${whole(total - max)}${suffix} over` : "in range";
	return (
		<div className={styles.bar} data-status={status}>
			<Inspect className={styles.barInspect} tip={<TipLines lines={macroTip(day, label, unit, progress)} />}>
				<div className={styles.barTop}>
					<span className={styles.barLabel}>{label}</span>
					<span className={styles.barStatus}>{text}</span>
				</div>
				<div className={styles.barValue}>
					{whole(total)}
					<span className={styles.barTarget}>
						{" "}
						of {whole(min)}–{whole(max)}
						{suffix}
					</span>
				</div>
				<div className={styles.track} role="meter" aria-label={`${label}, ${text}`} aria-valuemin={0} aria-valuemax={max} aria-valuenow={total}>
					<div className={styles.band} style={{ left: `${at(min) * 100}%`, width: `${(at(max) - at(min)) * 100}%` }} />
					<div className={styles.fill} style={{ transform: `scaleX(${at(total)})` }} />
				</div>
			</Inspect>
			{children}
		</div>
	);
}

function checkInLine(checkIn: CheckIn): string[] {
	const parts: string[] = [];
	if (checkIn.bodyweightLb !== null) parts.push(`${tenths(checkIn.bodyweightLb)} lb`);
	if (checkIn.steps !== null) parts.push(`${whole(checkIn.steps)} steps`);
	for (const [label, value] of [
		["energy", checkIn.energy],
		["bloat", checkIn.bloatScore],
		["sleep", checkIn.sleep],
		["stress", checkIn.stress],
	] as const)
		if (value !== null) parts.push(`${label} ${value}`);
	return parts;
}

function DaySummary({ day }: { day: DayView }) {
	const checkIn = checkInLine(day.progress === null ? day.checkIn : { ...day.checkIn, steps: null });
	return (
		<>
			{day.progress === null ? (
				<p className={styles.note}>No targets cover this day. Kcal so far: {whole(day.totals.kcal)}.</p>
			) : (
				<div className={styles.bars}>
					{BARS.map((bar) => (
						<Bar key={bar.macro} day={day} label={bar.label} unit={bar.unit} progress={day.progress?.[bar.macro] as MacroProgress}>
							{bar.macro === "kcal" ? <StepsLine day={day} /> : null}
						</Bar>
					))}
				</div>
			)}
			{checkIn.length === 0 && day.checkIn.notes === "" && !day.closed && !day.estimated ? null : (
				<p className={styles.checkIn}>
					{[day.closed ? "Closed" : null, day.estimated ? "Estimated totals" : null, ...checkIn].filter(Boolean).join(" · ")}
					{day.checkIn.notes === "" ? null : <span className={styles.checkInNotes}>{day.checkIn.notes}</span>}
				</p>
			)}
		</>
	);
}

function Entries({ day, onOpen }: { day: DayView; onOpen: (entry: FoodEntry) => void }) {
	if (day.entries.length === 0) return <p className={styles.empty}>{day.closed ? "Nothing was logged on this day." : "Nothing logged yet."}</p>;
	return (
		<ul className={styles.entries}>
			{day.entries.map((entry) => (
				<li key={entry.id}>
					<button type="button" className={styles.entry} disabled={day.closed || entry.id < 0} onClick={() => onOpen(entry)}>
						<span className={styles.entryMain}>
							<span className={styles.entryFood}>{entry.food}</span>
							<span className={styles.entryMeta}>
								{tenths(entry.qty).replace(/\.0$/, "")} {entry.unit} · {SOURCE_TAGS[entry.sourceKind]}
							</span>
						</span>
						<span className={styles.entryNumbers}>
							<span>{whole(entry.kcal)}</span>
							<span className={styles.entryMeta}>{whole(entry.protein_g)} g protein</span>
						</span>
					</button>
				</li>
			))}
		</ul>
	);
}

function EntryForm({ editor, onChange, onSave, onDelete }: { editor: Editor; onChange: (editor: Editor) => void; onSave: () => void; onDelete: () => void }) {
	const [confirming, setConfirming] = useState(false);
	return (
		<form
			className={styles.form}
			onSubmit={(event) => {
				event.preventDefault();
				onSave();
			}}
		>
			<div className={styles.fields}>
				{FIELDS.map((field) => (
					<label key={field.key} className={styles.field} style={{ gridColumn: `span ${field.span}` }}>
						<span>{field.label}</span>
						<Input
							value={editor.draft[field.key]}
							inputMode={field.numeric ? "decimal" : "text"}
							autoFocus={field.key === "food" && editor.id === null}
							autoComplete="off"
							onChange={(event) => onChange({ ...editor, error: null, draft: { ...editor.draft, [field.key]: event.target.value } })}
						/>
					</label>
				))}
			</div>
			{editor.error === null ? null : (
				<p className={styles.formError} role="alert">
					{editor.error}
				</p>
			)}
			<div className={styles.formActions}>
				{editor.id === null ? null : (
					<Button variant="destructive" data-confirming={confirming ? "" : undefined} onClick={() => (confirming ? onDelete() : setConfirming(true))}>
						{confirming ? "Delete for good" : "Delete"}
					</Button>
				)}
				<Button variant="primary" type="submit" className={styles.grow}>
					Save
				</Button>
			</div>
		</form>
	);
}

export function Today() {
	const date = useSearchParam("date") ?? today();
	const [load, setDay, reload] = useJson<DayView>(`/day?date=${date}`);
	const [editor, setEditor] = useState<Editor | null>(null);
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const shown = useRef(date);
	shown.current = date;

	useEffect(() => {
		if (open) return;
		const timer = setTimeout(() => setEditor(null), 400);
		return () => clearTimeout(timer);
	}, [open]);

	useEffect(() => {
		setOpen(false);
		setError(null);
	}, [date]);

	const day = load.status === "ready" ? load.data : null;

	function edit(next: Editor) {
		setEditor(next);
		setOpen(true);
	}

	async function change(before: DayView, optimistic: FoodEntry[], body: object, failed: Editor) {
		setDay(withEntries(before, optimistic));
		setOpen(false);
		try {
			const next = await request<DayView>("/day/food", { date: before.date, ...body });
			if (shown.current === before.date) setDay(next);
		} catch (cause) {
			if (shown.current !== before.date) return;
			setDay(before);
			edit({ ...failed, error: cause instanceof Error ? cause.message : String(cause) });
		}
	}

	function save() {
		if (editor === null || day === null) return;
		const parsed = parse(editor.draft);
		if (typeof parsed === "string") return setEditor({ ...editor, error: parsed });
		if (editor.id === null) {
			const pending: FoodEntry = { id: -Date.now(), ...parsed, fiber_g: null, sourceKind: "estimate", sourceRef: null, sourceLabel: "", clientKey: editor.clientKey };
			void change(day, [...day.entries, pending], { add: [{ ...parsed, client_key: editor.clientKey }] }, editor);
		} else {
			const id = editor.id;
			void change(day, day.entries.map((entry) => (entry.id === id ? { ...entry, ...parsed } : entry)), { edit: [{ id, ...parsed }] }, editor);
		}
	}

	function remove() {
		if (editor === null || editor.id === null || day === null) return;
		const id = editor.id;
		void change(day, day.entries.filter((entry) => entry.id !== id), { remove: [id] }, editor);
	}

	async function setClosed(closed: boolean) {
		if (day === null) return;
		setBusy(true);
		setError(null);
		try {
			const next = await request<DayView>(closed ? "/day/close" : "/day/reopen", { date: day.date });
			if (shown.current === day.date) setDay(next);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}

	const canAdd = day !== null && !day.closed;
	return (
		<ToolLayout
			title={date === today() ? "Today" : dayLabel(date)}
			sections={VIEWS}
			actions={
				<>
					<IconButton label="Previous day" onClick={() => goTo(addDays(date, -1))}>
						<Icon name="back" />
					</IconButton>
					<IconButton label="Next day" onClick={() => goTo(addDays(date, 1))}>
						<Icon name="chevron-right" />
					</IconButton>
					{day === null ? null : day.closed ? (
						<Button variant="quiet" loading={busy} onClick={() => void setClosed(false)}>
							Reopen
						</Button>
					) : (
						<Button loading={busy} onClick={() => void setClosed(true)}>
							Close day
						</Button>
					)}
				</>
			}
			panel={
				editor === null
					? undefined
					: {
							label: editor.id === null ? "Add food" : "Edit food",
							open,
							onOpenChange: setOpen,
							content: <EntryForm key={editor.clientKey} editor={editor} onChange={setEditor} onSave={save} onDelete={remove} />,
						}
			}
		>
			<div className={styles.page}>
				{error === null ? null : (
					<p className={styles.formError} role="alert">
						{error}
					</p>
				)}
				{load.status === "loading" ? (
					<div className={styles.bars} aria-busy="true">
						{BARS.map((bar) => (
							<Skeleton key={bar.macro} className={styles.barSkeleton} />
						))}
					</div>
				) : load.status === "error" ? (
					<div className={styles.empty}>
						<p>{load.message}</p>
						<Button onClick={reload}>Try again</Button>
					</div>
				) : (
					<>
						<DaySummary day={load.data} />
						<Entries day={load.data} onOpen={(entry) => edit(entryEditor(entry))} />
					</>
				)}
			</div>
			{canAdd ? (
				<div className={styles.addBar}>
					<Button variant="primary" className={styles.grow} onClick={() => edit(blankEditor())}>
						Add food
					</Button>
				</div>
			) : null}
		</ToolLayout>
	);
}
