create table jobs (
	job_id uuid primary key default gen_random_uuid(),
	seq bigint generated always as identity unique,
	kind text not null check (kind in ('posts', 'summary')),
	status text not null default 'ready' check (status in ('ready', 'claimed', 'printed', 'failed', 'unconfirmed')),
	payload jsonb not null,
	post_count integer not null,
	created_at timestamptz not null default now(),
	print_day date not null,
	ready_at timestamptz not null default '-infinity',
	claim_id uuid,
	claimed_at timestamptz,
	claim_expires_at timestamptz,
	claimed_by text,
	bridge text,
	result text check (result in ('printed', 'failed', 'unconfirmed')),
	acked_at timestamptz,
	acked_by text,
	lease_expired boolean not null default false,
	error text,
	failures integer not null default 0,
	requeued_from uuid references jobs (job_id)
);

create index jobs_ready on jobs (seq) where status = 'ready';

create index jobs_day on jobs (print_day) where kind = 'posts';

create unique index jobs_one_claimed on jobs ((true)) where status = 'claimed';

create table posts (
	id bigint primary key check (id > 0),
	seq bigint generated always as identity unique,
	author_id text not null,
	handle text not null check (handle ~ '^[A-Za-z0-9_]{1,15}$'),
	name text not null,
	clean_name text not null,
	text text not null,
	clean_text text not null,
	created_at timestamptz not null,
	lang text,
	conversation_id text,
	is_reply boolean not null,
	is_quote boolean not null,
	likes integer,
	reposts integer,
	replies integer,
	quotes integer,
	bookmarks integer,
	impressions integer,
	metrics_at timestamptz not null,
	flags text[] not null default '{}' check (flags <@ array['injection', 'addressed', 'phone', 'email', 'blocked', 'empty', 'overlong', 'mentions', 'unprintable', 'encoded']),
	screen_version smallint not null,
	ingested_at timestamptz not null default now(),
	status text not null check (status in ('pending', 'approved', 'rejected', 'overflow', 'queued', 'printed', 'unconfirmed', 'failed', 'summarized')),
	reason text,
	decided_by text check (decided_by in ('screen', 'prints-review', 'matt', 'caps', 'sweep')),
	decided_at timestamptz,
	job_id uuid references jobs (job_id),
	summary_job_id uuid references jobs (job_id),
	summarized_at timestamptz
);

create index posts_created on posts (created_at, id);

create index posts_author on posts (author_id);

create index posts_flags on posts using gin (flags);

create index posts_status on posts (status, id);

create index posts_unsummarized on posts (id) where status = 'overflow' and summary_job_id is null and summarized_at is null;

create table blocklist (
	term text primary key check (length(term) between 1 and 100),
	added_at timestamptz not null default now()
);

create table sync_state (
	id boolean primary key default true check (id),
	since_id bigint,
	pending_since_id bigint,
	next_token text,
	next_run_at timestamptz not null default '-infinity',
	last_run_at timestamptz,
	last_success_at timestamptz,
	last_error text,
	failures integer not null default 0,
	month text not null default '',
	month_reads integer not null default 0,
	capped_month text,
	stale_noticed_for timestamptz
);

insert into sync_state default values;

create table runs (
	id bigint generated always as identity primary key,
	started_at timestamptz not null,
	finished_at timestamptz not null,
	pages integer not null default 0,
	read integer not null default 0,
	inserted integer not null default 0,
	refreshed integer not null default 0,
	status text not null check (status in ('ok', 'partial', 'rate limited', 'usage capped', 'budget', 'failed')),
	rate_remaining integer,
	error text
);

create index runs_started on runs (started_at);
