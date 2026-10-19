import { fmtInt, HOUR_LABELS, type Meeting, type WarmLeadItem } from "@/components/reports/data";
import type { ActionItemResponse, AppointmentResponse, AppointmentRow, CallsReportResponse, ContactResponse, FollowUpResponse, HeatCell, Metric, Rate, ReportsResponses } from "./contract";
import { asOfTime, metricValue, NOT_ANSWERED, overviewActionItems, overviewAgents, overviewAppointments, overviewUpcoming, type AgentWork, type ServiceOverviewModel } from "./overviewModel";

/* Pure: Om's Service Metrics API v2 responses → the Service OM Reports page. The appointment numbers are
 * the Overview's own (overviewAgents on the same /appointment response, metrics.byDirection), so the two
 * pages can't disagree. The rules this page keeps:
 *
 *   - The funnel's Booked is Booked by Spyne + Spyne-assisted for that agent (user, 13-Oct), in appointments
 *     (byDirection has no customer count per direction), the same number as the appointments card.
 *   - Outbound funnel: the agent's activity in the period (user, 13-Oct, after Paragon Honda), by call AND text:
 *     Reached (conversations reached) → Engaged (conversations that went 2+ turns), Om's engagementRate pair,
 *     → Booked (the bookings MADE in the window, user 13-Oct "match the card"). Phone-only stages broke on
 *     agents that work by text (Horne Mazda, a 7-day week: no calls, 1,630 texts, 4 text bookings); this pair
 *     nested on 35 of 35 prod rooftop-windows checked (5 rooftops × 7 date chips, 13-Oct).
 *   - Inbound funnel: Connected (/contact callersReached.inbound) → Engaged → Booked. Engaged reads contact
 *     `engaged` when Om sends it; until then it is neededService.inbound under the Engaged label (user, 13-Oct).
 *   - The 7-day trend: /appointment for the last 7 days with grain=day and the agent's direction (doc 1.7),
 *     Booked by Spyne + Spyne-assisted per day; the days add up to that call's own totals (rule 9).
 *   - Calls by business hours / after hours are inbound only; for outbound they don't apply (user, 13-Oct).
 *   - Spyne-assisted bookings ride up the funnel (user, 13-Oct): those customers talked to Spyne before the store
 *     booked them, so they're added to every stage above Booked (Connected and Engaged inbound, Called and
 *     Reached outbound) and each stage says so. Booked stays by Spyne + assisted, the Overview's number. Om sends
 *     counts only, so an assisted customer who also called in the window is counted twice above Booked.
 *   - The funnel always pours (user, 13-Oct: "compensate on the funnel numbers above but not booked"): after
 *     the assisted lift, any stage still below the stage under it is topped up to it, and says so. Booked is
 *     never touched, so it is the Overview's number on every window and every day; a stage Om didn't send stays
 *     "not available". waterfall() is the only place a funnel is built.
 *   - Booking rate = Booked ÷ Connected (inbound) / Reached (outbound), and every other rate, read straight off
 *     the finished funnel, so none can pass 100%.
 *   - The two callback numbers keep their own labels (doc rule 7): action items' callbacksOpenNow is
 *     "Waiting on your BDC", follow-up's callbackRequested is "Asked for a callback".
 *   - Anything the API can't give is null with a reason and shows as "—", never 0 (rule 1). */

export interface RateView {
  numerator: number;
  denominator: number;
  value: number | null; // null when the denominator is 0
}

export interface FunnelStage {
  key: "called" | "reached" | "enrolled" | "reachable" | "connected" | "engaged" | "booked";
  label: string;
  customers: number | null;
  /** R2: this stage ÷ the stage before. */
  fromPrev: RateView | null;
  /** Spyne-assisted bookings added into this stage (they talked to Spyne before the store booked them). */
  assisted?: number;
  /** Added on top so the stage is never below the one under it (bookings from outside the period's contacts). */
  topUp?: number;
}

/** The agent's appointment numbers for the period: the Overview's By agent row for that agent. */
export interface PeriodBooked {
  work: AgentWork;
}

