/* The Service Metrics API as the Service OM pages read it: Om Thakare's "Service Metrics API v2"
 * (Confluence 1193934864, RETCONVAI-5282, live on UAT 13-Oct-2026). ONE file, so the pages, the mock and the
 * models agree on names. Field names below are Om's, from the doc's sample responses; anything marked
 * "(next deploy)" is documented but not on UAT yet, and everything is optional where the doc trims it.
 *
 * Endpoints (all GET, base /conversation/service-metrics, Bearer console session token, query params only):
 *   /appointment  /contact  /action-item  /campaign  /follow-up  /calls-report
 * Common params: enterpriseId, teamId, window (today|7d|30d|mtd|custom, default 30d), startDate/endDate
 * (YYYY-MM-DD, with custom), grain (total|day|week; day adds a `trend` series, doc 1.7), agentLine (service
 * default), timezone (IANA, default the rooftop's). window.from / window.to come back as ISO timestamps.
 *
 * The doc's rules the pages follow: never a 0 for "not available" (show the reason); same teamId / window /
 * timezone / agentLine on every call a page makes; read, don't recompute; Carl and Emily from
 * metrics.byDirection (inbound + outbound + unplaced = Booked by Spyne); clicking a number opens its rows
 * from the same endpoint, and the list's total equals the number. */

/** A count. `available: false` carries a reason and never a 0. */
export interface Metric {
  available: boolean;
  value: number | null;
  reason?: string | null;
  coverageFrom?: string;
}

/** A rate (today's contact fields). Numerator and denominator always come with it. */
export interface Rate {
  available: boolean;
  value: number | null;
  numerator: number;
  denominator: number;
}

export interface DirectionSplit<T> {
  inbound: T;
  outbound: T;
}

/** Prod (13-Oct) sends asOf as a block on every endpoint: when the response was built and the newest data
 * behind it. Older shapes sent an ISO string, or nothing. Read through asOfTime(). */
export interface AsOfBlock {
  generatedAt: string;
  lastAppointmentAt?: string | null;
  lastCallAt?: string | null;
  lastRepairOrderAt?: string | null;
}

export interface WindowInfo {
  from: string;
  to: string;
  timezone: string;
  grain?: string;
}

/* ── /appointment (1.1) ─────────────────────────────────────────────────────────────────────────── */
/** One day of `grain=day` (doc 1.7). The days add up to the same call's totals (rule 9). spyneAssisted is
 * null where Spyne-assisted isn't available. */
export interface AppointmentTrendPoint {
  date: string;
  endDate?: string;
  bookedBySpyne: number | null;
  spyneAssisted?: number | null;
  bookedByDealer?: number | null;
  scheduled?: number | null;
}

/** Booked = upcoming + cancelled + showed + no-show + status not available. */
export interface StatusOfBookings {
  available: boolean;
  booked: number;
  upcoming: number;
  cancelled: number;
  cancelledThroughSpyne?: number;
  cancelledOutsideSpyne?: number;
  showed: number;
  noShow: number;
  statusNotAvailable: number;
  statusNotAvailableReason?: string | null;
}

/** Appointments whose time has passed. showRate only where the scheduler reports no-shows. */
export interface Visits {
  available: boolean;
  due: number;
  showed: number;
  noShow: number;
  notKnown: number;
  bookedBeforeWindow?: number;
  showRate: number | null;
  confirmedVisitRate?: number | null;
  outcomeSource?: string;
}

/** Carl (inbound) or Emily (outbound). Appointment counts; spyneAssisted is null where it isn't available. */
export interface DirectionBlock {
  /** False when the line has nothing to count (no agent mapped): then the numbers aren't a real 0. */
  available?: boolean;
  reason?: string | null;
  bookedBySpyne: number | null;
  spyneAssisted?: number | null;
  statusOfBookings?: StatusOfBookings;
  visits?: Visits;
}

