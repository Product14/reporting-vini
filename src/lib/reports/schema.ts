/* Shapes for the materialized reporting aggregate.
 *
 * The sync (aggregate.ts) reduces Q12227's event-level rows — one per conversation — into:
 *   • agent_daily        — one summable row per (activity_day, team_id, agent_type)
 *   • agent_daily_breakdown — tall distribution rows (intent / source / hour / reply-offset)
 *
 * The GET API (build.ts) sums these across a date range and rebuilds the AgentData[] the UI
 * already consumes. Column names are snake_case to map 1:1 onto Postgres/Supabase columns. */

// One raw Q12227 row (event-level). Only the columns we read are typed; the rest pass through.
export interface RawRow {
  "cs.team_id": string;
  "cs.lead_id": string;
  enterprise_name: string;
  rooftop_name: string;
  rooftop_stage: string;
  agent_type: string; // "Sales Inbound" | "Sales Outbound" | "Service Inbound" | "Service Outbound"
  activity_day: string; // "YYYY-MM-DD"
  activity_ts: string; // ISO timestamp
  lead_created_at: string | null;
  lead_source: string | null;
  primary_intent: string | null;
  is_call: number;
  is_sms: number;
  n_sms_outbound: number;
  qualified: number;
  appointment_booked: number; // canonical: AI-booked (meetings.source='spyne') — PRIMARY/headline
  // canonical: AI-assisted (CRM, source!='spyne', booked on an agent-worked lead) — SECONDARY metric
  appointment_assisted: number;
  connected: number;
  reached_person: number;
  sms_replied: number;
  query_resolved: number;
  // CANONICAL transfer flag from the spine (1 when endedReason ∈ {'transferred','assistant-forwarded-call'}).
  // Completed hand-off to a human; matches the Calls tab. Used for counts (NOT the IRA had_transfer).
  transferred?: number;
  transfer_failed?: number; // 1 when endedReason='transfer_failed' — reported SEPARATELY, never in transfers.
  had_transfer: number; // legacy IRA/resolution-derived flag; undercounts ~⅓. Kept for a future quality view.
  // Retained upstream as the stricter "AI-completed-transfer" signal for a future quality view.
  had_callback: number;
  had_appt_intent: number;
  talk_seconds: number;
  quality_score: number | null;
  opted_out_sms: number;
  opted_out_call: number;
  after_hours: number;
  is_speed_to_lead: number; // 1 = speed-to-lead SMS (smsFlowJourneySource = speed_to_lead)
  speed_to_lead_response_time: number | null; // seconds: lead.external_created_at → conversation.createdAt
  [k: string]: unknown;
}

// Summable daily fact row. The GET API sums these over a window; nothing here is a ratio.
export interface AgentDailyRow {
  activity_day: string;
  team_id: string;
  agent_type: string;
  enterprise_name: string;
  rooftop_name: string;
  rooftop_stage: string;
  // volume
  calls: number; // Σ is_call
  sms_threads: number; // Σ is_sms
  conv_count: number; // total conversations (rows)
  connected: number; // Σ connected
  reached_person: number; // Σ reached_person
  qualified: number; // Σ qualified
  appointments: number; // canonical: distinct AI-booked appt leads (source='spyne') — PRIMARY/headline
  // canonical: distinct AI-assisted (CRM) appt leads — SECONDARY, shown smaller, never in the headline
  appointments_assisted: number;
  sms_sent: number; // Σ n_sms_outbound
  sms_replied: number; // Σ sms_replied
  after_hours: number; // Σ after_hours
  talk_seconds: number; // Σ talk_seconds
  transfers: number; // Σ transferred (disposition, incl assistant-forwarded-call). Call-level; the
  // window-DISTINCT headline comes from agent_lead_days via report_lead_counts (leads.transferLeads).
  transfers_failed: number; // Σ transfer_failed — reported separately, never folded into transfers
  callbacks: number; // Σ had_callback
  query_resolved: number; // Σ query_resolved
  opt_outs: number; // Σ opted_out_sms
  leads_attempted: number; // COUNT(DISTINCT cs.lead_id)
  // quality accumulators → weighted mean in the API
  quality_score_sum: number;
  quality_basis: number; // # rows with a quality_score
  // speed-to-lead accumulators (earliest is_speed_to_lead conversation per lead — cross-day deduped)
  new_leads: number; // distinct STL leads whose earliest STL conversation is on this activity_day
  stl_within5: number; // STL leads with speed_to_lead_response_time ≤ 300s ("instantly touched")
  stl_within1: number; // STL leads with speed_to_lead_response_time ≤ 60s (median-vs-1min upsell gate)
  stl_seconds_sum: number; // Σ min(speed_to_lead_response_time, 10m) — capped for average only
  stl_count: number; // # STL leads with a measurable speed_to_lead_response_time
  stl_afterhours_within5: number; // instantly-touched STL leads whose STL SMS was after-hours
  stl_within5_appts: number; // instantly-touched STL leads that booked on the earliest STL row
}

