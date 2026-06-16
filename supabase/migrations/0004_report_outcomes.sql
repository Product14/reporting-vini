-- Outbound disposition mix (card 12231, "outbound-outcomes-bucketed") → the "Outbound outcomes"
-- widget. Like report_campaigns (0002), this is ROOFTOP-level detail: the sync pulls 12231 per
-- outbound agent_type and stores one row per (team_id, agent_type, outcome_bucket). GET /api/reports
-- filters by team_id and attaches the buckets to the matching outbound agent.
--
-- Contract (must match 12231's SELECT): the card GROUPs BY team_id and emits team_id + outcome_bucket
-- + mappings. Until 12231 carries a team_id column, the sync stores nothing (team_id is required) and
-- the widget keeps its empty state — no rework when the card is fixed. pct is NOT stored; it's
-- recomputed downstream from the mappings within an agent.
--
-- Run in the Supabase SQL editor or `supabase db push`.

create table if not exists public.report_outcomes (
  team_id        text not null,
  agent_type     text,    -- "Sales Outbound" | "Service Outbound" (card 12231 filtered per agent_type)
  outcome_bucket text not null, -- e.g. "1 No reach" … "9 Other"; the numeric prefix is sort order only
  mappings       integer not null default 0, -- # conversation-lead mappings in this bucket
  synced_at      timestamptz not null default now()
);
create index if not exists report_outcomes_team_idx on public.report_outcomes (team_id);
