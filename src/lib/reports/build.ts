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
import type { AgentDailyRow, BreakdownRow, AppointmentRow, CallbackRow, CampaignRow, OutcomeRow, OpenFunnelRow, RecoverableRow } from "./schema";

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
  // rooftop-level detail (from the dedicated cards); attached to the relevant agents below.
  appointments?: AppointmentRow[];
  callbacks?: CallbackRow[];
  campaigns?: CampaignRow[];
  // Outbound disposition mix (from card 12231 via report_outcomes); attached to the matching outbound
  // agent. Replaces the dead Q12227 `outbound_outcome` path (that column never existed in Q12227).
  outcomes?: OutcomeRow[];
  // Sales-IB open funnel (card 12341 via report_open_funnel) → the STL card's "leads handled →
  // appointments booked" split (speed-to-lead vs follow-up). Attached to sales_ib only.
  openFunnel?: OpenFunnelRow[];
  // Recoverable inbound leads by bucket (card 12236 via report_money_on_table) → the Overview's
  // "Money on the table" card. Attached per inbound agent_type; the Overview sums across agents.
  recoverable?: RecoverableRow[];
  // Slot ids the dealer has actually onboarded (from the Spyne onboarded-agents API). When provided,
  // the report is GATED to these slots — agents the dealer hasn't paid for are dropped (personas kept
  // as-is). null/undefined → don't gate (show all four), the previous behavior.
  onboardedSlots?: Set<AgentData["id"]> | null;
  // EXACT window-distinct lead counts per agent_type (from report_lead_counts). When present, used for
  // "Leads dialed" (= unique leads contacted) + distinct appointments instead of summing per-day
  // distincts (which over-counts cross-day leads). undefined → fall back to the daily sum.
  leadCounts?: LeadCounts;
  priorLeadCounts?: LeadCounts;
  // Window-distinct "Leads by source" per agent_type (from report_source_counts → COUNT(DISTINCT
  // lead_id) per source). When present, REPLACES the per-day breakdown rollup, which sums per-day
  // distincts and so over-counts any lead touched on multiple days. undefined → fall back to breakdown.
  sourceCounts?: Record<string, { source: string; total: number; interacted: number; booked: number }[]>;
}

// Per-agent_type window-distinct lead counts (keyed by agent_type label, e.g. "Sales Outbound").
export type LeadCounts = Record<string, { contacted: number; dialed: number; connected: number; qualified: number; apptLeads: number }>;