export type BreakdownDim = "intent" | "source" | "hour" | "reply_offset";

// Tall distribution row. e.g. (dim="intent", dim_value="Pricing / payment", count=95, qualified=72).
export interface BreakdownRow {
  activity_day: string;
  team_id: string;
  agent_type: string;
  dim: BreakdownDim;
  dim_value: string;
  count: number;
  qualified: number; // resolved (intent) / appts-eligible — dim-specific
  appts: number;
}

// One row per (team_id, agent_type, lead_id, activity_day). Retains lead identity so window-distinct
// counts are EXACT (COUNT(DISTINCT lead_id) over the range) instead of summing per-day distincts —
// which over-counts any lead touched on multiple days (e.g. an outbound lead redialed across a week).
export interface LeadDayRow {
  team_id: string;
  agent_type: string;
  lead_id: string;
  activity_day: string;
  lead_source: string | null; // CRM source of the lead — carried here so "Leads by source" can be
  // window-distinct (COUNT(DISTINCT lead_id) per source) instead of summing per-day breakdown counts.
  dialed: boolean; // had ≥1 call (is_call) that day
  connected: boolean; // had a two-way conversation that day (talk_seconds>0 OR sms_replied>0)
  qualified: boolean; // was qualified that day
  appointment: boolean; // canonical: booked an AI appt (source='spyne') that day — PRIMARY
  appointment_assisted: boolean; // canonical: AI-assisted (CRM) appt that day — SECONDARY
  transferred: boolean; // canonical: had ≥1 completed transfer (disposition) that day — lead-level
  transfer_failed: boolean; // had ≥1 failed transfer that day — reported separately
}

export interface AggregateResult {
  daily: AgentDailyRow[];
  breakdown: BreakdownRow[];
  leadDays: LeadDayRow[];
}

