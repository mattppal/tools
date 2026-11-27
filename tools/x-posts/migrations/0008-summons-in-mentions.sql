alter table mentions add column sources text[] not null default '{mention}' check (cardinality(sources) > 0 and sources <@ array['mention', 'summons']);

alter table mention_sync add column summons_since_id text;

update mention_sync set summons_since_id = (select since_id::text from sync_state);
