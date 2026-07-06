-- Revives report_appointments (dropped in 0011), now sourced ClickHouse-direct by scripts/backfill.ts
-- instead of the live /api/meetings proxy.
--
-- WHY: the live Spyne meetings API (leads/dealer/v3/meetings) returns 401 the moment its session token
-- expires; spyneGet swallows the 401 and returns [], so the daily digest's appointment LIST and "Top
-- vehicles of interest" silently blank out — even though the appointment COUNT (from agent_lead_days)
-- still shows. Result: "N appointments booked" with an empty list. Sourcing these from a Supabase
-- snapshot (the same ETL that already feeds every other report number) removes that live dependency.
--
-- A trailing-window snapshot of AI-booked (meetings.source='spyne') meetings, resolved with the customer
-- name/phone (dealer_leads.customer) and vehicle make/model/year (proposed_vins → inventory.vinMaster,
-- with inventory.dealerVinMapping bridging the dealerVinId form). Full delete+replace each sync, exactly
-- like report_campaigns / report_outcomes / report_callbacks. Serves three reads in /api/meetings:
--   • scope=window       → rows booked_at ∈ [start, end)      (the digest's appointment list / drill-down)
--   • scope=upcoming     → rows meeting_start ≥ now, soonest first
--   • scope=top-vehicles → rows booked_at ≥ now-Nd, grouped by vehicle
-- Idempotent (create if not exists).

create table if not exists public.report_appointments (
  team_id        text not null,
  enterprise_id  text,
  service_type   text,           -- 'sales' | 'service'
  lead_id        text,
  meeting_id     text,
  customer_name  text,
  phone          text,
  vehicle        text,           -- "2019 Chevrolet Corvette Z06 1LZ", or '' when no VIN could be resolved
  intent         text,
  meeting_start  timestamptz,    -- when the appointment is scheduled
  booked_at      timestamptz,    -- when the meeting record was created (the "booked in period" date)
  synced_at      timestamptz not null default now()
);

-- window / drill-down reads filter by (team, service_type, booked_at); upcoming reads by meeting_start.
create index if not exists report_appointments_team_booked_idx
  on public.report_appointments (team_id, service_type, booked_at);
create index if not exists report_appointments_team_start_idx
  on public.report_appointments (team_id, service_type, meeting_start);
