/* Live data layer — fetches the materialized report for a team + window in ONE request to
 * /api/reports (which reads the Supabase aggregate the sync maintains) and returns it as the
 * AgentData[] the reporting UI already consumes. Replaces the old ~84 Metabase card round-trips.
 * Used by /reports (Overview) and /reports/agents (By agent) — no component/JSX changes. */

import { type AgentData, type Bucket, type Meeting, type MeetingsResult, type NamedAppt, type WarmLeadItem } from "./data";

export type { NamedAppt, WarmLeadItem } from "./data";
import { type Account } from "./accounts";

// Maps the CSM sheet's agent-type labels to this report's agent ids.
export const ID_BY_AGENT_TYPE: Record<string, AgentData["id"]> = {
  "Sales Inbound": "sales_ib",
  "Sales Outbound": "sales_ob",
  "Service Inbound": "service_ib",
  "Service Outbound": "service_ob",
};

/* Does this agent have ANY real activity in the window? Activity is ground truth for whether an agent
 * should appear — not just calls (an inbound agent can have a busy SMS/lead day with zero calls), so we
 * look across calls, conversations, qualified, appointments, SMS and unique leads touched. */
export function hasAgentActivity(a: AgentData): boolean {
  const m = a.metrics;
  const leads = a.leadFunnel?.contacted ?? a.report?.leadsAttempted ?? 0;
  return m.calls + m.conversations + m.qualified + m.appointments + m.smsSent + leads > 0;
}

/* Scope an agent list to the agents a rooftop actually runs. We keep the agents the CSM sheet lists for
 * this rooftop PLUS any agent with real activity in the window — the sheet goes stale, so activity is
 * the source of truth. Without this, an agent that runs live but was never added to the sheet (e.g. a
 * rooftop's Sales-OB) is silently hidden from BOTH the overview and the by-agent view. A rooftop not in
 * the tracker (no agents listed) shows all, so an unmapped team never renders an empty report. */
