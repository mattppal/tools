create table sessions (
	id uuid primary key default gen_random_uuid(),
	block_id text not null,
	week_id text not null,
	day_id text not null,
	day_title text not null,
	session_date date not null,
	notes text,
	status text not null default 'open' check (status in ('open', 'finished')),
	test boolean not null default false,
	finished_at timestamptz,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);

create unique index sessions_one_per_day on sessions (block_id, week_id, day_id) where not test;

create table exercises (
	session_id uuid not null references sessions (id) on delete cascade,
	position smallint not null,
	exercise_id text not null,
	name text not null,
	prescribed jsonb not null,
	status text not null default 'planned' check (status in ('planned', 'completed', 'skipped')),
	notes text,
	primary key (session_id, position)
);

create table sets (
	session_id uuid not null,
	position smallint not null,
	set_index smallint not null,
	weight numeric,
	unit text check (unit in ('lb', 'kg')),
	reps smallint check (reps >= 0),
	rir smallint check (rir >= 0),
	as_written boolean not null default false,
	notes text,
	updated_at timestamptz not null default now(),
	primary key (session_id, position, set_index),
	foreign key (session_id, position) references exercises (session_id, position) on delete cascade,
	check (weight is null or unit is not null)
);

create table deliveries (
	delivery_id uuid primary key,
	session_id uuid not null unique references sessions (id) on delete cascade,
	payload jsonb not null,
	attempts integer not null default 0,
	next_attempt_at timestamptz not null default now() + interval '1 minute',
	delivered_at timestamptz,
	last_status integer,
	last_error text,
	created_at timestamptz not null default now()
);

create index deliveries_due on deliveries (next_attempt_at) where delivered_at is null;