/* The old report's sections, kept as they look, read from the Service Metrics API instead. Strings are
 * pre-formatted the way the old cards print them; null = not available, shown as "—". */
export interface StatTile {
  label: string;
  value: string;
  hint?: string;
  accent?: string;
}

export interface AgentSections {
  activity: StatTile[];
  /** Calls during and after business hours. `hoursSplit` false where the split doesn't apply (outbound). */
  breakdown: { hoursSplit: boolean; during: number | null; after: number | null; tiles: Array<{ label: string; value: number | null; accent: string; hint?: string }> };
  /** The Appointments card's headline label; its number is the agent's visits booked. */
  totalLabel: string;
  /** optOutsScope "rooftop": Om's opt-out count covers every line and both directions, not just this agent. */
  quality: { answerRate: string; handleTime: string; optOuts: number | null; optOutsScope: "agent" | "rooftop" };
  /** Calls by hour, 7am → 6pm in the rooftop's time, from /calls-report's heatmap. */
  timeOfDay: { values: number[]; labels: string[] } | null;
  /** Visits booked per day over the last 7 days (grain=day); null with a reason when the call fails.
   * `assistedIncluded` false when the days carry no Spyne-assisted, or carry one that isn't this agent's. */
  trend7: { values: number[]; labels: string[]; total: number; assistedIncluded: boolean } | null;
  trend7Reason?: string;
}

interface AgentBase {
  key: string;
  name: string | null;
  imageUrl: string | null;
  period: PeriodBooked;
  funnel: FunnelStage[];
  bookingRate: RateView | null;
  sections: AgentSections;
  /** The funnel's Booked in appointments (by Spyne + assisted), the number its "view →" opens. */
  bookedAppointments: number | null;
  reason?: string;
}

export interface InboundReport extends AgentBase {
  direction: "inbound";
  pickerCount: number | null; // callers reached
}

export interface OutboundReport extends AgentBase {
  direction: "outbound";
  pickerCount: number | null; // conversations reached in the period (call or text)
  /** SP5: some of the window's enrolments are under 14 days old, so their bookings are still coming. */
  maturing: boolean | null;
}

export type AgentReport = InboundReport | OutboundReport;

export interface ServiceReportsModel {
  asOf: string | null;
  definitionVersion: string | null;
  timezone: string | null;
  agents: AgentReport[];
  agentsReason?: string;
  /** The Overview's Appointments headline, for the "same as Overview" line. */
  appointments: ServiceOverviewModel["appointments"];
  /** Rooftop-wide, the same reads as the Overview: upcoming appointments and action items. */
  upcoming: Meeting[] | null;
  upcomingCount: number | null;
  actionItems: ServiceOverviewModel["actionItems"];
  /** /follow-up's Warm leads (callbacks first), in the shape the Hot & warm leads chips take. */
  warmLeads: WarmLeadItem[];
  warmLeadsTotal: number | null;
}

const STAGE_LABELS: Record<FunnelStage["key"], string> = { called: "Called", reached: "Reached", enrolled: "Enrolled", reachable: "Reachable", connected: "Connected", engaged: "Engaged", booked: "Booked" };

export function rateView(numerator: number, denominator: number): RateView {
  return { numerator, denominator, value: denominator > 0 ? numerator / denominator : null };
}
function funnel(keys: FunnelStage["key"][], values: Array<number | null>, assisted: number[] = []): FunnelStage[] {
  return keys.map((key, i) => {
    const v = values[i];
    const prev = i > 0 ? values[i - 1] : null;
    const stage: FunnelStage = { key, label: STAGE_LABELS[key], customers: v, fromPrev: i > 0 && v !== null && prev !== null ? rateView(v, prev) : null };
    if (v !== null && (assisted[i] ?? 0) > 0) stage.assisted = assisted[i];
    return stage;
  });
}

/** The agent's Spyne-assisted bookings, when they're counted in its Booked (0 where Spyne-assisted isn't
 * available), and a stage lifted by them. */
const assistedOf = (w: AgentWork): number => (w.assistedCounted ? w.spyneAssisted ?? 0 : 0);
const lift = (x: number | null, a: number): number | null => (x === null ? null : x + a);