export function agentsForAccount(agents: AgentData[], account: Account | undefined): AgentData[] {
  const ids = new Set((account?.agents ?? []).map((t) => ID_BY_AGENT_TYPE[t]).filter(Boolean));
  if (!ids.size) return agents;
  return agents.filter((a) => ids.has(a.id) || hasAgentActivity(a));
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
    // Month-to-date: 1st of the current (store-local) month → today inclusive.
    case "mtd": return { start: `${today.slice(0, 7)}-01`, end };
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

/* Dollar-value layer removed in v3 (user decision 2026-07-07): the report leads with real counts —
 * appointments, conversations, hand-offs, time — not appts × a hardcoded rate, which dealers read as
 * fake. Value framing (avg-RO / gross-per-copy) can return later as a dealer-configurable model. */

export interface LiveOpts {
  teamId?: string;
  bucket?: Bucket;
  start?: string;
  end?: string;
  force?: boolean; // bypass the cache (used by the Refresh button)
  spyneToken?: string; // host-forwarded Spyne API token (prod); omit locally (server uses env)
}

// Minimal per-agent totals for the prior equal-length window — the basis for real period deltas.
// The v3 fields are optional so older cached payloads (and the mock path) still parse.
export interface Basis {
  calls: number;
  conversations: number;
  qualified: number;
  appointments: number;
  leads: number;
  sms: number;
  appointmentsAssisted?: number;
  transfers?: number;
  transfersFailed?: number;
  callbacks?: number;
  talkMinutes?: number;
  afterHours?: number;
}

export interface FetchResult {
  agents: AgentData[];
  hasData: boolean; // the SELECTED window has rows — drives inline "empty window" notes, not the gate
  // Has this rooftop EVER produced data (lifetime, any window)? Gates the full-surface "Coming soon"
  // placeholder: a live account whose selected window is empty still renders the report (with zeros).
  // Absent on the mock/error fallback → callers fall back to hasData (prior, window-scoped behavior).
  everLive?: boolean;
  fetchedAt: number; // epoch ms — drives the "last synced" label
  // The fetch failed or the server degraded (transient Supabase blip / cold-start timeout). A degraded
  // result is NOT cached and must NEVER flip the report to the "Coming soon" gate — an outage is not the
  // same as a rooftop that never went live. Callers treat it as "still loading" and retry.
  degraded?: boolean;
  // The request was rejected 401/403 (missing/invalid or wrong-team credential). TERMINAL — not degraded,
  // so the self-heal re-arm never fires. Locally this just means no ?auth_key= on the URL.
  unauthorized?: boolean;
  prior: Record<string, Basis>; // per-agent-id totals for the prior window (for fleet deltas)
  // The window the server actually resolved (store-local when a timezone was known) + that timezone.
  // Informational — lets the UI label the period / note the zone. Absent on the mock/error fallback.
  start?: string;
  end?: string;
  timezone?: string | null;
  // v3 named lists (rooftop-wide; the per-agent scoped copies live on agent.report). Absent on the
  // mock/degraded path — sections omit. LIVE-ONLY, never fabricated.
  namedAppointments?: NamedAppt[];
  warmLeads?: WarmLeadItem[];
}

// Per-direction sums for the hero tiles' Inbound/Outbound tri-split rows.
export interface FleetSplit {
  leads: number;
  conversations: number;
  qualified: number;
  appointments: number;
  appointmentsAssisted: number;
  transfers: number;
  transfersFailed: number;
  callbacks: number;
  handoffs: number; // transfers + callbacks (canonical "Hand-offs to team")
  calls: number;
  smsSent: number;
  talkMinutes: number;
  afterHours: number;
}

// Live fleet roll-up for the Overview: sums the account's live agents and computes real deltas
// from the prior-window basis. Dollar figures are intentionally absent (v3: counts, not $).
export interface FleetLive {
  calls: number;
  leads: number; // distinct leads touched/contacted (funnel entry) — the "Leads touched" MAIN tile
  conversations: number;
  qualified: number;
  appointments: number;
  appointmentsAssisted: number; // canonical: AI-assisted (CRM) — SECONDARY, never folded into appointments
  transfers: number; // canonical: completed hand-offs (lead-level when RPC available)
  transfersFailed: number; // reported separately, never folded in
  callbacks: number;
  handoffs: number; // transfers + callbacks
  // Query resolution (INBOUND only): a customer asked and the AI answered. Numerator = inbound
  // query_resolved (callFlow.handledByAI); denominator = queryConversations (inbound real conversations).
  // Scoped to inbound because outbound reactivation has ~no query_resolved and would dilute the rate.
  queryResolved: number;
  queryConversations: number;
  queryResolutionRate: number | null;
  // Response time = avg first-response (speed-to-lead) in seconds, from Sales-Inbound STL accumulators.
  // The honest rooftop "Response time" figure; null when no measurable new-lead touches. SMS reply
  // latency is shown on the Recent-calls detail page, not folded into this headline.
  responseTimeSec: number | null;
  // % of real conversations the AI handled end-to-end (no transfer) — the workload-offload headline.
  // null when there are no conversations.
  handledEndToEndPct: number | null;
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
  deltas: {
    appointments: number | null; leads: number | null; calls: number | null; conversations: number | null;
    qualified: number | null; sms: number | null; handoffs: number | null;
    talkMinutes: number | null; afterHours: number | null;
  };
  funnel: { label: string; value: number }[];
  bySplit: { inbound: FleetSplit; outbound: FleetSplit };
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
  const appointmentsAssisted = sum((a) => a.metrics.appointmentsAssisted ?? 0);
  // Hand-offs: transfers are lead-level (build prefers report_lead_counts), callbacks call-level daily
  // sums — both windowed. Failed transfers tracked separately, never added into transfers/handoffs.
  const cf = (f: (c: NonNullable<AgentData["report"]["callFlow"]>) => number) =>
    agents.reduce((s, a) => s + (a.report?.callFlow ? f(a.report.callFlow) : 0), 0);
  const transfers = cf((c) => c.transferred);
  const transfersFailed = cf((c) => c.transfersFailed ?? 0);
  const callbacks = cf((c) => c.callbacks ?? 0);
  const handoffs = transfers + callbacks;
  // Query resolution is an INBOUND concept: a customer asked something and the AI answered it. Outbound
  // reactivation has ~no query_resolved, so dividing by ALL conversations wrongly dilutes the rate (e.g.
  // to ~5% on outbound-heavy rooftops). Numerator AND denominator are inbound-only. query_resolved rides
  // on callFlow.handledByAI; the denominator is inbound real conversations (unique connected leads).
  // Numerator and denominator MUST be the same grain: query_resolved (callFlow.handledByAI) is a per-day
  // event sum, so the denominator is inbound connected CONVERSATIONS (metrics.conversations, also per-day
  // event-summed) — NOT window-distinct leadFunnel.connected, which would mismatch grains and pin the rate
  // at 100% on multi-day windows. resolved ⊆ connected, so the rate stays ≤ 100 naturally.
  const queryResolved = agents.filter(isInbound).reduce((s, a) => s + (a.report?.callFlow?.handledByAI ?? 0), 0);
  const queryConversations = agents.filter(isInbound).reduce((s, a) => s + a.metrics.conversations, 0);
  const queryResolutionRate = queryConversations > 0 ? Math.min(100, Math.round((100 * queryResolved) / queryConversations)) : null;
  // Leads touched = distinct leads the AI contacted (funnel entry). Unique-lead basis when available.
  const leads = hasLeadFunnel ? lf((f) => f.contacted) : sum((a) => a.report?.leadsAttempted ?? 0);
  // Response time = the Sales-Inbound speed-to-lead avg (only slot with a new-lead first-response funnel).
  const responseTimeSec = agents.find((a) => a.id === "sales_ib")?.report.speedToLead?.avgSec ?? null;

  // Per-direction split for the hero tri-rows.
  const splitFor = (dir: "Inbound" | "Outbound"): FleetSplit => {
    const mine = agents.filter((a) => a.dir === dir);
    const s = (f: (a: AgentData) => number) => mine.reduce((acc, a) => acc + f(a), 0);
    const tr = s((a) => a.report?.callFlow?.transferred ?? 0);
    const cb = s((a) => a.report?.callFlow?.callbacks ?? 0);
    return {
      leads: s((a) => a.leadFunnel?.contacted ?? a.report?.leadsAttempted ?? 0),
      conversations: s((a) => a.leadFunnel?.connected ?? a.metrics.conversations),
      qualified: s((a) => a.leadFunnel?.qualified ?? a.metrics.qualified),
      appointments: s((a) => a.metrics.appointments),
      appointmentsAssisted: s((a) => a.metrics.appointmentsAssisted ?? 0),
      transfers: tr,
      transfersFailed: s((a) => a.report?.callFlow?.transfersFailed ?? 0),
      callbacks: cb,
      handoffs: tr + cb,
      calls: s((a) => a.metrics.calls),
      smsSent: s((a) => a.metrics.smsSent),
      talkMinutes: s((a) => a.metrics.talkMinutes),
      afterHours: s((a) => a.metrics.afterHours),
    };
  };

  // call-weighted quality so a low-volume agent can't swing the fleet number
  const wAvg = (f: (a: AgentData) => number) => (calls ? agents.reduce((s, a) => s + f(a) * a.metrics.calls, 0) / calls : 0);
  const pSum = (f: (b: Basis) => number) => agents.reduce((s, a) => s + (prior?.[a.id] ? f(prior[a.id]) : 0), 0);

  // Funnel: every stage is distinct leads (monotonic: contacted ≥ connected ≥ qualified ≥ appt), with
  // the canonical wordings. Falls back to activity volumes only when no agent carries leadFunnel.
  const funnel = hasLeadFunnel
    ? [
        { label: "Leads reached", value: lf((f) => f.contacted) },
        { label: "Real conversations", value: conversations },
        { label: "Qualified leads", value: qualified },
        { label: "Appointments — AI-booked", value: appointments },
      ]
    : [
        { label: "Outreach & calls", value: calls + smsSent },
        { label: "Real conversations", value: connectedCalls },
        { label: "Qualified leads", value: qualified },
        { label: "Appointments — AI-booked", value: appointments },
      ];
  return {
    calls,
    leads,
    conversations,
    qualified,
    appointments,
    appointmentsAssisted,
    transfers,
    transfersFailed,
    callbacks,
    handoffs,
    queryResolved,
    queryConversations,
    queryResolutionRate,
    responseTimeSec,
    handledEndToEndPct: conversations > 0 ? Math.max(0, Math.round(((conversations - transfers) / conversations) * 100)) : null,
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
      leads: pctDelta(leads, pSum((b) => b.leads)),
      calls: pctDelta(calls, pSum((b) => b.calls)),
      conversations: pctDelta(conversations, pSum((b) => b.conversations)),
      qualified: pctDelta(qualified, pSum((b) => b.qualified)),
      sms: pctDelta(smsSent, pSum((b) => b.sms)),
      handoffs: pctDelta(handoffs, pSum((b) => (b.transfers ?? 0) + (b.callbacks ?? 0))),
      talkMinutes: pctDelta(talkMinutes, pSum((b) => b.talkMinutes ?? 0)),
      afterHours: pctDelta(afterHours, pSum((b) => b.afterHours ?? 0)),
    },
    funnel,
    bySplit: { inbound: splitFor("Inbound"), outbound: splitFor("Outbound") },
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

  // Forward the host's Spyne token (prod) as a Bearer header so /api/reports can resolve timezone +
  // onboarded agents. Omitted locally → the server falls back to its env token.
  const headers = opts.spyneToken ? { Authorization: `Bearer ${opts.spyneToken}` } : undefined;

  // Retry transient failures before giving up. A cold serverless start, a 504, or a momentary Supabase
  // blip makes the FIRST call fail/degrade — and a degraded response (no everLive, hasData:false) is
  // indistinguishable from "never live", so without a retry an established rooftop wrongly flips to the
  // "Coming soon" gate until the user manually refreshes. We retry with backoff and cache ONLY a clean
  // response, so a failure is never pinned for the 5-min TTL.
  const MAX_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const qs = new URLSearchParams(query);
      const r = await fetch(`/api/reports?${qs.toString()}`, { cache: "no-store", headers });
      // Auth failures are TERMINAL — no credential to retry with. Retrying (and the page's self-heal
      // re-arm) would hammer the endpoint forever. Return a non-degraded result so the re-arm never fires.
      if (r.status === 401 || r.status === 403) {
        return { agents: [], hasData: false, unauthorized: true, fetchedAt: Date.now(), prior: {} };
      }
      const j = (await r.json().catch(() => null)) as (Partial<FetchResult> & { degraded?: boolean }) | null;
      if (!r.ok || !j || !Array.isArray(j.agents)) throw new Error("bad /api/reports response");
      // Server flags a Supabase read failure as degraded (200 body, no everLive) → treat as transient.
      if (j.degraded) throw new Error("degraded /api/reports response");
      const result: FetchResult = {
        agents: j.agents as AgentData[],
        hasData: Boolean(j.hasData),
        everLive: typeof j.everLive === "boolean" ? j.everLive : undefined,
        fetchedAt: typeof j.fetchedAt === "number" ? j.fetchedAt : Date.now(),
        prior: (j.prior as Record<string, Basis>) ?? {},
        start: j.start,
        end: j.end,
        timezone: j.timezone ?? null,
        namedAppointments: Array.isArray(j.namedAppointments) ? (j.namedAppointments as NamedAppt[]) : undefined,
        warmLeads: Array.isArray(j.warmLeads) ? (j.warmLeads as WarmLeadItem[]) : undefined,
      };
      CACHE.set(cacheKey, result); // cache ONLY a clean response
      return result;
    } catch {
      // back off then retry; ~0.4s, ~0.8s between attempts
      if (attempt < MAX_ATTEMPTS - 1) await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
    }
  }

  // All attempts failed/degraded → return a degraded result WITHOUT caching, so the next view or refresh
  // re-hits the server. degraded:true keeps the UI in the "syncing" state instead of the "coming soon"
  // gate or fake zeros.
  return { agents: [], hasData: false, degraded: true, fetchedAt: Date.now(), prior: {} };
}

