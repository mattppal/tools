create table account (
	id boolean primary key default true check (id),
	user_id text not null,
	username text not null,
	scope text not null,
	access_token text not null,
	refresh_token text not null,
	expires_at timestamptz not null,
	connected_at timestamptz not null,
	refreshed_at timestamptz,
	last_error text
);

create table replies (
	reply_id bigint primary key check (reply_id > 0),
	post_id bigint not null references posts (id) on delete cascade,
	text text not null,
	username text not null,
	created_at timestamptz not null
);

create index replies_post_id on replies (post_id, created_at desc);

alter table posts add column sources text[] not null default '{summons}';

create table reposts (
	post_id bigint primary key references posts (id) on delete cascade,
	username text not null,
	created_at timestamptz not null
);
