-- Lead-day grain for EXACT window-distinct lead counts. The daily aggregate (agent_daily) stores
-- per-day distinct lead counts; summing those over a multi-day window over-counts any lead touched on
-- more than one day (an outbound lead redialed across a week). This table keeps lead identity at
-- (team_id, agent_type, lead_id, activity_day) so report_lead_counts() can COUNT(DISTINCT lead_id)
-- over an arbitrary range. Populated by the sync (aggregate.ts → backfill.ts), read by GET /api/reports.
--
-- This migration captures objects that were created live but never committed as a migration; it is
-- idempotent (create if not exists / create or replace) so it is a no-op against the current DB and
-- reproduces them on a fresh rebuild.
--
-- Run in the Supabase SQL editor or `supabase db push`.

create table if not exists public.agent_lead_days (
  team_id      text    not null,
  agent_type   text    not null,
  lead_id      text    not null,
  activity_day date    not null,
  dialed       boolean not null default false, -- had ≥1 call (is_call) that day
  connected    boolean not null default false, -- two-way conversation that day (talk_seconds>0 OR sms_replied>0)
  qualified    boolean not null default false, -- was qualified that day
  appointment  boolean not null default false, -- booked an appointment that day
  primary key (team_id, agent_type, lead_id, activity_day)
);
create index if not exists agent_lead_days_team_day_idx on public.agent_lead_days (team_id, activity_day);

-- Window-distinct lead counts per agent_type over [p_start, p_end). Each lead counts once no matter how
-- many days it was touched. Read by route.ts leadCountsFor() → buildResult (Leads dialed / distinct appts).
create or replace function public.report_lead_counts(p_team text, p_start date, p_end date)
returns table(
  agent_type      text,
  leads_contacted bigint,
  leads_dialed    bigint,
  leads_connected bigint,
  leads_qualified bigint,
  appt_leads      bigint
)
language sql
stable
as $function$
  select agent_type,
         count(distinct lead_id)                             as leads_contacted,
         count(distinct lead_id) filter (where dialed)       as leads_dialed,
         count(distinct lead_id) filter (where connected)    as leads_connected,
         count(distinct lead_id) filter (where qualified)    as leads_qualified,
         count(distinct lead_id) filter (where appointment)  as appt_leads
  from public.agent_lead_days
  where team_id = p_team and activity_day >= p_start and activity_day < p_end
  group by agent_type;
$function$;
