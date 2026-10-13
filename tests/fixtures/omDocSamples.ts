/* Om's Service Metrics API v2 doc (Confluence 1193934864, v6, 13-Oct), section 1: the UAT sample responses
 * for the test rooftop, copied as published. Where the doc trims a part ("[...]" / "{...}"), the stand-in is
 * marked FILLED; nothing else is invented. Used to run the pages' real API path (api.ts → source.ts → models)
 * on Om's own shapes while UAT is down. No customer data: the FILLED rows use made-up names. */

const WINDOW = { from: "2026-09-13T18:30:00.000Z", to: "2026-10-13T18:29:59.999Z", timezone: "Asia/Kolkata", grain: "total" };

export const APPOINTMENT = {
  teamId: "678958236",
  agentLine: "service",
  window: WINDOW,
  definitionVersion: "appointment-v8",
  metrics: {
    bookedBySpyne: { available: true, value: 21, reason: null },
    spyneAssisted: { available: false, value: null, reason: "<why it can't be shown here>", byType: null },
    active: { available: true, value: 16, reason: null },
    expectedRevenue: { available: true, value: 3200, active: 16, avgRo: 200, avgRoSource: "default" },
    statusOfBookings: { available: true, booked: 21, upcoming: 0, cancelled: 5, cancelledThroughSpyne: 0, cancelledOutsideSpyne: 5, showed: 2, noShow: 0, statusNotAvailable: 14, statusNotAvailableReason: "Past appointments the store hasn't updated yet." },
    visits: { available: true, due: 30, showed: 5, noShow: 0, notKnown: 25, bookedBeforeWindow: 14, showRate: null, confirmedVisitRate: 0.1667, outcomeSource: "scheduler" },
    realizedRevenue: { available: true, value: 1000, basis: "estimated", showed: 5, avgRo: 200 },
    byDirection: {
      inbound: { bookedBySpyne: 3, spyneAssisted: null },
      outbound: { bookedBySpyne: 0, spyneAssisted: null },
      unplaced: { bookedBySpyne: 18 },
    },
    bookingCohortRevenue: { earnedSoFar: 400, earnedBasis: "estimated", stillUpcoming: 0, estimated: 2800, lostAppointments: 5 },
    upcoming: { available: true, value: 18, reason: null },
  },
  trend: null,
  appointments: { items: [], total: 18, nextCursor: null }, // items FILLED (empty): the main call's list isn't read
  notes: [],
};

// FILLED rows, in the field names the live Overview already reads (src/lib/serviceMetrics.ts AppointmentListItem).
const row = (i: number, tag: string, direction: string | null, start: string) => ({
  meetingId: `m${i}`, customerName: `Test Customer ${i}`, vehicle: { year: "2022", make: "Honda", model: "Civic" }, services: "Oil change",
  scheduledStart: start, bookedOn: "2026-10-01T10:00:00.000Z", tag, direction, status: "upcoming",
});
export const UPCOMING_LIST = {
  window: WINDOW,
  metrics: null, // listOnly=true: "metrics and trend come back null" (section 7)
  trend: null,
  appointments: { items: [row(1, "booked_by_spyne", "inbound", "2026-10-14T09:00:00.000Z"), row(2, "booked_by_dealer", null, "2026-10-14T11:00:00.000Z")], total: 18, nextCursor: null },
};
export const CREATED_LIST_INBOUND = {
  window: WINDOW, metrics: null, trend: null,
  appointments: { items: [1, 2, 3].map((i) => ({ ...row(10 + i, "booked_by_spyne", "inbound", "2026-10-02T09:00:00.000Z"), status: "showed" })), total: 3, nextCursor: null },
};
export const CREATED_LIST_OUTBOUND = { window: WINDOW, metrics: null, trend: null, appointments: { items: [], total: 0, nextCursor: null } };

export const CONTACT = {
  metrics: {
    staffTimeSavedMinutes: { available: true, value: 135.44, inbound: 122.43, outbound: 13.01 },
    customersCalled: { inbound: { available: true, value: 4 }, outbound: { available: true, value: 3 } },
    callersReached: { inbound: { available: true, value: 4 }, outbound: { available: true, value: 3 } },
    neededService: { inbound: { available: true, value: 3 }, outbound: { available: false, value: null, reason: "FILLED: trimmed in the doc" } },
    wantedSomethingElse: { inbound: { available: true, value: 1 }, outbound: { available: false, value: null, reason: "FILLED: trimmed in the doc" } },
  },
  trend: null,
};

export const ACTION_ITEM = {
  metrics: {
    openNow: { available: true, value: 421, reason: null },
    pastSla: { available: true, value: 419, reason: null },
    dueToday: { available: true, value: 2, reason: null },
    callbacksOpenNow: { available: true, value: 22, reason: null },
  },
  // FILLED rows, in the field names the live Overview already reads (ActionItemListItem).
  actionItems: { items: [{ actionItemId: "a1", customerName: "Test Customer A", whatNeedsDoing: "Return customer's call", title: null, due: "2026-09-20T10:00:00.000Z", isLate: true }], total: 421, nextCursor: null },
};

