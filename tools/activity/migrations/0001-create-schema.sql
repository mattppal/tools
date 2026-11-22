create table days (
	day date not null,
	source text not null check (source in ('withings', 'apple_health', 'manual')),
	steps integer check (steps >= 0),
	active_kcal numeric(7, 1) check (active_kcal >= 0),
	total_kcal numeric(7, 1) check (total_kcal >= 0),
	distance_m numeric(9, 1) check (distance_m >= 0),
	elevation_m numeric(7, 1),
	soft_s integer check (soft_s >= 0),
	moderate_s integer check (moderate_s >= 0),
	intense_s integer check (intense_s >= 0),
	device text,
	raw jsonb,
	updated_by text not null,
	updated_at timestamptz not null default now(),
	primary key (day, source)
);

create view daily_activity as
select distinct on (day) day, source, steps, active_kcal, total_kcal, distance_m, elevation_m, soft_s, moderate_s, intense_s, updated_at
from days
order by day, array_position(array['withings', 'apple_health', 'manual'], source);

create table withings (
	id boolean primary key default true check (id),
	userid text not null,
	scope text not null,
	access_token text not null,
	refresh_token text not null,
	access_expires_at timestamptz not null,
	connected_at timestamptz not null default now(),
	refreshed_at timestamptz,
	backfill_cursor date,
	backfill_offset integer not null default 0,
	backfill_done_at timestamptz,
	recent_synced_at timestamptz,
	last_error text,
	last_error_at timestamptz,
	claimed_until timestamptz
);
