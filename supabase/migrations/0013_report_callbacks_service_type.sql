-- Priority follow-ups (report_callbacks) were rooftop-wide — shown on every agent card — so a
-- service-heavy rooftop's callbacks leaked onto the Sales agents. Carry the lead's service_type so the
-- GET API can scope each agent's follow-ups to its department (sales vs service). report_detail() uses
-- jsonb_agg(t) (whole-row), so the new column flows through with no RPC change.
--
-- Idempotent (add column if not exists) — safe to re-run. Backfilled by scripts/backfill.ts.

alter table public.report_callbacks add column if not exists service_type text;
