/* Rebuild the AgentData[] the reporting UI consumes from the materialized aggregate (agent_daily +
 * agent_daily_breakdown), summed over a date range. This is the server-side equivalent of
 * liveData.ts `fetchAgents()` — it OVERLAYS live values onto the mock AGENTS so the UI renders the
 * same shape; any field with no backing column (revenue/cost/deals/showed, csat/sentiment, the
 * human-baseline story) keeps its mock value, exactly as the card path does today.
 *
 * Returns a FetchResult so the rewritten client `fetchAgents()` can pass it through unchanged and
 * pages keep calling aggregateFleet(agents, prior). */

import { AGENTS as MOCK_AGENTS, type AgentData } from "@/components/reports/data";
import type { FetchResult, Basis } from "@/components/reports/liveData";
import type { AgentDailyRow, BreakdownRow } from "./schema";

const AGENT_TYPE_BY_ID: Record<AgentData["id"], string> = {
  sales_ib: "Sales Inbound",
  sales_ob: "Sales Outbound",
  service_ib: "Service Inbound",
  service_ob: "Service Outbound",
};
const COLORS = ["#6366f1", "#813fed", "#10b981", "#f59e0b", "#0ea5e9", "#94a3b8", "#ef4444", "#14b8a6"];

const pctDelta = (curr: number, prev: number): number => (prev ? Math.round(((curr - prev) / prev) * 100) : 0);
function fmtHandle(sec: number): string {
  if (!sec) return "—";
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return m ? `${m}m ${s.toString().padStart(2, "0")}s` : `${s}s`;
}
function fmtAvgLatency(sec: number): string {
  if (!sec) return "—";
  return sec >= 60 ? `${(sec / 60).toFixed(1)}m` : `${Math.round(sec)}s`;
}
function shortDay(d: string): string {
  const m = d.match(/\d{4}-(\d{2})-(\d{2})/);
  return m ? `${Number(m[2])}/${Number(m[1])}` : d.slice(0, 6);
}

// Σ a numeric column over a set of daily rows.
const sum = (rows: AgentDailyRow[], f: (r: AgentDailyRow) => number) => rows.reduce((s, r) => s + (f(r) || 0), 0);

// Collapse breakdown rows (already filtered to one agent_type) into value → totals, biggest first.
function rollupDim(rows: BreakdownRow[], dim: BreakdownRow["dim"]): { value: string; count: number; qualified: number; appts: number }[] {
  const m = new Map<string, { value: string; count: number; qualified: number; appts: number }>();
  for (const r of rows) {
    if (r.dim !== dim) continue;
    let e = m.get(r.dim_value);
    if (!e) { e = { value: r.dim_value, count: 0, qualified: 0, appts: 0 }; m.set(r.dim_value, e); }
    e.count += r.count; e.qualified += r.qualified; e.appts += r.appts;
  }
  return Array.from(m.values()).sort((a, b) => b.count - a.count);
}

const REPLY_LABEL: Record<string, string> = { "0": "Same day", "1": "Day 1", "2": "Day 2", "3+": "Day 3+" };
const REPLY_ORDER = ["0", "1", "2", "3+"];

export interface BuildInput {
  daily: AgentDailyRow[]; // current window, this team
  breakdown: BreakdownRow[]; // current window, this team
  priorDaily: AgentDailyRow[]; // prior equal-length window, this team (basis for deltas)
}

