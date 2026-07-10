-- report_transfer_quality was one blended row per team (Sales+Service mixed) computed from raw,
-- non-deduped endcallreports rows. Split by service_type so a Sales-scoped view never gets swamped
-- by Service volume (verified on John Elway Harley-Davidson: the blended number was 96% Service data
-- shown on a Sales page). scripts/push_metrics.py now pushes one row per (team_id, service_type).
alter table public.report_transfer_quality add column if not exists service_type text; -- "sales" | "service"

create index if not exists report_transfer_quality_team_service_idx
  on public.report_transfer_quality (team_id, service_type);
