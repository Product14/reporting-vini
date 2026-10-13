import type { ActionItemResponse, AgentProfile, AppointmentResponse, AppointmentTag, AsOfBlock, Metric, OverviewResponses } from "./contract";

/* Pure: the Service Metrics API's responses → what the Service OM Overview puts on screen. The ONLY place
 * the Overview's numbers are decided, so the Reports page can reuse the same reading and the two agree.
 *
 * Two bases for the Appointments tile:
 *   - "v2" when /appointment carries metrics.byDirection (Om's v2): headline = Booked by Spyne + Spyne-assisted,
 *     split Inbound (Carl) + Outbound (Emily) + unplaced, read straight from byDirection (doc rule 5).
 *     Where Spyne-assisted isn't available the headline is Booked by Spyne alone and says why (rule 1).
 *   - "legacy" for today's API: headline is bookedBySpyne, split from the booking-rate numerators with text
 *     bookings on Outbound (exactly what the old Overview shows), Spyne-assisted as a "+N" beside it.
 * A number the API could not give is null with a reason, never 0. */

export const NOT_ANSWERED = "The Service Metrics API did not answer.";

export interface OverviewAppointments {
  basis: "v2" | "legacy";
  total: number | null;
  bookedBySpyne: number | null;
  spyneAssisted: number | null;
  inbound: number | null;
  outbound: number | null;
  unplaced: number;
  reason?: string;
  /** Why Spyne-assisted isn't in the headline, when it isn't. */
  assistedReason?: string;
}

export interface UpcomingRow {
  id: string;
  customer: string;
  vehicle: string;
  services: string;
  when: string | null;
  kind: "booked" | "assisted" | "dealer";
}

export interface ActionRow {
  id: string;
  customer: string;
  what: string;
  due: string | null;
  isLate: boolean;
}

/** One agent's appointments for the window (the By agent card). Visits = appointments (G3). */
export interface AgentWork {
  key: string;
  direction: "inbound" | "outbound";
  name: string | null;
  imageUrl: string | null;
  bookedBySpyne: number | null;
  spyneAssisted: number | null;
  visitsBooked: number | null;
  /** Whether visitsBooked includes Spyne-assisted. False where the API can't give it (UAT today). */
  assistedCounted: boolean;
  /** Why Spyne-assisted has no per-agent number, when it hasn't. */
  assistedReason?: string;
}

/** The appointment types behind an agent's visits booked, so a clicked list asks for exactly what was counted. */
export function countedTypes(w: AgentWork): Array<Exclude<AppointmentTag, "booked_by_dealer">> {
  return w.assistedCounted ? ["booked_by_spyne", "spyne_assisted"] : ["booked_by_spyne"];
}

export interface ServiceOverviewModel {
  asOf: string | null;
  definitionVersion: string | null;
  timezone: string | null;
  appointments: OverviewAppointments;
  /** Inbound first. With `appointments.unplaced` these add up to the Appointments headline (A1, A6). */
  agents: { rows: AgentWork[]; reason?: string };
  upcoming: { count: number | null; rows: UpcomingRow[]; reason?: string };
  actionItems: { openNow: number | null; pastSla: number | null; dueToday: number | null; waitingOnBdc: number | null; rows: ActionRow[]; reason?: string };
}

function coversWindow(coverageFrom: string | undefined, windowFrom: string | undefined | null): boolean {
  if (!coverageFrom || !windowFrom) return true;
  const from = Date.parse(windowFrom);
  const cov = Date.parse(coverageFrom);
  return Number.isNaN(from) || Number.isNaN(cov) ? true : from >= cov;
}

/** When a response was built, as an ISO string: prod's asOf block (generatedAt), an older plain string, or null. */
export function asOfTime(x: string | AsOfBlock | null | undefined): string | null {
  if (typeof x === "string") return x;
  return x && typeof x.generatedAt === "string" ? x.generatedAt : null;
}

/** The one place a Metric becomes a number or null. */
export function metricValue(m: Metric | undefined | null, windowFrom?: string | null): number | null {
  return m && m.available === true && typeof m.value === "number" && coversWindow(m.coverageFrom, windowFrom) ? m.value : null;
}

const ASSISTED_MISSING = "Spyne-assisted isn't available for this rooftop yet.";
const num = (n: number | null | undefined): number | null => (typeof n === "number" ? n : null);

/** Booked by Spyne, Spyne-assisted (null with a reason when the API can't give it), and their sum. */
function bookedAndAssisted(appt: AppointmentResponse) {
  const m = appt.metrics;
  const from = appt.window?.from ?? null;
  const booked = metricValue(m.bookedBySpyne, from);
  const assisted = m.spyneAssisted ? metricValue(m.spyneAssisted, from) : metricValue(m.workedBySpyne, from);
  const assistedReason = assisted === null ? (m.spyneAssisted ?? m.workedBySpyne)?.reason ?? ASSISTED_MISSING : undefined;
  return { booked, assisted, assistedReason };
}

