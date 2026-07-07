/* Rebuild the AgentData[] the reporting UI consumes from the materialized aggregate (agent_daily +
 * agent_daily_breakdown), summed over a date range. This is the server-side equivalent of
 * liveData.ts `fetchAgents()` — it OVERLAYS live values onto the mock AGENTS so the UI renders the
 * same shape; any field with no backing column (revenue/cost/deals/showed, csat/sentiment, the
 * human-baseline story) keeps its mock value, exactly as the card path does today.
 *
 * Returns a FetchResult so the rewritten client `fetchAgents()` can pass it through unchanged and
 * pages keep calling aggregateFleet(agents, prior). */

import { AGENTS as MOCK_AGENTS, type AgentData, type NamedAppt, type WarmLeadItem } from "@/components/reports/data";
import type { FetchResult, Basis } from "@/components/reports/liveData";
import type { AgentDailyRow, BreakdownRow, CallbackRow, CampaignRow, OutcomeRow, ReportAppointmentRow, WarmLeadRow } from "./schema";

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
// transferred/callbacks are intent-dim measures (0 elsewhere; 0 on pre-0017 rows until a --full re-aggregate).
function rollupDim(rows: BreakdownRow[], dim: BreakdownRow["dim"]): { value: string; count: number; qualified: number; appts: number; transferred: number; callbacks: number }[] {
  const m = new Map<string, { value: string; count: number; qualified: number; appts: number; transferred: number; callbacks: number }>();
  for (const r of rows) {
    if (r.dim !== dim) continue;
    let e = m.get(r.dim_value);
    if (!e) { e = { value: r.dim_value, count: 0, qualified: 0, appts: 0, transferred: 0, callbacks: 0 }; m.set(r.dim_value, e); }
    e.count += r.count; e.qualified += r.qualified; e.appts += r.appts;
    e.transferred += r.transferred ?? 0; e.callbacks += r.callbacks ?? 0;
  }
  return Array.from(m.values()).sort((a, b) => b.count - a.count);
}

