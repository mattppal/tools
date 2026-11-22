alter table repo_files drop constraint repo_files_kind_check;
alter table repo_files add constraint repo_files_kind_check check (kind in ('program', 'session', 'profile'));

create table history_blocks (
	block_id text primary key,
	name text not null,
	goal text,
	starts date not null,
	ends date,
	deload_start date,
	source_path text not null
);

create table history_sessions (
	path text primary key,
	session_key text,
	session_date date not null,
	block_id text,
	week_id text,
	day_id text,
	kind text not null,
	modality text,
	status text,
	name text not null,
	duration_seconds numeric,
	recovery boolean not null default false
);

create index history_sessions_date on history_sessions (session_date);

create table history_exercises (
	path text not null references history_sessions (path) on delete cascade,
	position integer not null,
	exercise_key text not null,
	name text not null,
	status text,
	category text,
	equipment text,
	prescribed jsonb,
	primary key (path, position)
);

create index history_exercises_key on history_exercises (exercise_key);

create table history_sets (
	path text not null,
	position integer not null,
	set_index integer not null,
	type text,
	weight numeric,
	unit text,
	reps numeric,
	rir numeric,
	rpe numeric,
	distance numeric,
	distance_unit text,
	duration_seconds numeric,
	notes text,
	primary key (path, position, set_index),
	foreign key (path, position) references history_exercises (path, position) on delete cascade
);

create table history_prs (
	exercise_key text not null,
	reps integer not null,
	record_date date not null,
	weight numeric not null,
	unit text not null,
	type text,
	workout_key text,
	notes text,
	primary key (exercise_key, reps, record_date)
);
