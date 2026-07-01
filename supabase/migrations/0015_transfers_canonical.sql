-- canonical (LOCKED 2026-07-01): Transfers = COMPLETED disposition hand-offs to a human =
--   endcallreports.callDetails_endedReason ∈ {'transferred','assistant-forwarded-call'} (matches the
--   Calls tab; counts AI→human forwards). Counted WINDOW-DISTINCT at the LEAD grain (to match the
--   leads → conversations → qualified funnel), with callback-from-outbound already re-attributed to
--   outbound upstream. FAILED transfers (endedReason='transfer_failed') are stored + reported SEPARATELY,
--   never folded into the transfer count. IRA ('transfer completed') is NOT used — it undercounts ~⅓.
-- This migration adds the storage + window-distinct read path. Idempotent (add column if not exists /
-- drop+create function).

-- (1) Summable daily counts (call-level) written by aggregate.ts.
alter table public.agent_daily
  add column if not exists transfers_failed integer not null default 0;

-- (2) Lead-day flags so transfer counts are window-DISTINCT (a lead transferred on N days counts once).
alter table public.agent_lead_days
  add column if not exists transferred     boolean not null default false;
alter table public.agent_lead_days
  add column if not exists transfer_failed boolean not null default false;

-- (3) report_lead_counts() — add window-distinct transfer + failed-transfer lead counts.
-- DROP first: changing RETURNS TABLE column set can't be done via CREATE OR REPLACE.
drop function if exists public.report_lead_counts(text, date, date);
create or replace function public.report_lead_counts(p_team text, p_start date, p_end date)
returns table(
  agent_type          text,
  leads_contacted     bigint,
  leads_dialed        bigint,
  leads_connected     bigint,
  leads_qualified     bigint,
  appt_leads          bigint,
  appt_leads_assisted bigint,
  transfer_leads        bigint,  -- canonical: window-distinct completed transfers (headline)
  transfer_failed_leads bigint   -- reported separately
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
         count(distinct lead_id) filter (where appointment_assisted)  as appt_leads_assisted,
         count(distinct lead_id) filter (where transferred)           as transfer_leads,
         count(distinct lead_id) filter (where transfer_failed)       as transfer_failed_leads
  from public.agent_lead_days
  where team_id = p_team and activity_day >= p_start and activity_day < p_end
  group by agent_type;
$function$;

-- (4) report_lead_counts_2() — current + prior window in one pass.
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
  appt_leads_assisted bigint,
  transfer_leads        bigint,
  transfer_failed_leads bigint
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
         count(distinct lead_id) filter (where appointment_assisted)  as appt_leads_assisted,
         count(distinct lead_id) filter (where transferred)           as transfer_leads,
         count(distinct lead_id) filter (where transfer_failed)       as transfer_failed_leads
  from (
    select 'cur'::text   as win, agent_type, lead_id, dialed, connected, qualified, appointment, appointment_assisted, transferred, transfer_failed
    from public.agent_lead_days
    where team_id = p_team and activity_day >= p_cur_start   and activity_day < p_cur_end
    union all
    select 'prior'::text as win, agent_type, lead_id, dialed, connected, qualified, appointment, appointment_assisted, transferred, transfer_failed
    from public.agent_lead_days
    where team_id = p_team and activity_day >= p_prior_start and activity_day < p_prior_end
  ) t
  group by win, agent_type;
$function$;
