-- Sales-Inbound "open funnel" (card 12341): leads handled -> appointments booked, split by acquisition
-- path (speed-to-lead vs follow-up). ROOFTOP-level, agent_type='Sales Inbound'. Populated by the same
-- external ETL that fills the other report_* detail tables (delete-by-team then insert), and read by
-- GET /api/reports (filtered by team_id) → attached onto the Sales-IB speedToLead card.
--
-- Rates are stored as FRACTIONS (0.0771 = 7.71%); build.ts rounds them to whole-number %.
-- All-time for now — 12341's team_id/date params aren't embed-enabled, so it can't be windowed yet.
--
-- Run in the Supabase SQL editor or `supabase db push`.

create table if not exists public.report_open_funnel (
  team_id                          text not null,
  agent_type                       text, -- "Sales Inbound" (12341 is Sales-IB scoped)
  stl_leads_handled                integer not null default 0,
  stl_appointments_booked          integer not null default 0,
  stl_handled_to_booked_rate       numeric,
  followup_leads_handled           integer not null default 0,
  followup_appointments_booked     integer not null default 0,
  followup_handled_to_booked_rate  numeric,
  synced_at                        timestamptz not null default now()
);
create index if not exists report_open_funnel_team_idx on public.report_open_funnel (team_id, agent_type);
