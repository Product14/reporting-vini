/* Live data layer — fetches the materialized report for a team + window in ONE request to
 * /api/reports (which reads the Supabase aggregate the sync maintains) and returns it as the
 * AgentData[] the reporting UI already consumes. Replaces the old ~84 Metabase card round-trips.
 * Used by /reports (Overview) and /reports/agents (By agent) — no component/JSX changes. */

import { type AgentData, type Bucket, type Meeting, type MeetingsResult, type RAG } from "./data";
import { type Account } from "./accounts";

// Maps the CSM sheet's agent-type labels to this report's agent ids.
export const ID_BY_AGENT_TYPE: Record<string, AgentData["id"]> = {
  "Sales Inbound": "sales_ib",
  "Sales Outbound": "sales_ob",
  "Service Inbound": "service_ib",
  "Service Outbound": "service_ob",
};

/* Scope an agent list to the agents a rooftop actually runs (per the CSM sheet). A rooftop not in
 * the tracker (no agents listed) shows all, so an unmapped team never renders an empty report. */
export function agentsForAccount(agents: AgentData[], account: Account | undefined): AgentData[] {
  const ids = new Set((account?.agents ?? []).map((t) => ID_BY_AGENT_TYPE[t]).filter(Boolean));
  return ids.size ? agents.filter((a) => ids.has(a.id)) : agents;
}

export const DEFAULT_TEAM_ID = "9923577d07"; // Honda of Downtown LA — overridable per call

