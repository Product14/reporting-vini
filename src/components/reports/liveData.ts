/* Live data layer — fetches the materialized report for a team + window in ONE request to
 * /api/reports (which reads the Supabase aggregate the sync maintains) and returns it as the
 * AgentData[] the reporting UI already consumes. Replaces the old ~84 Metabase card round-trips.
 * Used by /reports (Overview) and /reports/agents (By agent) — no component/JSX changes. */

import { type AgentData, type Bucket } from "./data";
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
 * when none is known). `end` is exclusive and equals today's date, so each window's latest included day
 * is yesterday (the freshest complete day; the sync lags real-time by ~a day). Widths match the
 * original fixed windows: Today = the latest complete day, Yesterday the one before, last7/14/30
 * trailing N-day windows, Lifetime all history. */
export function rangeFor(bucket: Bucket, timeZone?: string): { start: string; end: string } {
  const end = todayIn(timeZone); // exclusive upper bound, store-local
  switch (bucket) {
    case "today": return { start: shiftDays(end, -1), end };
    case "yesterday": return { start: shiftDays(end, -2), end: shiftDays(end, -1) };
    case "last7": return { start: shiftDays(end, -7), end };
    case "last14": return { start: shiftDays(end, -14), end };
    case "last30": return { start: shiftDays(end, -30), end };
    case "lifetime": return { start: "2020-01-01", end };
    default: return { start: shiftDays(end, -30), end };
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

const pctDelta = (curr: number, prev: number): number => (prev ? Math.round(((curr - prev) / prev) * 100) : 0);

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
  qualified: number;
  appointments: number;
  leads: number;
  sms: number;
}

export interface FetchResult {
  agents: AgentData[];
  hasData: boolean;
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
  connectRate: number;
  deltas: { appointments: number; calls: number; qualified: number; sms: number };
  funnel: { label: string; value: number }[];
}

export function aggregateFleet(agents: AgentData[], prior?: Record<string, Basis>): FleetLive {
  const sum = (f: (a: AgentData) => number) => agents.reduce((s, a) => s + f(a), 0);
  const calls = sum((a) => a.metrics.calls);
  const conversations = sum((a) => a.metrics.conversations);
  const qualified = sum((a) => a.metrics.qualified);
  const appointments = sum((a) => a.metrics.appointments);
  const smsSent = sum((a) => a.metrics.smsSent);
  const afterHours = sum((a) => a.metrics.afterHours);
  const talkMinutes = sum((a) => a.metrics.talkMinutes);
  const optOuts = sum((a) => a.metrics.optOuts);
  // call-weighted quality so a low-volume agent can't swing the fleet number
  const wAvg = (f: (a: AgentData) => number) => (calls ? agents.reduce((s, a) => s + f(a) * a.metrics.calls, 0) / calls : 0);
  const pSum = (f: (b: Basis) => number) => agents.reduce((s, a) => s + (prior?.[a.id] ? f(prior[a.id]) : 0), 0);
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
    connectRate: calls ? Math.round((conversations / calls) * 100) : 0,
    deltas: {
      appointments: pctDelta(appointments, pSum((b) => b.appointments)),
      calls: pctDelta(calls, pSum((b) => b.calls)),
      qualified: pctDelta(qualified, pSum((b) => b.qualified)),
      sms: pctDelta(smsSent, pSum((b) => b.sms)),
    },
    funnel: [
      { label: "Outreach & calls", value: calls + smsSent },
      { label: "Conversations", value: conversations },
      { label: "Qualified / engaged", value: qualified },
      { label: "Appointments set", value: appointments },
    ],
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
