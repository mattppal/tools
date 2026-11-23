alter table posts add column reply_checked_at timestamptz;

alter table replies add column via text not null default 'tools' check (via in ('tools', 'x'));
