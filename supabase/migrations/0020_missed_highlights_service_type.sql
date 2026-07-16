-- report_highlights and report_missed_opportunities were rooftop-wide (no service dimension), so the
-- By-agent "Highlights" and "Missed opportunities" widgets showed Service wins on a Sales agent and
-- vice-versa (RETCONVAI-4150). Add a canonical service_type — the LEAD's service_type (join to
-- dealer_leads.leads), the SAME basis report_transfer_quality (0019) and the appt splits already use,
-- NOT report_useCase (which diverges: parts/finance/blank-useCase mis-bucket badly). scripts/push_metrics.py
-- now emits one dimension per (…, service_type); the by-agent view filters to the agent's own department.
alter table public.report_highlights            add column if not exists service_type text; -- "sales" | "service"
alter table public.report_missed_opportunities  add column if not exists service_type text; -- "sales" | "service"

create index if not exists report_highlights_team_service_idx
  on public.report_highlights (team_id, service_type);
create index if not exists report_missed_opportunities_team_service_idx
  on public.report_missed_opportunities (team_id, service_type);