export function buildResult({ daily, breakdown, priorDaily }: BuildInput): FetchResult {
  const hasData = daily.length > 0;

  // prior-window per-agent basis (drives report.deltas + fleet deltas)
  const prior: Record<string, Basis> = {};
  for (const base of MOCK_AGENTS) {
    const pr = priorDaily.filter((r) => r.agent_type === AGENT_TYPE_BY_ID[base.id]);
    prior[base.id] = {
      calls: sum(pr, (r) => r.calls),
      qualified: sum(pr, (r) => r.qualified),
      appointments: sum(pr, (r) => r.appointments),
      leads: sum(pr, (r) => r.leads_attempted),
      sms: sum(pr, (r) => r.sms_sent),
    };
  }

  const agents = MOCK_AGENTS.map((base): AgentData => {
    const type = AGENT_TYPE_BY_ID[base.id];
    const rows = daily.filter((r) => r.agent_type === type).sort((a, b) => a.activity_day.localeCompare(b.activity_day));
    const bd = breakdown.filter((r) => r.agent_type === type);
    const a: AgentData = structuredClone(base);
    if (!rows.length) return a; // no live rows → pure mock fallback for this agent

    const inbound = base.dir === "Inbound";
    const calls = sum(rows, (r) => r.calls);
    const connected = sum(rows, (r) => r.connected);
    const qualified = sum(rows, (r) => r.qualified);
    const appointments = sum(rows, (r) => r.appointments);
    const smsSent = sum(rows, (r) => r.sms_sent);
    const smsThreads = sum(rows, (r) => r.sms_threads);
    const afterHours = sum(rows, (r) => r.after_hours);
    const talkSeconds = sum(rows, (r) => r.talk_seconds);
    const transfers = sum(rows, (r) => r.transfers);
    const queryResolved = sum(rows, (r) => r.query_resolved);
    const optOuts = sum(rows, (r) => r.opt_outs);
    const leadsAttempted = sum(rows, (r) => r.leads_attempted);
    const connectRate = calls ? Math.round((connected / calls) * 100) : 0;
    const aht = connected ? talkSeconds / connected : 0;

    // ── no-column outcome fields (showed/deals/revenue/cost) have no Q12227 source. Derive them from
    //    the live funnel via the mock's conversion rates so they scale with live volume and stay
    //    monotonic, instead of leaking raw mock counts — which produced impossible funnels like
    //    showed (28) > appointments (1) when live volume is low. ──
    const showRate = base.metrics.appointments ? base.metrics.showed / base.metrics.appointments : 0;
    const closeRate = base.metrics.showed ? base.metrics.deals / base.metrics.showed : 0;
    const dealValue = base.metrics.deals ? base.metrics.revenue / base.metrics.deals : 0;
    const costPerCall = base.metrics.calls ? base.metrics.cost / base.metrics.calls : 0;
    const showed = Math.round(appointments * showRate);
    const deals = Math.round(showed * closeRate);

    // ── metrics: once an agent has live rows, every field reflects live data — a real 0 stays 0.
    //    No `|| mock` fallback: that previously replaced a true 0 with the mock value, letting mock
    //    numbers exceed live ones (e.g. qualified 96 > calls 82 when live qualified summed to 0). ──
    a.metrics = {
      ...a.metrics,
      calls,
      conversations: connected,
      connectRate,
      qualified,
      appointments,
      showed,
      deals,
      revenue: Math.round(deals * dealValue),
      cost: Math.round(calls * costPerCall),
      afterHours,
      talkMinutes: Math.round(talkSeconds / 60),
      smsSent,
      optOuts,
    };

    // ── quality: primary + handleTime are live; csat/sentiment have no Q12227 column → stay mock ──
    a.quality = {
      ...a.quality,
      primary: connectRate,
      handleTime: aht ? fmtHandle(aht) : a.quality.handleTime,
    };

    // ── channel split (counts: voice calls vs sms threads) ──
    if (calls || smsThreads) a.channelSplit = { voice: calls, sms: smsThreads };

    // ── hourly 7a–6p (12 buckets) from the hour breakdown ──
    const hours = rollupDim(bd, "hour");
    if (hours.length) {
      const byHour: Record<number, number> = {};
      for (const h of hours) byHour[Number(h.value)] = h.count;
      a.hourly = Array.from({ length: 12 }, (_, i) => byHour[7 + i] ?? 0);
    }

    // ── trend7 = last 7 days of calls ──
    if (rows.length) a.trend7 = rows.slice(-7).map((r) => r.calls);

    // ── report block ──
    const intents = rollupDim(bd, "intent");
    const sources = rollupDim(bd, "source");
    const replies = rollupDim(bd, "reply_offset");
    a.report = {
      ...a.report,
      leadsAttempted,
      abr: qualified ? Math.round((appointments / qualified) * 100) : 0,
      qualifiedPct: connected ? Math.round((qualified / connected) * 100) : 0,
      callFlow: {
        total: calls,
        answered: connected,
        missed: Math.max(0, calls - connected),
        transferred: transfers,
        lost: Math.max(0, connected - qualified),
        handledByAI: queryResolved,
      },
      dayOnDay: rows.map((r) => ({ day: shortDay(r.activity_day), touched: r.calls, qualified: r.qualified, appts: r.appointments })),
      intent: intents.length
        ? intents.slice(0, 8).map((r, i) => ({ label: r.value, value: r.count, color: COLORS[i % COLORS.length] }))
        : a.report.intent,
      queries: intents.length
        ? intents.slice(0, 8).map((r) => ({ label: r.value, total: r.count, resolved: r.qualified }))
        : a.report.queries,
      multiDayReply: replies.length
        ? REPLY_ORDER.filter((o) => replies.some((r) => r.value === o)).map((o) => {
            const r = replies.find((x) => x.value === o)!;
            return { day: REPLY_LABEL[o], pct: r.count ? Math.round((100 * r.qualified) / r.count) : 0 };
          })
        : a.report.multiDayReply,
      summary: {
        ...a.report.summary,
        conversations: connected,
        apptsBooked: appointments,
        bookingRate: qualified ? Math.round((appointments / qualified) * 100) : 0,
      },
    };

    // ── inbound-only: leads by source + speed to lead ──
    if (inbound && sources.length) {
      a.report.leadsBySource = sources.slice(0, 8).map((r) => ({
        source: r.value, interacted: r.count, engaged: r.count, total: r.count, handoffs: 0, appts: r.appts,
      }));
    }
    if (inbound) {
      const newLeads = sum(rows, (r) => r.new_leads);
      const within5 = sum(rows, (r) => r.stl_within5);
      const stlSec = sum(rows, (r) => r.stl_seconds_sum);
      const stlCnt = sum(rows, (r) => r.stl_count);
      if (newLeads || stlCnt) {
        a.report.speedToLead = {
          ...(a.report.speedToLead ?? ({} as NonNullable<AgentData["report"]["speedToLead"]>)),
          avg: stlCnt ? fmtAvgLatency(stlSec / stlCnt) : (a.report.speedToLead?.avg ?? "—"),
          pctWithin5: newLeads ? Math.round((100 * within5) / newLeads) : 0,
          crmLeadsNew: newLeads,
          instantlyTouched: within5,
          pctTouched: a.report.speedToLead?.pctTouched ?? 0,
        };
      }
    }

    // ── real period-over-period deltas vs prior window ──
    const pb = prior[base.id];
    if (pb) {
      const abrPrev = pb.qualified ? Math.round((pb.appointments / pb.qualified) * 100) : 0;
      a.report.deltas = {
        leadsAttempted: pctDelta(leadsAttempted, pb.leads),
        leadsQualified: pctDelta(qualified, pb.qualified),
        appointments: pctDelta(appointments, pb.appointments),
        totalCalls: pctDelta(calls, pb.calls),
        totalSms: pctDelta(smsSent, pb.sms),
        abr: pctDelta(a.report.abr, abrPrev),
      };
    }

    return a;
  });

  return { agents, hasData, fetchedAt: Date.now(), prior };
}
