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
  appointment_booked: number;
  connected: number;
  reached_person: number;
  sms_replied: number;
  query_resolved: number;
  had_transfer: number;
  had_callback: number;
  had_appt_intent: number;
  talk_seconds: number;
  quality_score: number | null;
  opted_out_sms: number;
  opted_out_call: number;
  after_hours: number;
  outbound_outcome: string | null; // outbound disposition: "Not Connected" | "Opt Out" | "Not Interested" | …
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
  appointments: number; // Σ appointment_booked
  sms_sent: number; // Σ n_sms_outbound
  sms_replied: number; // Σ sms_replied
  after_hours: number; // Σ after_hours
  talk_seconds: number; // Σ talk_seconds
  transfers: number; // Σ had_transfer
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

export type BreakdownDim = "intent" | "source" | "hour" | "reply_offset" | "outcome";

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

export interface AggregateResult {
  daily: AgentDailyRow[];
  breakdown: BreakdownRow[];
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

// Single-row sync bookkeeping table (id = 1).
export interface SyncState {
  id: number;
  last_run_at: string | null;
  last_status: "ok" | "error" | null;
  rows_synced: number | null;
  window_start: string | null;
  error: string | null;
}
