import { getSupabase, AGENT_DAILY, AGENT_DAILY_BREAKDOWN, AGENT_LEAD_DAYS, REPORT_CALLBACKS, REPORT_CAMPAIGNS, REPORT_OUTCOMES, REPORT_APPOINTMENTS, REPORT_WARM_LEADS, SYNC_STATE } from "@/lib/reports/supabase";
import { buildResult, AGENT_TYPE_BY_ID } from "@/lib/reports/build";
import type { AgentDailyRow, BreakdownRow, CallbackRow, CampaignRow, OutcomeRow, ReportAppointmentRow, WarmLeadRow } from "@/lib/reports/schema";

import { fetchLiveAppointments, countByAgent, bookedLeadsByAgent } from "@/lib/reports/liveAppointments";
import type { AgentData } from "@/components/reports/data";
import type { Basis } from "@/components/reports/liveData";
import { isCancelledMeeting } from "@/lib/reports/appointmentStatus";
import { rangeFor } from "@/components/reports/liveData";
import type { Bucket } from "@/components/reports/data";
import { getStoreTimeZone, getOnboardedSlots, getOnboardedNames, getOnboardedPhotos } from "@/lib/spyne/teamContext";
import { fetchCanonicalOverview, fetchCanonicalHotLeads, fetchCanonicalLeadSources } from "@/lib/spyne/consoleReports";
import { cached as cachedSpyne } from "@/lib/spyne/client";
import { enterpriseIdFromToken } from "@/lib/spyne/meetings";
import { requireTeamAuth, spyneTokenFrom, spyneEnvFrom } from "@/lib/reports/auth";
// Same helper the ETL buckets agent_daily / agent_lead_days with, so the appointment LIST is windowed
// in the identical day space as the COUNTS shown above it.
import { storeLocalDay } from "@/lib/reports/tzMap";

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
/* 60s while the canonical endpoints are slow. The four upstream calls now run SERIALLY (see the gate
   in consoleReports.ts) because overlapping them tripped the gateway's timeout; ~14s on the reference
   rooftop, and the 30s budget left no headroom for a cold start on top. */
export const maxDuration = 60;

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

/* ── SERVICE CLOSE RATE ON ONE BASIS (Reports only, ?close_basis=customers) — Freshdesk #23995 ──
 * Close rate is AI-booked ÷ qualified. On Paragon Honda it read 172% (lifetime) / 220% (Service Inbound,
 * MTD) because the two sides were different people, not just a different grain:
 *   • The spine marks a Service lead qualified only on a buying-intent action item or an intent-analysis
 *     match, and a booking the AI COMPLETES leaves neither behind — action items are follow-ups for a
 *     human, and a text or booking-link booking has no intent analysis at all. Paragon MTD Sep, Service
 *     Outbound: 43 of 54 booked customers were never in `qualified`; fleet, 30d: 24% of AI-booked
 *     Service customers.
 *   • Bookings are records (a reschedule or a second vehicle counts again); qualified is customers.
 * The rate is therefore taken over the customers this agent WORKED in the window (a row in
 * agent_lead_days — the funnel's own population). Each booked customer among them has by definition held
 * a real conversation and qualified, so connected and qualified add the ones they are missing — an exact
 * union, |stage ∪ booked| = |stage| + |booked − stage| — and the numerator is those booked CUSTOMERS
 * (leadFunnel.bookedLeads, read by closeRateParts). booked ⊆ qualified ⊆ connected ⊆ worked, so the rate
 * cannot pass 100% and the funnel's entry stage (leads reached / dialed, and the agent chip) is never
 * touched. A booking whose customer this agent did not work in the window still counts in
 * "Appointments — AI-booked" (records, unchanged) but not in the rate: one booked from a conversation
 * before the window, or one filed on a different customer record than the conversation that made it
 * (all 15 such on Paragon Honda, lifetime, Service Outbound — a duplicate or owner-vs-caller record).
 * Sales is untouched.
 *
 * OPT-IN PER REQUEST. Only Reports > Agent performance and its report library send the param; the
 * Overview and the digest cron get exactly the response they always have. */
/* A timestamp as whole UTC seconds. The snapshot's booked_at comes back from Postgres with a zone, the live
 * feed's createdAt as ISO-Z with milliseconds; a zone-less string is read as UTC (ClickHouse writes UTC). */
function epochSecond(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const iso = (ts.includes("T") ? ts : ts.replace(" ", "T")).replace(/([+-]\d{2})$/, "$1:00"); // "+00" → "+00:00"
  const t = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : `${iso}Z`);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

type LeadFlags = Map<string, { connected: boolean; qualified: boolean }>; // `${agent_type}|${lead_id}`
type StageGap = { worked: number; notConnected: number; notQualified: number };

