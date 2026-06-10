/* Live data layer — rebuilds the AGENTS[] the reporting UI already consumes, but with real
 * numbers pulled from the 20 Metabase cards (via /api/metabase/data). It OVERLAYS live values
 * onto the existing mock AgentData so the UI renders byte-for-byte the same; fields with no
 * backing card (revenue/cost/deals/showed, the human-baseline story, period deltas) keep their
 * mock values. Used by /reports (Overview) and /reports/agents — no component/JSX changes. */

import { AGENTS as MOCK_AGENTS, type AgentData, type Bucket } from "./data";
import { type Account } from "./accounts";

const AGENT_TYPE_BY_ID: Record<AgentData["id"], string> = {
  sales_ib: "Sales Inbound",
  sales_ob: "Sales Outbound",
  service_ib: "Service Inbound",
  service_ob: "Service Outbound",
};

// Reverse of AGENT_TYPE_BY_ID — maps the CSM sheet's agent-type labels to this report's agent ids.
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
};
export function rangeFor(bucket: Bucket): { start: string; end: string } {
  return RANGES[bucket] ?? RANGES.last30;
}

// The equal-length window immediately before [start, end) — used to compute real period deltas.
function priorWindow(start: string, end: string): { start: string; end: string } {
  const s = new Date(`${start}T00:00:00Z`);
  const e = new Date(`${end}T00:00:00Z`);
  const days = Math.max(1, Math.round((e.getTime() - s.getTime()) / 86_400_000));
  const ps = new Date(s);
  ps.setUTCDate(ps.getUTCDate() - days);
  return { start: ps.toISOString().slice(0, 10), end: start }; // prior end = current start (exclusive)
}
const pctDelta = (curr: number, prev: number): number => (prev ? Math.round(((curr - prev) / prev) * 100) : 0);

type Row = Record<string, unknown>;
const n = (v: unknown, fallback = 0): number => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
};
const first = (rows: Row[]): Row => rows[0] ?? {};
const COLORS = ["#6366f1", "#813fed", "#10b981", "#f59e0b", "#0ea5e9", "#94a3b8", "#ef4444", "#14b8a6"];

async function fetchCard(question: number, params: Record<string, string>): Promise<Row[]> {
  try {
    const qs = new URLSearchParams({ question: String(question), ...params });
    const r = await fetch(`/api/metabase/data?${qs.toString()}`, { cache: "no-store" });
    if (!r.ok) return [];
    const d = (await r.json().catch(() => ({}))) as { rows?: Row[] };
    return Array.isArray(d.rows) ? d.rows : [];
  } catch {
    return [];
  }
}

function fmtHandle(sec: number): string {
  if (!sec) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m ? `${m}m ${s.toString().padStart(2, "0")}s` : `${s}s`;
}
function shortDay(d: unknown): string {
  const s = String(d ?? "");
  const m = s.match(/\d{4}-(\d{2})-(\d{2})/);
  return m ? `${Number(m[2])}/${Number(m[1])}` : s.slice(0, 6);
}

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

/* Per-agent totals for one window — the lightweight basis for period deltas (bottom-line + funnel
 * only). Uses fetchCard directly (not the hit-counting wrapper) so an empty prior window never
 * affects the current window's hasData. */
async function fetchBasis(team: { team_id: string; start: string; end: string }): Promise<Record<string, Basis>> {
  const smsRows = await fetchCard(12212, team);
  const sms = n(first(smsRows).sms_out);
  const out: Record<string, Basis> = {};
  await Promise.all(
    MOCK_AGENTS.map(async (base) => {
      const ap = { ...team, agent_type: AGENT_TYPE_BY_ID[base.id] };
      const [bottomR, funnelR] = await Promise.all([fetchCard(12193, ap), fetchCard(12197, ap)]);
      const bottom = first(bottomR), funnel = first(funnelR);
      out[base.id] = {
        calls: n(funnel.handled) || n(bottom.conversations),
        qualified: n(funnel.qualified),
        appointments: n(bottom.appointments),
        leads: n(bottom.leads_interacted),
        sms,
      };
    }),
  );
  return out;
}

/* Build the 4 live agents (one per agent_type) for a team + window. Falls back to the matching
 * mock agent for any card that returns nothing, so the report always renders. */
