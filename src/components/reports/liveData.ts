/* Live data layer — rebuilds the AGENTS[] the reporting UI already consumes, but with real
 * numbers pulled from the 20 Metabase cards (via /api/metabase/data). It OVERLAYS live values
 * onto the existing mock AgentData so the UI renders byte-for-byte the same; fields with no
 * backing card (revenue/cost/deals/showed, the human-baseline story, period deltas) keep their
 * mock values. Used by /reports (Overview) and /reports/agents — no component/JSX changes. */

import { AGENTS as MOCK_AGENTS, type AgentData, type Bucket } from "./data";
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

/* Date window per the UI's bucket toggle (anchored to the data's latest day, 2026-06-09 exclusive).
 * `end` is exclusive. Each window is a distinct range — Today is the latest day, Yesterday the one
 * before it, and last7/14/30 are trailing windows ending on the latest day. */
const RANGES: Record<Bucket, { start: string; end: string }> = {
  today: { start: "2026-06-08", end: "2026-06-09" },
  yesterday: { start: "2026-06-07", end: "2026-06-08" },
  last7: { start: "2026-06-02", end: "2026-06-09" },
  last14: { start: "2026-05-26", end: "2026-06-09" },
  last30: { start: "2026-05-10", end: "2026-06-09" },
  // "Lifetime" = everything up to the data's latest day; start sits far enough back to capture all history.
  lifetime: { start: "2020-01-01", end: "2026-06-09" },
};
export function rangeFor(bucket: Bucket): { start: string; end: string } {
  return RANGES[bucket] ?? RANGES.last30;
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

// Client-side cache so switching back to a team/window doesn't re-hit Metabase. 5-minute TTL.
const CACHE = new Map<string, FetchResult>();
const CACHE_TTL_MS = 5 * 60 * 1000;

/* Synchronously read a cached window without touching the network — lets the UI paint instantly when
 * you navigate back to a page (stale-while-revalidate: show what we have, then fetchAgents refreshes
 * in the background per the TTL). Returns whatever is cached regardless of age, or null. */
export function peekAgents(opts: LiveOpts = {}): FetchResult | null {
  if (!opts.teamId) return null;
  const { start, end } = opts.start && opts.end ? { start: opts.start, end: opts.end } : rangeFor(opts.bucket ?? "last30");
  return CACHE.get(`${opts.teamId}|${start}|${end}`) ?? null;
}

/* Fetch the materialized report for a team + window in ONE request to /api/reports (which reads the
 * Supabase aggregate the sync maintains). Replaces the previous ~84 Metabase round-trips. Keeps the
 * same FetchResult shape + client cache, so pages and aggregateFleet() are unchanged. On any network
 * error it falls back to mock agents so the report still renders. */
export async function fetchAgents(opts: LiveOpts = {}): Promise<FetchResult> {
  const teamId = opts.teamId || DEFAULT_TEAM_ID;
  const { start, end } = opts.start && opts.end ? { start: opts.start, end: opts.end } : rangeFor(opts.bucket ?? "last30");
  const cacheKey = `${teamId}|${start}|${end}`;
  if (!opts.force) {
    const cached = CACHE.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;
  }

  let result: FetchResult;
  try {
    const qs = new URLSearchParams({ team_id: teamId, start, end });
    const r = await fetch(`/api/reports?${qs.toString()}`, { cache: "no-store" });
    const j = (await r.json().catch(() => null)) as Partial<FetchResult> | null;
    if (!r.ok || !j || !Array.isArray(j.agents)) throw new Error("bad /api/reports response");
    result = {
      agents: j.agents as AgentData[],
      hasData: Boolean(j.hasData),
      fetchedAt: typeof j.fetchedAt === "number" ? j.fetchedAt : Date.now(),
      prior: (j.prior as Record<string, Basis>) ?? {},
    };
  } catch {
    result = { agents: MOCK_AGENTS.map((a) => structuredClone(a)), hasData: false, fetchedAt: Date.now(), prior: {} };
  }

  CACHE.set(cacheKey, result);
  return result;
}