/* The agent_lead_days flags of the given leads over [start, end), OR-ed per (agent_type, lead). Reads only
 * those leads' rows (the rooftop's Service bookings, never the whole window), 100 ids per request, four
 * requests at a time. null on any error, so the caller can drop the whole rule rather than half-apply it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readLeadFlags(sb: any, teamId: string, start: string, end: string, leadIds: Set<string>): Promise<LeadFlags | null> {
  const ids = Array.from(leadIds);
  const flags: LeadFlags = new Map();
  const readChunk = async (chunk: string[]): Promise<boolean> => {
    // PostgREST caps a response at 1000 rows and a lead carries one row per active day: page the chunk.
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb
        .from(AGENT_LEAD_DAYS)
        .select("agent_type,lead_id,connected,qualified")
        .eq("team_id", teamId)
        .gte("activity_day", start)
        .lt("activity_day", end)
        .in("lead_id", chunk)
        .order("agent_type").order("lead_id").order("activity_day")
        .range(from, from + 999);
      if (error || !Array.isArray(data)) return false;
      for (const r of data as Array<{ agent_type: string; lead_id: string; connected: boolean; qualified: boolean }>) {
        const k = `${r.agent_type}|${r.lead_id}`;
        const f = flags.get(k) ?? { connected: false, qualified: false };
        f.connected ||= !!r.connected;
        f.qualified ||= !!r.qualified;
        flags.set(k, f);
      }
      if (data.length < 1000) return true;
    }
  };
  try {
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
    for (let i = 0; i < chunks.length; i += 4) {
      const ok = await Promise.all(chunks.slice(i, i + 4).map(readChunk));
      if (ok.includes(false)) return null;
    }
    return flags;
  } catch {
    return null;
  }
}

/* For each agent's booked customers: how many it WORKED in the window (any agent_lead_days row under that
 * agent), and of those, how many the connected / qualified stages do not already count. Pure. */
function stageGaps(flags: LeadFlags, booked: Record<string, Set<string>>): Record<string, StageGap> {
  const out: Record<string, StageGap> = {};
  for (const [type, leads] of Object.entries(booked)) {
    const g: StageGap = { worked: 0, notConnected: 0, notQualified: 0 };
    for (const l of leads) {
      const f = flags.get(`${type}|${l}`);
      if (!f) continue; // not worked by this agent in the window: outside the funnel and the rate
      g.worked++;
      if (!f.connected) g.notConnected++;
      if (!f.qualified) g.notQualified++;
    }
    out[type] = g;
  }
  return out;
}

// A booking with no lead id cannot be matched to a worked customer, so it stays outside the rate (noLead
// is collected for symmetry with bookedLeadsByAgent, not counted).
type Booked = { leads: Record<string, Set<string>>; noLead: Record<string, number> };
const serviceOnly = (b: Booked): Booked => ({
  leads: Object.fromEntries(Object.entries(b.leads).filter(([t]) => t.startsWith("Service "))),
  noLead: Object.fromEntries(Object.entries(b.noLead).filter(([t]) => t.startsWith("Service "))),
});

/* Applies the rule above to the Service agents (current window) and to their prior-window basis, so the
 * period deltas compare like with like. Pure apart from mutating the agents/prior it is handed. */
function applyCustomerBasis(agents: AgentData[], prior: Record<string, Basis> | undefined,
  gaps: Record<string, StageGap>, priGaps: Record<string, StageGap> | null): void {
  for (const agent of agents) {
    const type = AGENT_TYPE_BY_ID[agent.id];
    if (!type || agent.dept !== "Service") continue;
    const lf = agent.leadFunnel;
    if (lf) {
      const g = gaps[type];
      agent.leadFunnel = {
        ...lf,
        connected: lf.connected + (g?.notConnected ?? 0),
        qualified: lf.qualified + (g?.notQualified ?? 0),
        bookedLeads: g?.worked ?? 0,
      };
    }
    const basis = prior?.[agent.id];
    if (priGaps && basis) {
      const g = priGaps[type];
      prior![agent.id] = {
        ...basis,
        conversations: basis.conversations + (g?.notConnected ?? 0),
        qualified: basis.qualified + (g?.notQualified ?? 0),
      };
    }
  }
}

/* sync_state.last_run_at — when the ETL last finished. null when unavailable, in which case the UI
 * falls back to its previous behaviour rather than claiming a freshness it cannot prove. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function lastSyncAt(sb: any): Promise<string | null> {
  try {
    const { data, error } = await sb.from(SYNC_STATE).select("last_run_at").eq("id", 1).maybeSingle();
    if (error || !data?.last_run_at) return null;
    return String(data.last_run_at);
  } catch {
    return null;
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

/* PostgREST caps a single read at db-max-rows — 1000 on this project (measured: a request for 2000 rows
 * of report_appointments returns exactly 1000). A plain `.select("*").eq("team_id", …)` therefore
 * TRUNCATES SILENTLY once a rooftop's snapshot passes that many rows: no error, no flag, the list just
 * ends early and every count derived from it reads low.
 *
 * Not hypothetical. report_appointments is a trailing ~120d snapshot and Honda of Downtown Los Angeles
 * held 1,012 rows on 2026-09-09 — over the cap — before the meta.source='callback' exclusion trimmed it
 * to 900. Fleet-wide the table is 9,727 rows and the per-team maximum is 900 today, so nothing is
 * truncated right now, but the largest rooftop has already crossed the line once and grows back toward
 * it every day.
 *
 * The PRIMARY path (report_detail, above) is unaffected — it jsonb_agg's server-side and returns ONE
 * row, so the row cap never applies. This is the fallback that runs when that rpc is missing or errors,
 * which is exactly when nobody is watching.
 *
 * `.range()` needs a stable `.order()` or pages can repeat and drop rows between requests, so each table
 * pages on its own key. appointments/warm_leads use their natural unique id; the other three page on a
 * best-available column and are orders of magnitude under the cap (outcomes is a handful of buckets per
 * team, campaigns tens, callbacks hundreds), so a tie there cannot cost a row in practice.
 *
 * Each table still degrades to [] independently — a missing table must not fail the report. */