/* Coming-soon metrics derived from ClickHouse and stored in Supabase by scripts/push_metrics.py — read
 * from GET /api/reports/metrics (rooftop-level, separate from the Q12227 aggregate fetchAgents reads).
 * Only the fields the UI renders are typed. Returns null when no rooftop / on any error → the widgets
 * stay on their "coming soon" placeholder, so a missing push never breaks the report. */
export interface TransferQualityMetric {
  service_type: string | null; // "sales" | "service"
  transfers_ok: number;
  transfers_failed: number;
  forwarded: number;
  success_rate: number | null;
}
export interface ReportMetrics {
  transfer_quality: TransferQualityMetric[];
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
      transfer_quality: Array.isArray(j.transfer_quality) ? j.transfer_quality : [],
      calls_by_reason: Array.isArray(j.calls_by_reason) ? j.calls_by_reason : [],
      missed: Array.isArray(j.missed) ? j.missed : [],
      highlights: Array.isArray(j.highlights) ? j.highlights : [],
    };
  } catch {
    return null;
  }
}

/* ── Action items (dealer_leads.actionItems via /api/action-items) ─────────────────────────────────
 * Two shapes: the working LIST (scope=open/overdue) and the rooftop STATS scoreboard (scope=stats:
 * created/closed in-window + open/overdue/due-today now + who-closed-most). Both auth-required — forward
 * the host Spyne token in prod (omitted locally → server env / dev bypass). Return null / [] on error. */
