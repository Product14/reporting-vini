-- "Money on the table" (card 12236): recoverable INBOUND leads by bucket — leads the AI engaged that
-- haven't booked (e.g. "warm, no appointment"). ROOFTOP-level, per inbound agent_type. Populated by the
-- same external ETL that fills the other report_* detail tables (delete-by-team then insert), and read
-- by GET /api/reports (filtered by team_id) → summed across agents on the Overview's "Money on the
-- table" card.
--
-- Run in the Supabase SQL editor or `supabase db push`.

create table if not exists public.report_money_on_table (
  team_id            text not null,
  agent_type         text, -- "Sales Inbound" | "Service Inbound" (recoverable is inbound-only)
  recoverable_bucket text not null, -- "A. Warm, no appointment" | "B. Appt referenced, no record"; prefix = sort order
  recoverable_leads  integer not null default 0,
  synced_at          timestamptz not null default now()
);
create index if not exists report_money_on_table_team_idx on public.report_money_on_table (team_id);