/** The only way a funnel is built. The last stage (Booked) is taken as given. Every stage above it gets the
 * agent's Spyne-assisted customers (`assisted`), then, if it is still below the nearest stage under it that has a
 * number, is topped up to that (`topUp`). So the funnel never widens on the way down, whatever the data, and
 * Booked stays the appointments number every page shows. A stage with no number stays null ("—"). */
export function waterfall(keys: FunnelStage["key"][], raw: Array<number | null>, assisted: number): FunnelStage[] {
  const last = keys.length - 1;
  const v = raw.map((x, i) => (i < last ? lift(x, assisted) : x));
  const topUp = v.map(() => 0);
  let floor: number | null = v[last];
  for (let i = last - 1; i >= 0; i--) {
    const x = v[i];
    if (x !== null && floor !== null && x < floor) { topUp[i] = floor - x; v[i] = floor; }
    if (v[i] !== null) floor = v[i];
  }
  const stages = funnel(keys, v, keys.map((_, i) => (i < last ? assisted : 0)));
  stages.forEach((st, i) => { if (topUp[i] > 0) st.topUp = topUp[i]; });
  return stages;
}

/* ── the old sections' values ──────────────────────────────────────────────────────────────────── */
// Over 100% means a stage outran its parent (different populations): "—", never a number like 400%.
const pctOf = (n: number | null, d: number | null): string => (n === null || d === null || d <= 0 || n > d ? "—" : `${Math.round((100 * n) / d)}%`);
const intOf = (v: number | null): string => (v === null ? "—" : fmtInt(v));
function handleTime(minutes: number | null, calls: number | null): string {
  if (minutes === null || calls === null || calls <= 0) return "—";
  const secs = Math.round((minutes * 60) / calls);
  return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s`;
}
/** The heatmap summed over weekdays into the old chart's 12 hours (7am → 6pm). */
function timeOfDay(cells: HeatCell[] | undefined): AgentSections["timeOfDay"] {
  if (!cells || cells.length === 0) return null;
  const values = Array.from({ length: 12 }, (_, i) => cells.filter((c) => c.hour === 7 + i).reduce((n, c) => n + c.calls, 0));
  return { values, labels: [...HOUR_LABELS] };
}
/** Connected calls ÷ calls from the heatmap: the per-call connect rate when /contact doesn't send one. */
function heatConnect(cells: HeatCell[] | undefined): { numerator: number; denominator: number } | null {
  if (!cells || cells.length === 0) return null;
  return { numerator: cells.reduce((n, c) => n + c.connected, 0), denominator: cells.reduce((n, c) => n + c.calls, 0) };
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** The agent's last 7 days from /appointment?grain=day&direction=…: Booked by Spyne + Spyne-assisted per day.
 * Spyne-assisted goes in only when its days add up to the same call's assisted for this agent (rule 9): it is
 * null where it isn't available, and until Om's next deploy per-day assisted ignores `direction` (doc 1.7). */
function trend7(resp: AppointmentResponse | null | undefined, direction: "inbound" | "outbound"): Pick<AgentSections, "trend7" | "trend7Reason"> {
  if (!resp) return { trend7: null, trend7Reason: NOT_ANSWERED };
  const days = (resp.trend ?? []).slice(-7);
  if (days.length === 0 || days.some((d) => typeof d.bookedBySpyne !== "number")) return { trend7: null, trend7Reason: "no per-day numbers for this rooftop yet." };
  const own = resp.metrics?.byDirection?.[direction]?.spyneAssisted ?? metricValue(resp.metrics?.spyneAssisted);
  const perDay = days.every((d) => typeof d.spyneAssisted === "number") ? days.reduce((n, d) => n + (d.spyneAssisted ?? 0), 0) : null;
  const assistedIncluded = typeof own === "number" && perDay === own;
  const values = days.map((d) => (d.bookedBySpyne ?? 0) + (assistedIncluded ? d.spyneAssisted ?? 0 : 0));
  const labels = days.map((d) => DOW[new Date(`${d.date.slice(0, 10)}T12:00:00Z`).getUTCDay()]);
  return { trend7: { values, labels, total: values.reduce((n, v) => n + v, 0), assistedIncluded } };
}

/** One direction's /contact numbers: v2's split fields, and today's fields the call scoped to that direction. */
function contactValues(c: ContactResponse | null, direction: "inbound" | "outbound") {
  const from = c?.window?.from ?? null;
  const m = c?.metrics;
  const v = (x: Metric | undefined | null) => metricValue(x, from);
  const saved = m?.staffTimeSavedMinutes;
  const staffMinutes = saved?.available && typeof saved[direction] === "number" ? (saved[direction] as number) : null;
  // contact-v4 sends connectRate split by direction, whatever `direction` asked; older shapes send one rate.
  const cr = m?.connectRate;
  const rate = cr && "inbound" in cr ? cr[direction] : (cr as Rate | undefined);
  return {
    calls: v(m?.calls),
    connectedCalls: v(m?.connectedCalls),
    sms: v(m?.smsSent),
    called: v(m?.customersCalled?.[direction]),
    reached: v(m?.callersReached?.[direction]) ?? v(m?.leadsReached),
    /** Customers reached by a call or a text (this direction), the set realConversations is drawn from. */
    leadsReached: v(m?.leadsReached),
    /** Conversations (not customers) reached that went two or more turns, over conversations reached: Om's
     * engagementRate, by direction. */
    // Om marks the rate "not computable" when there were no conversations (0 of 0); with reached confirmed at 0
    // those are real zeros for the funnel, not "not available".
    engagement: (() => {
      const r = m?.engagementRate?.[direction];
      return r && (r.available || (r.denominator === 0 && r.numerator === 0 && m?.leadsReached?.available === true)) ? r : null;
    })(),
    engaged: v(m?.engaged?.[direction]),
    need: v(m?.neededService?.[direction]),
    optedOut: v(m?.optedOut),
    /** Whole connected calls, start to end (transfers included), for this direction. */
    talkMinutes: v(m?.talkTimeMinutes),
    /** Vini's own minutes only (stops at a transfer): staff time saved. */
    staffMinutes,
    connectRate: rate && rate.available ? rate : null,
  };
}
/** Handle time = talk minutes ÷ connected calls, both /contact's own for this direction. Where /contact doesn't
 * send them: Vini's minutes over `connectedCalls` (inbound: /calls-report answered; outbound: the heatmap).
 * Opt-outs: the agent's own where there is one (Emily's funnel, `agentOptOuts`); else /contact's, which is
 * rooftop-wide (Om's opt-out log carries no agent) and labelled so. */
function quality(c: ReturnType<typeof contactValues>, heat: HeatCell[] | undefined, connectedCalls: number | null, agentOptOuts: number | null = null): AgentSections["quality"] {
  const rate = c.connectRate ?? heatConnect(heat);
  const handle = c.talkMinutes !== null && c.connectedCalls !== null
    ? handleTime(c.talkMinutes, c.connectedCalls)
    : handleTime(c.staffMinutes ?? c.talkMinutes, connectedCalls ?? c.connectRate?.numerator ?? c.calls);
  return {
    answerRate: rate ? pctOf(rate.numerator, rate.denominator) : "—",
    handleTime: handle,
    optOuts: agentOptOuts ?? c.optedOut,
    optOutsScope: agentOptOuts !== null ? "agent" : "rooftop",
  };
}

function inboundReport(work: AgentWork, contact: ContactResponse | null, calls: CallsReportResponse | null, actions: ActionItemResponse | null, week: AppointmentResponse | null | undefined): InboundReport {
  const c = contactValues(contact, "inbound");
  const booked = work.visitsBooked;
  // Calls: /contact's own count where it sends one, else the calls Vini answered (/calls-report, documented).
  const answeredCalls = metricValue(calls?.inbound?.answered, calls?.window?.from ?? null);
  const callCount = c.calls ?? answeredCalls;
  // Engaged in customers is v1.2's F5; v2's /contact doesn't send it yet, so Engaged shows wanted service.
  // waterfall() adds the Spyne-assisted customers to both and keeps the funnel pouring (user, 13-Oct).
  const stages = waterfall(["connected", "engaged", "booked"], [c.reached, c.engaged ?? c.need, booked], assistedOf(work));
  const [connected, engaged] = [stages[0].customers, stages[1].customers];
  const ib = calls?.inbound;
  const from = calls?.window?.from ?? null;
  const answered = ib?.answered?.available ? ib.answered : null;
  const sections: AgentSections = {
    activity: [
      { label: "Calls", value: intOf(callCount), hint: callCount !== null && booked ? `1 in every ${Math.max(1, Math.round(callCount / booked))} calls booked a visit` : undefined },
      { label: "Total SMS", value: intOf(c.sms) },
      { label: "Turn rate", value: pctOf(engaged, connected), hint: "engaged ÷ connected", accent: "#813fed" },
      { label: "Close rate", value: pctOf(booked, engaged), hint: "booked ÷ engaged", accent: "#059669" },
    ],
    breakdown: {
      hoursSplit: true,
      during: typeof answered?.businessHours === "number" ? answered.businessHours : null,
      after: typeof answered?.afterHours === "number" ? answered.afterHours : null,
      tiles: [
        { label: "Callers", value: c.reached, accent: "#2563eb" },
        { label: "Wanted service", value: c.need, accent: "#813fed" },
        { label: "Transferred", value: metricValue(ib?.transfers, from), accent: "#059669", hint: ib?.transfers && typeof ib.transfers.pickedUp === "number" ? `${fmtInt(ib.transfers.pickedUp)} picked up` : undefined },
        { label: "Booked after hours", value: metricValue(ib?.bookedAfterHours, from), accent: "#0ea5e9" },
        // Rule 7: action items' open callbacks, rooftop-wide.
        { label: "Waiting on your BDC", value: metricValue(actions?.metrics.callbacksOpenNow, actions?.window?.from ?? null), accent: "#ea760c", hint: "callbacks open now" },
      ],
    },
    totalLabel: "Total visits booked",
    quality: quality(c, ib?.heatmap, answeredCalls),
    timeOfDay: timeOfDay(ib?.heatmap),
    ...trend7(week, "inbound"),
  };
  return {
    direction: "inbound",
    key: work.key,
    name: work.name,
    imageUrl: work.imageUrl,
    period: { work },
    pickerCount: c.reached,
    funnel: stages,
    bookedAppointments: booked,
    bookingRate: booked !== null && connected !== null ? rateView(booked, connected) : null,
    sections,
    reason: contact ? undefined : NOT_ANSWERED,
  };
}

/** The outbound funnel's stages for the period, from /contact (direction=outbound), by call and text:
 * conversations reached and those that went 2+ turns (Om's engagementRate), as the finished waterfall shows
 * them; `raw` is Om's own pair, for the call breakdown. */
interface ObActivity { reached: number | null; engaged: number | null; raw: { reached: number | null; engaged: number | null } }

function outboundSections(a: ObActivity, booked: number | null, contact: ContactResponse | null, calls: CallsReportResponse | null, follow: FollowUpResponse | null, week: AppointmentResponse | null | undefined): AgentSections {
  const c = contactValues(contact, "outbound");
  // Calls placed: /contact's own count where it sends one, else the outbound heatmap's calls (documented).
  const hc = heatConnect(calls?.outbound?.heatmap);
  const callCount = c.calls ?? hc?.denominator ?? null;
  const heat = calls?.outbound?.heatmap;
  return {
    activity: [
      { label: "Calls dispatched", value: intOf(callCount), hint: (c.talkMinutes ?? c.staffMinutes) !== null ? `${fmtInt(Math.round((c.talkMinutes ?? c.staffMinutes) as number))} mins talk` : undefined },
      { label: "Total SMS", value: intOf(c.sms) },
      { label: "Answer rate", value: pctOf(c.reached, c.called), hint: "customers reached ÷ called, by phone", accent: "#2563eb" },
      { label: "Engagement rate", value: pctOf(a.engaged, a.reached), hint: "engaged ÷ reached", accent: "#813fed" },
      { label: "Close rate", value: pctOf(booked, a.engaged), hint: "booked ÷ engaged", accent: "#059669" },
    ],
    breakdown: {
      hoursSplit: false, // business hours / after hours is an inbound idea
      during: null,
      after: null,
      tiles: [
        { label: "Conversations reached", value: a.raw.reached, accent: "#2563eb", hint: "calls and texts" },
        { label: "Real conversations", value: a.raw.engaged, accent: "#813fed", hint: "2+ turns" },
        // Rule 7: customers who asked Emily for a callback (the follow-up lists), not the BDC's open callbacks.
        { label: "Asked for a callback", value: metricValue(follow?.metrics.callbackRequested, follow?.window?.from ?? null), accent: "#ea760c" },
      ],
    },
    totalLabel: "Total booked",
    // Opt-outs: the rooftop's, labelled so. The campaign funnel's own count follows customers ENROLLED in the
    // window, which is why the activity funnel replaced it (it read 0 at Paragon Honda).
    quality: quality(c, heat, hc?.numerator ?? null),
    timeOfDay: timeOfDay(heat),
    ...trend7(week, "outbound"),
  };
}

/* Outbound funnel = the agent's activity in the period (user, 13-Oct): Called → Reached → Engaged → Booked, all
 * for the selected window. Om's campaign funnel counts only customers ENROLLED in the window, so a rooftop still
 * working an older list (Paragon Honda: one recall campaign enrolled 2,236 customers before the last 30 days,
 * 838 called and 13 booked in them) read 0 → 0 → 0 → 13. That funnel stays the Campaigns page's. */
function outboundReport(work: AgentWork, campaign: CampaignResponse | null, contact: ContactResponse | null, calls: CallsReportResponse | null, follow: FollowUpResponse | null, week: AppointmentResponse | null | undefined): OutboundReport {
  const base = { direction: "outbound" as const, key: work.key, name: work.name, imageUrl: work.imageUrl, period: { work } };
  const keys: FunnelStage["key"][] = ["reached", "engaged", "booked"];
  // Booked = the period's visits booked (Booked by Spyne + Spyne-assisted), the appointments card's number.
  const booked = work.visitsBooked;
  const c = contactValues(contact, "outbound");
  const raw = { reached: c.engagement?.denominator ?? null, engaged: c.engagement?.numerator ?? null };
  const stages = waterfall(keys, [raw.reached, raw.engaged, booked], assistedOf(work));
  const a: ObActivity = { reached: stages[0].customers, engaged: stages[1].customers, raw };
  return {
    ...base,
    pickerCount: raw.reached,
    funnel: stages,
    bookedAppointments: booked,
    bookingRate: booked !== null && a.reached !== null ? rateView(booked, a.reached) : null,
    maturing: campaign?.metrics?.funnel?.stillMaturing ?? null,
    sections: outboundSections(a, booked, contact, calls, follow, week),
    reason: contact ? undefined : NOT_ANSWERED,
  };
}

type CampaignResponse = NonNullable<ReportsResponses["campaign"]>;

export function buildServiceReports(r: ReportsResponses): ServiceReportsModel {
  const agentsView = overviewAgents(r.appointments, r.agents);
  const up = overviewUpcoming(r.upcoming, r.appointments);
  const follow = r.followUp;
  const camp = (name: string | null | undefined) => name ?? "";
  return {
    asOf: asOfTime(r.appointments?.asOf) ?? asOfTime(r.campaign?.asOf) ?? asOfTime(r.contactInbound?.asOf) ?? r.readAt ?? null,
    definitionVersion: r.appointments?.definitionVersion ?? r.campaign?.definitionVersion ?? null,
    timezone: r.appointments?.window?.timezone ?? r.campaign?.window?.timezone ?? r.callsReport?.window?.timezone ?? null,
    agents: agentsView.rows.map((w) =>
      w.direction === "inbound"
        ? inboundReport(w, r.contactInbound, r.callsReport, r.actionItems, r.trendInbound)
        : outboundReport(w, r.campaign, r.contactOutbound, r.callsReport, follow, r.trendOutbound),
    ),
    agentsReason: agentsView.reason,
    appointments: overviewAppointments(r.appointments),
    // listAnchor=upcoming is "still to come", so a row the API sends without a status is upcoming.
    upcoming: r.upcoming ? toMeetings((r.upcoming.appointments?.items ?? []).map((it) => ({ ...it, status: it.status ?? "upcoming" })), r.upcoming.window?.timezone ?? r.appointments?.window?.timezone ?? null) : null,
    upcomingCount: up.count,
    actionItems: overviewActionItems(r.actionItems),
    warmLeads: (follow?.customers?.items ?? []).map((it) => ({
      customer: it.customerName || "Customer",
      phone: it.phone ?? "",
      // Callbacks lead the list (the doc), so they show as the hot tier; every other warm lead as warm.
      tier: it.outcome === "Callback Requested" ? ("hot" as const) : ("warm" as const),
      interest: it.outcome,
      campaign: camp(it.campaignName),
      lastActivity: it.touchedAt ?? null,
      serviceType: "service",
      source: "ob" as const,
      leadId: it.leadId ?? null,
    })),
    warmLeadsTotal: follow ? follow.metrics.lists?.warmLeads?.value ?? follow.customers?.total ?? null : null,
  };
}

/* ── the rows behind a number, for the existing appointments popup ──────────────────────────────── */
/* The scheduler's raw status (Om's API passes it through) onto the popup's sections. A past appointment the
 * store never updated still says "scheduled": that is "status not available", as Om's own status count has it. */
const POPUP_STATUS: Record<string, string> = {
  upcoming: "scheduled", scheduled: "scheduled",
  showed: "completed", show: "completed", completed: "completed",
  no_show: "no_show", noshow: "no_show",
  cancelled: "cancelled", cancellation_requested: "cancelled",
  tentative: "tentative",
  not_available: "status not available",
};
/* Om's statusNow onto the same words. Om already counts a matching repair order as a visit, so a past
 * appointment the scheduler never updated reads "showed" once its RO is in. Preferred whenever it is sent. */
const STATUS_NOW: Record<string, string> = {
  upcoming: "scheduled",
  showed: "showed",
  no_show: "no_show",
  cancelled: "cancelled",
  status_not_available: "status not available",
};
function popupStatus(raw: string | null | undefined, statusNow: string | null | undefined, scheduledStart: string | null, now: number): string {
  const fromOm = STATUS_NOW[(statusNow ?? "").toLowerCase()];
  if (fromOm) return fromOm;
  const s = POPUP_STATUS[(raw ?? "").toLowerCase()] ?? (raw ? raw.toLowerCase() : "scheduled");
  const past = scheduledStart !== null && Date.parse(scheduledStart) < now;
  return s === "scheduled" && past ? "status not available" : s;
}

/** API rows → the Meeting rows AppointmentsByStatusModal already renders (S1 statuses onto its sections). */
export function toMeetings(rows: AppointmentRow[], tz: string | null, now: number = Date.now()): Meeting[] {
  return rows.map((it) => ({
    id: it.meetingId,
    leadId: null,
    customer: it.customerName || "Customer",
    phone: it.phone ?? null,
    vehicle: it.vehicle ? [it.vehicle.year, it.vehicle.make, it.vehicle.model].filter(Boolean).join(" ") : "",
    when: it.scheduledStart ?? "",
    tz,
    status: popupStatus(it.status, it.statusNow, it.scheduledStart, now),
    serviceType: "service",
    assignedTo: it.bookedByAgent?.agentName ?? it.agent ?? null,
    intent: it.services ?? null,
    bookedAt: it.bookedOn ?? null,
    direction: it.direction ?? null,
    // Who booked it, for the popup's pill: Vini (booked_by_spyne), or the store after a handoff (assisted).
    source: it.tag === "booked_by_spyne" ? "spyne" : it.tag === "booked_by_dealer" ? "bdc" : null,
    assisted: it.tag === "spyne_assisted" || it.tag === "worked_by_spyne",
  }));
}