export interface ActionItem {
  id: string;
  intent: string;
  leadId: string | null;
  assignedTo: string | null;
  description: string;
  priority: string;
  completed: boolean;
  dept: "sales" | "service" | "other";
  customer: string | null;
  phone: string | null;
  dueAt: string;
  at: string;
}
export interface ActionItemStats { created: number; completed: number; open: number; overdue: number; dueToday: number }
export interface ActionItemCloser { assignedTo: string; closed: number }

export async function fetchActionItemStats(
  teamId: string,
  opts: { start?: string; end?: string; service?: "sales" | "service" | "both"; spyneToken?: string } = {},
): Promise<{ stats: ActionItemStats; closers: ActionItemCloser[] } | null> {
  if (!teamId) return null;
  const query: Record<string, string> = { team_id: teamId, scope: "stats", serviceType: opts.service ?? "both" };
  if (opts.start && opts.end) { query.start = opts.start; query.end = opts.end; }
  try {
    const headers = opts.spyneToken ? { Authorization: `Bearer ${opts.spyneToken}` } : undefined;
    const r = await fetch(`/api/action-items?${new URLSearchParams(query)}`, { cache: "no-store", headers });
    if (!r.ok) return null;
    const j = (await r.json().catch(() => null)) as { stats?: ActionItemStats; closers?: ActionItemCloser[] } | null;
    if (!j || !j.stats) return null;
    return { stats: j.stats, closers: Array.isArray(j.closers) ? j.closers : [] };
  } catch {
    return null;
  }
}

