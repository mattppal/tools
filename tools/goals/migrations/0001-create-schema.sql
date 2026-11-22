create table goal_years (
	year integer primary key check (year between 2000 and 2100),
	north_star text not null default '',
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);

create table goals (
	id uuid primary key default gen_random_uuid(),
	year integer not null references goal_years (year),
	horizon text not null check (horizon in ('year', 'quarter')),
	quarter smallint check (quarter between 1 and 4),
	area text not null check (area in ('fitness', 'relationships', 'career', 'content', 'finance', 'life-quality', 'systems', 'inner')),
	title text not null check (title = regexp_replace(btrim(title), '\s+', ' ', 'g') and length(title) between 1 and 200),
	description text not null default '',
	metric text,
	target text,
	status text not null default 'unknown' check (status in ('active', 'achieved', 'partial', 'missed', 'dropped', 'unknown')),
	parent_id uuid references goals (id) on delete set null check (parent_id <> id),
	source_url text,
	todoist_project_id text,
	todoist_task_ids text[] not null default '{}',
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	check ((horizon = 'quarter') = (quarter is not null))
);

create unique index goals_natural_key on goals (year, horizon, coalesce(quarter, 0), lower(regexp_replace(btrim(title), '\s+', ' ', 'g')));

create index goals_parent on goals (parent_id);

create table goal_checkins (
	id uuid primary key default gen_random_uuid(),
	goal_id uuid not null references goals (id) on delete cascade,
	date date not null,
	note text not null check (length(btrim(note)) > 0),
	progress numeric(5, 2) check (progress between 0 and 100),
	status_at_checkin text not null check (status_at_checkin in ('active', 'achieved', 'partial', 'missed', 'dropped', 'unknown')),
	source text not null check (source in ('matt', 'gtd-bot')),
	client_key text not null check (length(client_key) between 1 and 100),
	request jsonb not null,
	created_at timestamptz not null default now()
);

create unique index goal_checkins_client_key on goal_checkins (goal_id, client_key);

create index goal_checkins_latest on goal_checkins (goal_id, date desc, created_at desc);
