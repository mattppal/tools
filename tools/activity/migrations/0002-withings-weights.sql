alter table withings
	add column meas_lastupdate bigint,
	add column meas_pending_lastupdate bigint,
	add column meas_offset integer not null default 0,
	add column weights_synced_at timestamptz;

create table withings_weighins (
	grpid bigint primary key,
	measured_ts bigint not null,
	local_date date not null,
	local_time text not null,
	weight_kg numeric(7, 3) not null,
	weight_lb numeric(5, 2) not null,
	fat_pct numeric(5, 2),
	fat_mass_lb numeric(5, 2),
	fat_source text check (fat_source in ('fat_ratio', 'derived_from_fat_mass')),
	attrib integer not null,
	model text,
	updated_at timestamptz not null default now()
);

create index withings_weighins_local_date on withings_weighins (local_date);
