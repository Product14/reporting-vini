-- Materialized reporting aggregate for the reports tab.
-- Run in the Supabase SQL editor (or `supabase db push`). Replace the two placeholders in the
-- pg_cron block at the bottom (<APP_URL>, <CRON_SECRET>) with your real values before running that part.

-- ───────────────────────── fact tables ─────────────────────────

-- One summable row per (activity_day, team_id, agent_type). The GET API sums these over a range.
create table if not exists public.agent_daily (
  activity_day      date    not null,
  team_id           text    not null,
  agent_type        text    not null,
  enterprise_name   text,
  rooftop_name      text,
  rooftop_stage     text,
  calls             integer not null default 0,
  sms_threads       integer not null default 0,
  conv_count        integer not null default 0,
  connected         integer not null default 0,
  reached_person    integer not null default 0,
  qualified         integer not null default 0,
  appointments      integer not null default 0,
  sms_sent          integer not null default 0,
  sms_replied       integer not null default 0,
  after_hours       integer not null default 0,
  talk_seconds      bigint  not null default 0,
  transfers         integer not null default 0,
  callbacks         integer not null default 0,
  query_resolved    integer not null default 0,
  opt_outs          integer not null default 0,
  leads_attempted   integer not null default 0,
  quality_score_sum bigint  not null default 0,
  quality_basis     integer not null default 0,
  new_leads         integer not null default 0,
  stl_within5       integer not null default 0,
  stl_seconds_sum   bigint  not null default 0,
  stl_count         integer not null default 0,
  updated_at        timestamptz not null default now(),
  primary key (activity_day, team_id, agent_type)
);
create index if not exists agent_daily_team_day_idx on public.agent_daily (team_id, activity_day);

-- Tall distribution rows (intent / source / hour / reply_offset) the API rolls up with GROUP BY.
create table if not exists public.agent_daily_breakdown (
  activity_day date    not null,
  team_id      text    not null,
  agent_type   text    not null,
  dim          text    not null,  -- 'intent' | 'source' | 'hour' | 'reply_offset'
  dim_value    text    not null,
  count        integer not null default 0,
  qualified    integer not null default 0,
  appts        integer not null default 0,
  primary key (activity_day, team_id, agent_type, dim, dim_value)
);
create index if not exists agent_daily_breakdown_team_day_idx on public.agent_daily_breakdown (team_id, activity_day);

-- Single-row sync bookkeeping (drives the "last synced" label + observability).
create table if not exists public.sync_state (
  id          integer primary key default 1,
  last_run_at timestamptz,
  last_status text,
  rows_synced integer,
  window_start date,
  error       text,
  constraint sync_state_singleton check (id = 1)
);
insert into public.sync_state (id) values (1) on conflict (id) do nothing;

-- ───────────────────────── scheduled sync (pg_cron + pg_net) ─────────────────────────
-- The cron job just pings the Next.js /api/sync route, which pulls Q12227 and upserts the tables.
-- Requires the pg_cron and pg_net extensions (available on Supabase).

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Edit <APP_URL> (e.g. https://reporting.spyne.ai) and <CRON_SECRET> (must match the app env var),
-- then run this block. Cadence: every 2 min if Q12227 has an activity_day embedding param; otherwise
-- raise the interval (e.g. '*/15 * * * *') since each run does a full-table pull.
-- select cron.unschedule('agent-sync');  -- run first if re-scheduling
select cron.schedule(
  'agent-sync',
  '*/2 * * * *',
  $$
  select net.http_post(
    url     := '<APP_URL>/api/sync',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer <CRON_SECRET>'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 280000
  );
  $$
);
