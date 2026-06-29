-- "Leads by source" was inflated: it summed the per-day source breakdown, which over-counts any lead
-- touched on multiple days (lead-days ≈ conversation events for heavy-SMS dealers — e.g. I 40 Cargurus
-- showed ~1,500 vs ~322 truly distinct leads). Same trap agent_lead_days + report_lead_counts() fixed
-- for "Leads dialed". The fix: carry lead_source onto the lead-day grain and COUNT(DISTINCT lead_id)
-- per source over the window.
--
-- Idempotent (add column if not exists / create or replace) — safe to re-run.

alter table public.agent_lead_days add column if not exists lead_source text;

-- Window-distinct lead counts per (agent_type, lead_source) over [p_start, p_end). Each lead counts once
-- regardless of how many days it was touched. Read by route.ts → buildResult → "Leads by source" card:
--   total_leads     = leads from this source the agent touched
--   interacted_leads = subset that had a two-way conversation (connected)
--   booked_leads    = subset that booked an appointment
create or replace function public.report_source_counts(p_team text, p_start date, p_end date)
returns table(
  agent_type       text,
  lead_source      text,
  total_leads      bigint,
  interacted_leads bigint,
  booked_leads     bigint
)
language sql
stable
as $function$
  select agent_type,
         lead_source,
         count(distinct lead_id)                            as total_leads,
         count(distinct lead_id) filter (where connected)   as interacted_leads,
         count(distinct lead_id) filter (where appointment) as booked_leads
  from public.agent_lead_days
  where team_id = p_team
    and activity_day >= p_start and activity_day < p_end
    and lead_source is not null and lead_source <> ''
  group by agent_type, lead_source;
$function$;
