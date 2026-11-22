alter table apple_health_samples add column ended_at timestamptz;
alter table apple_health_samples add column extra jsonb;

create or replace view daily_activity as
select distinct on (day) day, source, steps, active_kcal, total_kcal, distance_m, elevation_m, soft_s, moderate_s, intense_s, updated_at
from days
order by day, coalesce(steps, 0) = 0, array_position(array['withings', 'apple_health', 'manual'], source);
