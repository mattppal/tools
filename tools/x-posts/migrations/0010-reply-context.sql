alter table mentions add column refs_known boolean not null default false;
alter table mentions add column replied_to_id bigint check (replied_to_id > 0);
alter table mentions add column quoted_id bigint check (quoted_id > 0);

create table post_context (
	id bigint primary key check (id > 0),
	post jsonb,
	fetched_at timestamptz not null
);
