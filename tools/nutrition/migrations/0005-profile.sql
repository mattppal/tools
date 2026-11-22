create table profile (
	id boolean primary key default true check (id),
	birth_date date,
	updated_at timestamptz not null default now()
);
