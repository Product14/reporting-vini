-- Speed-to-Lead detail metrics. Additive columns on the daily fact table; all default 0 so existing
-- rows stay valid until the next full backfill repopulates them. Drives the richer "Speed to lead"
-- card (after-hours instant touches, instant→appointment conversion) and the median-response upsell
-- gate (median first-response > 1 min ⇔ fewer than half of measured leads were touched within 1 min).

alter table public.agent_daily
  add column if not exists stl_within1            integer not null default 0,  -- new leads first-touched ≤ 60s (median-vs-1min basis)
  add column if not exists stl_afterhours_within5 integer not null default 0,  -- instant (≤5min) touches whose lead arrived after-hours
  add column if not exists stl_within5_appts      integer not null default 0;  -- instant (≤5min) touched leads that booked an appointment
