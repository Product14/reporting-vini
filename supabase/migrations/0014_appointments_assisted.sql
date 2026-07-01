-- canonical (LOCKED 2026-06-30): Appointments are TWO metrics, never merged.
--   • AI-booked (PRIMARY / headline)  = meetings.source='spyne' (the AI created the meeting record).
--   • AI-assisted (CRM, SECONDARY)    = meeting booked in the CRM (source!='spyne') on a lead the agent
--                                       worked (outbound-task / AI conversation). Shown smaller; NEVER
--                                       folded into the headline.
-- This migration adds the storage + window-distinct read path for the AI-assisted (CRM) secondary count.
-- The existing `appointments` / `appointment` columns keep their meaning (AI-booked, source='spyne').
-- Idempotent (add column if not exists / create or replace).

-- (1) Summable daily count of distinct AI-assisted (CRM) appt leads. Written by aggregate.ts.
alter table public.agent_daily
  add column if not exists appointments_assisted integer not null default 0;

-- (2) Lead-day flag so the AI-assisted count is window-DISTINCT (a lead assisted on N days counts once).
alter table public.agent_lead_days
  add column if not exists appointment_assisted boolean not null default false;

-- (3) report_lead_counts() — add the window-distinct AI-assisted appt-lead count alongside appt_leads.
-- DROP first: adding a column to a function's RETURNS TABLE changes its result type, which
-- CREATE OR REPLACE cannot do in Postgres ("cannot change return type of existing function").
drop function if exists public.report_lead_counts(text, date, date);
create or replace function public.report_lead_counts(p_team text, p_start date, p_end date)
returns table(
  agent_type        text,
  leads_contacted   bigint,
  leads_dialed      bigint,
  leads_connected   bigint,
  leads_qualified   bigint,
  appt_leads        bigint,
  appt_leads_assisted bigint  -- canonical: AI-assisted (CRM) — SECONDARY, kept separate from appt_leads
)
language sql
stable
as $function$
  select agent_type,
         count(distinct lead_id)                                      as leads_contacted,
         count(distinct lead_id) filter (where dialed)                as leads_dialed,
         count(distinct lead_id) filter (where connected)             as leads_connected,
         count(distinct lead_id) filter (where qualified)             as leads_qualified,
         count(distinct lead_id) filter (where appointment)           as appt_leads,
         count(distinct lead_id) filter (where appointment_assisted)  as appt_leads_assisted
  from public.agent_lead_days
  where team_id = p_team and activity_day >= p_start and activity_day < p_end
  group by agent_type;
$function$;

-- (4) report_lead_counts_2() — same AI-assisted column for the current + prior window in one pass.
-- DROP first for the same reason as (3) — the RETURNS TABLE column set is changing.
drop function if exists public.report_lead_counts_2(text, date, date, date, date);
create or replace function public.report_lead_counts_2(
  p_team text, p_cur_start date, p_cur_end date, p_prior_start date, p_prior_end date
)
returns table(
  win                 text,
  agent_type          text,
  leads_contacted     bigint,
  leads_dialed        bigint,
  leads_connected     bigint,
  leads_qualified     bigint,
  appt_leads          bigint,
  appt_leads_assisted bigint  -- canonical: AI-assisted (CRM) — SECONDARY
)
language sql
stable
as $function$
  select win,
         agent_type,
         count(distinct lead_id)                                      as leads_contacted,
         count(distinct lead_id) filter (where dialed)                as leads_dialed,
         count(distinct lead_id) filter (where connected)             as leads_connected,
         count(distinct lead_id) filter (where qualified)             as leads_qualified,
         count(distinct lead_id) filter (where appointment)           as appt_leads,
         count(distinct lead_id) filter (where appointment_assisted)  as appt_leads_assisted
  from (
    select 'cur'::text   as win, agent_type, lead_id, dialed, connected, qualified, appointment, appointment_assisted
    from public.agent_lead_days
    where team_id = p_team and activity_day >= p_cur_start   and activity_day < p_cur_end
    union all
    select 'prior'::text as win, agent_type, lead_id, dialed, connected, qualified, appointment, appointment_assisted
    from public.agent_lead_days
    where team_id = p_team and activity_day >= p_prior_start and activity_day < p_prior_end
  ) t
  group by win, agent_type;
$function$;
