import { type FormEvent, useRef, useState } from "react";
import { Button } from "../../src/kit/button.tsx";
import { fieldVariants, Input } from "../../src/kit/input.tsx";
import styles from "./goals.module.css";
import { type Checkin, type Goal, type Status, STATUS_LABELS, STATUSES } from "./types.ts";
import { request } from "./ui.tsx";

export function CheckinForm({ goal, onSaved, onCancel }: { goal: Goal; onSaved: (goal: Goal) => void; onCancel: () => void }) {
	const [note, setNote] = useState("");
	const [progress, setProgress] = useState("");
	const [status, setStatus] = useState<Status>(goal.status);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const attempt = useRef<{ content: string; key: string } | null>(null);

	async function save(event?: FormEvent) {
		event?.preventDefault();
		if (note.trim() === "" || saving) return;
		setSaving(true);
		setError(null);
		try {
			const percent = progress.trim() === "" ? null : Number(progress);
			const content = { goal_id: goal.id, note: note.trim(), progress: percent, ...(status === goal.status ? {} : { status }) };
			const serialized = JSON.stringify(content);
			if (attempt.current?.content !== serialized) attempt.current = { content: serialized, key: crypto.randomUUID() };
			const saved = await request<{ goal: Goal; checkin: Checkin }>("/checkins", { ...content, client_key: attempt.current.key });
			onSaved(saved.goal);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
			setSaving(false);
		}
	}

	return (
		<form className={styles.checkinForm} onSubmit={save} aria-label={`Check in on ${goal.title}`}>
			<textarea
				className={styles.textarea}
				rows={2}
				value={note}
				placeholder="What happened?"
				aria-label="Note"
				autoFocus
				onChange={(event) => setNote(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void save();
					if (event.key === "Escape") onCancel();
				}}
			/>
			<div className={styles.checkinFields}>
				<label className={styles.field}>
					Progress
					<span className={styles.percent}>
						<Input size="sm" type="number" inputMode="decimal" min={0} max={100} step="any" value={progress} placeholder="–" onChange={(event) => setProgress(event.target.value)} />%
					</span>
				</label>
				<label className={styles.field}>
					Status
					<select className={fieldVariants({ size: "sm" })} value={status} onChange={(event) => setStatus(event.target.value as Status)}>
						{STATUSES.map((option) => (
							<option key={option} value={option}>
								{STATUS_LABELS[option]}
							</option>
						))}
					</select>
				</label>
				<div className={styles.formActions}>
					<Button size="sm" variant="quiet" onClick={onCancel}>
						Cancel
					</Button>
					<Button size="sm" variant="primary" type="submit" loading={saving} disabled={note.trim() === ""}>
						Save
					</Button>
				</div>
			</div>
			{error === null ? null : <p className={styles.formError}>{error}</p>}
		</form>
	);
}
