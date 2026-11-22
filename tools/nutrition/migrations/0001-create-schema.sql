create table phases (
	id bigint generated always as identity primary key,
	kind text not null check (kind in ('baseline', 'elimination', 'reintroduction', 'maintain', 'cut', 'gain')),
	start_date date not null unique,
	end_date date check (end_date >= start_date),
	summary text not null default ''
);

create unique index phases_one_open on phases ((true)) where end_date is null;

create table phase_trackers (
	phase_id bigint primary key references phases (id),
	start_weight_override_lb numeric(5, 2),
	target_rate_per_week numeric(6, 5) not null default 0,
	weeks integer not null,
	tolerance_lb numeric(3, 1) not null default 0.5,
	max_weekly_kcal_change integer not null default 150,
	min_logged_days integer not null default 5,
	current_kcal_target integer not null
);

create table plan_versions (
	effective_from date primary key,
	kcal_min integer not null,
	kcal_max integer not null,
	protein_min_g integer not null,
	protein_max_g integer not null,
	fat_min_g integer not null,
	fat_max_g integer not null,
	carbs_min_g integer not null,
	carbs_max_g integer not null,
	notes text not null default '',
	change text not null,
	created_by text not null,
	created_at timestamptz not null default now(),
	check (kcal_min <= kcal_max and protein_min_g <= protein_max_g and fat_min_g <= fat_max_g and carbs_min_g <= carbs_max_g)
);

create table days (
	day date primary key,
	closed_at timestamptz,
	steps integer,
	bloat_score numeric(3, 1) check (bloat_score between 0 and 10),
	energy numeric(3, 1) check (energy between 0 and 10),
	sleep numeric(3, 1) check (sleep between 0 and 10),
	stress numeric(3, 1) check (stress between 0 and 10),
	notes text not null default '',
	totals_estimated boolean not null default false,
	imported jsonb
);

create table food_entries (
	id bigint generated always as identity primary key,
	day date not null references days (day),
	food text not null,
	qty numeric(10, 2) not null check (qty > 0),
	unit text not null,
	kcal numeric(7, 1) not null check (kcal >= 0),
	protein_g numeric(6, 1) not null check (protein_g >= 0),
	carbs_g numeric(6, 1) not null check (carbs_g >= 0),
	fat_g numeric(6, 1) not null check (fat_g >= 0),
	fiber_g numeric(6, 1) check (fiber_g >= 0),
	source_kind text not null check (source_kind in ('usda_fdc', 'open_food_facts', 'tracker_export', 'estimate')),
	source_ref text,
	source_label text not null default '',
	client_key text not null unique,
	created_by text not null,
	created_at timestamptz not null default now(),
	check ((source_kind in ('usda_fdc', 'open_food_facts')) = (source_ref is not null))
);

create index food_entries_day on food_entries (day);

create table weigh_ins (
	measured_on date not null,
	source text not null check (source in ('withings', 'bot', 'sheet', 'daily_file')),
	weight_lb numeric(5, 2) not null,
	primary key (measured_on, source)
);

create table deliveries (
	delivery_id uuid primary key,
	day date not null references days (day),
	payload jsonb not null,
	attempts integer not null default 0,
	next_attempt_at timestamptz not null default now() + interval '1 minute',
	delivered_at timestamptz,
	last_status integer,
	last_error text
);

create index deliveries_due on deliveries (next_attempt_at) where delivered_at is null;

create view daily_weights as
select distinct on (measured_on) measured_on, weight_lb, source
from weigh_ins
order by measured_on, array_position(array['withings', 'bot', 'sheet', 'daily_file'], source);

create view weight_trend as
select
	measured_on,
	weight_lb,
	avg(weight_lb) over (order by measured_on range between interval '6 days' preceding and current row) as rolling_7d,
	avg(weight_lb) over (order by measured_on range between interval '13 days' preceding and current row) as rolling_14d,
	avg(weight_lb) over (order by measured_on range between interval '27 days' preceding and current row) as rolling_28d
from daily_weights;

create view day_totals as
select
	d.day,
	d.closed_at is not null as closed,
	d.totals_estimated,
	count(f.id)::integer as entries,
	coalesce(sum(f.kcal), 0) as kcal,
	coalesce(sum(f.protein_g), 0) as protein_g,
	coalesce(sum(f.carbs_g), 0) as carbs_g,
	coalesce(sum(f.fat_g), 0) as fat_g,
	coalesce(sum(f.fiber_g), 0) as fiber_g
from days d
left join food_entries f on f.day = d.day
group by d.day;
