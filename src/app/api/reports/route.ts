import { getSupabase, AGENT_DAILY, AGENT_DAILY_BREAKDOWN, REPORT_CALLBACKS, REPORT_CAMPAIGNS, REPORT_OUTCOMES, REPORT_APPOINTMENTS, REPORT_WARM_LEADS } from "@/lib/reports/supabase";
import { buildResult } from "@/lib/reports/build";
import type { AgentDailyRow, BreakdownRow, CallbackRow, CampaignRow, OutcomeRow, ReportAppointmentRow, WarmLeadRow } from "@/lib/reports/schema";
import { rangeFor } from "@/components/reports/liveData";
import type { Bucket } from "@/components/reports/data";
import { getStoreTimeZone, getOnboardedSlots, getOnboardedNames } from "@/lib/spyne/teamContext";
import { requireTeamAuth, spyneTokenFrom, spyneEnvFrom } from "@/lib/reports/auth";

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
// A cold invocation cold-starts the function AND opens a fresh Supabase connection before running five
// sequential round-trips (readFacts → detail + lead-counts + source-counts + ever-live). Under Vercel's
// short default timeout that cold path can 504, which the client can't distinguish from "never live" and
// shows "report is on its way". Give the cold path room to finish so the first load succeeds.
export const maxDuration = 30;

// Equal-length window immediately before [start, end) — basis for period deltas.
function priorWindow(start: string, end: string): { start: string; end: string } {
  const s = new Date(`${start}T00:00:00Z`), e = new Date(`${end}T00:00:00Z`);
  const days = Math.max(1, Math.round((e.getTime() - s.getTime()) / 86_400_000));
  const ps = new Date(s);
  ps.setUTCDate(ps.getUTCDate() - days);
  return { start: ps.toISOString().slice(0, 10), end: start };
}

// canonical: apptLeads = AI-booked (source='spyne', PRIMARY); apptLeadsAssisted = AI-assisted (CRM, SECONDARY).
export type LeadCounts = Record<string, { contacted: number; dialed: number; connected: number; qualified: number; apptLeads: number; apptLeadsAssisted: number; transferLeads: number; transferFailedLeads: number }>;

function leadRow(r: Record<string, unknown>): LeadCounts[string] {
  return {
    contacted: Number(r.leads_contacted) || 0,
    dialed: Number(r.leads_dialed) || 0,
    connected: Number(r.leads_connected) || 0,
    qualified: Number(r.leads_qualified) || 0,
    apptLeads: Number(r.appt_leads) || 0,
    apptLeadsAssisted: Number(r.appt_leads_assisted) || 0, // canonical: AI-assisted (CRM) — SECONDARY
    transferLeads: Number(r.transfer_leads) || 0, // canonical: window-distinct completed transfers (headline)
    transferFailedLeads: Number(r.transfer_failed_leads) || 0, // reported separately
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

// Window-distinct "Leads by source" per agent_type (report_source_counts → COUNT(DISTINCT lead_id) per
// source). Keyed by agent_type label; each entry is the source rows, biggest-first. {} on error/absence
// → buildResult falls back to the per-day breakdown rollup (lead-days, the inflated behavior).
export type SourceCounts = Record<string, { source: string; total: number; interacted: number; booked: number }[]>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sourceCountsFor(sb: any, teamId: string, start: string, end: string): Promise<SourceCounts | undefined> {
  try {
    const { data, error } = await sb.rpc("report_source_counts", { p_team: teamId, p_start: start, p_end: end });
    if (error || !Array.isArray(data)) return undefined;
    const out: SourceCounts = {};
    for (const r of data as Array<Record<string, unknown>>) {
      const type = String(r.agent_type);
      (out[type] ??= []).push({
        source: String(r.lead_source ?? ""),
        total: Number(r.total_leads) || 0,
        interacted: Number(r.interacted_leads) || 0,
        booked: Number(r.booked_leads) || 0,
      });
    }
    for (const type of Object.keys(out)) out[type].sort((a, b) => b.total - a.total);
    return out;
  } catch {
    return undefined;
  }
}

type Detail = { callbacks: CallbackRow[]; campaigns: CampaignRow[]; outcomes: OutcomeRow[]; appointments: ReportAppointmentRow[]; warmLeads: WarmLeadRow[] };
const EMPTY_DETAIL: Detail = { callbacks: [], campaigns: [], outcomes: [], appointments: [], warmLeads: [] };

/* The per-team detail tables in ONE report_detail() rpc (callbacks / campaigns / outcomes + the v3
 * named appointments / warm leads — all fed directly from ClickHouse by scripts/backfill.ts). On any
 * error returns null so the caller falls back to the independent reads — output identical. An
 * un-migrated DB (pre-0017 rpc) simply omits the two new keys → []. */
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
      appointments: (d.appointments ?? []) as ReportAppointmentRow[],
      warmLeads: (d.warmLeads ?? []) as WarmLeadRow[],
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
    // A transient probe error must NEVER demote a rooftop to "Coming soon": on error degrade to true
    // (assume live). A clean read with zero rows is the only signal that means "never live".
    if (error) return true;
    return Array.isArray(data) && data.length > 0;
  } catch {
    return true;
  }
}

