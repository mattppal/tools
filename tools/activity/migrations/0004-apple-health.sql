create table apple_health_sleep (
	source text not null,
	stage text not null check (stage in ('in_bed', 'asleep', 'awake', 'core', 'deep', 'rem', 'unspecified')),
	started_at timestamptz not null,
	ended_at timestamptz not null check (ended_at >= started_at),
	utc_offset_min integer not null,
	updated_at timestamptz not null default now(),
	primary key (source, started_at, stage)
);

create index apple_health_sleep_ended on apple_health_sleep (ended_at);

create table apple_health_samples (
	metric text not null,
	source text not null,
	measured_at timestamptz not null,
	utc_offset_min integer not null,
	units text,
	qty numeric,
	min numeric,
	avg numeric,
	max numeric,
	updated_at timestamptz not null default now(),
	primary key (metric, source, measured_at)
);

create index apple_health_samples_time on apple_health_samples (metric, measured_at);

create table apple_health_workouts (
	id text primary key,
	name text not null,
	source text not null,
	local_date date not null,
	started_at timestamptz not null,
	ended_at timestamptz not null,
	duration_s integer not null,
	active_kcal numeric,
	total_kcal numeric,
	distance_m numeric,
	elevation_m numeric,
	hr_avg integer,
	hr_min integer,
	hr_max integer,
	location text,
	data jsonb not null,
	updated_at timestamptz not null default now()
);

create index apple_health_workouts_date on apple_health_workouts (local_date);

create table apple_health_pushes (
	automation text primary key,
	received_at timestamptz not null default now(),
	session_id text,
	counts jsonb not null
);
