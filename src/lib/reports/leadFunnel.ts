/* The lead funnel of ONE rooftop, and nothing else — the lean twin of GET /api/reports for the callers
 * that only want `leadFunnel` (reseller-lead-funnel).
 *
 * WHY NOT JUST CALL THE REPORT. GET /api/reports builds a whole page: store timezone, three onboarded-agent
 * reads, six detail tables, source counts, the live meetings feed, and four canonical calls (overview,
 * lead-sources x2, hot-leads) that share a gate of two per instance. Cold, that is 40-60s per rooftop and a
 * 504 at Vercel's 60s limit. `leadFunnel` is set in exactly two places in buildResult — the aggregate
 * (agent_daily rows + the window-distinct report_lead_counts_2 rpc) and the SALES canonical overview overlay
 * — so those are the only inputs fetched here. buildResult is the same function the report uses, so the
 * funnel is computed by the same code from the same inputs.
 *
 * WHAT IS DELIBERATELY NOT FETCHED, and the effect on leadFunnel: onboarded agents (null → all four slots
 * are kept, the agents a dealer never bought just read 0), live meetings (touches metrics.appointments,
 * never leadFunnel), hot-leads / lead-sources / detail tables (not in the funnel). The store timezone is
 * fetched only when the caller gave a relative bucket instead of start/end. */
import { getSupabase, AGENT_DAILY } from "@/lib/reports/supabase";
import { buildResult } from "@/lib/reports/build";
import type { AgentDailyRow } from "@/lib/reports/schema";
import { rangeFor } from "@/components/reports/liveData";
import type { Bucket } from "@/components/reports/data";
import { getStoreTimeZone } from "@/lib/spyne/teamContext";
import { fetchCanonicalOverview } from "@/lib/spyne/consoleReports";
import { cached as cachedSpyne } from "@/lib/spyne/client";
import { enterpriseIdFromToken } from "@/lib/spyne/meetings";

export type FunnelAgent = { id: string; leadFunnel: unknown };
export type TeamFunnel = { degraded: boolean; agents: FunnelAgent[] };

type LeadCounts = NonNullable<Parameters<typeof buildResult>[0]["leadCounts"]>;

// Equal-length window immediately before [start, end) — the rpc wants both windows (same as the report).
function priorWindow(start: string, end: string): { start: string; end: string } {
  const s = new Date(`${start}T00:00:00Z`), e = new Date(`${end}T00:00:00Z`);
  const days = Math.max(1, Math.round((e.getTime() - s.getTime()) / 86_400_000));
  const ps = new Date(s);
  ps.setUTCDate(ps.getUTCDate() - days);
  return { start: ps.toISOString().slice(0, 10), end: start };
}

function leadRow(r: Record<string, unknown>): LeadCounts[string] {
  return {
    contacted: Number(r.leads_contacted) || 0,
    dialed: Number(r.leads_dialed) || 0,
    connected: Number(r.leads_connected) || 0,
    qualified: Number(r.leads_qualified) || 0,
    apptLeads: Number(r.appt_leads) || 0,
    apptLeadsAssisted: Number(r.appt_leads_assisted) || 0,
    transferLeads: Number(r.transfer_leads) || 0,
    transferFailedLeads: Number(r.transfer_failed_leads) || 0,
  };
}

/* Window-distinct lead counts for the CURRENT window (a lead touched on N days counts once). undefined on
 * error → buildResult falls back to summing per-day figures, exactly as the report does. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function leadCounts(sb: any, teamId: string, start: string, end: string): Promise<LeadCounts | undefined> {
  const prior = priorWindow(start, end);
  try {
    const { data, error } = await sb.rpc("report_lead_counts_2", {
      p_team: teamId, p_cur_start: start, p_cur_end: end, p_prior_start: prior.start, p_prior_end: prior.end,
    });
    if (error || !Array.isArray(data)) return undefined;
    const cur: LeadCounts = {};
    for (const r of data as Array<Record<string, unknown>>) {
      if (String(r.win) !== "prior") cur[String(r.agent_type)] = leadRow(r);
    }
    return cur;
  } catch {
    return undefined;
  }
}

export async function leadFunnelFor(args: {
  teamId: string;
  token: string;
  env: string | null;
  bucket: string | null;
  start: string | null;
  end: string | null;
}): Promise<TeamFunnel> {
  const { teamId, token, env } = args;
  const sb = getSupabase();
  // No aggregate configured → the report would serve mock-shaped numbers. Never hand those out as a funnel.
  if (!sb) return { degraded: true, agents: [] };

  let start: string, end: string;
  if (args.start && args.end) {
    ({ start, end } = { start: args.start, end: args.end });
  } else {
    // A relative bucket resolves in the STORE's day, so only this branch pays for the timezone call.
    const timezone = await getStoreTimeZone(teamId, token, env);
    ({ start, end } = rangeFor((args.bucket as Bucket) ?? "last30", timezone ?? undefined));
  }

  // Started now so it overlaps the Supabase reads. Same cache key as the report, so a warm instance shares it.
  const canonicalP = cachedSpyne(`canon-overview:${env ?? "prod"}:${teamId}:${start}:${end}`, async () => {
    const enterpriseId = enterpriseIdFromToken(token);
    if (!enterpriseId) return null;
    return fetchCanonicalOverview({ enterpriseId, teamId, dept: "sales", start, end }, token, env);
  }).catch(() => null);

  const [dailyRes, counts] = await Promise.all([
    sb.from(AGENT_DAILY).select("*").eq("team_id", teamId).gte("activity_day", start).lt("activity_day", end),
    leadCounts(sb, teamId, start, end),
  ]);
  const canonical = await canonicalP;
  // A failed read is an outage, not a quiet rooftop — the caller must not show its zeros as zeros.
  if (dailyRes.error) {
    console.error(`[lead-funnel] Supabase read failed for team ${teamId}: ${dailyRes.error.message}`);
    return { degraded: true, agents: [] };
  }

  const result = buildResult({
    canonical,
    daily: (dailyRes.data ?? []) as AgentDailyRow[],
    breakdown: [],
    priorDaily: [],
    leadCounts: counts,
  });
  const agents = result.agents.filter((a) => a.id && a.leadFunnel).map((a) => ({ id: a.id, leadFunnel: a.leadFunnel }));
  // Same rule the report uses for its own degraded flag: no canonical answer AND nothing in the aggregate.
  return { degraded: !canonical && !result.hasData, agents };
}
