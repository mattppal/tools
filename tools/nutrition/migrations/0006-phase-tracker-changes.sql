create table phase_tracker_changes (
	id bigint generated always as identity primary key,
	phase_id bigint not null references phases (id),
	field text not null,
	old_value text,
	new_value text,
	changed_at timestamptz not null default now(),
	changed_by text not null
);

create index phase_tracker_changes_phase on phase_tracker_changes (phase_id, changed_at);
