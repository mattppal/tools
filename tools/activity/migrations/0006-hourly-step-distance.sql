with seconds as (
	delete from apple_health_samples
	where source = 'Apple Health' and metric in ('step_count', 'walking_running_distance')
		and (ended_at is null or ended_at <> measured_at + interval '1 hour' or date_trunc('hour', measured_at, 'UTC') <> measured_at)
	returning metric, source, measured_at, utc_offset_min, units, qty
)
insert into apple_health_samples (metric, source, measured_at, ended_at, utc_offset_min, units, qty)
select metric, source, date_trunc('hour', measured_at, 'UTC'), date_trunc('hour', measured_at, 'UTC') + interval '1 hour', max(utc_offset_min), min(units), sum(qty)
from seconds
group by metric, source, date_trunc('hour', measured_at, 'UTC')
on conflict (metric, source, measured_at) do nothing;