/** One direction's appointments as the pages count them: Booked by Spyne + Spyne-assisted (assisted left out,
 * not zeroed, when the rooftop's total isn't available, so the parts still add up to the headline). */
function directionTotal(b: { available?: boolean; bookedBySpyne: number | null; spyneAssisted?: number | null } | undefined, assistedOn: boolean): number | null {
  if (b?.available === false) return null;
  const booked = num(b?.bookedBySpyne);
  if (booked === null) return null;
  return booked + (assistedOn ? num(b?.spyneAssisted) ?? 0 : 0);
}

export function overviewAppointments(appt: AppointmentResponse | null): OverviewAppointments {
  if (!appt) return { basis: "legacy", total: null, bookedBySpyne: null, spyneAssisted: null, inbound: null, outbound: null, unplaced: 0, reason: NOT_ANSWERED };
  const m = appt.metrics;
  const from = appt.window?.from ?? null;
  const { booked, assisted, assistedReason } = bookedAndAssisted(appt);

  if (m.byDirection) {
    const d = m.byDirection;
    const total = booked === null ? null : booked + (assisted ?? 0);
    const inbound = directionTotal(d.inbound, assisted !== null);
    const outbound = directionTotal(d.outbound, assisted !== null);
    // Om places an assisted booking by its handoff's channel; one with no channel lands under neither agent,
    // and unplaced carries no assisted count. Those go to unplaced, so the headline always adds up.
    const placedAssisted = (num(d.inbound?.spyneAssisted) ?? 0) + (num(d.outbound?.spyneAssisted) ?? 0);
    const unplacedAssisted = assisted === null ? 0 : num(d.unplaced?.spyneAssisted) ?? Math.max(0, assisted - placedAssisted);
    const unplacedBooked = num(d.unplaced?.bookedBySpyne);
    const unplaced = unplacedBooked !== null ? unplacedBooked + unplacedAssisted : Math.max(0, (total ?? 0) - (inbound ?? 0) - (outbound ?? 0));
    return {
      basis: "v2",
      total,
      bookedBySpyne: booked,
      spyneAssisted: assisted,
      inbound,
      outbound,
      unplaced,
      reason: total === null ? m.bookedBySpyne?.reason ?? NOT_ANSWERED : undefined,
      assistedReason,
    };
  }

  // Legacy: the old Overview's exact split (serviceMetrics.ts loadServiceOverviewOverlay).
  const rateNum = (r: { available: boolean; numerator: number } | undefined) => (r && r.available && typeof r.numerator === "number" ? r.numerator : null);
  const inbound = rateNum(m.bookingRate?.inbound);
  const outboundCalls = rateNum(m.bookingRate?.outbound);
  const text = metricValue(m.bookedByText, from);
  const outbound = outboundCalls === null && (text ?? 0) === 0 ? outboundCalls : (outboundCalls ?? 0) + (text ?? 0);
  return {
    basis: "legacy",
    total: booked,
    bookedBySpyne: booked,
    spyneAssisted: assisted,
    inbound,
    outbound,
    unplaced: booked === null ? 0 : Math.max(0, booked - (inbound ?? 0) - (outbound ?? 0)),
    reason: booked === null ? m.bookedBySpyne?.reason ?? NOT_ANSWERED : undefined,
    assistedReason,
  };
}

export const ASSISTED_NOT_SPLIT = "Today's API gives Spyne-assisted as one rooftop total, not per agent.";

/* The By agent card's rows: Carl (inbound) and Emily (outbound) from metrics.byDirection (rule 5), with names
 * and photos from the rooftop's onboarded agents (Om's API has none). A direction shows when the rooftop has
 * that agent, or when it booked anything (so the rows always add up), or when the agent list is unknown. */