/** The three appointment types (B1). */
export type AppointmentTag = "booked_by_spyne" | "spyne_assisted" | "booked_by_dealer";

/** One row of /appointment's list. The doc trims the row; these are the fields today's API sends. */
export interface AppointmentRow {
  meetingId: string;
  customerName: string | null;
  vehicle: { year?: string; make?: string; model?: string } | null;
  services: string | null;
  scheduledStart: string | null;
  phone?: string | null;
  bookedOn?: string | null;
  tag?: AppointmentTag | string | null;
  channel?: "call" | "text" | null;
  direction?: "inbound" | "outbound" | null;
  /** The scheduler's own status, as stored: scheduled, completed, cancelled, cancellation_requested, noshow,
   * no_show, tentative, or null (Om's code). Not normalised by the API. */
  status?: string | null;
  /** Where it stands now, Om's own S1–S5 status (RETCONVAI-5282): a matching repair order makes it "showed"
   * even when the scheduler still says scheduled. Absent on API builds from before 13-Oct-2026. */
  statusNow?: "upcoming" | "showed" | "no_show" | "cancelled" | "status_not_available" | null;
  /** The Vini agent that booked it (Booked by Spyne rows only). */
  bookedByAgent?: { teamAgentMappingId: string; agentName: string | null } | null;
  advisor?: string | null;
  subType?: string | null;
  campaignId?: string | null;
  /** Sample data only; the API sends bookedByAgent and campaignId. */
  agent?: string | null;
  campaignName?: string | null;
}

export interface AppointmentResponse {
  teamId?: string;
  agentLine?: string;
  window: WindowInfo;
  definitionVersion?: string;
  /** A block on prod (generatedAt, lastAppointmentAt, lastCallAt, lastRepairOrderAt); read through asOfTime(). */
  asOf?: string | AsOfBlock;
  metrics: {
    bookedBySpyne: Metric;
    spyneAssisted?: Metric & { byType?: { transfer: number | null; request: number | null; intent: number | null } | null };
    active?: Metric;
    expectedRevenue?: { available: boolean; value: number | null; active?: number; avgRo?: number; avgRoSource?: string };
    statusOfBookings?: StatusOfBookings;
    visits?: Visits;
    realizedRevenue?: { available: boolean; value: number | null; basis?: string; showed?: number; avgRo?: number };
    byDirection?: DirectionSplit<DirectionBlock> & { unplaced?: { bookedBySpyne: number | null; spyneAssisted?: number | null } };
    bookingCohortRevenue?: { earnedSoFar: number; earnedBasis?: string; stillUpcoming: number; estimated: number; lostAppointments: number };
    upcoming?: Metric;
    // Today's (v1) names, read only when v2's are absent.
    workedBySpyne?: Metric;
    bookingRate?: DirectionSplit<Rate>;
    bookedByText?: Metric;
  };
  /** With `grain=day` (or week): one point per rooftop calendar day; null otherwise. */
  trend?: AppointmentTrendPoint[] | null;
  appointments?: { items: AppointmentRow[]; total: number; nextCursor?: string | null };
  notes?: unknown[];
}

