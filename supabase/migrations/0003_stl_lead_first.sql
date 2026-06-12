-- Canonical earliest speed-to-lead conversation per lead. Drives cross-day STL dedup in agent_daily
-- so a lead with STL on Jun 10 and Jun 11 only counts on Jun 10 (earliest activity_ts).

create table if not exists public.stl_lead_first (
  team_id      text        not null,
  agent_type   text        not null,
  lead_id      text        not null,
  activity_day date        not null,
  activity_ts  timestamptz not null,
  response_sec integer,
  updated_at   timestamptz not null default now(),
  primary key (team_id, agent_type, lead_id)
);
create index if not exists stl_lead_first_team_day_idx on public.stl_lead_first (team_id, activity_day);
