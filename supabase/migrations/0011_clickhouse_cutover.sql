-- ClickHouse-direct cutover (Metabase removed).
--
-- Two DB changes the new ETL (scripts/backfill.ts, ClickHouse-direct + watermark-incremental) needs:
--
--   (1) sync_state.watermark — the max source `updatedAt` the last incremental run processed. The sync
--       asks ClickHouse which (team, day) partitions changed since this and re-aggregates from the oldest
--       changed day (capped), so late edits to old rows are caught without re-scanning all of history.
--
--   (2) report_detail() — REWRITTEN to stop selecting the three tables the cutover retires:
--         • report_appointments   — the /reports/agents "Upcoming appointments" card now lists from the
--                                    live /api/meetings Spyne proxy; this detail was computed but unrendered.
--         • report_open_funnel     — never populated by any in-repo ETL (was an external Metabase card).
--         • report_money_on_table  — same; never populated.
--       Leaving the old RPC pointed at these would throw once they're dropped (all six detail surfaces come
--       from this one function). The surviving keys (callbacks / campaigns / outcomes) are now fed directly
--       from ClickHouse by backfill.ts. build.ts already tolerates the dropped keys (optional-chained →
--       the speed-to-lead open-funnel and "money on the table" cards keep their existing coming-soon state).
--
-- The DROP of those three tables, the route.ts fallback-read cleanup, and the supabase.ts constant removal
-- ship together in the code cutover (after this RPC no longer references them). This migration is safe to
-- apply first: it only ADDS a column and REPLACES the function.
--
-- NOTE on a "precomputed overview" materialized view: deliberately NOT added here. A naive
-- sum-every-column MV over agent_daily would re-introduce the "Leads dialed" inflation — appointments and
-- leads_attempted are per-day DISTINCT-lead counts that must NOT be summed across days (that's exactly what
-- agent_lead_days + report_lead_counts_2() exist to fix). agent_daily (additive grain) + agent_lead_days
-- (lead identity) ARE the precompute; the 0010 RPCs already collapse the windowed reads. A correct windowed
-- overview MV (additive from agent_daily, distinct from agent_lead_days) can be added once the email
-- overview's exact windows are fixed — tracked separately so it isn't guessed wrong.

-- (1) Watermark bookkeeping on the single-row sync_state.
alter table public.sync_state add column if not exists watermark timestamptz;

-- (2) report_detail() without the retired tables. Same shape/semantics for the surviving keys, so the API
-- swaps nothing; the three removed keys simply become absent (callers optional-chain them).
create or replace function public.report_detail(p_team text)
returns jsonb
language sql
stable
as $function$
  select jsonb_build_object(
    'callbacks',  coalesce((select jsonb_agg(t) from public.report_callbacks t where t.team_id = p_team), '[]'::jsonb),
    'campaigns',  coalesce((select jsonb_agg(t) from public.report_campaigns t where t.team_id = p_team), '[]'::jsonb),
    'outcomes',   coalesce((select jsonb_agg(t) from public.report_outcomes  t where t.team_id = p_team), '[]'::jsonb)
  );
$function$;

-- (3) Drop the retired detail tables. Safe now that report_detail() (above) and /api/reports no longer
-- reference them. report_appointments: the "Upcoming appointments" card lists from the live /api/meetings
-- proxy. report_open_funnel / report_money_on_table: never populated by any in-repo ETL.
drop table if exists public.report_appointments;
drop table if exists public.report_open_funnel;
drop table if exists public.report_money_on_table;
