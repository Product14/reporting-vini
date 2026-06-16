import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/* Server-only Supabase client (service-role key — full read/write, bypasses RLS).
 * Never import this into a Client Component; it must stay server-side. Both /api/sync (writes)
 * and /api/reports (reads) use it. Returns null when unconfigured so callers can degrade to mock. */

let cached: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  cached = createClient(url, key, { auth: { persistSession: false } });
  return cached;
}

export const AGENT_DAILY = "agent_daily";
export const AGENT_DAILY_BREAKDOWN = "agent_daily_breakdown";
export const SYNC_STATE = "sync_state";
// Per-row detail tables (see supabase/migrations/0002_report_detail.sql).
export const REPORT_APPOINTMENTS = "report_appointments";
export const REPORT_CALLBACKS = "report_callbacks";
export const REPORT_CAMPAIGNS = "report_campaigns";
export const REPORT_OUTCOMES = "report_outcomes";
export const STL_LEAD_FIRST = "stl_lead_first";
// Persisted rooftop timezone map (see supabase/migrations/0006_team_tz.sql). Seeded by the sync when a
// Spyne token is available; read as a fallback so bucketing stays store-local across token outages.
export const TEAM_TZ = "team_tz";
