import { getSupabase, AGENT_DAILY, AGENT_DAILY_BREAKDOWN, REPORT_CALLBACKS, REPORT_CAMPAIGNS, REPORT_OUTCOMES } from "@/lib/reports/supabase";
import { buildResult } from "@/lib/reports/build";
import type { AgentDailyRow, BreakdownRow, CallbackRow, CampaignRow, OutcomeRow } from "@/lib/reports/schema";
import { rangeFor } from "@/components/reports/liveData";
import type { Bucket } from "@/components/reports/data";
import { getStoreTimeZone, getOnboardedSlots } from "@/lib/spyne/teamContext";

/* Reads the materialized aggregate from Supabase and returns the same FetchResult the reporting UI
 * already consumes — one fast query instead of the ~84 Metabase round-trips fetchAgents() used to do.
 * Falls back to all-mock agents (buildResult does this) when Supabase is unconfigured or empty.
 *
 * Round-trips per call are kept minimal (was ~11, now ~4): agent_daily is read ONCE across the
 * combined [prior.start, end) range and split in-memory; the six report_* detail tables come back in
 * ONE report_detail() rpc; and both lead-count windows come from ONE report_lead_counts_2() rpc. Each
 * rpc degrades to the prior multi-read behavior on error, so an un-migrated DB still works. */
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

function leadRow(r: Record<string, unknown>): LeadCounts[string] {
  return {
    contacted: Number(r.leads_contacted) || 0,
    dialed: Number(r.leads_dialed) || 0,
    connected: Number(r.leads_connected) || 0,
    qualified: Number(r.leads_qualified) || 0,
    apptLeads: Number(r.appt_leads) || 0,
  };
}

