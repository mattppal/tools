alter table weigh_ins
	add column measured_at timestamptz,
	add column grpid bigint,
	add column fat_pct numeric(5, 2);