/* ── /contact (1.2) ─────────────────────────────────────────────────────────────────────────────── */
export interface ContactResponse {
  window?: WindowInfo;
  definitionVersion?: string;
  asOf?: string | AsOfBlock;
  metrics: {
    // v2, split by direction inside one response
    staffTimeSavedMinutes?: { available: boolean; value: number | null; inbound?: number | null; outbound?: number | null; reason?: string | null };
    customersCalled?: DirectionSplit<Metric>;
    callersReached?: DirectionSplit<Metric>;
    neededService?: DirectionSplit<Metric>;
    wantedSomethingElse?: DirectionSplit<Metric>;
    // contact-v4's own fields, scoped by the `direction` the call asked for (Om's code)
    calls?: Metric;
    connectedCalls?: Metric;
    smsSent?: Metric;
    talkTimeMinutes?: Metric;
    leadsReached?: Metric;
    realConversations?: Metric;
    engagementRate?: DirectionSplit<Rate>;
    /** Always split inbound / outbound in contact-v4, whatever `direction` asked; a single rate in older shapes. */
    connectRate?: Rate | DirectionSplit<Rate>;
    /** Rooftop-wide: not scoped by agentLine or direction (the opt-out log carries no agent). */
    optedOut?: Metric;
    afterHoursLeads?: Metric;
    /** v1.2 promised Engaged in customers (F4/F5); not in v2's sample. Read if it appears. */
    engaged?: DirectionSplit<Metric>;
  };
  /** With `grain=day`: calls, connectedCalls, smsSent, leadsReached, realConversations per day (doc 1.7). */
  trend?: Array<{ date: string; endDate?: string; calls?: number; connectedCalls?: number; smsSent?: number; leadsReached?: number; realConversations?: number }> | null;
}

/* ── /action-item (1.3) ─────────────────────────────────────────────────────────────────────────── */
export interface ActionItemRow {
  actionItemId: string;
  customerName: string | null;
  whatNeedsDoing: string;
  title?: string | null;
  due: string | null;
  isLate: boolean;
}

export interface ActionItemResponse {
  window?: WindowInfo;
  definitionVersion?: string;
  asOf?: string | AsOfBlock;
  metrics: {
    openNow: Metric;
    pastSla: Metric;
    dueToday?: Metric;
    callbacksOpenNow?: Metric; // "Waiting on your BDC" (rule 7)
    cleared?: Metric;
  };
  actionItems: { items: ActionItemRow[]; total: number; nextCursor?: string | null };
}

/* ── /campaign (1.4) ────────────────────────────────────────────────────────────────────────────── */
export interface FunnelStages {
  enrolled: number;
  reachable: number;
  connected: number;
  engaged: number;
  booked: number;
}

export interface CampaignFunnel {
  enrollments?: number;
  removedBeforeAttempt?: number;
  stages: FunnelStages;
  /** Om: bookingRate = Booked ÷ Engaged; bookedOfConnected = Booked ÷ Connected (spec R1). */
  rates?: { bookingRate?: number; bookedOfConnected?: number; yield?: number; reachable?: number; connected?: number; engaged?: number };
  bookedAppointments?: number;
  active?: number;
  expectedRevenue?: number;
  avgRo?: number;
  beside?: { spyneAssisted: number; bookedWithViniInboundAfter: number };
  /** D1–D3 keyed by reason; D4 keyed by follow-up list. */
  drops?: Partial<Record<"D1" | "D2" | "D3" | "D4", Record<string, number>>>;
  stillMaturing?: boolean;
  /** (next deploy) */
  byChannel?: Partial<Record<"call" | "text" | "callback" | "notAttempted", FunnelStages>>;
  optedOut?: { afterConnecting: number; beforeConnecting: number };
}

export interface CampaignResponse {
  view?: string;
  window?: WindowInfo;
  definitionVersion?: string;
  asOf?: string | AsOfBlock;
  metrics: {
    funnel: CampaignFunnel;
    funnelByType?: Array<{ campaignType: string; campaigns: number; funnel: CampaignFunnel }>;
  };
  byCampaign?: Array<{ campaignId: string; name?: string; status?: string; campaignType?: string; funnel: CampaignFunnel }>;
}

/* ── /follow-up (1.5) ───────────────────────────────────────────────────────────────────────────── */
export interface FollowUpCustomer {
  leadId?: string;
  customerName: string | null;
  phone?: string | null;
  outcome: string;
  campaignName?: string | null;
  touchedAt?: string | null;
}

