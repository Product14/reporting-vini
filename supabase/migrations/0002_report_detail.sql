-- Per-row report detail the daily aggregate can't hold: appointment / callback lists and the
-- per-campaign table. Populated by /api/sync pulling the dedicated Metabase cards
--   12233 (upcoming appointments), 12234 (callbacks), 12232 (best campaign)
-- which are ROOFTOP-level (no agent_type) — the sync maps rooftop_name -> team_id (the same map
-- Q12227 already carries). GET /api/reports filters these by team_id and attaches them per report.
-- Each sync replaces a team's rows (delete-by-team then insert), so they never accumulate stale data.
--
-- Run in the Supabase SQL editor or `supabase db push`.

-- ── upcoming appointments (card 12233) ──
create table if not exists public.report_appointments (
  team_id          text not null,
  customer_name    text,
  appointment_time timestamptz,
  vehicle          text,
  status           text,
  assigned_to      text,
  booked_at        timestamptz,
  synced_at        timestamptz not null default now()
);
create index if not exists report_appointments_team_idx on public.report_appointments (team_id, appointment_time);

-- ── callbacks requested (card 12234) ──
create table if not exists public.report_callbacks (
  team_id       text not null,
  customer_name text,
  callback_due  timestamptz,
  intent        text,
  priority      text,
  assigned_to   text,
  requested_on  timestamptz,
  synced_at     timestamptz not null default now()
);
create index if not exists report_callbacks_team_idx on public.report_callbacks (team_id, callback_due);

-- ── best campaign (card 12232) ──
create table if not exists public.report_campaigns (
  team_id       text not null,
  agent_type    text, -- "Sales Outbound" | "Service Outbound" (card 12232 filtered per agent_type)
  campaign      text not null,
  use_case      text,
  enrolled      integer not null default 0,
  appointments  integer not null default 0,
  warm_leads    integer not null default 0,
  opt_outs      integer not null default 0,
  no_reach      integer not null default 0,
  appt_rate_pct numeric,
  synced_at     timestamptz not null default now()
);
create index if not exists report_campaigns_team_idx on public.report_campaigns (team_id);
