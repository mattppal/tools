alter table days
	add column hr_avg integer,
	add column hr_min integer,
	add column hr_max integer,
	add column hr_zone_0_s integer,
	add column hr_zone_1_s integer,
	add column hr_zone_2_s integer,
	add column hr_zone_3_s integer;

update withings set backfill_cursor = current_date, backfill_offset = 0, backfill_done_at = null;

create table withings_streams (
	name text primary key check (name in ('measures', 'workouts', 'sleep', 'intraday')),
	state jsonb not null default '{}',
	synced_at timestamptz,
	done_at timestamptz
);

create table withings_measures (
	grpid bigint not null,
	type integer not null,
	measured_at timestamptz not null,
	value numeric not null,
	attrib integer not null,
	category integer not null,
	model text,
	device_hash text,
	updated_at timestamptz not null default now(),
	primary key (grpid, type)
);

create index withings_measures_type_time on withings_measures (type, measured_at);

create table withings_workouts (
	id bigint primary key,
	category integer not null,
	local_date date not null,
	started_at timestamptz not null,
	ended_at timestamptz not null,
	timezone text,
	duration_s integer not null,
	distance_m numeric,
	calories numeric,
	steps integer,
	elevation_m numeric,
	hr_avg integer,
	hr_min integer,
	hr_max integer,
	hr_zone_0_s integer,
	hr_zone_1_s integer,
	hr_zone_2_s integer,
	hr_zone_3_s integer,
	pool_laps integer,
	intensity integer,
	attrib integer,
	model text,
	device_id text,
	data jsonb not null,
	modified_at timestamptz,
	updated_at timestamptz not null default now()
);

create index withings_workouts_date on withings_workouts (local_date);

create table withings_sleep (
	id bigint primary key,
	local_date date not null,
	started_at timestamptz not null,
	ended_at timestamptz not null,
	timezone text,
	model text,
	model_id integer,
	device_hash text,
	total_sleep_s integer,
	in_bed_s integer,
	light_s integer,
	deep_s integer,
	rem_s integer,
	awake_s integer,
	wakeup_count integer,
	sleep_latency_s integer,
	sleep_efficiency numeric,
	hr_avg integer,
	hr_min integer,
	hr_max integer,
	rr_avg integer,
	rr_min integer,
	rr_max integer,
	breathing_disturbances integer,
	snoring_s integer,
	sleep_score integer,
	data jsonb not null,
	modified_at timestamptz,
	updated_at timestamptz not null default now()
);

create index withings_sleep_date on withings_sleep (local_date);

create table withings_intraday (
	day date primary key,
	bucket_s integer not null,
	samples integer not null,
	buckets jsonb not null,
	models text[] not null,
	updated_at timestamptz not null default now()
);

create table withings_workout_links (
	workout_id bigint primary key references withings_workouts (id) on delete cascade,
	session_path text,
	status text not null check (status in ('matched', 'ambiguous')),
	candidates text[] not null,
	updated_at timestamptz not null default now()
);

create view daily_health as
with sleep as (
	select local_date as day, count(*) as sleeps, sum(total_sleep_s) as sleep_s,
		(array_agg(sleep_score order by total_sleep_s desc nulls last))[1] as sleep_score,
		(array_agg(hr_min order by total_sleep_s desc nulls last))[1] as resting_hr,
		(array_agg(hr_avg order by total_sleep_s desc nulls last))[1] as sleep_hr_avg,
		(array_agg(rr_avg order by total_sleep_s desc nulls last))[1] as sleep_rr_avg
	from withings_sleep group by local_date
),
workouts as (
	select local_date as day, count(*) as workouts, sum(calories) as workout_kcal, sum(duration_s) as workout_s
	from withings_workouts group by local_date
),
heart as (
	select day, hr_avg, hr_min, hr_max from days where source = 'withings'
),
all_days as (
	select day from daily_activity union select day from sleep union select day from workouts
)
select d.day, a.steps, a.active_kcal, a.total_kcal, a.distance_m, h.hr_avg as day_hr_avg, h.hr_min as day_hr_min, h.hr_max as day_hr_max,
	s.resting_hr, s.sleeps, s.sleep_s, s.sleep_score, s.sleep_hr_avg, s.sleep_rr_avg,
	coalesce(w.workouts, 0) as workouts, w.workout_kcal, w.workout_s
from all_days d
left join daily_activity a on a.day = d.day
left join heart h on h.day = d.day
left join sleep s on s.day = d.day
left join workouts w on w.day = d.day;