export async function fetchActionItems(
  teamId: string,
  opts: { scope?: "open" | "overdue" | "recent"; service?: "sales" | "service" | "both"; limit?: number; spyneToken?: string } = {},
): Promise<ActionItem[]> {
  if (!teamId) return [];
  const query: Record<string, string> = {
    team_id: teamId,
    scope: opts.scope ?? "open",
    serviceType: opts.service ?? "both",
    limit: String(opts.limit ?? 100),
  };
  try {
    const headers = opts.spyneToken ? { Authorization: `Bearer ${opts.spyneToken}` } : undefined;
    const r = await fetch(`/api/action-items?${new URLSearchParams(query)}`, { cache: "no-store", headers });
    const j = (await r.json().catch(() => null)) as { actionItems?: ActionItem[] } | null;
    if (!r.ok || !j || !Array.isArray(j.actionItems)) return [];
    return j.actionItems;
  } catch {
    return [];
  }
}

/* ── Customers / lead book (dealer_leads.leads via /api/customers) ── */
export interface Customer {
  leadId: string | null;
  customer: string;
  phone: string | null;
  source: string;
  status: string;
  statusBucket: "active" | "sold" | "lost" | "service" | "other";
  sold: boolean;
  crmLeadId: string | null;
  lastActivity: string;
}
export async function fetchCustomers(
  teamId: string,
  opts: { bucket?: "active" | "sold" | "lost" | "service" | "all"; q?: string; limit?: number; spyneToken?: string } = {},
): Promise<Customer[]> {
  if (!teamId) return [];
  const query: Record<string, string> = { team_id: teamId, bucket: opts.bucket ?? "all", limit: String(opts.limit ?? 100) };
  if (opts.q) query.q = opts.q;
  try {
    const headers = opts.spyneToken ? { Authorization: `Bearer ${opts.spyneToken}` } : undefined;
    const r = await fetch(`/api/customers?${new URLSearchParams(query)}`, { cache: "no-store", headers });
    const j = (await r.json().catch(() => null)) as { customers?: Customer[] } | null;
    if (!r.ok || !j || !Array.isArray(j.customers)) return [];
    return j.customers;
  } catch {
    return [];
  }
}