export function overviewAgents(appt: AppointmentResponse | null, profiles?: AgentProfile[] | null): ServiceOverviewModel["agents"] {
  if (!appt) return { rows: [], reason: NOT_ANSWERED };
  const m = appt.metrics;
  const profile = (d: AgentWork["direction"]) => profiles?.find((p) => p.direction === d) ?? null;

  if (m.byDirection) {
    const d = m.byDirection;
    const { assisted, assistedReason } = bookedAndAssisted(appt);
    const rows: AgentWork[] = [];
    for (const direction of ["inbound", "outbound"] as const) {
      const block = d[direction];
      const off = block?.available === false;
      const booked = off ? null : num(block?.bookedBySpyne);
      const mine = assisted === null || off ? null : num(block?.spyneAssisted);
      const p = profile(direction);
      const has = !profiles || profiles.length === 0 || p !== null || (booked ?? 0) + (mine ?? 0) > 0;
      if (!has) continue;
      rows.push({
        key: direction,
        direction,
        name: p?.name ?? null,
        imageUrl: p?.imageUrl ?? null,
        bookedBySpyne: booked,
        spyneAssisted: mine,
        visitsBooked: directionTotal(block, assisted !== null),
        assistedCounted: mine !== null,
        assistedReason: mine === null ? (off ? block?.reason ?? NOT_ANSWERED : assisted === null ? assistedReason : "Spyne-assisted isn't split by agent for this rooftop.") : undefined,
      });
    }
    return { rows, reason: rows.length === 0 ? "No Service agent is live on this rooftop." : undefined };
  }
  // Today's API: the same split the Appointments tile uses, and no per-agent Spyne-assisted.
  const a = overviewAppointments(appt);
  const rows: AgentWork[] = [];
  for (const [direction, booked] of [["inbound", a.inbound], ["outbound", a.outbound]] as const) {
    if (booked === null) continue;
    const p = profile(direction);
    rows.push({ key: direction, direction, name: p?.name ?? null, imageUrl: p?.imageUrl ?? null, bookedBySpyne: booked, spyneAssisted: null, visitsBooked: booked, assistedCounted: false, assistedReason: ASSISTED_NOT_SPLIT });
  }
  return { rows, reason: rows.length === 0 ? a.reason : undefined };
}

function vehicleText(v: { year?: string; make?: string; model?: string } | null | undefined): string {
  return v ? [v.year, v.make, v.model].filter(Boolean).join(" ") : "";
}

/** The upcoming list (listAnchor=upcoming, soonest first). Each row keeps its tag: Booked by Spyne,
 * Spyne-assisted, or the BDC's own booking. The count is /appointment's `upcoming` metric, the list's total
 * when the metric isn't there. */
export function overviewUpcoming(list: AppointmentResponse | null, appt?: AppointmentResponse | null): ServiceOverviewModel["upcoming"] {
  if (!list) return { count: null, rows: [], reason: NOT_ANSWERED };
  const rows: UpcomingRow[] = (list.appointments?.items ?? []).map((it) => ({
    id: it.meetingId,
    customer: it.customerName || "Customer",
    vehicle: vehicleText(it.vehicle),
    services: it.services ?? "",
    when: it.scheduledStart,
    kind: it.tag === "spyne_assisted" || it.tag === "worked_by_spyne" ? "assisted" : it.tag === "booked_by_dealer" ? "dealer" : "booked",
  }));
  const metric = metricValue(appt?.metrics?.upcoming ?? list.metrics?.upcoming);
  return { count: metric ?? list.appointments?.total ?? rows.length, rows };
}

export function overviewActionItems(resp: ActionItemResponse | null): ServiceOverviewModel["actionItems"] {
  if (!resp) return { openNow: null, pastSla: null, dueToday: null, waitingOnBdc: null, rows: [], reason: NOT_ANSWERED };
  const from = resp.window?.from ?? null;
  return {
    openNow: metricValue(resp.metrics.openNow, from),
    pastSla: metricValue(resp.metrics.pastSla, from),
    dueToday: metricValue(resp.metrics.dueToday, from),
    waitingOnBdc: metricValue(resp.metrics.callbacksOpenNow, from),
    rows: (resp.actionItems?.items ?? []).map((it) => ({
      id: it.actionItemId,
      customer: it.customerName || "Customer",
      what: it.title || it.whatNeedsDoing,
      due: it.due,
      isLate: it.isLate,
    })),
    reason: resp.metrics.openNow?.available === false ? resp.metrics.openNow.reason ?? NOT_ANSWERED : undefined,
  };
}

export function buildServiceOverview(r: OverviewResponses): ServiceOverviewModel {
  return {
    asOf: asOfTime(r.appointments?.asOf) ?? asOfTime(r.actionItems?.asOf) ?? r.readAt ?? null,
    definitionVersion: r.appointments?.definitionVersion ?? r.actionItems?.definitionVersion ?? null,
    timezone: r.appointments?.window?.timezone ?? r.upcoming?.window?.timezone ?? r.actionItems?.window?.timezone ?? null,
    appointments: overviewAppointments(r.appointments),
    agents: overviewAgents(r.appointments, r.agents),
    upcoming: overviewUpcoming(r.upcoming, r.appointments),
    actionItems: overviewActionItems(r.actionItems),
  };
}