const DETAIL_PAGE = 1000;
const DETAIL_ORDER: Record<string, string> = {
  [REPORT_APPOINTMENTS]: "meeting_id", // one row per meeting — unique
  [REPORT_WARM_LEADS]: "lead_id",      // one row per lead — unique
  [REPORT_CAMPAIGNS]: "campaign",
  [REPORT_OUTCOMES]: "outcome_bucket",
  [REPORT_CALLBACKS]: "callback_due",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function pageAll<T>(sb: any, table: string, teamId: string): Promise<T[]> {
  const out: T[] = [];
  // Safety ceiling: 50 pages (50k rows) is far beyond any rooftop's 120d snapshot and stops a
  // mis-ordered key from looping forever.
  for (let page = 0; page < 50; page++) {
    try {
      const { data, error } = await sb
        .from(table)
        .select("*")
        .eq("team_id", teamId)
        .order(DETAIL_ORDER[table] ?? "team_id", { ascending: true })
        .range(page * DETAIL_PAGE, (page + 1) * DETAIL_PAGE - 1);
      if (error) return out; // degrade to what we have, same as the previous `safe()`
      const rows = (data ?? []) as T[];
      out.push(...rows);
      if (rows.length < DETAIL_PAGE) return out; // short page ⇒ last page
    } catch {
      return out;
    }
  }
  console.warn(`[reports] ${table}: hit the ${50 * DETAIL_PAGE}-row paging ceiling for team ${teamId}`);
  return out;
}

/* Fallback: the original five independent reads, now paged. Only used when report_detail() is
 * unavailable. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchDetailPerTable(sb: any, teamId: string): Promise<Detail> {
  const [callbacks, campaigns, outcomes, appointments, warmLeads] = await Promise.all([
    pageAll<CallbackRow>(sb, REPORT_CALLBACKS, teamId),
    pageAll<CampaignRow>(sb, REPORT_CAMPAIGNS, teamId),
    pageAll<OutcomeRow>(sb, REPORT_OUTCOMES, teamId),
    pageAll<ReportAppointmentRow>(sb, REPORT_APPOINTMENTS, teamId),
    pageAll<WarmLeadRow>(sb, REPORT_WARM_LEADS, teamId),
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
  // Reports > Agent performance asks for the Service close rate on one basis (applyCustomerBasis above).
  // Every other caller omits it and gets the response unchanged.
  let customerBasis = searchParams.get("close_basis") === "customers";

  // Resolve the rooftop's timezone + onboarded agents from the Spyne API (best-effort; both null when
  // auth is unavailable or the call fails → previous behavior: UTC windows, all agents shown).
  const [timezone, onboardedSlots, onboardedNames, onboardedPhotos] = await Promise.all([
    getStoreTimeZone(teamId, spyneToken, spyneEnv),
    getOnboardedSlots(teamId, spyneToken, spyneEnv),
    getOnboardedNames(teamId, spyneToken, spyneEnv),
    getOnboardedPhotos(teamId, spyneToken, spyneEnv),
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

  /* THE CANONICAL RUNGS. Started HERE, not awaited until buildResult, so it overlaps the Supabase
   * reads below and costs no extra wall-clock.
   *
   * SALES ONLY, deliberately. The canonical definitions were agreed for Sales Inbound/Outbound;
   * service agents keep the aggregate's own numbers until the same exercise is done for them, and the
   * overlay in buildResult is keyed by agentType so they are simply not matched.
   *
   * Never throws and never rejects the request: `spyneGet` returns null on any failure, the overlay is
   * skipped, and the report renders from the aggregate exactly as it did before. */
  const canonicalP = cachedSpyne(
    `canon-overview:${spyneEnv ?? "prod"}:${teamId}:${start}:${end}`,
    async () => {
      const enterpriseId = enterpriseIdFromToken(spyneToken);
      if (!enterpriseId) return null;
      return fetchCanonicalOverview(
        { enterpriseId, teamId, dept: "sales", start, end },
        spyneToken,
        spyneEnv,
      );
    },
  ).catch(() => null);

  /* Leads by type and source, per DIRECTION — the card is per agent. Two calls, both memoised, both
     fired now so they overlap the Supabase reads rather than adding to the critical path. */
  const leadSourcesP = Promise.all(
    (["inbound", "outbound"] as const).map((direction) =>
      cachedSpyne(`canon-src:${spyneEnv ?? "prod"}:${teamId}:${direction}:${start}:${end}`, async () => {
        const enterpriseId = enterpriseIdFromToken(spyneToken);
        if (!enterpriseId) return null;
        return fetchCanonicalLeadSources({ enterpriseId, teamId, dept: "sales", direction, start, end }, spyneToken, spyneEnv);
      }).catch(() => null),
    ),
  ).then(([inbound, outbound]) => ({ inbound, outbound }));

  /* Qualified-minus-booked, for "Hot & warm leads". Same memo treatment and the same never-throws
     contract: null simply leaves the Supabase snapshot in place. */
  const hotLeadsP = cachedSpyne(
    `canon-hot:${spyneEnv ?? "prod"}:${teamId}:${start}:${end}`,
    async () => {
      const enterpriseId = enterpriseIdFromToken(spyneToken);
      if (!enterpriseId) return null;
      return fetchCanonicalHotLeads({ enterpriseId, teamId, dept: "sales", start, end }, spyneToken, spyneEnv);
    },
  ).catch(() => null);

  const sb = getSupabase();
  if (!sb) {
    /* No aggregate configured → mock-shaped result so the UI still renders, BUT the canonical rungs
       are still overlaid. That is what makes local dev (and, as the migration completes, prod) show
       real Reached/Engaged/Qualified/Booked with no Supabase at all. */
    const canonNow = await canonicalP;
    const built = buildResult({ canonical: canonNow, canonicalHotLeads: await hotLeadsP, canonicalLeadSources: await leadSourcesP, daily: [], breakdown: [], priorDaily: [], onboardedSlots, onboardedNames, onboardedPhotos });
    /* NO AGGREGATE AND NO CANONICAL ANSWER IS AN OUTAGE, NOT AN EMPTY ROOFTOP. Returning a confident
       200 full of zeros is how a slow upstream ends up telling a dealer they booked nothing. degraded
       keeps the UI in its syncing state and lets the client retry. */
    /* Same window as the full path below, but ONLY when the canonical answer actually arrived. A
       degraded body is the "report is on its way" state — pinning that for 15 minutes would leave a
       dealer on a syncing screen long after the upstream recovered. */
    return Response.json({ ...built, ...meta, ...(canonNow ? {} : { degraded: true }) },
      canonNow ? { headers: { "Cache-Control": "private, max-age=900, stale-while-revalidate=1800" } } : undefined);
  }

  // agent_daily is read ONCE across the combined [prior.start, end) range and split in-memory into the
  // current and prior windows (prior.end === start), replacing the old two separate window reads.
  const readFacts = () =>
    Promise.all([
      sb.from(AGENT_DAILY).select("*").eq("team_id", teamId).gte("activity_day", prior.start).lt("activity_day", end),
      sb.from(AGENT_DAILY_BREAKDOWN).select("*").eq("team_id", teamId).gte("activity_day", start).lt("activity_day", end),
    ]);

  // Retry a transient read error — a momentary connection blip usually clears on a fresh attempt. ALSO
  // retry a clean-but-EMPTY read: an established rooftop returning ZERO rows across the whole ~60-day
  // [prior.start, end) window is almost always a momentary empty result set, not "never live". Letting
  // it through flips a LIVE rooftop to the "Coming soon" gate until the user manually reloads — the bug
  // where dealers had to refresh many times before their report appeared. A genuinely brand-new rooftop
  // just re-confirms empty here (a little extra latency on a page it doesn't populate anyway).
  let res = await readFacts();
  const blank = () => !(res[0].error || res[1].error) && ((res[0].data?.length ?? 0) === 0);
  for (let attempt = 0; attempt < 3 && ((res[0].error || res[1].error) || blank()); attempt++) {
    await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    res = await readFacts();
  }
  const err = res[0].error || res[1].error;
  const [allDailyRes, bd] = res;

  if (err) {
    // A read failure must NOT 502 (that blanks the report). Degrade to the same mock-shaped result
    // the no-backend path serves so the UI still renders; flag it so the failure is observable.
    // `degraded: true` is in the BODY (not just the header) so the digest pipeline can tell an outage
    // from a genuinely quiet day and SUPPRESS the email instead of sending all-zeros. HTTP stays 200 so
    // existing healthy callers that rely on 200 don't break.
    console.error(`[/api/reports] Supabase read failed for team ${teamId}: ${err.message}`);
    return Response.json({
      ...buildResult({ canonical: await canonicalP, canonicalHotLeads: await hotLeadsP, canonicalLeadSources: await leadSourcesP, daily: [], breakdown: [], priorDaily: [], onboardedSlots, onboardedNames, onboardedPhotos }),
      ...meta,
      degraded: true,
    }, {
      headers: { "X-Reports-Degraded": "supabase-read-error" },
    });
  }

  const allDaily = (allDailyRes.data ?? []) as AgentDailyRow[];
  const cur = allDaily.filter((r) => (r.activity_day as unknown as string) >= start);   // [start, end)
  const pri = allDaily.filter((r) => (r.activity_day as unknown as string) < start);     // [prior.start, start)

  // Detail tables (one rpc, fallback to six reads) + both lead-count windows (one rpc) + the
  // lifetime "ever live" probe in parallel.
  const [detail, lc, sourceCounts, everLive, syncedAt, live] = await Promise.all([
    fetchDetailCombined(sb, teamId).then((d) => d ?? fetchDetailPerTable(sb, teamId)),
    leadCountsBoth(sb, teamId, start, end, prior.start, prior.end),
    sourceCountsFor(sb, teamId, start, end),
    teamEverLive(sb, teamId),
    lastSyncAt(sb),
    /* AI-booked appointments come from the meetings API, not the aggregate — the one number dealers
     * check against the appointments console, which reads that same API. Fetched across BOTH windows in
     * one call so the period delta compares live against live. Null = no credential or the call failed,
     * and every appointment number below then stays exactly as the aggregate had it. */
    fetchLiveAppointments({ teamId, start: prior.start, end, token: spyneToken, env: spyneEnv }),
  ]);
  const { callbacks, campaigns, outcomes, appointments, warmLeads } = detail ?? EMPTY_DETAIL;
  // Named appointments are shown for the report window — filter the ~120d snapshot by booking date.
  // ★ WINDOWED IN THE STORE'S OWN DAY SPACE (fixed 2026-09-09). `start`/`end` are resolved in the
  // rooftop's timezone a few lines above, and agent_lead_days (which the COUNTS come from) is bucketed
  // store-local by the ETL — but this filter used to slice `booked_at` as a raw UTC prefix. For a
  // Pacific rooftop that is a 7-8h shift, so every booking made after 5pm local landed on the next UTC
  // day and the list carried a different set of days than the number above it. Honda of Downtown Los
  // Angeles, trailing 30d: the UTC slice returned 107 rows / 89 Service-Inbound after dedupe against a
  // card of 84; re-bucketed store-local it returns 103 / 85. That single mismatch was 4 of the 5.
  // Falls back to the raw prefix when the rooftop's tz is unknown (storeLocalDay's own contract), which
  // is exactly the previous behavior.
  let windowedAppointments = appointments.filter((a) => {
    // A cancelled booking is not a booking, in either half (appointmentStatus.ts). The snapshot SQL drops
    // them already; this covers rows synced before that change. The live AI-booked rows are filtered at
    // fetch (liveAppointments.ts).
    if (isCancelledMeeting(a.status)) return false;
    const raw = (a.booked_at ?? "").slice(0, 10);
    if (!raw) return false;
    const day = storeLocalDay(a.booked_at ?? "", timezone ?? undefined, raw);
    /* Booking date is now the ONLY window test, for both halves. The extra "an assisted row must also
     * have an in-window AI touch" gate went with the definition change (2026-09-24): AI-assisted is the
     * meeting's own ai_assisted flag, so there is no AI-touch claim left to re-verify here. Keeping it
     * would have silently filtered the newly-admitted rows back out through the retired rule. */
    return day >= start && day < end;
  });

  /* ── AI-BOOKED APPOINTMENTS, SWAPPED TO LIVE ──
   * The list and the tile must move together. Making the tile live while the list stayed on the
   * aggregate would just relocate the mismatch we set out to remove, so the AI-booked half of the list
   * is rebuilt from the same live meetings the tile counts. Assisted rows are untouched: they are not
   * in this API's set and depend on the aggregate to know the AI worked the lead.
   *
   * Detail the live API doesn't carry (booked_via — call / SMS / web chat) is enriched back from the
   * snapshot row with the same meeting_id, so a booking the aggregate already knows about keeps its
   * "AI-booked, via SMS" label and only a booking too new for the aggregate reads as plain "AI-booked". */
  /* ALL OR NOTHING (close basis). Read the funnel flags of every Service booking up front — current
   * window, and the prior one when the live fetch ran. If either read fails, drop the basis for the whole
   * request: callbacks stay where they were and the funnel is untouched, i.e. exactly the response
   * without the param. Moving callbacks without the union would put more bookings over the same
   * qualified count (Paragon lifetime, Service Outbound: 179% instead of 162%). */
  let flagsCur: LeadFlags | null = null;
  let flagsPri: LeadFlags | null = null;
  if (customerBasis) {
    const ids = new Set<string>();
    for (const m of live?.meetings ?? []) if (m.leadId && (m.agentType || m.serviceType || "").toLowerCase() === "service") ids.add(m.leadId);
    for (const a of windowedAppointments) if (!a.assisted && a.lead_id && (a.service_type || "").toLowerCase() === "service") ids.add(a.lead_id);
    [flagsCur, flagsPri] = await Promise.all([
      readLeadFlags(sb, teamId, start, end, ids),
      live ? readLeadFlags(sb, teamId, prior.start, prior.end, ids) : Promise.resolve(null),
    ]);
    if (!flagsCur || (live && !flagsPri)) customerBasis = false;
  }
  let liveAppts = live?.meetings ?? null;
  const appointmentsLive = !!liveAppts;
  if (liveAppts) {
    const snapshotByMeeting = new Map(windowedAppointments.filter((a) => a.meeting_id).map((a) => [a.meeting_id as string, a]));
    /* ★ THE FEED'S `id` IS NOT ONE ID. It is meetings.meeting_id on some rows and the Mongo _id on
     * others — the same mixture meetings.ts:88 already keys both ways for the warm-transfer screen. The
     * snapshot only stores meeting_id, so a row arriving under its _id missed this lookup entirely and
     * lost the direction, the channel label and the vehicle the aggregate already knew. LEAD ID is the
     * one key both sides always carry, so it backs the meeting-id lookup up.
     *
     * Deliberately narrow: the lead-keyed row supplies DEPARTMENT and DIRECTION only, which are
     * properties of how the AI worked that lead. booked_via and vehicle stay keyed on the meeting,
     * because a lead with two bookings can have made one by call and one by text and guessing between
     * them would put a wrong channel on a named row. */
    const snapshotByLead = new Map<string, ReportAppointmentRow>();
    for (const a of windowedAppointments) {
      if (!a.assisted && a.lead_id && !snapshotByLead.has(a.lead_id)) snapshotByLead.set(a.lead_id, a);
    }
    const snapFor = (m: { id: string; leadId?: string | null }) =>
      (m.id ? snapshotByMeeting.get(m.id) : undefined) ?? (m.leadId ? snapshotByLead.get(m.leadId) : undefined);

    /* The API states the booking agent on ~99% of rows (agentData). For the rest, take the department
     * and direction the aggregate already resolved for that meeting. Without this the row still lists —
     * it is a real appointment — but belongs to no agent, so the tiles sum to one less than the list
     * beneath them. Anything still unresolved stays listed and uncounted rather than being guessed at. */
    /* CALLBACK → OUTBOUND (Reports basis only). agentData.callType is the CALL's direction, so a
     * customer who calls the outbound line back reads "inbound" here — while the spine
     * (callbackAttribution.ts) and the snapshot (detailQueries conv_dir) both credit that conversation to
     * OUTBOUND. Taking agentData's word put the booking on the Inbound card and its conversation on the
     * Outbound card: Paragon Honda, MTD Sep, Service Inbound read 11 bookings over 5 qualified (220%) and 9
     * of the 11 were callbacks. The snapshot row for the same meeting carries the flip, so an inbound vs
     * outbound disagreement resolves to outbound. Keyed over the whole ~120d snapshot so the prior window
     * flips too; a booking newer than the last sync keeps agentData's direction until the next one. */
    // SERVICE bookings only: the close basis is a Service rule, and Sales stays exactly as it was.
    /* ★ MATCHED ON LEAD + BOOKING SECOND, NOT ONLY THE ID (fixed after #36). The feed's `id` is
     * meetings.meeting_id on some rows and the Mongo _id on others (see the snapshotByLead note above),
     * and the snapshot only stores meeting_id — so an id-only match silently skipped every row the API
     * handed back under its _id. In prod that was all 8 of Paragon Honda's callbacks since 6 Sep: Riley
     * (Service Inbound, 30d) kept 7 bookings beside a 0% close rate. booked_at is the same meeting's
     * created_at on both sides, so lead + that second identifies the meeting whichever id the API sent;
     * ±1 s absorbs a rounding difference between the two copies. */
    const snapshotOutbound = customerBasis ? new Set<string>() : null;
    if (snapshotOutbound) {
      for (const a of appointments) {
        if (a.assisted || (a.service_type ?? "").toLowerCase() !== "service" || (a.direction ?? "").toLowerCase() !== "outbound") continue;
        if (a.meeting_id) snapshotOutbound.add(`m:${a.meeting_id}`);
        const sec = epochSecond(a.booked_at);
        if (a.lead_id && sec !== null) snapshotOutbound.add(`l:${a.lead_id}|${sec}`);
      }
    }
    const isSnapshotOutbound = (m: { id: string; leadId?: string | null; bookedAt?: string | null }): boolean => {
      if (!snapshotOutbound) return false;
      if (m.id && snapshotOutbound.has(`m:${m.id}`)) return true;
      const sec = epochSecond(m.bookedAt);
      return !!m.leadId && sec !== null && [sec, sec - 1, sec + 1].some((x) => snapshotOutbound.has(`l:${m.leadId}|${x}`));
    };
    liveAppts = liveAppts.map((m) => {
      if (m.direction === "inbound" && (m.agentType || m.serviceType || "").toLowerCase() === "service" && isSnapshotOutbound(m)) m = { ...m, direction: "outbound" };
      if (m.agentType && m.direction) return m;
      const prev = snapFor(m);
      if (!prev) return m;
      return {
        ...m,
        agentType: m.agentType ?? (prev.service_type ? prev.service_type.toLowerCase() : null),
        direction: m.direction ?? (prev.direction ? prev.direction.toLowerCase() : null),
      };
    });
    const booked: ReportAppointmentRow[] = liveAppts
      .filter((m) => { const d = (m.bookedAt ?? "").slice(0, 10); return d >= start && d < end; })
      .map((m) => {
        const prev = m.id ? snapshotByMeeting.get(m.id) : undefined;
        return {
          team_id: teamId,
          enterprise_id: prev?.enterprise_id ?? null,
          service_type: (m.agentType || m.serviceType || "").toLowerCase() || null,
          lead_id: m.leadId,
          meeting_id: m.id,
          customer_name: m.customer,
          phone: m.phone,
          vehicle: m.vehicle || prev?.vehicle || null,
          intent: m.intent,
          meeting_start: m.when || null,
          booked_at: m.bookedAt,
          status: m.status || null,
          assisted: false,
          direction: m.direction ?? prev?.direction ?? null,
          booked_via: prev?.booked_via ?? null,
        } satisfies ReportAppointmentRow;
      });
    const assisted = windowedAppointments.filter((a) => a.assisted);
    windowedAppointments = [...booked, ...assisted];
  }
  // Invariant: a rooftop that returned real rows in THIS request can't be "never live" — don't let a
  // separate probe (even a clean-but-stale empty read) demote it. The probe still gates brand-new
  // rooftops whose selected window AND lifetime are both empty.

  /* Per-agent, per-store-local-day counts from the same rows, so the day-on-day chart plots the
   * bookings the funnel counts rather than agent_daily's separate appointment column. */
  const apptDayCounts: Record<string, Record<string, number>> = {};
  for (const a of windowedAppointments) {
    if (a.assisted) continue;
    const svc = (a.service_type || "").toLowerCase();
    const dir = (a.direction || "").toLowerCase();
    if ((svc !== "sales" && svc !== "service") || (dir !== "inbound" && dir !== "outbound")) continue;
    const type = `${svc === "sales" ? "Sales" : "Service"} ${dir === "inbound" ? "Inbound" : "Outbound"}`;
    const raw = (a.booked_at ?? "").slice(0, 10);
    if (!raw) continue;
    const day = storeLocalDay(a.booked_at ?? "", timezone ?? undefined, raw);
    (apptDayCounts[type] ??= {})[day] = ((apptDayCounts[type] ??= {})[day] ?? 0) + 1;
  }

  const result = buildResult({
    canonical: await canonicalP,
    canonicalHotLeads: await hotLeadsP,
    canonicalLeadSources: await leadSourcesP,
    daily: cur,
    breakdown: (bd.data ?? []) as BreakdownRow[],
    priorDaily: pri,
    callbacks,
    campaigns,
    outcomes,
    namedAppointments: windowedAppointments,
    apptDayCounts,
    warmLeads,
    onboardedSlots,
    onboardedNames,
    onboardedPhotos,
    leadCounts: lc.cur,
    priorLeadCounts: lc.prior,
    sourceCounts,
  });

  /* Same rule as the no-aggregate path above: an empty window WITH no canonical answer is an outage,
     not a finding. Only flagged when the aggregate is empty too — a rooftop with real rows still
     renders them if the canonical call happens to fail. */
  const canonicalResolved = await canonicalP;

  /* Resolved AFTER buildResult because it reads result.hasData, which is now true when the CANONICAL
     API supplied numbers even with an empty aggregate — a rooftop serving real rungs is self-evidently
     live, and letting the lifetime probe demote it would show the "report is on its way" gate over a
     working rooftop. */
  const everLiveResolved = everLive || allDaily.length > 0 || result.hasData;

  /* syncedAt = when the AGGREGATE was last rebuilt, not when this request ran. The header used to say
   * "Synced just now" off the client's own fetch time, over data that can be hours old: the sync
   * workflow is scheduled hourly but GitHub actually fires it every 1.4-5.5h. On Heiser Chevrolet that
   * read "Synced just now" beside 1 appointment while the appointments console, reading the live API,
   * showed 3 — the two missing ones were booked AFTER the last sync finished. Telling a dealer a number
   * is current when it is hours behind is how a sync lag gets mistaken for a bug. */
  /* ── ONE SOURCE FOR THE APPOINTMENT NUMBER ──
   * The per-agent AI-booked count is derived from the SAME rows the list shows — always, not only when
   * the live fetch succeeded. This is what stops the card and its own drill-down disagreeing.
   *
   * It used to come from agent_daily, i.e. the spine, which counts a meeting only once it attaches to a
   * conversation belonging to a lead that exists. That drops 5.2% of AI-booked meetings fleet-wide and
   * put the card under its own export: team 9923577d07 Service Inbound read 84 beside a sheet listing
   * 87. `windowedAppointments` is the meetings API when we have a credential and the meetings-table
   * snapshot when we don't, and both are a direct read of the booking records — neither needs a
   * conversation to exist. Whichever it is, the number and the list are now the same rows counted once.
   *
   * The prior window uses live rows when we have them and otherwise leaves the aggregate's basis alone —
   * the snapshot only covers the current window, so recomputing it from these rows would read zero. */
  const curByAgent: Record<string, number> = {};
  const curBooked: Booked = { leads: {}, noLead: {} }; // same rows, as customers (applyCustomerBasis)
  /* ★ SPLIT BY DEPARTMENT, NOT ONE ROOFTOP-WIDE NUMBER (fixed 2026-09-11). A booking no agent owns is
   * still added to the total the tile shows — but that tile is department-scoped whenever the header's
   * switcher is on Sales or Service, and this used to hand every scope the SAME rooftop-wide scalar.
   * Principle BMW MINI of San Antonio, service tab, 30d: Service Inbound 44 + Service Outbound 1 = 45
   * under a department total of 46, because one SALES booking with no resolvable direction was being
   * counted on the service tab (and on the sales tab, and on All — the same row three times over).
   * A row whose own department is unknown belongs to the rooftop and to neither department, so it is
   * kept apart in `unknown` and only "All" picks it up — which is exactly how the LIST beneath these
   * tiles already filters (`a.serviceType === dept`). Tile and list now scope identically. */
  const unattributedBy = { sales: 0, service: 0, unknown: 0 };
  /* ROOFTOP TOTAL for AI-assisted, by department. The spine can only credit an assist to an AGENT when
   * the lead has an in-window spine conversation to hang it on (lead_assist_conv), so summing the agent
   * rows under-reports the rooftop: 2b110492b6, 30d — 19 attributed against 23 meetings the CRM flags.
   * Assisted rows carry no direction by construction (a CRM meeting has no inbound/outbound), so they
   * CANNOT be re-attributed from the snapshot the way the AI-booked half is above. The honest split is
   * therefore: per-agent cards show what the spine can attribute, the rooftop tiles show this total. */
  const assistedBy = { sales: 0, service: 0, unknown: 0 };
  const assistedByAgent: Record<string, number> = {};
  for (const a of windowedAppointments) {
    if (a.assisted) {
      const svcA = (a.service_type || "").toLowerCase();
      assistedBy[svcA === "sales" || svcA === "service" ? svcA : "unknown"]++;
      /* PER-AGENT assists, from the same rows as the rooftop total directly above — which is what makes
         the agent cards sum to the tile instead of to a windowed subset of it. `direction` on an assisted
         row is the agent whose conversation earned the assist (detailQueries assist_agent), resolved over
         the full 90-day lookback rather than the report window. A row that resolves to no agent is left
         out of the per-agent map and stays in the rooftop total, exactly like an unattributed booking. */
      const dirA = (a.direction || "").toLowerCase();
      if ((svcA === "sales" || svcA === "service") && (dirA === "inbound" || dirA === "outbound")) {
        const typeA = `${svcA === "sales" ? "Sales" : "Service"} ${dirA === "inbound" ? "Inbound" : "Outbound"}`;
        assistedByAgent[typeA] = (assistedByAgent[typeA] ?? 0) + 1;
      }
      continue;
    }
    const svc = (a.service_type || "").toLowerCase();
    const dir = (a.direction || "").toLowerCase();
    const dept = svc === "sales" || svc === "service" ? svc : null;
    if (!dept || (dir !== "inbound" && dir !== "outbound")) {
      // Real bookings with no call, chat or conversation behind them — no agent owns them. Counted at
      // the scope that DOES own them (their department, or the rooftop when even that is unknown) and
      // listed there, never guessed onto an agent.
      unattributedBy[dept ?? "unknown"]++;
      continue;
    }
    const type = `${svc === "sales" ? "Sales" : "Service"} ${dir === "inbound" ? "Inbound" : "Outbound"}`;
    curByAgent[type] = (curByAgent[type] ?? 0) + 1;
    if (a.lead_id) (curBooked.leads[type] ??= new Set()).add(a.lead_id);
    else curBooked.noLead[type] = (curBooked.noLead[type] ?? 0) + 1;
  }
  const appointmentsUnattributed = unattributedBy.sales + unattributedBy.service + unattributedBy.unknown;
  const priByAgent = liveAppts ? countByAgent(liveAppts, prior.start, prior.end).byAgent : null;
  for (const agent of result.agents) {
    const type = AGENT_TYPE_BY_ID[agent.id];
    if (!type) continue;
    agent.metrics.appointments = curByAgent[type] ?? 0;
    /* Assists come from the appointment snapshot too, overriding the spine's figure. The spine can only
       credit an assist when the lead has an IN-WINDOW conversation to hang it on, so its per-agent numbers
       are a subset of the rooftop total (Covina Kia 30d: 19 of 38). These are attributed over the same
       90-day lookback the rooftop total uses, so the two reconcile. */
    agent.metrics.appointmentsAssisted = assistedByAgent[type] ?? 0;
    const basis = result.prior?.[agent.id];
    if (priByAgent && basis && typeof basis.appointments === "number") basis.appointments = priByAgent[type] ?? 0;
  }
  if (customerBasis && flagsCur) {
    applyCustomerBasis(result.agents, result.prior,
      stageGaps(flagsCur, serviceOnly(curBooked).leads),
      // The prior window has booking rows only when the live fetch ran (same rule as its appointments).
      liveAppts && flagsPri ? stageGaps(flagsPri, serviceOnly(bookedLeadsByAgent(liveAppts, prior.start, prior.end)).leads) : null);
  }

  return Response.json({ ...result, ...meta, syncedAt, appointmentsLive, appointmentsUnattributed, appointmentsUnattributedBy: unattributedBy, appointmentsAssistedBy: assistedBy, everLive: everLiveResolved, ...(!canonicalResolved && !result.hasData ? { degraded: true } : {}) }, {
    /* PRIVATE, not shared: this body carries customer names and phone numbers, so it must never sit in
       a shared CDN cache. `max-age` lets a reload come straight from the browser — the canonical
       endpoints are multi-second warehouse queries and a refresh should not pay for them twice — and
       `stale-while-revalidate` keeps the numbers on screen while the refresh runs.

       RAISED 60s -> 900s (15 min). Measured on 3d3deabc98: a COLD request is 6-16s, because this route
       fans out to four canonical calls and the slowest (overview) is 8.3s on a busy rooftop. The old 60s
       was far shorter than the work it was protecting, and the server-side cache behind it is a
       module-level Map — per serverless instance on Vercel, so a reload routed to a fresh instance pays
       the full cold cost. The browser cache is the only layer that survives both a reload and an
       instance change, which is why it carries the long window. The Refresh button bypasses it
       explicitly (see `force` in liveData.ts), so a dealer can always get live numbers on demand. */
    headers: { "Cache-Control": "private, max-age=900, stale-while-revalidate=1800" },
  });
}