const FUNNEL = {
  enrollments: 1,
  removedBeforeAttempt: 0,
  stages: { enrolled: 1, reachable: 1, connected: 1, engaged: 1, booked: 0 },
  rates: { bookingRate: 0, bookedOfConnected: 0, yield: 0, reachable: 1, connected: 1, engaged: 1 },
  bookedAppointments: 0,
  active: 0,
  expectedRevenue: 0,
  avgRo: 200,
  beside: { spyneAssisted: 0, bookedWithViniInboundAfter: 0 },
  drops: {
    D1: { number_disconnected: 0, calls_unanswered: 0, texts_failed: 0, not_attempted_yet: 0 },
    D2: { opted_out_by_text: 0, voicemail_only: 0, text_delivered_no_reply: 0, answered_never_spoke: 0, call_screener_only: 0 },
    D3: { spoken_opt_out: 0, wrong_number: 0, wrong_or_unavailable_person: 0, language_barrier: 0, hung_up_at_greeting: 0, too_short: 0 },
    D4: { notNow: 1 },
  },
  stillMaturing: false,
};
export const CAMPAIGN = { view: "campaign", metrics: { funnel: FUNNEL }, byCampaign: [{ campaignId: "eca01e1d-32f9-44a1-b52a-40d3faf51c50", name: "FILLED", status: "FILLED", funnel: FUNNEL }] };

export const FOLLOW_UP = {
  view: "rooftop",
  metrics: {
    connected: { available: true, value: 4 },
    booked: { available: true, value: 1 },
    callbackRequested: { available: true, value: 0 },
    lists: {
      warmLeads: { label: "Warm leads", bucket: "Needs your team", value: 1 },
      notNow: { label: "Not now", bucket: "Waiting on customer", value: 1 },
      alreadyTakenCareOf: { label: "Already taken care of", bucket: "Handled by your team", value: 0 },
      declined: { label: "Declined", bucket: "Declined", value: 0 },
      noClearOutcome: { label: "No clear outcome", bucket: "Dropped", value: 1 },
    },
  },
  addsUp: { connectedMinusBooked: 3, listsTotal: 3, ok: true },
  customers: { list: "warmLeads", items: [{ leadId: "<lead id>", customerName: "<name>", phone: "<phone>", outcome: "No Slots Available", campaignName: "<campaign>", touchedAt: "2026-10-02T15:04:11.000Z" }], total: 1, nextCursor: null },
};

export const CALLS_REPORT = {
  inbound: {
    answered: { available: true, value: 112, businessHours: 108, afterHours: 4 },
    bookedAfterHours: { available: true, value: 1 },
    transfers: { available: true, value: 7, pickedUp: 0, notPickedUp: 7 },
    reasons: { available: true, rows: [{ reason: "Schedule Service Appointment", calls: 41, handledByVini: 41, sentToTeam: 0, booked: 2 }] },
    heatmap: [{ weekday: 1, hour: 14, calls: 6, connected: 3 }],
  },
  outbound: { heatmap: [{ weekday: 1, hour: 16, calls: 2, connected: 2 }] },
};

/* FILLED: the doc gives only the shape of a grain=day trend (section 1.7, "values illustrative"). 7 days for
 * Carl adding up to the call's own total, Spyne-assisted null as on UAT; Emily all zero. */
const days = ["2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13"];
const trendCall = (perDay: number[]) => {
  const total = perDay.reduce((n, v) => n + v, 0);
  return {
    window: { ...WINDOW, from: "2026-10-06T18:30:00.000Z", grain: "day" },
    metrics: { bookedBySpyne: { available: true, value: total }, spyneAssisted: { available: false, value: null, reason: "<why>" } },
    trend: days.map((date, i) => ({ date, endDate: date, bookedBySpyne: perDay[i], spyneAssisted: null, bookedByDealer: 3, scheduled: 4 })),
  };
};
export const TREND_INBOUND = trendCall([0, 1, 0, 0, 1, 0, 0]);
export const TREND_OUTBOUND = trendCall([0, 0, 0, 0, 0, 0, 0]);

/** Answers a Service Metrics URL the way the doc's UAT samples do, and records it. */
export function omDocFetch(seen: URL[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    seen.push(url);
    const p = url.searchParams;
    const path = url.pathname.split("/service-metrics/")[1];
    let body: unknown = null;
    if (path === "appointment") {
      if (p.get("grain") === "day") body = p.get("direction") === "outbound" ? TREND_OUTBOUND : TREND_INBOUND;
      else if (p.get("listAnchor") === "upcoming") body = UPCOMING_LIST;
      else if (p.get("listAnchor") === "created") body = p.get("direction") === "outbound" ? CREATED_LIST_OUTBOUND : CREATED_LIST_INBOUND;
      else body = APPOINTMENT;
    } else if (path === "contact") body = CONTACT;
    else if (path === "action-item") body = ACTION_ITEM;
    else if (path === "campaign") body = CAMPAIGN;
    else if (path === "follow-up") body = FOLLOW_UP;
    else if (path === "calls-report") body = CALLS_REPORT;
    return body ? new Response(JSON.stringify(body), { status: 200 }) : new Response("not found", { status: 404 });
  }) as typeof fetch;
}
