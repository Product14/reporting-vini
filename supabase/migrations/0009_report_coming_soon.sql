-- "Coming soon" / mock metrics promoted to live (AGENT_FIELDS.md widgets #9, #12, #15, #16, #19, #22, #23
-- and the `showed` metric). These are NOT in Q12227/Metabase — they're derived from production ClickHouse
-- (dealer_leads) by scripts/push_metrics.py, which runs the `ch` queries and POSTs the result to
-- POST /api/reports/metrics. That endpoint replaces a team's rows (delete-by-team then insert), exactly
-- like the other report_* detail tables. GET /api/reports/metrics reads them back, filtered by team_id.
--
-- All tables are ROOFTOP-level (team_id). Rates are stored as FRACTIONS (0.779 = 77.9%) to match the
-- report_open_funnel convention; the reader rounds to whole-number %. window_days records the trailing
-- window the snapshot was computed over (feed tables omit it — they're point-in-time, not windowed).
--
-- Run in the Supabase SQL editor or `supabase db push`.

-- ── appointment status / show rate (the `showed` metric) ──
create table if not exists public.report_appt_status (
  team_id      text not null,
  service_type text,                 -- "sales" | "service"
  booked_via   text,                 -- "call" | "sms/chat"
  booked       integer not null default 0,
  showed       integer not null default 0,   -- status IN ('show','completed')
  no_show      integer not null default 0,   -- status IN ('noshow','no_show')
  cancelled    integer not null default 0,
  upcoming     integer not null default 0,   -- still scheduled, in the future
  show_rate    numeric,                       -- fraction; null when no resolved meetings
  window_days  integer,
  synced_at    timestamptz not null default now()
);
create index if not exists report_appt_status_team_idx on public.report_appt_status (team_id);

-- ── transfer success (quality 4th cell, widget #19) — one row per team ──
create table if not exists public.report_transfer_quality (
  team_id          text not null,
  transfers_ok     integer not null default 0,  -- endedReason='transferred'
  transfers_failed integer not null default 0,
  forwarded        integer not null default 0,  -- assistant-forwarded-call (cold forward)
  success_rate     numeric,                      -- ok / (ok + failed), fraction
  window_days      integer,
  synced_at        timestamptz not null default now()
);
create index if not exists report_transfer_quality_team_idx on public.report_transfer_quality (team_id);

-- ── calls by reason (widget #23) ──
create table if not exists public.report_calls_by_reason (
  team_id     text not null,
  direction   text,                 -- "inbound" | "outbound"
  reason      text not null,        -- report_useCase (Service / Sales / Parts / …)
  calls       integer not null default 0,
  booked      integer not null default 0,
  window_days integer,
  synced_at   timestamptz not null default now()
);
create index if not exists report_calls_by_reason_team_idx on public.report_calls_by_reason (team_id);

-- ── active outbound campaigns, multichannel (widget #9) ──
create table if not exists public.report_outbound_campaigns (
  team_id         text not null,
  campaign_id     text,
  name            text,
  status          text,             -- campaignStatus (running / paused / …)
  days_live       integer,
  leads           integer not null default 0,
  call_tasks      integer not null default 0,
  sms_tasks       integer not null default 0,
  appts           integer not null default 0,
  conversion_rate numeric,          -- appts / leads, fraction
  synced_at       timestamptz not null default now()
);
create index if not exists report_outbound_campaigns_team_idx on public.report_outbound_campaigns (team_id);

-- ── top objections (widget #12): structured outbound outcomes + AI-clustered themes ──
create table if not exists public.report_objections (
  team_id     text not null,
  kind        text not null,        -- "outbound_outcome" (structured) | "theme" (AI-clustered)
  label       text not null,
  channel     text,                 -- "call" | "sms" for outbound_outcome; null for themes
  count       integer not null default 0,
  examples    text[],               -- a few sample phrases (themes only)
  window_days integer,
  synced_at   timestamptz not null default now()
);
create index if not exists report_objections_team_idx on public.report_objections (team_id, kind);

-- ── missed opportunities (widget #22), call + sms ──
create table if not exists public.report_missed_opportunities (
  team_id     text not null,
  channel     text not null,        -- "call" | "sms"
  category    text not null,        -- voicemail / no_answer / abandoned / sms_failed
  count       integer not null default 0,
  window_days integer,
  synced_at   timestamptz not null default now()
);
create index if not exists report_missed_opportunities_team_idx on public.report_missed_opportunities (team_id);

-- ── upcoming appointment feed (widget #15) — point-in-time, not windowed ──
create table if not exists public.report_upcoming_meetings (
  team_id            text not null,
  lead_id            text,
  service_type       text,
  intent             text,
  booked_via         text,          -- "call" | "sms/chat"
  meeting_start_time timestamptz,
  synced_at          timestamptz not null default now()
);
create index if not exists report_upcoming_meetings_team_idx on public.report_upcoming_meetings (team_id, meeting_start_time);

-- ── priority follow-ups (widget #16): call action-items + outbound callbacks due, call + sms ──
create table if not exists public.report_follow_ups (
  team_id   text not null,
  source    text,                   -- "call_action_item" | "outbound_callback"
  channel   text,                   -- "call" | "sms"
  lead_id   text,
  detail    text,
  due_at    timestamptz,
  synced_at timestamptz not null default now()
);
create index if not exists report_follow_ups_team_idx on public.report_follow_ups (team_id);

-- ── highlights — best booked calls (widget #22) — point-in-time feed ──
create table if not exists public.report_highlights (
  team_id     text not null,
  direction   text,
  use_case    text,
  score       integer,
  title       text,
  occurred_on date,
  synced_at   timestamptz not null default now()
);
create index if not exists report_highlights_team_idx on public.report_highlights (team_id);