/* EXACT window-distinct lead counts for the CURRENT and PRIOR window in one rpc (report_lead_counts_2,
 * counts DISTINCT lead_id per window so a lead touched on N days counts once). Returns {} on error/absence
 * so each window degrades to undefined → buildResult falls back to summing per-day distincts (the prior,
 * inflated behavior) rather than breaking. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function leadCountsBoth(sb: any, teamId: string, start: string, end: string, priorStart: string, priorEnd: string): Promise<{ cur?: LeadCounts; prior?: LeadCounts }> {
  try {
    const { data, error } = await sb.rpc("report_lead_counts_2", {
      p_team: teamId, p_cur_start: start, p_cur_end: end, p_prior_start: priorStart, p_prior_end: priorEnd,
    });
    if (error || !Array.isArray(data)) return {};
    const cur: LeadCounts = {}, prior: LeadCounts = {};
    for (const r of data as Array<Record<string, unknown>>) {
      (String(r.win) === "prior" ? prior : cur)[String(r.agent_type)] = leadRow(r);
    }
    return { cur, prior };
  } catch {
    return {};
  }
}

type Detail = { callbacks: CallbackRow[]; campaigns: CampaignRow[]; outcomes: OutcomeRow[] };
const EMPTY_DETAIL: Detail = { callbacks: [], campaigns: [], outcomes: [] };

/* The per-team detail tables in ONE report_detail() rpc (callbacks / campaigns / outcomes — all now fed
 * directly from ClickHouse by scripts/backfill.ts). On any error returns null so the caller falls back
 * to the independent reads — output identical. (appointments / open-funnel / money-on-table were retired
 * in migration 0011: the first is served live by /api/meetings, the other two were never populated.) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchDetailCombined(sb: any, teamId: string): Promise<Detail | null> {
  try {
    const { data, error } = await sb.rpc("report_detail", { p_team: teamId });
    if (error || !data || typeof data !== "object") return null;
    const d = data as Record<string, unknown>;
    return {
      callbacks: (d.callbacks ?? []) as CallbackRow[],
      campaigns: (d.campaigns ?? []) as CampaignRow[],
      outcomes: (d.outcomes ?? []) as OutcomeRow[],
    };
  } catch {
    return null;
  }
}

/* Has this rooftop EVER produced agent activity (any day, any agent)? This — NOT whether the selected
 * window has rows — is what gates the full-surface "Coming soon" placeholder. A brand-new account that
 * has never run shows it; a LIVE account whose *selected window* merely happens to be empty (e.g.
 * "Today" before the first call of the day, or a quiet weekend) does NOT — it renders the real report
 * with zeros. Cheap existence probe (one row). Degrades to false on error → same as prior behavior. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function teamEverLive(sb: any, teamId: string): Promise<boolean> {
  try {
    const { data, error } = await sb.from(AGENT_DAILY).select("activity_day").eq("team_id", teamId).limit(1);
    return !error && Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}

/* Fallback: the original six independent reads. Each degrades to [] independently (a missing table must
 * not fail the report). Only used when report_detail() is unavailable. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchDetailPerTable(sb: any, teamId: string): Promise<Detail> {
  const safe = async <T,>(p: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> => {
    try { const { data, error } = await p; return error ? [] : ((data ?? []) as T[]); } catch { return []; }
  };
  const [callbacks, campaigns, outcomes] = await Promise.all([
    safe<CallbackRow>(sb.from(REPORT_CALLBACKS).select("*").eq("team_id", teamId)),
    safe<CampaignRow>(sb.from(REPORT_CAMPAIGNS).select("*").eq("team_id", teamId)),
    safe<OutcomeRow>(sb.from(REPORT_OUTCOMES).select("*").eq("team_id", teamId)),
  ]);
  return { callbacks, campaigns, outcomes };
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

  // agent_daily is read ONCE across the combined [prior.start, end) range and split in-memory into the
  // current and prior windows (prior.end === start), replacing the old two separate window reads.
  const readFacts = () =>
    Promise.all([
      sb.from(AGENT_DAILY).select("*").eq("team_id", teamId).gte("activity_day", prior.start).lt("activity_day", end),
      sb.from(AGENT_DAILY_BREAKDOWN).select("*").eq("team_id", teamId).gte("activity_day", start).lt("activity_day", end),
    ]);

  // Retry once on a transient read error before degrading — a momentary connection blip usually
  // clears on a fresh attempt.
  let res = await readFacts();
  let err = res[0].error || res[1].error;
  if (err) {
    await new Promise((r) => setTimeout(r, 150));
    res = await readFacts();
    err = res[0].error || res[1].error;
  }
  const [allDailyRes, bd] = res;

  if (err) {
    // A read failure must NOT 502 (that blanks the report). Degrade to the same mock-shaped result
    // the no-backend path serves so the UI still renders; flag it so the failure is observable.
    console.error(`[/api/reports] Supabase read failed for team ${teamId}: ${err.message}`);
    return Response.json({ ...buildResult({ daily: [], breakdown: [], priorDaily: [], onboardedSlots }), ...meta }, {
      headers: { "X-Reports-Degraded": "supabase-read-error" },
    });
  }

  const allDaily = (allDailyRes.data ?? []) as AgentDailyRow[];
  const cur = allDaily.filter((r) => (r.activity_day as unknown as string) >= start);   // [start, end)
  const pri = allDaily.filter((r) => (r.activity_day as unknown as string) < start);     // [prior.start, start)

  // Detail tables (one rpc, fallback to six reads) + both lead-count windows (one rpc) + the
  // lifetime "ever live" probe in parallel.
  const [detail, lc, everLive] = await Promise.all([
    fetchDetailCombined(sb, teamId).then((d) => d ?? fetchDetailPerTable(sb, teamId)),
    leadCountsBoth(sb, teamId, start, end, prior.start, prior.end),
    teamEverLive(sb, teamId),
  ]);
  const { callbacks, campaigns, outcomes } = detail ?? EMPTY_DETAIL;

  const result = buildResult({
    daily: cur,
    breakdown: (bd.data ?? []) as BreakdownRow[],
    priorDaily: pri,
    callbacks,
    campaigns,
    outcomes,
    onboardedSlots,
    leadCounts: lc.cur,
    priorLeadCounts: lc.prior,
  });

  return Response.json({ ...result, ...meta, everLive }, {
    headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=120" },
  });
}
