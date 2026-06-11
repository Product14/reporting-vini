import { getSupabase, AGENT_DAILY, AGENT_DAILY_BREAKDOWN, REPORT_APPOINTMENTS, REPORT_CALLBACKS, REPORT_CAMPAIGNS } from "@/lib/reports/supabase";
import { buildResult } from "@/lib/reports/build";
import type { AgentDailyRow, BreakdownRow, AppointmentRow, CallbackRow, CampaignRow } from "@/lib/reports/schema";
import { rangeFor } from "@/components/reports/liveData";
import type { Bucket } from "@/components/reports/data";

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

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const teamId = searchParams.get("team_id");
  if (!teamId) return Response.json({ error: "team_id is required" }, { status: 400 });

  const startQ = searchParams.get("start");
  const endQ = searchParams.get("end");
  const { start, end } = startQ && endQ ? { start: startQ, end: endQ } : rangeFor((searchParams.get("bucket") as Bucket) ?? "last30");
  const prior = priorWindow(start, end);

  const sb = getSupabase();
  if (!sb) {
    // No backend configured → return mock-shaped result so the UI still renders.
    return Response.json(buildResult({ daily: [], breakdown: [], priorDaily: [] }));
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
    return Response.json(buildResult({ daily: [], breakdown: [], priorDaily: [] }), {
      headers: { "X-Reports-Degraded": "supabase-read-error" },
    });
  }

  // Rooftop-level detail (appointments / callbacks / campaigns). These tables may not exist yet
  // (migration 0002 not applied) — a read error there must NOT fail the report, so each degrades to
  // an empty list independently.
  const safe = async <T,>(p: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> => {
    try { const { data, error } = await p; return error ? [] : ((data ?? []) as T[]); } catch { return []; }
  };
  const [appointments, callbacks, campaigns] = await Promise.all([
    safe<AppointmentRow>(sb.from(REPORT_APPOINTMENTS).select("*").eq("team_id", teamId)),
    safe<CallbackRow>(sb.from(REPORT_CALLBACKS).select("*").eq("team_id", teamId)),
    safe<CampaignRow>(sb.from(REPORT_CAMPAIGNS).select("*").eq("team_id", teamId)),
  ]);

  const result = buildResult({
    daily: (cur.data ?? []) as AgentDailyRow[],
    breakdown: (bd.data ?? []) as BreakdownRow[],
    priorDaily: (pri.data ?? []) as AgentDailyRow[],
    appointments,
    callbacks,
    campaigns,
  });

  return Response.json(result, {
    headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=120" },
  });
}
