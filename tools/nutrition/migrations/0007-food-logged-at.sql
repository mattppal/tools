alter table food_entries add column logged_at timestamptz;

update food_entries set logged_at = created_at where day >= '2026-11-22';

alter table food_entries alter column logged_at set default now();