export async function fetchAgents(opts: LiveOpts = {}): Promise<FetchResult> {
  const teamId = opts.teamId || DEFAULT_TEAM_ID;
  const { start, end } = opts.start && opts.end ? { start: opts.start, end: opts.end } : rangeFor(opts.bucket ?? "last30");
  const cacheKey = `${teamId}|${start}|${end}`;
  if (!opts.force) {
    const cached = CACHE.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;
  }
  const team = { team_id: teamId, start, end };
  // Prior equal-length window — fetched concurrently with the current window for real period deltas.
  const prior = priorWindow(start, end);
  const priorBasisP = fetchBasis({ team_id: teamId, start: prior.start, end: prior.end });

  // Wrap every card fetch so we know whether Metabase returned any rows for this team/window.
  let hits = 0;
  const card = async (q: number, p: Record<string, string>): Promise<Row[]> => {
    const rows = await fetchCard(q, p);
    if (rows.length) hits++;
    return rows;
  };

  // team-level cards — fetched once, shared across the 4 agents
  const [channelRows, apptSrcRows, leadsSrcRows, optoutRows, multidayRows] = await Promise.all([
    card(12203, team),
    card(12207, team),
    card(12208, team),
    card(12212, team),
    card(12206, team),
  ]);
  const channel = first(channelRows);
  const optout = first(optoutRows);

  const agents = await Promise.all(
    MOCK_AGENTS.map(async (base): Promise<AgentData> => {
      const ap = { ...team, agent_type: AGENT_TYPE_BY_ID[base.id] };
      const inbound = base.dir === "Inbound";
      const [bottomR, perfR, funnelR, qIntR, nqIntR, resoR, outInR, outOutR, dayR, todR, splitR, speedR, qualR, qscoreR] =
        await Promise.all([
          card(12193, ap), card(12194, ap), card(12197, ap), card(12198, ap), card(12199, ap), card(12200, ap),
          card(12201, ap), card(12202, team), card(12196, ap), card(12205, ap), card(12204, ap), card(12209, ap),
          card(12210, ap), card(12211, ap),
        ]);

      const bottom = first(bottomR), perf = first(perfR), funnel = first(funnelR);
      const split = first(splitR), speed = first(speedR), qual = first(qualR), qscore = first(qscoreR);
      const a: AgentData = structuredClone(base);

      const calls = n(funnel.handled) || n(bottom.conversations) || a.metrics.calls;
      const connected = n(funnel.connected) || a.metrics.conversations;
      const qualified = n(funnel.qualified) || n(perf.qualified_calls) || a.metrics.qualified;
      const appointments = n(bottom.appointments, a.metrics.appointments);

      // ── metrics (money/deals/showed stay mock — no card) ──
      a.metrics = {
        ...a.metrics,
        calls,
        conversations: connected,
        connectRate: n(qual.connect_rate, a.metrics.connectRate),
        qualified,
        appointments,
        afterHours: n(split.after_hours, a.metrics.afterHours),
        talkMinutes: Math.round((n(qual.aht_sec) * connected) / 60) || a.metrics.talkMinutes,
        // team-level SMS card (12212) — shown on the per-agent detail view
        smsSent: optoutRows.length ? n(optout.sms_out) : a.metrics.smsSent,
        optOuts: optoutRows.length ? n(optout.optouts) : a.metrics.optOuts,
      };

      // ── quality ──
      a.quality = {
        ...a.quality,
        primary: n(qual.connect_rate, a.quality.primary),
        handleTime: n(qual.aht_sec) ? fmtHandle(n(qual.aht_sec)) : a.quality.handleTime,
        csat: n(qual.csat_5pt, a.quality.csat),
        sentiment: n(qual.positive_sent_pct, a.quality.sentiment),
      };

      // ── outcomes (top-level donut) ──
      const outRows = inbound ? outInR : outOutR;
      if (outRows.length) {
        a.outcomes = outRows.slice(0, 6).map((r, i) => ({
          label: String(r.outcome ?? "—"),
          value: n(r.calls ?? r.tasks),
          color: COLORS[i % COLORS.length],
        }));
      }

      // ── channel split (team-level) ──
      if (channelRows.length) {
        a.channelSplit = { voice: n(channel.call_only) + n(channel.omni), sms: n(channel.sms_only) + n(channel.omni) };
      }

      // ── hourly 7a–6p (12 buckets) ──
      if (todR.length) {
        const byHour: Record<number, number> = {};
        for (const r of todR) byHour[n(r.hour)] = n(r.calls);
        a.hourly = Array.from({ length: 12 }, (_, i) => byHour[7 + i] ?? 0);
      }

      // ── trend7 = last 7 days of calls ──
      if (dayR.length) a.trend7 = dayR.slice(-7).map((r) => n(r.calls));

      // ── report block ──
      const totalResolved = dayR.reduce((s, r) => s + n(r.resolved), 0) || 1;
      a.report = {
        ...a.report,
        leadsAttempted: n(bottom.leads_interacted, a.report.leadsAttempted),
        abr: qualified ? Math.round((appointments / qualified) * 100) : a.report.abr,
        qualifiedPct: connected ? Math.round((qualified / connected) * 100) : a.report.qualifiedPct,
        callFlow: {
          total: calls,
          answered: connected,
          missed: n(funnel.missed),
          transferred: n(perf.routed_leads),
          lost: n(funnel.not_qualified),
          handledByAI: n(perf.resolved_by_ai),
        },
        dayOnDay: dayR.length
          ? dayR.map((r) => ({
              day: shortDay(r.day),
              touched: n(r.calls),
              qualified: n(r.resolved),
              appts: Math.round((appointments * n(r.resolved)) / totalResolved),
            }))
          : a.report.dayOnDay,
        intent: qIntR.length
          ? qIntR.slice(0, 8).map((r, i) => ({ label: String(r.intent ?? "—"), value: n(r.calls), color: COLORS[i % COLORS.length] }))
          : a.report.intent,
        queries: resoR.length
          ? resoR.slice(0, 8).map((r) => ({ label: String(r.intent ?? "—"), total: n(r.handled), resolved: Math.round((n(r.handled) * n(r.resolution_pct)) / 100) }))
          : a.report.queries,
        multiDayReply: multidayRows.length
          ? multidayRows.slice(0, 7).map((r) => ({ day: `Day ${n(r.day_offset)}`, pct: n(r.sent) ? Math.round((100 * n(r.replied)) / n(r.sent)) : 0 }))
          : a.report.multiDayReply,
        summary: { ...a.report.summary, conversations: connected, apptsBooked: appointments, bookingRate: qualified ? Math.round((appointments / qualified) * 100) : a.report.summary.bookingRate },
      };

      // ── inbound-only blocks ──
      if (inbound && leadsSrcRows.length) {
        a.report.leadsBySource = leadsSrcRows.slice(0, 8).map((r) => ({
          source: String(r.source ?? "—"),
          interacted: n(r.interacted),
          engaged: n(r.interacted),
          total: n(r.total_leads),
          handoffs: 0,
          appts: n(r.qualified),
        }));
      }
      if (inbound && speedR.length) {
        const newLeads = n(speed.new_leads), within5 = n(speed.within_5min), medH = n(speed.median_hours);
        a.report.speedToLead = {
          ...(a.report.speedToLead ?? ({} as NonNullable<AgentData["report"]["speedToLead"]>)),
          avg: medH >= 1 ? `${medH.toFixed(1)}h` : `${Math.round(medH * 60)}m`,
          pctWithin5: newLeads ? Math.round((100 * within5) / newLeads) : 0,
          crmLeadsNew: newLeads,
          instantlyTouched: within5,
          pctTouched: a.report.speedToLead?.pctTouched ?? 0,
        };
      }

      return a;
    }),
  );
  // Real period-over-period deltas: compare each agent's current totals to the prior window.
  const priorBasis = await priorBasisP;
  for (const a of agents) {
    const pb = priorBasis[a.id];
    if (!pb) continue;
    const abrPrev = pb.qualified ? Math.round((pb.appointments / pb.qualified) * 100) : 0;
    a.report = {
      ...a.report,
      deltas: {
        leadsAttempted: pctDelta(a.report.leadsAttempted, pb.leads),
        leadsQualified: pctDelta(a.metrics.qualified, pb.qualified),
        appointments: pctDelta(a.metrics.appointments, pb.appointments),
        totalCalls: pctDelta(a.metrics.calls, pb.calls),
        totalSms: pctDelta(a.metrics.smsSent, pb.sms),
        abr: pctDelta(a.report.abr, abrPrev),
      },
    };
  }

  const result: FetchResult = { agents, hasData: hits > 0, fetchedAt: Date.now(), prior: priorBasis };
  CACHE.set(cacheKey, result);
  return result;
}
