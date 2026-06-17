import { getSupabase, AGENT_DAILY, AGENT_DAILY_BREAKDOWN, REPORT_APPOINTMENTS, REPORT_CALLBACKS, REPORT_CAMPAIGNS, REPORT_OUTCOMES, REPORT_OPEN_FUNNEL, REPORT_MONEY_ON_TABLE } from "@/lib/reports/supabase";
import { buildResult } from "@/lib/reports/build";
import type { AgentDailyRow, BreakdownRow, AppointmentRow, CallbackRow, CampaignRow, OutcomeRow, OpenFunnelRow, RecoverableRow } from "@/lib/reports/schema";
import { rangeFor } from "@/components/reports/liveData";
import type { Bucket } from "@/components/reports/data";
import { getStoreTimeZone, getOnboardedSlots } from "@/lib/spyne/teamContext";

/* Reads the materialized aggregate from Supabase and returns the same FetchResult the reporting UI
 * already consumes — one fast query instead of the ~84 Metabase round-trips fetchAgents() used to do.
 * Falls back to all-mock agents (buildResult does this) when Supabase is unconfigured or empty. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Equal-length window immediately before [start, end) — basis for period deltas.
function priorWindow(start: string, end: string): { start: string; end: string } {
  const s = new Date(`${start}T00:00:00Z`), e = new Date(`${end}T00:00:00Z`);
  const days = Math.max(1, Math.round((e.getTime() - s.getTime()) / 86_400_000));
  const ps = new Date(s);
  ps.setUTCDate(ps.getUTCDate() - days);
  return { start: ps.toISOString().slice(0, 10), end: start };
}

export type LeadCounts = Record<string, { contacted: number; dialed: number; connected: number; qualified: number; apptLeads: number }>;

/* EXACT window-distinct lead counts per agent_type via the report_lead_counts() SQL function (counts
 * DISTINCT lead_id over the range, so a lead touched on N days counts once — not N times). Returns
 * undefined when the function/table is absent or errors, so buildResult falls back to summing the
 * per-day distincts (the previous, inflated behavior) rather than breaking. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function leadCountsFor(sb: any, teamId: string, start: string, end: string): Promise<LeadCounts | undefined> {
  try {
    const { data, error } = await sb.rpc("report_lead_counts", { p_team: teamId, p_start: start, p_end: end });
    if (error || !Array.isArray(data)) return undefined;
    const m: LeadCounts = {};
    for (const r of data as Array<Record<string, unknown>>) {
      m[String(r.agent_type)] = {
        contacted: Number(r.leads_contacted) || 0,
        dialed: Number(r.leads_dialed) || 0,
        connected: Number(r.leads_connected) || 0,
        qualified: Number(r.leads_qualified) || 0,
        apptLeads: Number(r.appt_leads) || 0,
      };
    }
    return m;
  } catch {
    return undefined;
  }
}

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const teamId = searchParams.get("team_id");
  if (!teamId) return Response.json({ error: "team_id is required" }, { status: 400 });

  // Spyne API token: PROD forwards it per-request from the host — via the Authorization header or an
  // `auth_key`/`spyne_token`/`token` query param (the host uses `auth_key`); LOCAL DEV omits it and the
  // client falls back to SPYNE_API_TOKEN (env). Strip any "Bearer " prefix from whichever source.
  const tokenSource = request.headers.get("authorization")
    || searchParams.get("auth_key") || searchParams.get("spyne_token") || searchParams.get("token") || "";
  const spyneToken = tokenSource.replace(/^Bearer\s+/i, "").trim() || null;

  // Resolve the rooftop's timezone + onboarded agents from the Spyne API (best-effort; both null when
  // auth is unavailable or the call fails → previous behavior: UTC windows, all agents shown).
  const [timezone, onboardedSlots] = await Promise.all([
    getStoreTimeZone(teamId, spyneToken),
    getOnboardedSlots(teamId, spyneToken),
  ]);

  // Relative buckets resolve to a window in the STORE's timezone (so a Pacific rooftop's "Today" is a
  // Pacific day, not a UTC day). Explicit start/end (the custom date picker) are taken as-is — they're
  // already store-local calendar dates.
  const startQ = searchParams.get("start");
  const endQ = searchParams.get("end");
  const { start, end } = startQ && endQ
    ? { start: startQ, end: endQ }
    : rangeFor((searchParams.get("bucket") as Bucket) ?? "last30", timezone ?? undefined);
  const prior = priorWindow(start, end);
  const meta = { start, end, timezone };

  const sb = getSupabase();
  if (!sb) {
    // No backend configured → return mock-shaped result so the UI still renders.
    return Response.json({ ...buildResult({ daily: [], breakdown: [], priorDaily: [], onboardedSlots }), ...meta });
  }

  // One read = the current window, its breakdowns, and the prior window (delta basis).
  const readFacts = () =>
    Promise.all([
      sb.from(AGENT_DAILY).select("*").eq("team_id", teamId).gte("activity_day", start).lt("activity_day", end),
      sb.from(AGENT_DAILY_BREAKDOWN).select("*").eq("team_id", teamId).gte("activity_day", start).lt("activity_day", end),
      sb.from(AGENT_DAILY).select("*").eq("team_id", teamId).gte("activity_day", prior.start).lt("activity_day", prior.end),
    ]);

  // Retry once on a transient read error before degrading — a momentary connection blip usually
  // clears on a fresh attempt.
  let res = await readFacts();
  let err = res[0].error || res[1].error || res[2].error;
  if (err) {
    await new Promise((r) => setTimeout(r, 150));
    res = await readFacts();
    err = res[0].error || res[1].error || res[2].error;
  }
  const [cur, bd, pri] = res;

  if (err) {
    // A read failure must NOT 502 (that blanks the report). Degrade to the same mock-shaped result
    // the no-backend path serves so the UI still renders; flag it so the failure is observable.
    console.error(`[/api/reports] Supabase read failed for team ${teamId}: ${err.message}`);
    return Response.json({ ...buildResult({ daily: [], breakdown: [], priorDaily: [], onboardedSlots }), ...meta }, {
      headers: { "X-Reports-Degraded": "supabase-read-error" },
    });
  }

  // Rooftop-level detail (appointments / callbacks / campaigns). These tables may not exist yet
  // (migration 0002 not applied) — a read error there must NOT fail the report, so each degrades to
  // an empty list independently.
  const safe = async <T,>(p: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> => {
    try { const { data, error } = await p; return error ? [] : ((data ?? []) as T[]); } catch { return []; }
  };
  const [appointments, callbacks, campaigns, outcomes, openFunnel, recoverable, leadCounts, priorLeadCounts] = await Promise.all([
    safe<AppointmentRow>(sb.from(REPORT_APPOINTMENTS).select("*").eq("team_id", teamId)),
    safe<CallbackRow>(sb.from(REPORT_CALLBACKS).select("*").eq("team_id", teamId)),
    safe<CampaignRow>(sb.from(REPORT_CAMPAIGNS).select("*").eq("team_id", teamId)),
    safe<OutcomeRow>(sb.from(REPORT_OUTCOMES).select("*").eq("team_id", teamId)),
    safe<OpenFunnelRow>(sb.from(REPORT_OPEN_FUNNEL).select("*").eq("team_id", teamId)),
    safe<RecoverableRow>(sb.from(REPORT_MONEY_ON_TABLE).select("*").eq("team_id", teamId)),
    leadCountsFor(sb, teamId, start, end),
    leadCountsFor(sb, teamId, prior.start, prior.end),
  ]);

  const result = buildResult({
    daily: (cur.data ?? []) as AgentDailyRow[],
    breakdown: (bd.data ?? []) as BreakdownRow[],
    priorDaily: (pri.data ?? []) as AgentDailyRow[],
    appointments,
    callbacks,
    campaigns,
    outcomes,
    openFunnel,
    recoverable,
    onboardedSlots,
    leadCounts,
    priorLeadCounts,
  });

  return Response.json({ ...result, ...meta }, {
    headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=120" },
  });
}
