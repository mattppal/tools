create table repo_sync (
	id boolean primary key default true check (id),
	head_sha text,
	head_etag text,
	synced_at timestamptz,
	checked_at timestamptz,
	last_error text
);

insert into repo_sync default values;

create table repo_files (
	path text primary key,
	sha text not null,
	kind text not null check (kind in ('program', 'session')),
	content jsonb,
	parse_error text,
	synced_at timestamptz not null default now()
);
