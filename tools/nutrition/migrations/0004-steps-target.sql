alter table plan_versions add column steps_target integer check (steps_target > 0);
