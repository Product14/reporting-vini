-- Round-trip reducers for GET /api/reports.
--
-- Background: /api/reports was making ~11 Supabase round-trips per (team × window)
-- call — agent_daily ×2 (current + prior window), agent_daily_breakdown, six
-- report_* detail reads, and report_lead_counts ×2. At ~13k calls/day that's the
-- bulk of the project's API volume. These two functions collapse the detail reads
-- and the lead-count reads into ONE call each, with no change to the data returned.
--
-- Both are STABLE/read-only and additive — the original report_lead_counts() is
-- kept intact, so nothing that used it breaks.

-- (1) All six per-team detail tables in a single JSONB payload. Each key holds the
-- exact same rows `select * ... where team_id = $1` returned, so the API can swap
-- six reads for one rpc() and parse the arrays unchanged. coalesce → [] keeps the
-- shape stable for teams with no rows.
create or replace function public.report_detail(p_team text)
returns jsonb
language sql
stable
as $function$
  select jsonb_build_object(
    'appointments', coalesce((select jsonb_agg(t) from public.report_appointments    t where t.team_id = p_team), '[]'::jsonb),
    'callbacks',    coalesce((select jsonb_agg(t) from public.report_callbacks       t where t.team_id = p_team), '[]'::jsonb),
    'campaigns',    coalesce((select jsonb_agg(t) from public.report_campaigns       t where t.team_id = p_team), '[]'::jsonb),
    'outcomes',     coalesce((select jsonb_agg(t) from public.report_outcomes        t where t.team_id = p_team), '[]'::jsonb),
    'openFunnel',   coalesce((select jsonb_agg(t) from public.report_open_funnel     t where t.team_id = p_team), '[]'::jsonb),
    'recoverable',  coalesce((select jsonb_agg(t) from public.report_money_on_table  t where t.team_id = p_team), '[]'::jsonb)
  );
$function$;

-- (2) Window-distinct lead counts for the current AND prior window in one pass.
-- Same per-window output as report_lead_counts(), tagged with `win` ('cur'|'prior')
-- so the API gets both windows from a single rpc() instead of two.
create or replace function public.report_lead_counts_2(
  p_team text, p_cur_start date, p_cur_end date, p_prior_start date, p_prior_end date
)
returns table(
  win             text,
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
  select win,
         agent_type,
         count(distinct lead_id)                            as leads_contacted,
         count(distinct lead_id) filter (where dialed)      as leads_dialed,
         count(distinct lead_id) filter (where connected)   as leads_connected,
         count(distinct lead_id) filter (where qualified)   as leads_qualified,
         count(distinct lead_id) filter (where appointment) as appt_leads
  from (
    select 'cur'::text   as win, agent_type, lead_id, dialed, connected, qualified, appointment
    from public.agent_lead_days
    where team_id = p_team and activity_day >= p_cur_start   and activity_day < p_cur_end
    union all
    select 'prior'::text as win, agent_type, lead_id, dialed, connected, qualified, appointment
    from public.agent_lead_days
    where team_id = p_team and activity_day >= p_prior_start and activity_day < p_prior_end
  ) t
  group by win, agent_type;
$function$;
