create table deliveries (
	delivery_id uuid primary key,
	app text not null,
	event text not null,
	ref text,
	payload jsonb not null,
	created_at timestamptz not null default now(),
	attempts integer not null default 0,
	next_attempt_at timestamptz not null default now() + interval '1 minute',
	delivered_at timestamptz,
	last_status integer,
	last_error text,
	claimed_until timestamptz,
	claim_id uuid
);

create index deliveries_due on deliveries (next_attempt_at) where delivered_at is null;
create index deliveries_ref on deliveries (app, ref, created_at);