// ── Per-row detail tables (rooftop-level; keyed by team_id). Populated by the sync from the dedicated
//    Metabase cards, read by the GET API and attached to each report. Not part of the daily aggregate. ──
export interface AppointmentRow {
  team_id: string;
  customer_name: string | null;
  appointment_time: string | null;
  vehicle: string | null;
  status: string | null;
  assigned_to: string | null;
  booked_at: string | null;
}
export interface CallbackRow {
  team_id: string;
  service_type: string | null; // 'sales' | 'service' — scopes the follow-up to the agent's department
  customer_name: string | null;
  callback_due: string | null;
  intent: string | null;
  priority: string | null;
  assigned_to: string | null;
  requested_on: string | null;
}
export interface CampaignRow {
  team_id: string;
  agent_type: string | null; // "Sales Outbound" | "Service Outbound" — which outbound agent owns it
  campaign: string;
  use_case: string | null;
  enrolled: number;
  appointments: number;
  warm_leads: number;
  opt_outs: number;
  no_reach: number;
  appt_rate_pct: number | null;
}
// Outbound disposition mix (card 12231) → the "Outbound outcomes" widget. One row per
// (team_id, agent_type, outcome_bucket). pct is derived downstream from mappings, not stored.
export interface OutcomeRow {
  team_id: string;
  agent_type: string | null; // "Sales Outbound" | "Service Outbound" — which outbound agent owns it
  outcome_bucket: string; // e.g. "1 No reach" … "10 Other"; numeric prefix is sort order only (stripped for display)
  mappings: number;
}
// Sales-IB "open funnel" (card 12341 → report_open_funnel): leads handled → appointments booked, per
// acquisition path. Rooftop-level, agent_type='Sales Inbound'. Rates are FRACTIONS (0.0771 = 7.71%);
// build rounds them to whole-number %. All-time (12341 isn't date-windowed yet).
export interface OpenFunnelRow {
  team_id: string;
  agent_type: string | null;
  stl_leads_handled: number;
  stl_appointments_booked: number;
  stl_handled_to_booked_rate: number;
  followup_leads_handled: number;
  followup_appointments_booked: number;
  followup_handled_to_booked_rate: number;
}
// "Money on the table" (card 12236 → report_money_on_table): recoverable INBOUND leads by bucket —
// leads the AI engaged that haven't booked. Rooftop-level, per inbound agent_type. The bucket's letter
// prefix ("A. ") is sort order only; build strips it for display.
export interface RecoverableRow {
  team_id: string;
  agent_type: string | null; // "Sales Inbound" | "Service Inbound"
  recoverable_bucket: string;
  recoverable_leads: number;
}

// ── "Coming soon" metrics derived from ClickHouse (dealer_leads), not Q12227. Written by
//    scripts/push_metrics.py via POST /api/reports/metrics; read by GET /api/reports/metrics.
//    Rooftop-level (team_id). Rates are FRACTIONS (0.779 = 77.9%). See 0009_report_coming_soon.sql. ──
export interface ApptStatusRow {
  team_id: string;
  service_type: string | null;
  booked_via: string | null; // "call" | "sms/chat"
  booked: number;
  showed: number;
  no_show: number;
  cancelled: number;
  upcoming: number;
  show_rate: number | null;
  window_days: number | null;
}
export interface TransferQualityRow {
  team_id: string;
  transfers_ok: number;
  transfers_failed: number;
  forwarded: number;
  success_rate: number | null;
  window_days: number | null;
}
export interface CallsByReasonRow {
  team_id: string;
  direction: string | null; // "inbound" | "outbound"
  reason: string;
  calls: number;
  booked: number;
  window_days: number | null;
}
export interface OutboundCampaignRow {
  team_id: string;
  campaign_id: string | null;
  name: string | null;
  status: string | null;
  days_live: number | null;
  leads: number;
  call_tasks: number;
  sms_tasks: number;
  appts: number;
  conversion_rate: number | null;
}
export interface ObjectionRow {
  team_id: string;
  kind: string; // "outbound_outcome" | "theme"
  label: string;
  channel: string | null; // "call" | "sms" for outbound_outcome
  count: number;
  examples: string[] | null;
  window_days: number | null;
}
export interface MissedOpportunityRow {
  team_id: string;
  channel: string; // "call" | "sms"
  category: string; // voicemail / no_answer / abandoned / sms_failed
  count: number;
  window_days: number | null;
}
export interface UpcomingMeetingRow {
  team_id: string;
  lead_id: string | null;
  service_type: string | null;
  intent: string | null;
  booked_via: string | null;
  meeting_start_time: string | null;
}
export interface FollowUpRow {
  team_id: string;
  source: string | null; // "call_action_item" | "outbound_callback"
  channel: string | null; // "call" | "sms"
  lead_id: string | null;
  detail: string | null;
  due_at: string | null;
}
export interface HighlightRow {
  team_id: string;
  direction: string | null;
  use_case: string | null;
  score: number | null;
  title: string | null;
  occurred_on: string | null;
}

// Single-row sync bookkeeping table (id = 1).
export interface SyncState {
  id: number;
  last_run_at: string | null;
  last_status: "ok" | "error" | null;
  rows_synced: number | null;
  window_start: string | null;
  error: string | null;
}
