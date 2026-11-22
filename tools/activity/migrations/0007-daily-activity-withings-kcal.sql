create or replace view daily_activity as
select distinct on (d.day) d.day, d.source, d.steps,
	coalesce(w.active_kcal, d.active_kcal)::numeric(7, 1) as active_kcal,
	coalesce(w.total_kcal, d.total_kcal)::numeric(7, 1) as total_kcal,
	d.distance_m,
	coalesce(w.elevation_m, d.elevation_m)::numeric(7, 1) as elevation_m,
	coalesce(w.soft_s, d.soft_s) as soft_s,
	coalesce(w.moderate_s, d.moderate_s) as moderate_s,
	coalesce(w.intense_s, d.intense_s) as intense_s,
	greatest(d.updated_at, w.updated_at) as updated_at
from days d
left join days w on w.day = d.day and w.source = 'withings'
order by d.day, d.steps desc nulls last, array_position(array['withings', 'apple_health', 'manual'], d.source);