export interface FollowUpResponse {
  view?: string;
  window?: WindowInfo;
  asOf?: string | AsOfBlock;
  metrics: {
    connected?: Metric;
    booked?: Metric;
    callbackRequested?: Metric; // "Asked for a callback" (rule 7)
    lists: Record<string, { label: string; bucket: string; value: number }>;
    optedOutBeforeConnecting?: Metric; // (next deploy)
  };
  addsUp?: { connectedMinusBooked: number; listsTotal: number; ok: boolean };
  customers?: { list: string; items: FollowUpCustomer[]; total: number; nextCursor?: string | null } | null;
}

/* ── /calls-report (1.6) ────────────────────────────────────────────────────────────────────────── */
/** weekday 0 = Sunday; hour in the rooftop's timezone. Answer rate for a cell = connected ÷ calls. */
export interface HeatCell {
  weekday: number;
  hour: number;
  calls: number;
  connected: number;
}

export interface CallsReportResponse {
  window?: WindowInfo;
  asOf?: string | AsOfBlock;
  inbound: {
    answered: Metric & { businessHours?: number; afterHours?: number };
    bookedAfterHours?: Metric;
    transfers?: Metric & { pickedUp?: number; notPickedUp?: number };
    reasons?: { available: boolean; rows: Array<{ reason: string; calls: number; handledByVini: number; sentToTeam: number; booked: number }> };
    heatmap?: HeatCell[];
  };
  outbound?: { heatmap?: HeatCell[] };
}

/* ── onboarded agents (not Om's API: /conversation/agents/team/:teamId/onboarded-agents) ─────────── */
/** The names and photos for Carl and Emily, which Om's API does not carry. */
export interface AgentProfile {
  direction: "inbound" | "outbound";
  name: string | null;
  imageUrl: string | null;
}

/* ── what each page asks for ────────────────────────────────────────────────────────────────────── */
/** The window vocabulary the API takes. Custom endDate is INCLUSIVE. */
export interface WindowParams {
  window: "today" | "7d" | "30d" | "mtd" | "custom";
  startDate?: string;
  endDate?: string;
  timezone?: string;
}

/** The Overview: bookings, the upcoming list (appointment date), action items, and who the agents are. */
export interface OverviewResponses {
  /** When the page read these (the API sends no asOf), so two reads can be told apart. */
  readAt?: string;
  appointments: AppointmentResponse | null;
  upcoming: AppointmentResponse | null;
  actionItems: ActionItemResponse | null;
  agents?: AgentProfile[] | null;
}

/** Reports: the Overview's reads plus the funnel, contact numbers, calls report and warm leads. */
export interface ReportsResponses {
  readAt?: string;
  appointments: AppointmentResponse | null;
  campaign: CampaignResponse | null;
  contactInbound: ContactResponse | null;
  contactOutbound: ContactResponse | null;
  upcoming: AppointmentResponse | null;
  actionItems: ActionItemResponse | null;
  callsReport: CallsReportResponse | null;
  followUp: FollowUpResponse | null;
  /** The 7-day trend: /appointment over the last 7 days with grain=day, one call per direction (doc 1.7). */
  trendInbound?: AppointmentResponse | null;
  trendOutbound?: AppointmentResponse | null;
  agents?: AgentProfile[] | null;
}

/** A9: the rows behind a number on the page, exactly the ones it counted. */
export type AppointmentListQuery = {
  basis: "booked";
  direction: "inbound" | "outbound";
  types: Array<Exclude<AppointmentTag, "booked_by_dealer">>;
};

export interface AppointmentList {
  items: AppointmentRow[];
  total: number;
}

/* Gaps against these pages (also listed for Om):
 *  1. Agent names and photos: not in the API (taken from onboarded-agents).
 *  2. Inbound Engaged in customers (F5): not in v2's /contact sample.
 *  3. Booked in customers per direction (G4): byDirection gives appointments only.
 *  4. (Resolved in doc v5: grain=day with direction gives the 7-day trend.)
 *  5. (Resolved in doc v6: `direction` filters /appointment's list.)
 *  6. asOf on every response (G7): not in v2's samples, so the pages show the read time only when it's sent. */