// Friendly labels for the buying-intent action-item vocab shown on warm-lead chips; anything unmapped
// falls back to a sentence-cased version of the raw value ("purchase intent" → "Purchase intent").
const INTENT_PRETTY: Record<string, string> = {
  ScheduleAppointment: "Asked to book",
  RescheduleAppointment: "Wants to reschedule",
  SALES_SCHEDULE_SHOWROOM_VISIT: "Showroom visit",
  CheckVehicleAvailability: "Vehicle availability",
  CheckVehiclePrice: "Vehicle price",
  InquireFinanceStatus: "Financing",
  SALES_CONNECT_TO_FINANCE: "Financing",
  InquireTradeInValue: "Trade-in value",
  SALES_TRADE_IN_FOLLOW_UP: "Trade-in follow-up",
  ScheduleTestDrive: "Test drive",
  SALES_SCHEDULE_TEST_DRIVE: "Test drive",
  InquireLeaseOptions: "Lease options",
  SALES_FOLLOW_UP_WITH_QUOTE: "Waiting on a quote",
  SERVICE_SCHEDULE_APPOINTMENT: "Service appointment",
  SERVICE_SEND_ESTIMATE: "Service estimate",
};
function prettyInterest(raw: string | null | undefined): string {
  if (!raw) return "";
  const mapped = INTENT_PRETTY[raw];
  if (mapped) return mapped;
  const s = raw.replace(/_/g, " ").trim().toLowerCase();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

const REPLY_LABEL: Record<string, string> = { "0": "Same day", "1": "Day 1", "2": "Day 2", "3+": "Day 3+" };
const REPLY_ORDER = ["0", "1", "2", "3+"];

export interface BuildInput {
  daily: AgentDailyRow[]; // current window, this team
  breakdown: BreakdownRow[]; // current window, this team
  priorDaily: AgentDailyRow[]; // prior equal-length window, this team (basis for deltas)
  // rooftop-level detail (fed from ClickHouse by scripts/backfill.ts); attached to the relevant agents below.
  callbacks?: CallbackRow[];
  campaigns?: CampaignRow[];
  // Outbound disposition mix (from card 12231 via report_outcomes); attached to the matching outbound
  // agent. Replaces the dead Q12227 `outbound_outcome` path (that column never existed in Q12227).
  outcomes?: OutcomeRow[];
  // v3 named lists (report_appointments already window-filtered by the route; report_warm_leads is a
  // "now" snapshot). Scoped per agent below AND returned rooftop-wide on the FetchResult.
  namedAppointments?: ReportAppointmentRow[];
  warmLeads?: WarmLeadRow[];
  // Slot ids the dealer has actually onboarded (from the Spyne onboarded-agents API). When provided,
  // the report is GATED to these slots — agents the dealer hasn't paid for are dropped (personas kept
  // as-is). null/undefined → don't gate (show all four), the previous behavior.
  onboardedSlots?: Set<AgentData["id"]> | null;
  // The dealer's REAL agent name per slot (from the onboarded-agents API), e.g. { service_ob: "Mark" }.
  // Overrides the mock persona (summary.person) so the report shows the name the dealer actually gave
  // the agent instead of a fabricated one. A missing slot / undefined → keep the mock persona.
  onboardedNames?: Partial<Record<AgentData["id"], string>> | null;
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
// canonical: apptLeads = AI-booked (source='spyne', PRIMARY); apptLeadsAssisted = AI-assisted (CRM, SECONDARY).
export type LeadCounts = Record<string, { contacted: number; dialed: number; connected: number; qualified: number; apptLeads: number; apptLeadsAssisted: number; transferLeads: number; transferFailedLeads: number }>;

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

export function buildResult({ daily, breakdown, priorDaily, callbacks, campaigns, outcomes, namedAppointments, warmLeads, onboardedSlots, onboardedNames, leadCounts, priorLeadCounts, sourceCounts }: BuildInput): FetchResult {
  const hasData = daily.length > 0;

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
  // Outbound disposition slices — keep the raw bucket (canonical best→least ordering) and strip the
  // numeric sort-prefix ("1 No reach" → "No reach") for display.
  const outcomeItems = (outcomes ?? []).map((o) => ({
    agentType: o.agent_type, bucket: o.outcome_bucket, label: o.outcome_bucket.replace(/^\d+\s+/, ""), value: o.mappings,
  }));

  // ── v3 named lists (display shapes; PII stays behind the authed API) ──
  // Named appointments: one row per LEAD (reschedules create multiple active meeting records — keep
  // the AI-booked row over an assisted one, then the latest booking). canonical: `assisted` rows are
  // AI-assisted (CRM) — labeled distinctly, never counted into the AI-booked headline.
  const namedApptItems: (NamedAppt & { direction: string })[] = (() => {
    const rows = (namedAppointments ?? [])
      .map((a) => ({
        customer: a.customer_name?.trim() || "—",
        phone: a.phone ?? "",
        channel: (a.assisted ? null : a.direction === "inbound" ? "Inbound" : a.direction === "outbound" ? "Outbound" : null) as NamedAppt["channel"],
        how: a.assisted ? "AI-assisted → CRM" : a.booked_via === "sms" ? "AI-booked, via SMS" : "AI-booked, on call",
        vehicle: fmtVehicle(a.vehicle),
        when: a.meeting_start ?? null,
        bookedAt: a.booked_at ?? null,
        status: a.status ?? "",
        assisted: Boolean(a.assisted),
        serviceType: (a.service_type ?? "").toLowerCase(),
        direction: (a.direction ?? "").toLowerCase(),
        leadId: a.lead_id ?? a.meeting_id ?? "",
      }))
      .sort((x, y) => (x.assisted === y.assisted ? (y.bookedAt ?? "").localeCompare(x.bookedAt ?? "") : x.assisted ? 1 : -1));
    const seen = new Set<string>();
    const out: (NamedAppt & { direction: string })[] = [];
    for (const r of rows) {
      if (r.leadId && seen.has(r.leadId)) continue;
      if (r.leadId) seen.add(r.leadId);
      const { leadId, ...item } = r; // eslint-disable-line @typescript-eslint/no-unused-vars
      out.push(item);
    }
    return out.sort((x, y) => (y.bookedAt ?? "").localeCompare(x.bookedAt ?? ""));
  })();
  const warmLeadItems: WarmLeadItem[] = (warmLeads ?? [])
    .filter((w) => (w.customer_name ?? "").trim() || (w.phone ?? "").trim())
    .map((w) => ({
      customer: w.customer_name?.trim() || "—",
      phone: w.phone ?? "",
      tier: (w.tier === "warm" ? "warm" : "hot") as WarmLeadItem["tier"],
      interest: prettyInterest(w.outcome),
      campaign: w.campaign?.trim() ?? "",
      lastActivity: w.last_activity ?? null,
      serviceType: (w.service_type ?? "").toLowerCase(),
      source: (w.source === "ib" ? "ib" : "ob") as WarmLeadItem["source"],
      leadId: w.lead_id ?? null,
    }))
    .sort((x, y) => (x.tier === y.tier ? (y.lastActivity ?? "").localeCompare(x.lastActivity ?? "") : x.tier === "hot" ? -1 : 1));

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
      // v3 hero deltas: hand-offs (transfers lead-level when available + callbacks), talk, after-hours.
      appointmentsAssisted: plc ? plc.apptLeadsAssisted : sum(pr, (r) => r.appointments_assisted),
      transfers: plc ? plc.transferLeads : sum(pr, (r) => r.transfers),
      transfersFailed: plc ? plc.transferFailedLeads : sum(pr, (r) => r.transfers_failed),
      callbacks: sum(pr, (r) => r.callbacks),
      talkMinutes: Math.round(sum(pr, (r) => r.talk_seconds) / 60),
      afterHours: sum(pr, (r) => r.after_hours),
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
    // canonical: this is AI-booked (meetings.source='spyne') — the PRIMARY/headline appointments number.
    const appointments = lc ? lc.apptLeads : sum(rows, (r) => r.appointments);
    // canonical: AI-assisted (CRM) appointments — SECONDARY. Reported separately ("+N AI-assisted"),
    // NEVER folded into `appointments`. Window-distinct when available, else per-day-distinct sum.
    const appointmentsAssisted = lc ? lc.apptLeadsAssisted : sum(rows, (r) => r.appointments_assisted);
    const smsSent = sum(rows, (r) => r.sms_sent);
    const smsThreads = sum(rows, (r) => r.sms_threads);
    const afterHours = sum(rows, (r) => r.after_hours);
    const talkSeconds = sum(rows, (r) => r.talk_seconds);
    // canonical: transfers = window-DISTINCT leads with a completed transfer (lead grain, matches the
    // funnel); fall back to the call-level daily sum when lead-counts are unavailable.
    const transfers = lc ? lc.transferLeads : sum(rows, (r) => r.transfers);
    const transfersFailed = lc ? lc.transferFailedLeads : sum(rows, (r) => r.transfers_failed);
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
      appointments, // canonical: AI-booked (source='spyne') — PRIMARY/headline
      appointmentsAssisted, // canonical: AI-assisted (CRM) — SECONDARY, shown smaller, never in headline
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
        transfersFailed, // canonical: failed transfers — reported separately, never in `transferred`
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
      // v3: per-intent outcome mix (IB "what customers wanted & how it was handled"). Call-side only —
      // intent comes from IRA, which exists only for calls. Inbound agents only.
      intentOutcomes: inbound && intents.length
        ? intents.slice(0, 8).map((r) => ({ label: r.value, conversations: r.count, resolved: r.qualified, booked: r.appts, transferred: r.transferred, callback: r.callbacks }))
        : undefined,
      multiDayReply: replies.length
        ? REPLY_ORDER.filter((o) => replies.some((r) => r.value === o)).map((o) => {
            const r = replies.find((x) => x.value === o)!;
            return { day: REPLY_LABEL[o], pct: r.count ? Math.round((100 * r.qualified) / r.count) : 0 };
          })
        : [],
      summary: {
        ...a.report.summary,
        // Real agent name from the dealer's onboarded-agents config; fall back to the mock persona.
        person: onboardedNames?.[base.id]?.trim() || a.report.summary.person,
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
    // Leads by source — shown for BOTH inbound (where leads came from) and outbound (which list/source
    // the dialed leads came from). Prefer the window-distinct RPC; fall back to the breakdown rollup.
    a.report.leadsBySource = srcRows && srcRows.length
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
            avgSec: stlCnt ? Math.round(stlSec / stlCnt) : null, // numeric basis for the fleet "Response time" tile
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
      a.report = { ...a.report, intent: [], queries: [], multiDayReply: [], leadsBySource: undefined, speedToLead: undefined, outcomes: undefined, intentOutcomes: undefined };
    }

    // Rooftop-level detail, attached after the zeroing above so it survives for quiet agents (a warm
    // lead or callback is still workable on a day the agent made no calls).
    // Dead legacy fields — explicitly undefined so the cloned mock never leaks fabricated rows.
    a.report.upcomingAppointments = undefined; // served live by /api/meetings (agents page card)
    a.report.moneyOnTable = undefined; // retired with the $ layer (source table dropped in 0011)
    // Callbacks scoped to the agent's DEPARTMENT (sales agents → sales leads' callbacks, service →
    // service) so a service-heavy rooftop's follow-ups don't leak onto the Sales cards. Rows with an
    // unknown/blank service_type fall back to showing (better than hiding a real callback).
    const dept = base.dept === "Service" ? "service" : "sales";
    const dir = inbound ? "ib" : "ob";
    const myCallbacks = callbackItems.filter((c) => !c.serviceType || c.serviceType === dept);
    a.report.followUps = myCallbacks.length
      ? myCallbacks.map((c) => ({ customer: c.customer, due: c.due, intent: c.intent, priority: c.priority }))
      : undefined;
    // v3 named lists scoped to this agent: dept always; direction when the row carries one (assisted
    // CRM rows have none → shown on both directions of the dept, matching their lead-level attribution).
    const myAppts = namedApptItems.filter((n) => n.serviceType === dept && (n.assisted || !n.direction || n.direction === (inbound ? "inbound" : "outbound")));
    a.report.namedAppointments = myAppts.length
      ? myAppts.map(({ direction: _d, ...rest }) => rest) // eslint-disable-line @typescript-eslint/no-unused-vars
      : undefined;
    const myWarm = warmLeadItems.filter((w) => w.serviceType === dept && w.source === dir);
    a.report.warmLeads = myWarm.length ? myWarm : undefined;
    if (!inbound) {
      const mine = campaignItems.filter((c) => c.agentType === type);
      a.report.activeCampaigns = mine.length
        ? mine.map((c) => ({ name: c.name, useCase: c.useCase, enrolled: c.enrolled, appts: c.appts, apptRate: c.apptRate, warmLeads: c.warmLeads, optOuts: c.optOuts, noReach: c.noReach }))
        : undefined;
      // Disposition mix, biggest slice first (the widget computes its own percentages from value).
      // `bucket` (raw, sort-prefixed) rides along for the canonical best→least table ordering.
      const mineOutcomes = outcomeItems.filter((o) => o.agentType === type);
      a.report.outcomes = mineOutcomes.length
        ? [...mineOutcomes].sort((x, y) => y.value - x.value).slice(0, 12).map((o) => ({ label: o.label, value: o.value, bucket: o.bucket }))
        : undefined;
    }

    return a;
  });

  // Rooftop-wide named lists for the Overview (per-agent scoped copies live on agent.report).
  const namedApptsOut: NamedAppt[] = namedApptItems.map(({ direction: _d, ...rest }) => rest); // eslint-disable-line @typescript-eslint/no-unused-vars
  return {
    agents,
    hasData,
    fetchedAt: Date.now(),
    prior,
    namedAppointments: namedApptsOut.length ? namedApptsOut : undefined,
    warmLeads: warmLeadItems.length ? warmLeadItems : undefined,
  };
}
