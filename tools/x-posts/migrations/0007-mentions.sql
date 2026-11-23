create table mentions (
	id bigint primary key check (id > 0),
	author_id text not null,
	text text not null,
	created_at timestamptz not null,
	conversation_id text,
	ingested_at timestamptz not null,
	dismissed_at timestamptz
);

create index mentions_open on mentions (id desc) where dismissed_at is null;

create table mention_replies (
	reply_id bigint primary key check (reply_id > 0),
	mention_id bigint not null references mentions (id) on delete cascade,
	text text not null,
	username text not null,
	created_at timestamptz not null,
	via text not null check (via in ('tools', 'x'))
);

create index mention_replies_mention_id on mention_replies (mention_id, created_at desc);

create table x_users (
	id text primary key,
	username text not null,
	name text not null,
	avatar_url text check (avatar_url is null or avatar_url like 'https://pbs.twimg.com/%'),
	fetched_at timestamptz not null
);

create table mention_sync (
	id boolean primary key default true check (id),
	since_id text,
	own_since_id text,
	last_run_at timestamptz,
	last_success_at timestamptz,
	last_error text,
	month text not null default '',
	spent_mills integer not null default 0 check (spent_mills >= 0),
	paused_month text,
	paused_reason text check (paused_reason in ('budget', 'capped'))
);

insert into mention_sync default values;