/* Fallback: the original six independent reads. Each degrades to [] independently (a missing table must
 * not fail the report). Only used when report_detail() is unavailable. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchDetailPerTable(sb: any, teamId: string): Promise<Detail> {
  const safe = async <T,>(p: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> => {
    try { const { data, error } = await p; return error ? [] : ((data ?? []) as T[]); } catch { return []; }
  };
  const [callbacks, campaigns, outcomes, appointments, warmLeads] = await Promise.all([
    safe<CallbackRow>(sb.from(REPORT_CALLBACKS).select("*").eq("team_id", teamId)),
    safe<CampaignRow>(sb.from(REPORT_CAMPAIGNS).select("*").eq("team_id", teamId)),
    safe<OutcomeRow>(sb.from(REPORT_OUTCOMES).select("*").eq("team_id", teamId)),
    safe<ReportAppointmentRow>(sb.from(REPORT_APPOINTMENTS).select("*").eq("team_id", teamId)),
    safe<WarmLeadRow>(sb.from(REPORT_WARM_LEADS).select("*").eq("team_id", teamId)),
  ]);
  return { callbacks, campaigns, outcomes, appointments, warmLeads };
}

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const teamId = searchParams.get("team_id");
  if (!teamId) return Response.json({ error: "team_id is required" }, { status: 400 });

  // Require a credential and validate team scope before returning any rooftop data: a valid Spyne
  // session token scoped to this team, or the service CRON_SECRET. No credential → 401; token scoped
  // to a different team → 403.
  const auth = requireTeamAuth(request, teamId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  // Spyne API token: PROD forwards it per-request from the host — via the Authorization header or an
  // `auth_key`/`spyne_token`/`token` query param (the host uses `auth_key`); LOCAL DEV omits it and the
  // client falls back to SPYNE_API_TOKEN (env). spyneTokenFrom skips the CRON_SECRET so the cron's
  // `Authorization: Bearer <secret>` doesn't shadow the real dealer token it sends as ?auth_key= — which
  // would silently drop timezone/onboarded-agent enrichment back to UTC/all-agents.
  const spyneToken = spyneTokenFrom(request);
  // Which Spyne backend the enrichment calls below hit — the console now embeds a rooftop with
  // ?env=uat|stag|prod, and a UAT dealer's token only works against the UAT API.
  const spyneEnv = spyneEnvFrom(request);

  // Resolve the rooftop's timezone + onboarded agents from the Spyne API (best-effort; both null when
  // auth is unavailable or the call fails → previous behavior: UTC windows, all agents shown).
  const [timezone, onboardedSlots, onboardedNames] = await Promise.all([
    getStoreTimeZone(teamId, spyneToken, spyneEnv),
    getOnboardedSlots(teamId, spyneToken, spyneEnv),
    getOnboardedNames(teamId, spyneToken, spyneEnv),
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
    return Response.json({ ...buildResult({ daily: [], breakdown: [], priorDaily: [], onboardedSlots, onboardedNames }), ...meta });
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
    // `degraded: true` is in the BODY (not just the header) so the digest pipeline can tell an outage
    // from a genuinely quiet day and SUPPRESS the email instead of sending all-zeros. HTTP stays 200 so
    // existing healthy callers that rely on 200 don't break.
    console.error(`[/api/reports] Supabase read failed for team ${teamId}: ${err.message}`);
    return Response.json({ ...buildResult({ daily: [], breakdown: [], priorDaily: [], onboardedSlots, onboardedNames }), ...meta, degraded: true }, {
      headers: { "X-Reports-Degraded": "supabase-read-error" },
    });
  }

  const allDaily = (allDailyRes.data ?? []) as AgentDailyRow[];
  const cur = allDaily.filter((r) => (r.activity_day as unknown as string) >= start);   // [start, end)
  const pri = allDaily.filter((r) => (r.activity_day as unknown as string) < start);     // [prior.start, start)

  // Detail tables (one rpc, fallback to six reads) + both lead-count windows (one rpc) + the
  // lifetime "ever live" probe in parallel.
  const [detail, lc, sourceCounts, everLive] = await Promise.all([
    fetchDetailCombined(sb, teamId).then((d) => d ?? fetchDetailPerTable(sb, teamId)),
    leadCountsBoth(sb, teamId, start, end, prior.start, prior.end),
    sourceCountsFor(sb, teamId, start, end),
    teamEverLive(sb, teamId),
  ]);
  const { callbacks, campaigns, outcomes, appointments, warmLeads } = detail ?? EMPTY_DETAIL;
  // Named appointments are shown for the report window — filter the ~120d snapshot by booking date.
  // UTC date-slice vs the store-local window can drift ±1 day at boundaries; the COUNTS stay canonical
  // (they come from report_lead_counts_2 / agent_lead_days, not this list). Warm leads are a "now"
  // snapshot — deliberately NOT windowed.
  const windowedAppointments = appointments.filter((a) => {
    const day = (a.booked_at ?? "").slice(0, 10);
    return day >= start && day < end;
  });
  // Invariant: a rooftop that returned real rows in THIS request can't be "never live" — don't let a
  // separate probe (even a clean-but-stale empty read) demote it. The probe still gates brand-new
  // rooftops whose selected window AND lifetime are both empty.
  const everLiveResolved = everLive || allDaily.length > 0;

  const result = buildResult({
    daily: cur,
    breakdown: (bd.data ?? []) as BreakdownRow[],
    priorDaily: pri,
    callbacks,
    campaigns,
    outcomes,
    namedAppointments: windowedAppointments,
    warmLeads,
    onboardedSlots,
    onboardedNames,
    leadCounts: lc.cur,
    priorLeadCounts: lc.prior,
    sourceCounts,
  });

  return Response.json({ ...result, ...meta, everLive: everLiveResolved }, {
    headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=120" },
  });
}