/* ── Recent conversations (dealer_leads.endcallreports / smsMessages via /api/conversations) ── */
export interface Conversation {
  id: string;
  leadId: string | null;
  callId?: string | null;
  phone: string | null;
  customer: string | null;
  email?: string | null;
  channel: "call" | "sms";
  dept: "sales" | "service" | "other";
  agent?: string | null; // AI agent name (calls)
  direction: "inbound" | "outbound";
  title: string; // the call's intent/title
  summary: string;
  vehicle?: string | null; // vehicle of interest (from report_sales.vehicleRequested)
  durationSec?: number; // call length in seconds
  recordingUrl?: string | null; // call recording (calls)
  score?: number; // AI score out of 10 (report_aiScore_totalScore)
  sentiment?: string; // "Neutral" | "Negative" (derived from frustration)
  outcome?: string; // "Resolved" | "Not Resolved" (derived from query resolution)
  appointmentScheduled: boolean;
  queryResolved: boolean;
  hasActionItem: boolean;
  aiScore?: number | null; // AI-quality scorePercentage (0-100), when present
  grade?: string | null;
  frustrated?: boolean;
  msgs?: number;
  // SMS-thread rows only: the message bubbles (oldest→newest), for the preview drawer.
  sms?: { authorType: string; body: string; status: string; at: string; direction: string }[];
  at: string;
}
export async function fetchConversations(
  teamId: string,
  opts: { channel?: "call" | "sms" | "both"; service?: "sales" | "service" | "both"; since?: string; leadId?: string; limit?: number; spyneToken?: string } = {},
): Promise<Conversation[]> {
  if (!teamId) return [];
  const query: Record<string, string> = {
    team_id: teamId,
    channel: opts.channel ?? "call",
    serviceType: opts.service ?? "both",
    limit: String(opts.limit ?? 100),
  };
  if (opts.since) query.since = opts.since;
  // Lead-scoped drill-down: fetch this lead's full recent history (server ignores the time window).
  if (opts.leadId) query.leadId = opts.leadId;
  try {
    const headers = opts.spyneToken ? { Authorization: `Bearer ${opts.spyneToken}` } : undefined;
    const r = await fetch(`/api/conversations?${new URLSearchParams(query)}`, { cache: "no-store", headers });
    const j = (await r.json().catch(() => null)) as { conversations?: Conversation[] } | null;
    if (!r.ok || !j || !Array.isArray(j.conversations)) return [];
    return j.conversations;
  } catch {
    return [];
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
