-- Reporting tab v3: named lists + intent-outcome measures. Additive + idempotent only —
-- migration 0016 is ALREADY APPLIED in prod (report_appointments is live), so its extensions here
-- are defensive ALTERs, never a table rewrite.

-- (1) report_appointments: AI-assisted (CRM) rows join the snapshot, flagged — the UI shows them
--     smaller ("AI-assisted → CRM") and never folds them into the AI-booked headline. direction /
--     booked_via ('call'|'sms') describe HOW the AI booked (AI-booked rows only; CRM meetings carry
--     no channel). status is the meeting's live status (scheduled/cancelled/show/noshow/completed).
alter table public.report_appointments add column if not exists assisted   boolean not null default false;
alter table public.report_appointments add column if not exists direction  text;
alter table public.report_appointments add column if not exists booked_via text;
alter table public.report_appointments add column if not exists status     text;

-- (2) Named warm leads ("Work these now"). Snapshot table, full delete+replace each sync like the
--     other report_* detail tables. tier: 'hot' (concrete buying signal) | 'warm' (engaged, nurture).
--     source: 'ib' (buying-intent action item) | 'ob' (campaign outcome).
create table if not exists public.report_warm_leads (
  team_id       text not null,
  source        text,
  service_type  text,
  lead_id       text,
  tier          text,
  customer_name text,
  phone         text,
  campaign      text,
  outcome       text,
  last_activity timestamptz,
  synced_at     timestamptz not null default now()
);
create index if not exists report_warm_leads_team_idx
  on public.report_warm_leads (team_id, tier, last_activity desc);

-- (3) Intent×outcome measures for the inbound "what customers wanted & how it was handled" table.
--     agent_daily_breakdown intent rows already carry count / qualified(=resolved) / appts(=booked);
--     these add the hand-off outcomes. Historical rows stay 0 until a --full re-aggregate.
alter table public.agent_daily_breakdown add column if not exists transferred integer not null default 0;
alter table public.agent_daily_breakdown add column if not exists callbacks   integer not null default 0;

-- (4) report_detail(): serve the two new keys in the same single-RPC read. Same jsonb return type →
--     CREATE OR REPLACE is legal; old API deployments ignore the extra keys, new API on an
--     un-migrated DB falls back to per-table reads.
create or replace function public.report_detail(p_team text)
returns jsonb
language sql
stable
as $function$
  select jsonb_build_object(
    'callbacks',    coalesce((select jsonb_agg(t) from public.report_callbacks    t where t.team_id = p_team), '[]'::jsonb),
    'campaigns',    coalesce((select jsonb_agg(t) from public.report_campaigns    t where t.team_id = p_team), '[]'::jsonb),
    'outcomes',     coalesce((select jsonb_agg(t) from public.report_outcomes     t where t.team_id = p_team), '[]'::jsonb),
    'appointments', coalesce((select jsonb_agg(t) from public.report_appointments t where t.team_id = p_team), '[]'::jsonb),
    'warmLeads',    coalesce((select jsonb_agg(t) from public.report_warm_leads   t where t.team_id = p_team), '[]'::jsonb)
  );
$function$;

-- PostgREST caches the schema — without this the new columns fail inserts with PGRST204 and the new
-- table 404s until a manual reload.
notify pgrst, 'reload schema';