// Today's calendar date (YYYY-MM-DD). When a store IANA timezone is given, anchor to THAT zone's
// "today" so a Pacific rooftop's day boundaries are Pacific midnight, not UTC midnight — otherwise a
// UTC day spans ~5pm-prev-day → ~5pm Pacific and bleeds the previous evening into "today". With no
// timezone we fall back to UTC (the historical behavior).
function todayIn(timeZone?: string): string {
  const now = new Date();
  if (!timeZone) return now.toISOString().slice(0, 10);
  // en-CA renders as YYYY-MM-DD; timeZone shifts it to the store's local calendar day.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
// Shift a YYYY-MM-DD date by n whole days, returning YYYY-MM-DD. Date-only math (UTC midnight) so it's
// timezone-agnostic — it just adds/subtracts whole days to a bare calendar date.
function shiftDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/* Date window per the UI's bucket toggle — ROLLING relative to today in the store's timezone (or UTC
 * when none is known). Windows INCLUDE today (the live, in-progress day) so the report aligns with the
 * Spyne console's calendar days: "Today" is the current day, "Yesterday" the one before, last7/14/30 the
 * trailing N days ENDING today, Lifetime all history. `end` is exclusive = tomorrow, so today is in range.
 * Caveat: the current day is PARTIAL — end-call-reports enrich a few minutes after each call ends and the
 * sync pulls on its own cadence, so "Today" trails a live console slightly until the day closes. (This
 * replaced the old "Today = latest *complete* day" shift, which made every window read a day behind and
 * disagree with the console's "Today".) */
export function rangeFor(bucket: Bucket, timeZone?: string): { start: string; end: string } {
  const today = todayIn(timeZone);   // current calendar day, store-local
  const end = shiftDays(today, 1);   // exclusive upper bound = tomorrow, so today is included
  switch (bucket) {
    case "today": return { start: today, end };
    case "yesterday": return { start: shiftDays(today, -1), end: today };
    case "last7": return { start: shiftDays(today, -6), end };
    case "last14": return { start: shiftDays(today, -13), end };
    case "last30": return { start: shiftDays(today, -29), end };
    case "lifetime": return { start: "2020-01-01", end };
    default: return { start: shiftDays(today, -29), end };
  }
}

/* Short, human label for an IANA timezone (e.g. "America/Los_Angeles" → "PDT"/"PST"). Used to tell the
 * dealer which timezone the report's days/times are in. Returns "" when unknown/unparseable. */
export function tzShortLabel(tz?: string | null): string {
  if (!tz) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date());
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

// Shift an inclusive ISO date one day forward — turns a UI date-picker "end" into the exclusive end the queries expect.
export function addDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Period-over-period % change. Returns null (not 0) when there's NO prior basis (prev === 0) so the UI
// can distinguish "new / no prior data" from a genuine 0% change — rendering "▲ 0%" for real growth
// from an empty prior window is misleading.
const pctDelta = (curr: number, prev: number): number | null => (prev ? Math.round(((curr - prev) / prev) * 100) : null);

/* ── Per-appointment dollar value (whiteboard spec) ──────────────────────────
 * The dollar value a booked appointment is worth, by agent slot. SINGLE SOURCE OF TRUTH —
 * the same per-category rates as the Programs dashboard in vini-daily-calls
 * (src/agents/AgentsDashboard.tsx COST_PER_APPT). Hardcoded by design (leadership spec),
 * not a user-set cost, so every surface values an appointment identically. */
export const APPT_VALUE_BY_AGENT: Record<AgentData["id"], number> = {
  sales_ib: 200,
  sales_ob: 250,
  service_ib: 100,
  service_ob: 200,
};

// Department-average per-appointment value — the fallback when an agent id isn't one of the four
// known slots, so an unmapped id values its appointments at a sensible dept rate instead of $0
// (which silently zeroed real bookings in "Value created"). Sales avg $225, Service avg $150.
export const DEPT_AVG_APPT_VALUE = { sales: 225, service: 150 } as const;

// Per-appointment value for an agent id: the exact slot rate when known, else the department average
// inferred from the id ("service" → Service avg, else Sales avg). Warns once per unmapped id (dev only)
// so the gap is visible rather than silent.
const warnedUnmappedIds = new Set<string>();
function warnUnmappedId(id: string): void {
  if (process.env.NODE_ENV === "production" || warnedUnmappedIds.has(id)) return;
  warnedUnmappedIds.add(id);
  console.warn(`[liveData] unmapped agent id "${id}" — valuing appointments at the department average`);
}
export const apptValueForId = (id: string): number => {
  const known = APPT_VALUE_BY_AGENT[id as AgentData["id"]];
  if (known != null) return known;
  warnUnmappedId(id);
  return /service/i.test(id) ? DEPT_AVG_APPT_VALUE.service : DEPT_AVG_APPT_VALUE.sales;
};

// Value created by ONE agent slot = its appointments × that slot's per-appointment value (falling back
// to the department average for an unmapped id rather than $0).
export const valueForAgent = (id: AgentData["id"], appointments: number): number =>
  appointments * apptValueForId(id);

// Fleet value = Σ per-agent (each agent's appointments × its own rate). Use this — NOT a single
// flat rate — so a rooftop's mix of Sales/Service × IB/OB is valued correctly.
export const fleetValue = (agents: AgentData[]): number =>
  agents.reduce((s, a) => s + valueForAgent(a.id, a.metrics.appointments), 0);

// Appointment-weighted blended $/appt across a set of agents — for copy and pooled figures
// (e.g. money-on-table) where the per-lead agent slot isn't known. Falls back to 0 when no appts.
export const blendedApptValue = (agents: AgentData[]): number => {
  const appts = agents.reduce((s, a) => s + a.metrics.appointments, 0);
  return appts > 0 ? Math.round(fleetValue(agents) / appts) : 0;
};

/* ROI factor → RAG (whiteboard spec, same thresholds as the Programs dashboard):
 *   ≥ 3 → Green · ≥ 1.5 → Amber · else Red. The factor itself (value ÷ run-cost or MRR) needs a
 *   cost/MRR source that reporting-vini doesn't carry yet — this helper is the shared classifier. */
export const ROI_GREEN = 3;
export const ROI_AMBER = 1.5;
export const roiRAG = (factor: number): RAG => (factor >= ROI_GREEN ? "green" : factor >= ROI_AMBER ? "amber" : "red");

/* @deprecated flat-rate value — superseded by valueForAgent/fleetValue (per-category whiteboard rates).
 * Kept only so any out-of-tree caller keeps compiling; in-tree code uses the per-agent helpers. */
export const appointmentValue = (appointments: number, apptCost: number): number => appointments * apptCost;

export interface LiveOpts {
  teamId?: string;
  bucket?: Bucket;
  start?: string;
  end?: string;
  force?: boolean; // bypass the cache (used by the Refresh button)
  spyneToken?: string; // host-forwarded Spyne API token (prod); omit locally (server uses env)
}

// Minimal per-agent totals for the prior equal-length window — the basis for real period deltas.
export interface Basis {
  calls: number;
  conversations: number;
  qualified: number;
  appointments: number;
  leads: number;
  sms: number;
}

export interface FetchResult {
  agents: AgentData[];
  hasData: boolean; // the SELECTED window has rows — drives inline "empty window" notes, not the gate
  // Has this rooftop EVER produced data (lifetime, any window)? Gates the full-surface "Coming soon"
  // placeholder: a live account whose selected window is empty still renders the report (with zeros).
  // Absent on the mock/error fallback → callers fall back to hasData (prior, window-scoped behavior).
  everLive?: boolean;
  fetchedAt: number; // epoch ms — drives the "last synced" label
  prior: Record<string, Basis>; // per-agent-id totals for the prior window (for fleet deltas)
  // The window the server actually resolved (store-local when a timezone was known) + that timezone.
  // Informational — lets the UI label the period / note the zone. Absent on the mock/error fallback.
  start?: string;
  end?: string;
  timezone?: string | null;
}

// Live fleet roll-up for the Overview: sums the account's live agents and computes real deltas
// from the prior-window basis. Money/deals/showed are intentionally absent — they have no card.
export interface FleetLive {
  calls: number;
  conversations: number;
  qualified: number;
  appointments: number;
  afterHours: number;
  talkMinutes: number;
  smsSent: number;
  optOuts: number;
  csat: number;
  sentiment: number;
  connectRate: number; // blended connected-calls / calls across IB+OB — kept for back-compat
  // Inbound-only answer rate (answered inbound calls / inbound calls). The honest figure for a
  // "Connect / answer" cell, which is an inbound concept; null when the fleet has no inbound calls.
  answerRateInbound: number | null;
  // null === no prior-window basis ("new"); a number is a real % change (incl. 0).
  deltas: { appointments: number | null; calls: number | null; conversations: number | null; qualified: number | null; sms: number | null };
  funnel: { label: string; value: number }[];
}

export function aggregateFleet(agents: AgentData[], prior?: Record<string, Basis>): FleetLive {
  const sum = (f: (a: AgentData) => number) => agents.reduce((s, a) => s + f(a), 0);
  const calls = sum((a) => a.metrics.calls);
  const connectedCalls = sum((a) => a.metrics.conversations); // connected CALLS — the answer-rate basis
  // Inbound-only slice for an honest answer rate (answer rate is an inbound concept; folding outbound
  // dial connect-rate into the same number makes it meaningless).
  const isInbound = (a: AgentData) => a.dir === "Inbound";
  const inboundCalls = agents.filter(isInbound).reduce((s, a) => s + a.metrics.calls, 0);
  const inboundAnswered = agents.filter(isInbound).reduce((s, a) => s + a.metrics.conversations, 0);
  const smsSent = sum((a) => a.metrics.smsSent);
  const afterHours = sum((a) => a.metrics.afterHours);
  const talkMinutes = sum((a) => a.metrics.talkMinutes);
  const optOuts = sum((a) => a.metrics.optOuts);

  // Unique-lead stages (distinct leads, summed across agents). The displayed "Conversations"/"Qualified"
  // counts + the funnel all use these, so a given label shows ONE number everywhere. connectRate stays on
  // connected CALLS (it's an answer rate). Falls back to event counts when no agent carries leadFunnel.
  const hasLeadFunnel = agents.some((a) => a.leadFunnel);
  const lf = (pick: (f: NonNullable<AgentData["leadFunnel"]>) => number) =>
    agents.reduce((s, a) => s + (a.leadFunnel ? pick(a.leadFunnel) : 0), 0);
  const conversations = hasLeadFunnel ? lf((f) => f.connected) : connectedCalls; // unique connected leads
  const qualified = hasLeadFunnel ? lf((f) => f.qualified) : sum((a) => a.metrics.qualified); // unique qualified leads
  const appointments = sum((a) => a.metrics.appointments); // already lead-based (build sets metrics.appointments = apptLeads)

  // call-weighted quality so a low-volume agent can't swing the fleet number
  const wAvg = (f: (a: AgentData) => number) => (calls ? agents.reduce((s, a) => s + f(a) * a.metrics.calls, 0) / calls : 0);
  const pSum = (f: (b: Basis) => number) => agents.reduce((s, a) => s + (prior?.[a.id] ? f(prior[a.id]) : 0), 0);

  // Funnel: every stage is distinct leads (monotonic: contacted ≥ connected ≥ qualified ≥ appt). Falls
  // back to activity volumes only when no agent carries leadFunnel (pure-mock / no-backend).
  const funnel = hasLeadFunnel
    ? [
        { label: "Leads reached", value: lf((f) => f.contacted) },
        { label: "Conversations", value: conversations },
        { label: "Qualified", value: qualified },
        { label: "Appointments", value: appointments },
      ]
    : [
        { label: "Outreach & calls", value: calls + smsSent },
        { label: "Conversations", value: connectedCalls },
        { label: "Qualified / engaged", value: qualified },
        { label: "Appointments set", value: appointments },
      ];
  return {
    calls,
    conversations,
    qualified,
    appointments,
    afterHours,
    talkMinutes,
    smsSent,
    optOuts,
    csat: +wAvg((a) => a.quality.csat).toFixed(1),
    sentiment: Math.round(wAvg((a) => a.quality.sentiment)),
    connectRate: calls ? Math.round((connectedCalls / calls) * 100) : 0,
    answerRateInbound: inboundCalls ? Math.round((inboundAnswered / inboundCalls) * 100) : null,
    deltas: {
      appointments: pctDelta(appointments, pSum((b) => b.appointments)),
      calls: pctDelta(calls, pSum((b) => b.calls)),
      conversations: pctDelta(conversations, pSum((b) => b.conversations)),
      qualified: pctDelta(qualified, pSum((b) => b.qualified)),
      sms: pctDelta(smsSent, pSum((b) => b.sms)),
    },
    funnel,
  };
}

// Client-side cache so switching back to a team/window doesn't re-hit the server. 5-minute TTL.
const CACHE = new Map<string, FetchResult>();
const CACHE_TTL_MS = 5 * 60 * 1000;

/* Cache key for a team + window. Relative buckets key by the bucket NAME (not a client-computed date
 * range) because the server now resolves the actual dates in the store's timezone — the client no
 * longer knows the exact window up front. Custom date-picker ranges key by their explicit dates. */
function cacheKeyFor(teamId: string, opts: LiveOpts): string {
  return opts.start && opts.end ? `${teamId}|${opts.start}|${opts.end}` : `${teamId}|b:${opts.bucket ?? "last30"}`;
}

/* Synchronously read a cached window without touching the network — lets the UI paint instantly when
 * you navigate back to a page (stale-while-revalidate: show what we have, then fetchAgents refreshes
 * in the background per the TTL). Returns whatever is cached regardless of age, or null. */
export function peekAgents(opts: LiveOpts = {}): FetchResult | null {
  if (!opts.teamId) return null;
  return CACHE.get(cacheKeyFor(opts.teamId, opts)) ?? null;
}

/* Fetch the materialized report for a team + window in ONE request to /api/reports (which reads the
 * Supabase aggregate the sync maintains). Replaces the previous ~84 Metabase round-trips. Keeps the
 * same FetchResult shape + client cache, so pages and aggregateFleet() are unchanged. On any network
 * error it falls back to mock agents so the report still renders. */
export async function fetchAgents(opts: LiveOpts = {}): Promise<FetchResult> {
  const teamId = opts.teamId || DEFAULT_TEAM_ID;
  const cacheKey = cacheKeyFor(teamId, opts);
  if (!opts.force) {
    const cached = CACHE.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;
  }

  // Relative buckets send the bucket NAME and let the server compute the window in the store's
  // timezone; custom ranges send explicit (store-local) dates. Either way the server owns the dates,
  // so they're consistent with the timezone it resolved.
  const query: Record<string, string> = opts.start && opts.end
    ? { team_id: teamId, start: opts.start, end: opts.end }
    : { team_id: teamId, bucket: opts.bucket ?? "last30" };

  let result: FetchResult;
  try {
    const qs = new URLSearchParams(query);
    // Forward the host's Spyne token (prod) as a Bearer header so /api/reports can resolve timezone +
    // onboarded agents. Omitted locally → the server falls back to its env token.
    const headers = opts.spyneToken ? { Authorization: `Bearer ${opts.spyneToken}` } : undefined;
    const r = await fetch(`/api/reports?${qs.toString()}`, { cache: "no-store", headers });
    const j = (await r.json().catch(() => null)) as Partial<FetchResult> | null;
    if (!r.ok || !j || !Array.isArray(j.agents)) throw new Error("bad /api/reports response");
    result = {
      agents: j.agents as AgentData[],
      hasData: Boolean(j.hasData),
      everLive: typeof j.everLive === "boolean" ? j.everLive : undefined,
      fetchedAt: typeof j.fetchedAt === "number" ? j.fetchedAt : Date.now(),
      prior: (j.prior as Record<string, Basis>) ?? {},
      start: j.start,
      end: j.end,
      timezone: j.timezone ?? null,
    };
  } catch {
    // On error, render nothing rather than mock numbers — hasData:false drives the "coming soon" state.
    result = { agents: [], hasData: false, fetchedAt: Date.now(), prior: {} };
  }

  CACHE.set(cacheKey, result);
  return result;
}

/* Coming-soon metrics derived from ClickHouse and stored in Supabase by scripts/push_metrics.py — read
 * from GET /api/reports/metrics (rooftop-level, separate from the Q12227 aggregate fetchAgents reads).
 * Only the fields the UI renders are typed. Returns null when no rooftop / on any error → the widgets
 * stay on their "coming soon" placeholder, so a missing push never breaks the report. */
export interface ReportMetrics {
  transfer_quality: { transfers_ok: number; transfers_failed: number; forwarded: number; success_rate: number | null } | null;
  calls_by_reason: Array<{ direction: string | null; reason: string; calls: number; booked: number }>;
  missed: Array<{ channel: string; category: string; count: number }>;
  highlights: Array<{ direction: string | null; use_case: string | null; score: number | null; title: string | null; occurred_on: string | null }>;
}

export async function fetchReportMetrics(teamId: string, spyneToken?: string): Promise<ReportMetrics | null> {
  if (!teamId) return null;
  try {
    // Forward the host's Spyne token (prod) so the now-authenticated GET /api/reports/metrics authorizes,
    // same as fetchAgents/fetchMeetings. Omitted locally → the server falls back to its env token.
    const headers = spyneToken ? { Authorization: `Bearer ${spyneToken}` } : undefined;
    const r = await fetch(`/api/reports/metrics?team_id=${encodeURIComponent(teamId)}`, { cache: "no-store", headers });
    if (!r.ok) return null;
    const j = (await r.json()) as Partial<ReportMetrics> | null;
    if (!j) return null;
    return {
      transfer_quality: j.transfer_quality ?? null,
      calls_by_reason: Array.isArray(j.calls_by_reason) ? j.calls_by_reason : [],
      missed: Array.isArray(j.missed) ? j.missed : [],
      highlights: Array.isArray(j.highlights) ? j.highlights : [],
    };
  } catch {
    return null;
  }
}

export interface MeetingFetchOpts {
  teamId: string;
  enterpriseId?: string; // host-forwarded on the iframe URL; else the server decodes it from the token
  service?: "sales" | "service" | "both"; // default "both" (rooftop-wide)
  scope?: "window" | "upcoming"; // "upcoming" = from now forward; "window" = the report's date range
  bucket?: Bucket;
  start?: string;
  end?: string;
  agentType?: string; // report slot id (sales_ib/…) — scopes the drill to that agent's booked leads
  spyneToken?: string; // host-forwarded Spyne token (prod); omit locally (server uses env)
}

/* Fetch the meeting/appointment records behind an appointment count (scope:"window") or the upcoming
 * bookings (scope:"upcoming") via /api/meetings, which proxies the Spyne product API server-side so the
 * token never reaches the browser. Returns an empty list on any error → the card/modal shows its empty
 * state rather than breaking. */
export async function fetchMeetings(opts: MeetingFetchOpts): Promise<MeetingsResult> {
  const { teamId, enterpriseId, service = "both", scope = "window", bucket, start, end, agentType, spyneToken } = opts;
  const query: Record<string, string> = { team_id: teamId, serviceType: service, scope };
  if (enterpriseId) query.enterprise_id = enterpriseId;
  if (scope === "window") {
    if (start && end) { query.start = start; query.end = end; }
    else query.bucket = bucket ?? "last30";
    if (agentType) query.agent_type = agentType;
  }
  try {
    const qs = new URLSearchParams(query);
    const headers = spyneToken ? { Authorization: `Bearer ${spyneToken}` } : undefined;
    const r = await fetch(`/api/meetings?${qs.toString()}`, { cache: "no-store", headers });
    const j = (await r.json().catch(() => null)) as Partial<MeetingsResult> | null;
    if (!r.ok || !j || !Array.isArray(j.meetings)) return { meetings: [], total: 0 };
    return { meetings: j.meetings as Meeting[], total: typeof j.total === "number" ? j.total : j.meetings.length };
  } catch {
    return { meetings: [], total: 0 };
  }
}