// Format an ISO timestamp as a short, locale-stable "when" label (e.g. "Jun 11 · 9:30 AM" UTC).
function fmtWhen(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  let h = d.getUTCHours();
  const m = d.getUTCMinutes().toString().padStart(2, "0");
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${mon} ${d.getUTCDate()} · ${h}:${m} ${ap}`;
}

// The card sends `vehicle` as a JSON-encoded array of VIN/identifier strings — "[]" when empty,
// '["1N4BL...","..."]' when populated. Parse it to a clean comma-joined label; "" → UI "Vehicle TBD".
function fmtVehicle(raw: string | null | undefined): string {
  if (!raw) return "";
  const s = raw.trim();
  if (s === "" || s === "[]") return "";
  try {
    const arr = JSON.parse(s);
    if (Array.isArray(arr)) return arr.map((v) => String(v).trim()).filter(Boolean).join(", ");
  } catch {
    /* not JSON — fall through and show the raw value */
  }
  return s;
}

export function buildResult({ daily, breakdown, priorDaily, appointments, callbacks, campaigns, outcomes, openFunnel, recoverable, onboardedSlots, leadCounts, priorLeadCounts, sourceCounts }: BuildInput): FetchResult {
  const hasData = daily.length > 0;

  // Rooftop-level detail mapped once into the UI shapes. Appointments/callbacks attach to inbound
  // agents, campaigns to outbound — the cards aren't split by agent, so each relevant agent shows
  // the rooftop's list.
  const apptItems = (appointments ?? []).map((a) => ({
    customer: a.customer_name ?? "—", when: fmtWhen(a.appointment_time),
    vehicle: fmtVehicle(a.vehicle), status: a.status ?? "",
  }));
  // Keep service_type so each agent shows only its department's callbacks (sales agents → sales leads,
  // service → service) — a service-heavy rooftop's callbacks must not leak onto the Sales cards.
  const callbackItems = (callbacks ?? []).map((c) => ({
    serviceType: (c.service_type ?? "").toLowerCase(),
    customer: c.customer_name ?? "—", due: fmtWhen(c.callback_due), intent: c.intent ?? "", priority: c.priority ?? "",
  }));
  const campaignItems = (campaigns ?? []).map((c) => ({
    agentType: c.agent_type, name: c.campaign, useCase: c.use_case ?? "", enrolled: c.enrolled, appts: c.appointments,
    apptRate: c.appt_rate_pct ?? 0, warmLeads: c.warm_leads, optOuts: c.opt_outs, noReach: c.no_reach,
  }));
  // Outbound disposition slices — strip the numeric sort-prefix ("1 No reach" → "No reach") for display.
  const outcomeItems = (outcomes ?? []).map((o) => ({
    agentType: o.agent_type, label: o.outcome_bucket.replace(/^\d+\s+/, ""), value: o.mappings,
  }));
  // Recoverable leads by bucket — strip the letter sort-prefix ("A. Warm…" → "Warm…") for display.
  const recoverableItems = (recoverable ?? []).map((r) => ({
    agentType: r.agent_type ?? "", bucket: r.recoverable_bucket,
    label: r.recoverable_bucket.replace(/^[A-Za-z]\.\s*/, ""), leads: r.recoverable_leads,
  }));

  // prior-window per-agent basis (drives report.deltas + fleet deltas)
  const prior: Record<string, Basis> = {};
  for (const base of MOCK_AGENTS) {
    const type = AGENT_TYPE_BY_ID[base.id];
    const pr = priorDaily.filter((r) => r.agent_type === type);
    const plc = priorLeadCounts?.[type];
    prior[base.id] = {
      calls: sum(pr, (r) => r.calls),
      // unique-lead basis when available (matches the displayed conversations/qualified), else daily sum
      conversations: plc ? plc.connected : sum(pr, (r) => r.connected),
      qualified: plc ? plc.qualified : sum(pr, (r) => r.qualified),
      appointments: plc ? plc.apptLeads : sum(pr, (r) => r.appointments),
      leads: plc ? plc.contacted : sum(pr, (r) => r.leads_attempted),
      sms: sum(pr, (r) => r.sms_sent),
    };
  }

  // Which slots to render: the onboarded ones (when the dealer's list is known) UNION any agent_type
  // that actually has activity rows in this window. Activity is ground truth — an agent running live
  // but missing from the onboarded list (or that list being unavailable) must never be silently
  // dropped. null onboardedSlots → show all four (previous behavior). Personas are NOT changed.
  const activeTypes = new Set(daily.map((r) => r.agent_type));
  const slots = MOCK_AGENTS.filter(
    (base) => (onboardedSlots ? onboardedSlots.has(base.id) : true) || activeTypes.has(AGENT_TYPE_BY_ID[base.id]),
  );

  const agents = slots.map((base): AgentData => {
    const type = AGENT_TYPE_BY_ID[base.id];
    const rows = daily.filter((r) => r.agent_type === type).sort((a, b) => a.activity_day.localeCompare(b.activity_day));
    const bd = breakdown.filter((r) => r.agent_type === type);
    const a: AgentData = structuredClone(base);
    // NOTE: we do NOT early-return mock when rows is empty. An agent with no activity in the
    // selected window must read as ZERO on a live rooftop — returning mock here let fabricated
    // volume leak into the fleet roll-up and "Value created" (e.g. a 1-day window showing more
    // appointments than a 7-day one). The overlay below produces zeros from the empty sums; the
    // residual mock visuals are cleared at the end of the loop.

    const inbound = base.dir === "Inbound";
    const lc = leadCounts?.[type]; // exact window-distinct counts for this agent_type (if available)
    const calls = sum(rows, (r) => r.calls);
    const connected = sum(rows, (r) => r.connected);
    const qualified = sum(rows, (r) => r.qualified);
    // distinct booked leads over the window (exact); fall back to the per-day-distinct sum (overcounts)
    const appointments = lc ? lc.apptLeads : sum(rows, (r) => r.appointments);
    const smsSent = sum(rows, (r) => r.sms_sent);
    const smsThreads = sum(rows, (r) => r.sms_threads);
    const afterHours = sum(rows, (r) => r.after_hours);
    const talkSeconds = sum(rows, (r) => r.talk_seconds);
    const transfers = sum(rows, (r) => r.transfers);
    const callbacks = sum(rows, (r) => r.callbacks);
    const queryResolved = sum(rows, (r) => r.query_resolved);
    const optOuts = sum(rows, (r) => r.opt_outs);
    // "Leads dialed/attempted" = unique leads CONTACTED over the window (distinct lead_id, any touch).
    // The daily sum double-counts a lead touched on multiple days; window-distinct fixes that.
    const leadsAttempted = lc ? lc.contacted : sum(rows, (r) => r.leads_attempted);
    const connectRate = calls ? Math.round((connected / calls) * 100) : 0;
    const aht = connected ? talkSeconds / connected : 0;
    // Unique-lead funnel stages (distinct leads over the window). Falls back to event counts when the
    // lead-day counts are unavailable so the funnel still renders. contacted ≥ connected ≥ qualified ≥ appt.
    const leadConnected = lc ? lc.connected : connected;
    const leadQualified = lc ? lc.qualified : qualified;

    // ── metrics: live-backed fields only, real 0 stays 0. Fields with NO Q12227 source
    //    (showed/deals/revenue/cost) are zeroed — never fabricated — and surfaced as "coming soon"
    //    in the UI rather than carrying mock values. ──
    a.metrics = {
      ...a.metrics,
      calls,
      conversations: connected,
      connectRate,
      qualified,
      appointments,
      showed: 0,
      deals: 0,
      revenue: 0,
      cost: 0,
      afterHours,
      talkMinutes: Math.round(talkSeconds / 60),
      smsSent,
      optOuts,
    };

    // ── unique-lead funnel (distinct leads at each stage) → fleet + per-agent "Outreach → conversation
    //    → qualified → appointment" funnels. Every stage is window-distinct, so no lead is counted twice. ──
    a.leadFunnel = { contacted: leadsAttempted, connected: leadConnected, qualified: leadQualified, appt: appointments };

    // ── quality: only the live-backed bits. csat/sentiment have no Q12227 column → zeroed (the UI
    //    hides them); handleTime is "—" when there's no talk time, never a mock value. ──
    a.quality = {
      ...a.quality,
      primary: connectRate,
      handleTime: aht ? fmtHandle(aht) : "—",
      csat: 0,
      sentiment: 0,
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
      // conversion rates on a consistent unique-lead basis (appt-leads / qualified-leads / connected-leads)
      abr: leadQualified ? Math.round((appointments / leadQualified) * 100) : 0,
      qualifiedPct: leadConnected ? Math.round((leadQualified / leadConnected) * 100) : 0,
      callFlow: {
        total: calls,
        answered: connected,
        missed: Math.max(0, calls - connected),
        transferred: transfers,
        callbacks,
        lost: Math.max(0, connected - qualified),
        handledByAI: queryResolved,
      },
      dayOnDay: rows.map((r) => ({ day: shortDay(r.activity_day), touched: r.calls, qualified: r.qualified, appts: r.appointments })),
      intent: intents.length
        ? intents.slice(0, 8).map((r, i) => ({ label: r.value, value: r.count, color: COLORS[i % COLORS.length] }))
        : [],
      queries: intents.length
        ? intents.slice(0, 8).map((r) => ({ label: r.value, total: r.count, resolved: r.qualified }))
        : [],
      multiDayReply: replies.length
        ? REPLY_ORDER.filter((o) => replies.some((r) => r.value === o)).map((o) => {
            const r = replies.find((x) => x.value === o)!;
            return { day: REPLY_LABEL[o], pct: r.count ? Math.round((100 * r.qualified) / r.count) : 0 };
          })
        : [],
      summary: {
        ...a.report.summary,
        conversations: connected,
        apptsBooked: appointments,
        bookingRate: leadQualified ? Math.round((appointments / leadQualified) * 100) : 0,
      },
    };

    // ── outbound disposition mix → "Outbound outcomes" widget. Sourced from card 12231
    //    (report_outcomes), attached in the cumulative-detail block below (it's rooftop-wide, not
    //    window-scoped, so it must survive the quiet-agent zeroing — like campaigns). ──

    // ── inbound-only: leads by source + speed to lead. Always assigned from live data (or cleared) —
    //    never left as the cloned mock when there's nothing live to show. ──
    // "Leads by source": prefer the window-distinct RPC (sourceCounts: COUNT(DISTINCT lead_id) per
    // source — exact). Fall back to the per-day breakdown rollup (lead-days; over-counts cross-day leads)
    // only when the RPC is unavailable. Both map onto Total leads / Interacted (two-way) / Booked.
    const srcRows = sourceCounts?.[type];
    a.report.leadsBySource = !inbound
      ? undefined
      : srcRows && srcRows.length
        ? srcRows.slice(0, 8).map((s) => ({ source: s.source, interacted: s.interacted, engaged: s.interacted, total: s.total, handoffs: 0, appts: s.booked }))
        : sources.length
          ? sources.slice(0, 8).map((r) => ({ source: r.value, interacted: r.qualified, engaged: r.qualified, total: r.count, handoffs: 0, appts: r.appts }))
          : undefined;
    // Speed-to-lead is a SALES INBOUND concept only — service inbound has no new-CRM-lead funnel,
    // so it never shows the card (base.id gate, not just `inbound`).
    if (base.id === "sales_ib") {
      const newLeads = sum(rows, (r) => r.new_leads);
      const within5 = sum(rows, (r) => r.stl_within5);
      const within1 = sum(rows, (r) => r.stl_within1);
      const stlSec = sum(rows, (r) => r.stl_seconds_sum);
      const stlCnt = sum(rows, (r) => r.stl_count);
      const afterHoursInstant = sum(rows, (r) => r.stl_afterhours_within5);
      const instantAppts = sum(rows, (r) => r.stl_within5_appts);
      a.report.speedToLead = (newLeads || stlCnt)
        ? {
            avg: stlCnt ? fmtHandle(stlSec / stlCnt) : "—",
            pctWithin5: newLeads ? Math.round((100 * within5) / newLeads) : 0,
            crmLeadsNew: newLeads,
            instantlyTouched: within5,
            afterHoursInstant,
            instantAppts,
            instantApptRate: within5 ? Math.round((100 * instantAppts) / within5) : 0,
            // median first-response ≤ 1 min ⇔ at least half of measured leads were touched within 1 min.
            // false (slow, or no measurable leads) → the UI pitches the STL upsell instead of the card.
            medianUnderMin: stlCnt > 0 && within1 * 2 >= stlCnt,
            missedCalledBack: 0, // no Q12227 source
            pctTouched: 0,
            note: "",
          }
        : undefined;
      // Open-funnel split (card 12341 → report_open_funnel): appts booked / leads handled by acquisition
      // path. All-time (12341 isn't windowed yet), attached onto the windowed STL card. Sales IB only.
      const ofRow = openFunnel?.find((o) => o.agent_type === type);
      if (ofRow && a.report.speedToLead) {
        a.report.speedToLead.openFunnel = {
          stlLeadsHandled: ofRow.stl_leads_handled,
          stlAppts: ofRow.stl_appointments_booked,
          stlRate: Math.round((ofRow.stl_handled_to_booked_rate || 0) * 100),
          followupLeadsHandled: ofRow.followup_leads_handled,
          followupAppts: ofRow.followup_appointments_booked,
          followupRate: Math.round((ofRow.followup_handled_to_booked_rate || 0) * 100),
        };
      }
    } else {
      a.report.speedToLead = undefined;
    }

    // ── real period-over-period deltas vs prior window ──
    const pb = prior[base.id];
    if (pb) {
      const abrPrev = pb.qualified ? Math.round((pb.appointments / pb.qualified) * 100) : 0;
      a.report.deltas = {
        leadsAttempted: pctDelta(leadsAttempted, pb.leads),
        // unique-lead basis (matches the funnel's qualified stage), not the qualified-events flag-sum
        leadsQualified: pctDelta(leadQualified, pb.qualified),
        appointments: pctDelta(appointments, pb.appointments),
        totalCalls: pctDelta(calls, pb.calls),
        totalSms: pctDelta(smsSent, pb.sms),
        abr: pctDelta(a.report.abr, abrPrev),
      };
    }

    // No activity in this window → strip the mock visuals that fall back when there are no rows,
    // so the agent reads as a genuine zero (metrics/report counts are already 0 from empty sums).
    if (!rows.length) {
      a.trend7 = a.trend7.map(() => 0);
      a.hourly = a.hourly.map(() => 0);
      a.channelSplit = { voice: 0, sms: 0 };
      a.report = { ...a.report, intent: [], queries: [], multiDayReply: [], leadsBySource: undefined, speedToLead: undefined, outcomes: undefined };
    }

    // Rooftop-level detail. Appointments + callbacks are rooftop-wide → show on EVERY agent card.
    // Campaigns are tagged by agent_type → only the matching outbound agent shows them.
    // Attached after the zeroing above so it survives for quiet agents.
    a.report.upcomingAppointments = apptItems.length ? apptItems : undefined;
    // Callbacks scoped to the agent's DEPARTMENT (sales agents → sales leads' callbacks, service →
    // service) so a service-heavy rooftop's follow-ups don't leak onto the Sales cards. Rows with an
    // unknown/blank service_type fall back to showing (better than hiding a real callback).
    const dept = base.dept === "Service" ? "service" : "sales";
    const myCallbacks = callbackItems.filter((c) => !c.serviceType || c.serviceType === dept);
    a.report.followUps = myCallbacks.length
      ? myCallbacks.map((c) => ({ customer: c.customer, due: c.due, intent: c.intent, priority: c.priority }))
      : undefined;
    // Money on the table (card 12236): recoverable leads by bucket for this agent's inbound type.
    // Summed across agents on the Overview; outbound agents match no rows → undefined.
    const mineRec = recoverableItems.filter((r) => r.agentType === type);
    a.report.moneyOnTable = mineRec.length
      ? mineRec.map((r) => ({ bucket: r.bucket, label: r.label, leads: r.leads })).sort((x, y) => x.bucket.localeCompare(y.bucket))
      : undefined;
    if (!inbound) {
      const mine = campaignItems.filter((c) => c.agentType === type);
      a.report.activeCampaigns = mine.length
        ? mine.map((c) => ({ name: c.name, useCase: c.useCase, enrolled: c.enrolled, appts: c.appts, apptRate: c.apptRate, warmLeads: c.warmLeads, optOuts: c.optOuts, noReach: c.noReach }))
        : undefined;
      // Disposition mix, biggest slice first (the widget computes its own percentages from value).
      const mineOutcomes = outcomeItems.filter((o) => o.agentType === type);
      a.report.outcomes = mineOutcomes.length
        ? [...mineOutcomes].sort((x, y) => y.value - x.value).slice(0, 8).map((o) => ({ label: o.label, value: o.value }))
        : undefined;
    }

    return a;
  });

  return { agents, hasData, fetchedAt: Date.now(), prior };
}
