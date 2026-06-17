/* ────────────── Reporting data model (Phase 1, static fleet numbers) ──────────────
 * Single source of truth shared by /reports (Overview), /reports/agents (By agent),
 * and /reports/campaigns. Base numbers are per-day ("yesterday"); volume metrics
 * scale by the time bucket. Phase 2 swaps this module for a GET /reports endpoint
 * backed by the outcome/event store (see PRD 12 + IMPL_Reporting).
 *
 * Framing: this is the dealer's PRIMARY source of truth — it must answer money,
 * pipeline, activity, quality, missed opportunity, compliance and data-health.
 */

export type Bucket = "today" | "yesterday" | "last7" | "last14" | "last30" | "lifetime";
export const BUCKET_LABELS: Record<Bucket, string> = {
  today: "Today",
  yesterday: "Yesterday",
  last7: "Last 7 days",
  last14: "Last 14 days",
  last30: "Last 30 days",
  lifetime: "Lifetime",
};
export const BUCKET_FACTOR: Record<Bucket, number> = { today: 0.42, yesterday: 1, last7: 6.6, last14: 13, last30: 27.5, lifetime: 120 };

export type RAG = "green" | "amber" | "red";

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString();
}
export function fmtMoney(n: number): string {
  const v = Math.round(n);
  if (Math.abs(v) >= 1000) return `$${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k`;
  return `$${v.toLocaleString()}`;
}
export function fmtMoneyFull(n: number): string {
  return `$${Math.round(n).toLocaleString()}`;
}

export interface AgentMetrics {
  calls: number; // handled (inbound) or dispatched (outbound)
  connectRate: number; // % answer (IB) / connect (OB)
  conversations: number; // reached a person/agent
  qualified: number; // qualified (sales) / booked-eligible (service)
  appointments: number;
  showed: number;
  deals: number; // sales deals closed / service ROs completed
  revenue: number; // $ attributed
  cost: number; // $ to run (telephony + SMS + data lookups)
  smsSent: number;
  optOuts: number;
  afterHours: number; // captured (inbound)
  talkMinutes: number;
}

export interface AgentQuality {
  primaryLabel: string; // "Qualification rate" (OB) / "Answer rate" (IB)
  primary: number; // %
  primaryStatus: RAG;
  handleTime: string;
  handleStatus: RAG;
  csat: number; // /5
  csatStatus: RAG;
  fourthLabel: string; // "Transfer success" / "Compliance"
  fourthValue: string;
  fourthStatus: RAG;
  sentiment: number; // % positive
}

export interface AgentData {
  id: "sales_ib" | "sales_ob" | "service_ib" | "service_ob";
  name: string;
  dept: "Sales" | "Service";
  dir: "Inbound" | "Outbound";
  icon: string;
  blurb: string;
  health: RAG;
  headlineLabel: string; // "Calls handled" / "Calls dispatched"
  metrics: AgentMetrics;
  quality: AgentQuality;
  outcomes: { label: string; value: number; color: string }[];
  channelSplit: { voice: number; sms: number };
  hourly: number[]; // 12 buckets, 7am → 6pm
  topObjections: { label: string; pct: number }[];
  highlights: { kind: "win" | "miss"; text: string; value?: string }[];
  activityTitle: string;
  activityCols: string[];
  activityRows: string[][];
  trend7: number[]; // last 7 days of the headline volume (oldest → newest)
  report: AgentReport; // everything the agent-wise mockups (Sales IB / Sales OB) call for
  // Unique-lead funnel stages (distinct leads over the window) — drives the Outreach→conversation→
  // qualified→appointment funnel on both the Overview (fleet sum) and per-agent pages. Set live by
  // build.ts; absent on mock agents (those funnels fall back to event-count metrics).
  leadFunnel?: { contacted: number; connected: number; qualified: number; appt: number };
}

/* ────────────── Agent-wise report blocks (from the IB / OB mockups) ────────────── */

// Headline KPI tiles — value comes from metrics; these add the period-over-period delta
// (the "↓9% vs prev" pills) and the small sub-breakdown counts under the strip.
export interface KpiDeltas {
  leadsAttempted: number;
  leadsQualified: number;
  appointments: number;
  totalCalls: number;
  totalSms: number;
  abr: number;
}
// The little labelled counts under the KPI strip. Inbound and outbound show a different mix.
export interface KpiBreakdown {
  label: string;
  value: number;
}
// One day of the day-on-day line chart (Touched / Qualified / Appointments, dual-axis).
export interface DayPoint {
  day: string;
  touched: number;
  qualified: number;
  appts: number;
}
// Intent breakdown slice (qualified vs not, and the intent mix within).
export interface IntentSlice {
  label: string;
  value: number;
  color: string;
}
// A query topic + how often the agent resolved it without a human.
export interface QueryTopic {
  label: string;
  resolved: number;
  total: number;
}
// Call-flow funnel — total → answered/missed → transferred/lost, with the AI-handled share.
export interface CallFlow {
  total: number;
  answered: number;
  missed: number;
  transferred: number;
  callbacks?: number; // had_callback — optional so mock callFlow objects don't need it
  lost: number;
  handledByAI: number;
}
// Reply rate by days-since-first-touch (multi-day reply effectiveness).
export interface ReplyByDay {
  day: string;
  pct: number;
}
// The agent performance summary card (Emily / Jenny).
export interface AgentSummary {
  person: string;
  tagline: string;
  conversations: number;
  avgFirstContact: string;
  apptsBooked: number;
  bookingRate: number; // %
}
// ── Inbound-only ──
export interface LeadSource {
  source: string;
  interacted: number;
  engaged: number;
  total: number;
  handoffs: number;
  appts: number;
}
export interface SpeedToLead {
  avg: string;
  pctWithin5: number;
  crmLeadsNew: number;
  instantlyTouched: number;
  afterHoursInstant: number; // instantly-touched leads that arrived after-hours
  instantAppts: number; // instantly-touched leads that booked an appointment
  instantApptRate: number; // instantAppts / instantlyTouched, %
  medianUnderMin: boolean; // typical (median) first-response ≤ 1 min — false → pitch the STL upsell
  missedCalledBack: number;
  pctTouched: number;
  note: string;
  // Open-funnel split (card 12341, Sales Inbound only): leads handled → appointments booked, per
  // acquisition path. rate = appts/handled as a whole-number %. Populated from report_open_funnel
  // (external ETL, like the other detail tables); absent → the breakdown shows "coming soon".
  openFunnel?: {
    stlLeadsHandled: number; stlAppts: number; stlRate: number;
    followupLeadsHandled: number; followupAppts: number; followupRate: number;
  };
}
// Shapes mirror the Supabase-backed Metabase cards (12233 / 12234 / 12232).
export interface UpcomingAppt {
  customer: string; // customer_name
  when: string; // appointment_time (formatted for display)
  vehicle: string;
  status: string; // booked / confirmed / cancelled …
}
/* A single appointment/meeting record from the Spyne meetings API (leads/dealer/v3/meetings),
 * normalized for display + drill-down. Powers the "Upcoming appointments" card and the list of
 * leads behind any appointment count. `when` is the raw ISO start time — the UI formats it in `tz`. */
export interface Meeting {
  id: string;
  leadId: string | null;
  customer: string;
  phone: string | null;
  vehicle: string; // "2026 Mercedes-Benz C-Class C 300", or "" when the API has no vehicle data
  when: string; // meetingStartTime, ISO 8601 (UTC)
  tz: string | null; // IANA timezone the meeting is scheduled in
  status: string; // scheduled / confirmed / cancelled / completed / no_show …
  serviceType: string; // "sales" | "service"
  assignedTo: string | null;
  intent: string | null;
  bookedAt: string | null; // createdAt — when the appointment was booked (ISO 8601, UTC)
}
export interface MeetingsResult {
  meetings: Meeting[];
  total: number;
  error?: string;
}
export interface FollowUp {
  customer: string; // customer_name
  due: string; // callback_due (formatted)
  intent: string; // RequestCallback, …
  priority: string; // LOW / MEDIUM / HIGH
}
// ── Outbound-only ──
export interface ActiveCampaign {
  name: string; // campaign
  useCase: string; // use_case
  enrolled: number;
  appts: number; // appointments
  apptRate: number; // appt_rate_pct
  warmLeads: number;
  optOuts: number;
  noReach: number;
}
export interface NoInteraction {
  total: number;
  interested: number;
  noReply: number;
  disconnected: number;
}
// One slice of the outbound disposition mix (e.g. "Not Connected" → 206).
export interface OutcomeSlice {
  label: string;
  value: number;
}
// The 3-pitch inbound story, each shown against the industry/human-team average.
export interface Benchmark {
  label: string; // "Leads touched"
  ours: string; // "100%"
  theirs: string; // "55%"
  caption: string; // the one-line why
  multiplier?: string; // "5.5× more"
  accent: string;
}
// Before/after compare table: values[0] = the dealer's human team, then month 1/2/3 of the agent.
export interface CompareRow {
  metric: string;
  values: string[]; // length 4: [Your team, M1, M2, M3]
  better: "up" | "down"; // which direction is an improvement
}

export interface AgentReport {
  // shared (both IB and OB)
  leadsAttempted: number; // per-day base, scales with bucket
  turnRate: number; // %
  abr: number; // appointment-booking rate %
  deltas: KpiDeltas;
  breakdown: KpiBreakdown[];
  dayOnDay: DayPoint[];
  intent: IntentSlice[];
  qualifiedPct: number;
  queries: QueryTopic[];
  callFlow: CallFlow;
  multiDayReply: ReplyByDay[];
  summary: AgentSummary;
  // inbound-only
  leadsBySource?: LeadSource[];
  speedToLead?: SpeedToLead;
  upcomingAppointments?: UpcomingAppt[];
  followUps?: FollowUp[];
  // "Money on the table" (card 12236): recoverable inbound leads by bucket (rooftop-level, per inbound
  // agent_type). Summed across agents on the Overview's "Money on the table" card.
  moneyOnTable?: { bucket: string; label: string; leads: number }[];
  // outbound-only
  activeCampaigns?: ActiveCampaign[];
  noInteraction?: NoInteraction;
  outcomes?: OutcomeSlice[]; // outbound disposition mix (from card 12231 / report_outcomes), biggest first

  // inbound-only — the 3-pitch story (vs industry) + month-on-month before/after
  benchmarks?: Benchmark[];
  compare?: CompareRow[];
}

const HOURS = ["7a", "8a", "9a", "10a", "11a", "12p", "1p", "2p", "3p", "4p", "5p", "6p"];
export const HOUR_LABELS = HOURS;

export const AGENTS: AgentData[] = [
  {
    id: "sales_ib",
    name: "Sales Inbound",
    dept: "Sales",
    dir: "Inbound",
    icon: "📞",
    blurb: "Answers inbound sales calls, qualifies intent, books showroom appointments — including after-hours.",
    health: "green",
    headlineLabel: "Calls handled",
    metrics: { calls: 142, connectRate: 94, conversations: 134, qualified: 96, appointments: 38, showed: 28, deals: 9, revenue: 36400, cost: 4100, smsSent: 40, optOuts: 2, afterHours: 27, talkMinutes: 596 },
    quality: { primaryLabel: "Answer rate", primary: 94, primaryStatus: "green", handleTime: "4m 12s", handleStatus: "green", csat: 4.6, csatStatus: "green", fourthLabel: "Transfer success", fourthValue: "88%", fourthStatus: "amber", sentiment: 82 },
    outcomes: [
      { label: "Booked appointment", value: 38, color: "#10b981" },
      { label: "Info given", value: 54, color: "#6366f1" },
      { label: "Transferred to rep", value: 31, color: "#813fed" },
      { label: "Callback scheduled", value: 12, color: "#f59e0b" },
      { label: "Abandoned", value: 7, color: "#dc2626" },
    ],
    channelSplit: { voice: 90, sms: 10 },
    hourly: [4, 11, 18, 16, 14, 12, 13, 15, 14, 9, 7, 9],
    topObjections: [{ label: "Wants to think it over", pct: 34 }, { label: "Price / payment", pct: 28 }, { label: "Checking other dealers", pct: 19 }],
    highlights: [
      { kind: "win", text: "After-hours calls captured that would otherwise have gone to voicemail.", value: "27" },
      { kind: "miss", text: "Calls waited >60s before pickup — tighten the answer SLA at peak.", value: "11" },
    ],
    activityTitle: "Calls by reason",
    activityCols: ["Call reason", "Handled", "Qualified", "Appointments"],
    activityRows: [
      ["New-vehicle inquiry", "61", "48", "22"],
      ["Pricing / trade question", "34", "21", "8"],
      ["Inventory availability", "29", "18", "6"],
      ["Financing question", "18", "9", "2"],
    ],
    trend7: [118, 131, 126, 140, 122, 137, 142],
    report: {
      leadsAttempted: 168,
      turnRate: 71,
      abr: 24,
      deltas: { leadsAttempted: 9, leadsQualified: 6, appointments: -9, totalCalls: 4, totalSms: 12, abr: -3 },
      breakdown: [
        { label: "After hours", value: 27 },
        { label: "Overflows", value: 9 },
        { label: "During hours", value: 133 },
        { label: "Handoffs", value: 31 },
        { label: "Transfers", value: 22 },
        { label: "Callback req.", value: 12 },
      ],
      dayOnDay: [
        { day: "Mon", touched: 118, qualified: 78, appts: 30 },
        { day: "Tue", touched: 131, qualified: 88, appts: 34 },
        { day: "Wed", touched: 126, qualified: 84, appts: 31 },
        { day: "Thu", touched: 140, qualified: 96, appts: 38 },
        { day: "Fri", touched: 122, qualified: 80, appts: 29 },
        { day: "Sat", touched: 137, qualified: 92, appts: 35 },
        { day: "Sun", touched: 142, qualified: 96, appts: 38 },
      ],
      intent: [
        { label: "High intent", value: 54, color: "#10b981" },
        { label: "Mid intent", value: 42, color: "#6366f1" },
        { label: "Low intent", value: 26, color: "#f59e0b" },
        { label: "Not qualified", value: 38, color: "#9ca3af" },
      ],
      qualifiedPct: 72,
      queries: [
        { label: "Pricing / payment", resolved: 78, total: 95 },
        { label: "Inventory availability", resolved: 52, total: 68 },
        { label: "Service pricing / estimate", resolved: 38, total: 59 },
        { label: "Talk to a rep", resolved: 21, total: 36 },
      ],
      callFlow: { total: 142, answered: 134, missed: 8, transferred: 31, lost: 7, handledByAI: 96 },
      multiDayReply: [
        { day: "Same day", pct: 61 },
        { day: "Day 1", pct: 22 },
        { day: "Day 2", pct: 11 },
        { day: "Day 3+", pct: 6 },
      ],
      summary: { person: "Emily", tagline: "Sales · Inbound", conversations: 247, avgFirstContact: "1m 47s", apptsBooked: 32, bookingRate: 13 },
      leadsBySource: [
        { source: "Internet", interacted: 505, engaged: 228, total: 505, handoffs: 22, appts: 18 },
        { source: "Walk-in", interacted: 117, engaged: 88, total: 117, handoffs: 14, appts: 11 },
        { source: "Phone", interacted: 101, engaged: 74, total: 101, handoffs: 9, appts: 6 },
        { source: "Other", interacted: 39, engaged: 21, total: 39, handoffs: 4, appts: 3 },
      ],
      speedToLead: { avg: "1m 47s", pctWithin5: 97, crmLeadsNew: 87, instantlyTouched: 68, afterHoursInstant: 19, instantAppts: 31, instantApptRate: 46, medianUnderMin: true, missedCalledBack: 23, pctTouched: 94, note: "6 of 7 days the average was under 5 minutes", openFunnel: { stlLeadsHandled: 68, stlAppts: 31, stlRate: 46, followupLeadsHandled: 41, followupAppts: 9, followupRate: 22 } },
      benchmarks: [
        { label: "Leads touched", ours: "100%", theirs: "55%", caption: "Every lead — including after-hours and overflow that used to ring out.", multiplier: "Never misses", accent: "#10b981" },
        { label: "Time to first touch", ours: "47 sec", theirs: "3 hrs", caption: "Instant, not hours later. Speed is what wins the lead.", multiplier: "~230× faster", accent: "#813fed" },
        { label: "Follow-ups per lead", ours: "11", theirs: "2", caption: "It takes 8–10 follow-ups to book; humans give up after 2.", multiplier: "5.5× more", accent: "#6366f1" },
      ],
      compare: [
        { metric: "Every lead touched", values: ["55%", "92%", "97%", "100%"], better: "up" },
        { metric: "After-hours captured", values: ["0%", "74%", "88%", "96%"], better: "up" },
        { metric: "Time to first response", values: ["3h 08m", "2m 30s", "1m 20s", "47s"], better: "down" },
        { metric: "Follow-ups per lead", values: ["2", "6", "9", "11"], better: "up" },
      ],
    },
  },
  {
    id: "sales_ob",
    name: "Sales Outbound",
    dept: "Sales",
    dir: "Outbound",
    icon: "🚀",
    blurb: "Runs the outbound campaigns built in the flow — aged-lead, speed-to-lead, equity, lease, service-drive trade-in.",
    health: "green",
    headlineLabel: "Calls dispatched",
    metrics: { calls: 1240, connectRate: 31, conversations: 384, qualified: 158, appointments: 54, showed: 41, deals: 12, revenue: 48200, cost: 6900, smsSent: 720, optOuts: 23, afterHours: 0, talkMinutes: 1460 },
    quality: { primaryLabel: "Qualification rate", primary: 41, primaryStatus: "green", handleTime: "3m 48s", handleStatus: "green", csat: 4.4, csatStatus: "green", fourthLabel: "Transfer success", fourthValue: "82%", fourthStatus: "amber", sentiment: 79 },
    outcomes: [
      { label: "Interested → booked", value: 54, color: "#10b981" },
      { label: "Not now / nurture", value: 121, color: "#f59e0b" },
      { label: "Not interested", value: 98, color: "#9ca3af" },
      { label: "Wrong number", value: 41, color: "#dc2626" },
      { label: "Opt-out", value: 23, color: "#6b7280" },
    ],
    channelSplit: { voice: 62, sms: 38 },
    hourly: [38, 92, 128, 142, 121, 96, 88, 130, 138, 118, 84, 65],
    topObjections: [{ label: "Already purchased", pct: 31 }, { label: "Not in market", pct: 27 }, { label: "Bad data / wrong #", pct: 21 }],
    highlights: [
      { kind: "win", text: "Service-Drive Trade-In drove appointments off equity-positive owners in for service.", value: "18 appts" },
      { kind: "miss", text: "Aged-lead list ran a high wrong-number rate — a data-hygiene gap, not an agent gap.", value: "22%" },
    ],
    activityTitle: "Campaigns",
    activityCols: ["Campaign", "Dispatched", "Connect", "Conversions"],
    activityRows: [
      ["Service-Drive Trade-In", "210", "34%", "18"],
      ["Aged-Lead Re-Engagement", "468", "26%", "11"],
      ["Equity Mining", "302", "33%", "14"],
      ["Speed-to-Lead", "260", "39%", "11"],
    ],
    trend7: [980, 1120, 1075, 1198, 1042, 1165, 1240],
    report: {
      // leads attempted (unique leads dialed) ≥ conversations(384) ≥ qualified(158) ≥ appts(54); 1,240 dials ≈ 1.9/lead
      leadsAttempted: 640,
      turnRate: 31,
      abr: 8, // 54 appts ÷ 640 leads
      deltas: { leadsAttempted: -9, leadsQualified: -6, appointments: 7, totalCalls: -4, totalSms: 11, abr: 3 },
      breakdown: [
        { label: "Connected", value: 384 },
        { label: "No answer", value: 740 },
        { label: "Voicemail", value: 116 },
        { label: "Callback req.", value: 18 },
        { label: "Exited", value: 96 },
        { label: "Opt-out", value: 23 },
      ],
      dayOnDay: [
        { day: "Mon", touched: 980, qualified: 124, appts: 42 },
        { day: "Tue", touched: 1120, qualified: 142, appts: 47 },
        { day: "Wed", touched: 1075, qualified: 136, appts: 45 },
        { day: "Thu", touched: 1198, qualified: 158, appts: 54 },
        { day: "Fri", touched: 1042, qualified: 130, appts: 41 },
        { day: "Sat", touched: 1165, qualified: 150, appts: 49 },
        { day: "Sun", touched: 1240, qualified: 158, appts: 54 },
      ],
      intent: [
        { label: "Interested → booked", value: 54, color: "#10b981" },
        { label: "Nurture / not now", value: 121, color: "#f59e0b" },
        { label: "Not interested", value: 98, color: "#6366f1" },
        { label: "Bad data / wrong #", value: 41, color: "#9ca3af" },
      ],
      qualifiedPct: 41,
      queries: [
        { label: "Pricing / payment", resolved: 142, total: 198 },
        { label: "Trade-in value", resolved: 96, total: 151 },
        { label: "Lease maturity options", resolved: 64, total: 110 },
        { label: "Book a test drive", resolved: 48, total: 72 },
      ],
      callFlow: { total: 1240, answered: 384, missed: 856, transferred: 44, lost: 116, handledByAI: 340 },
      multiDayReply: [
        { day: "Same day", pct: 34 },
        { day: "Day 1", pct: 28 },
        { day: "Day 2", pct: 21 },
        { day: "Day 3+", pct: 17 },
      ],
      summary: { person: "Jenny", tagline: "Sales · Outbound", conversations: 384, avgFirstContact: "3m 48s", apptsBooked: 54, bookingRate: 14 },
      benchmarks: [
        { label: "List worked", ours: "100%", theirs: "20%", caption: "Every aged, equity and lease lead — humans only chase the hottest few.", multiplier: "Never cherry-picks", accent: "#10b981" },
        { label: "Touches per lead", ours: "8", theirs: "2", caption: "Call → SMS → call across days; humans give up after 2 dials.", multiplier: "4× the cadence", accent: "#6366f1" },
        { label: "Speed to new lead", ours: "1m 50s", theirs: "3 hrs", caption: "Fresh ADF leads dialed in under 2 minutes, not hours.", multiplier: "~100× faster", accent: "#813fed" },
      ],
      compare: [
        { metric: "Aged list worked", values: ["20%", "70%", "88%", "100%"], better: "up" },
        { metric: "Touches per lead", values: ["2", "5", "7", "8"], better: "up" },
        { metric: "Speed to new lead", values: ["3h 00m", "28m", "6m", "1m 50s"], better: "down" },
        { metric: "Dead leads re-engaged", values: ["0%", "60%", "85%", "100%"], better: "up" },
      ],
    },
  },
  {
    id: "service_ib",
    name: "Service Inbound",
    dept: "Service",
    dir: "Inbound",
    icon: "🛎️",
    blurb: "Answers inbound service calls, books the service drive, and captures after-hours scheduling demand.",
    health: "amber",
    headlineLabel: "Calls handled",
    metrics: { calls: 268, connectRate: 91, conversations: 244, qualified: 138, appointments: 121, showed: 92, deals: 92, revenue: 18900, cost: 5200, smsSent: 60, optOuts: 1, afterHours: 44, talkMinutes: 812 },
    quality: { primaryLabel: "Answer rate", primary: 91, primaryStatus: "amber", handleTime: "3m 02s", handleStatus: "green", csat: 4.5, csatStatus: "green", fourthLabel: "Transfer success", fourthValue: "90%", fourthStatus: "green", sentiment: 80 },
    outcomes: [
      { label: "Appointment booked", value: 121, color: "#10b981" },
      { label: "Info / status", value: 63, color: "#6366f1" },
      { label: "Transferred", value: 22, color: "#813fed" },
      { label: "Callback", value: 14, color: "#f59e0b" },
      { label: "Abandoned", value: 24, color: "#dc2626" },
    ],
    channelSplit: { voice: 88, sms: 12 },
    hourly: [22, 41, 38, 24, 19, 16, 18, 21, 20, 17, 8, 4],
    topObjections: [{ label: "Just shopping price", pct: 29 }, { label: "Will call back", pct: 24 }, { label: "Wants specific advisor", pct: 18 }],
    highlights: [
      { kind: "win", text: "After-hours service calls booked straight into the scheduler — no voicemail tag.", value: "44" },
      { kind: "miss", text: "Calls abandoned during the 8–9am peak — a staffing / AI-capacity gap at open.", value: "24" },
    ],
    activityTitle: "Calls by reason",
    activityCols: ["Call reason", "Handled", "Booked", "After-hours"],
    activityRows: [
      ["Maintenance / oil change", "112", "68", "19"],
      ["Recall follow-up", "47", "29", "8"],
      ["Diagnostic / check-engine", "63", "16", "11"],
      ["Reschedule / status", "46", "8", "6"],
    ],
    trend7: [241, 255, 248, 272, 239, 261, 268],
    report: {
      leadsAttempted: 296,
      turnRate: 68,
      abr: 41,
      deltas: { leadsAttempted: 5, leadsQualified: 8, appointments: 6, totalCalls: 3, totalSms: 9, abr: 2 },
      breakdown: [
        { label: "After hours", value: 44 },
        { label: "Overflows", value: 17 },
        { label: "During hours", value: 224 },
        { label: "Handoffs", value: 22 },
        { label: "Transfers", value: 14 },
        { label: "Callback req.", value: 14 },
      ],
      dayOnDay: [
        { day: "Mon", touched: 241, qualified: 122, appts: 108 },
        { day: "Tue", touched: 255, qualified: 132, appts: 114 },
        { day: "Wed", touched: 248, qualified: 128, appts: 110 },
        { day: "Thu", touched: 272, qualified: 138, appts: 121 },
        { day: "Fri", touched: 239, qualified: 120, appts: 102 },
        { day: "Sat", touched: 261, qualified: 134, appts: 116 },
        { day: "Sun", touched: 268, qualified: 138, appts: 121 },
      ],
      intent: [
        { label: "Booked", value: 121, color: "#10b981" },
        { label: "Info / status", value: 63, color: "#6366f1" },
        { label: "Will call back", value: 38, color: "#f59e0b" },
        { label: "Not qualified", value: 22, color: "#9ca3af" },
      ],
      qualifiedPct: 57,
      queries: [
        { label: "Service pricing / estimate", resolved: 96, total: 138 },
        { label: "Maintenance scheduling", resolved: 88, total: 112 },
        { label: "Recall status", resolved: 41, total: 55 },
        { label: "Talk to service department", resolved: 28, total: 52 },
      ],
      callFlow: { total: 268, answered: 244, missed: 24, transferred: 22, lost: 24, handledByAI: 184 },
      multiDayReply: [
        { day: "Same day", pct: 58 },
        { day: "Day 1", pct: 24 },
        { day: "Day 2", pct: 12 },
        { day: "Day 3+", pct: 6 },
      ],
      summary: { person: "Mia", tagline: "Service · Inbound", conversations: 244, avgFirstContact: "2m 10s", apptsBooked: 121, bookingRate: 50 },
      leadsBySource: [
        { source: "Phone", interacted: 188, engaged: 162, total: 188, handoffs: 14, appts: 84 },
        { source: "Service web", interacted: 56, engaged: 41, total: 56, handoffs: 5, appts: 24 },
        { source: "Walk-in", interacted: 18, engaged: 14, total: 18, handoffs: 2, appts: 9 },
        { source: "Other", interacted: 6, engaged: 4, total: 6, handoffs: 1, appts: 4 },
      ],
      speedToLead: { avg: "2m 10s", pctWithin5: 92, crmLeadsNew: 64, instantlyTouched: 51, afterHoursInstant: 22, instantAppts: 27, instantApptRate: 53, medianUnderMin: true, missedCalledBack: 13, pctTouched: 89, note: "After-hours demand booked straight into the scheduler", openFunnel: { stlLeadsHandled: 51, stlAppts: 27, stlRate: 53, followupLeadsHandled: 30, followupAppts: 6, followupRate: 20 } },
      benchmarks: [
        { label: "Calls answered", ours: "100%", theirs: "61%", caption: "Every service call — even the 8am open rush and after hours.", multiplier: "Never misses", accent: "#10b981" },
        { label: "Time to first touch", ours: "38 sec", theirs: "2h 40m", caption: "Booked straight into the drive — no voicemail tag.", multiplier: "~250× faster", accent: "#813fed" },
        { label: "Follow-ups per lead", ours: "9", theirs: "2", caption: "Declined work re-engaged until it books; humans stop at 2.", multiplier: "4.5× more", accent: "#6366f1" },
      ],
      compare: [
        { metric: "Calls answered", values: ["61%", "88%", "94%", "100%"], better: "up" },
        { metric: "After-hours captured", values: ["0%", "70%", "85%", "92%"], better: "up" },
        { metric: "Time to first response", values: ["2h 40m", "1m 50s", "55s", "38s"], better: "down" },
        { metric: "Follow-ups per lead", values: ["2", "5", "7", "9"], better: "up" },
      ],
    },
  },
  {
    id: "service_ob",
    name: "Service Outbound",
    dept: "Service",
    dir: "Outbound",
    icon: "🔧",
    blurb: "Runs recall, due-service and service-specials waves — compliance-grade, exempt-aware.",
    health: "green",
    headlineLabel: "Calls dispatched",
    metrics: { calls: 980, connectRate: 36, conversations: 353, qualified: 166, appointments: 71, showed: 53, deals: 53, revenue: 22600, cost: 4800, smsSent: 540, optOuts: 14, afterHours: 0, talkMinutes: 980 },
    quality: { primaryLabel: "Qualification rate", primary: 47, primaryStatus: "green", handleTime: "2m 51s", handleStatus: "green", csat: 4.5, csatStatus: "green", fourthLabel: "Compliance (exempt)", fourthValue: "OK", fourthStatus: "green", sentiment: 83 },
    outcomes: [
      { label: "Booked", value: 71, color: "#10b981" },
      { label: "Not now", value: 96, color: "#f59e0b" },
      { label: "Declined", value: 84, color: "#9ca3af" },
      { label: "Wrong number", value: 38, color: "#dc2626" },
      { label: "Opt-out", value: 14, color: "#6b7280" },
    ],
    channelSplit: { voice: 55, sms: 45 },
    hourly: [30, 78, 112, 121, 98, 72, 70, 104, 110, 92, 58, 35],
    topObjections: [{ label: "No issues currently", pct: 33 }, { label: "Going elsewhere", pct: 22 }, { label: "Cost concern", pct: 17 }],
    highlights: [
      { kind: "win", text: "Recall wave booked safety appointments — every contact logged for the OEM audit.", value: "38" },
      { kind: "miss", text: "Due-service reminders had no current-mileage on file, falling back to a generic script.", value: "31%" },
    ],
    activityTitle: "Campaigns",
    activityCols: ["Campaign", "Dispatched", "Connect", "Booked"],
    activityRows: [
      ["Recall (safety)", "286", "41%", "38"],
      ["Due-Service Reminder", "402", "33%", "21"],
      ["Service Specials", "292", "35%", "12"],
    ],
    trend7: [902, 945, 918, 988, 930, 962, 980],
    report: {
      // leads attempted (unique leads dialed) ≥ conversations(353) ≥ qualified(166) ≥ appts(71); 980 dials ≈ 1.75/lead
      leadsAttempted: 560,
      turnRate: 36,
      abr: 13, // 71 appts ÷ 560 leads
      deltas: { leadsAttempted: 4, leadsQualified: 7, appointments: 5, totalCalls: -2, totalSms: 8, abr: 2 },
      breakdown: [
        { label: "Connected", value: 353 },
        { label: "No answer", value: 540 },
        { label: "Voicemail", value: 87 },
        { label: "Callback req.", value: 14 },
        { label: "Exited", value: 84 },
        { label: "Opt-out", value: 14 },
      ],
      dayOnDay: [
        { day: "Mon", touched: 902, qualified: 142, appts: 60 },
        { day: "Tue", touched: 945, qualified: 152, appts: 64 },
        { day: "Wed", touched: 918, qualified: 146, appts: 62 },
        { day: "Thu", touched: 988, qualified: 166, appts: 71 },
        { day: "Fri", touched: 930, qualified: 148, appts: 58 },
        { day: "Sat", touched: 962, qualified: 158, appts: 66 },
        { day: "Sun", touched: 980, qualified: 166, appts: 71 },
      ],
      intent: [
        { label: "Booked", value: 71, color: "#10b981" },
        { label: "Not now", value: 96, color: "#f59e0b" },
        { label: "Declined", value: 84, color: "#6366f1" },
        { label: "Bad data / wrong #", value: 38, color: "#9ca3af" },
      ],
      qualifiedPct: 47,
      queries: [
        { label: "Recall safety notice", resolved: 118, total: 152 },
        { label: "Due-service reminder", resolved: 88, total: 134 },
        { label: "Service specials", resolved: 52, total: 96 },
        { label: "Reschedule existing", resolved: 31, total: 48 },
      ],
      callFlow: { total: 980, answered: 353, missed: 627, transferred: 22, lost: 87, handledByAI: 318 },
      multiDayReply: [
        { day: "Same day", pct: 40 },
        { day: "Day 1", pct: 26 },
        { day: "Day 2", pct: 20 },
        { day: "Day 3+", pct: 14 },
      ],
      summary: { person: "Theo", tagline: "Service · Outbound", conversations: 353, avgFirstContact: "2m 51s", apptsBooked: 71, bookingRate: 20 },
      benchmarks: [
        { label: "Recall / due list worked", ours: "100%", theirs: "25%", caption: "Every recall and due-service owner contacted — nothing slips.", multiplier: "Never misses a recall", accent: "#10b981" },
        { label: "Touches per lead", ours: "7", theirs: "2", caption: "Persistent, compliant cadence; humans stop after 2 tries.", multiplier: "3.5× the cadence", accent: "#6366f1" },
        { label: "Declined work re-engaged", ours: "100%", theirs: "15%", caption: "Every declined RO followed up — humans rarely call back.", multiplier: "6× revival", accent: "#813fed" },
      ],
      compare: [
        { metric: "Recall / due list worked", values: ["25%", "72%", "90%", "100%"], better: "up" },
        { metric: "Touches per lead", values: ["2", "4", "6", "7"], better: "up" },
        { metric: "Declined work re-engaged", values: ["15%", "55%", "80%", "100%"], better: "up" },
      ],
    },
  },
];

export function agentById(id: string, agents: AgentData[] = AGENTS): AgentData {
  return agents.find((a) => a.id === id) ?? agents[0];
}

/* Period-over-period deltas for the fleet bottom-line (vs the prior equal window). */
export const FLEET_DELTAS = {
  revenue: 11,
  roi: 6,
  net: 14,
  appointments: 8,
  deals: 5,
  cost: -3,
  calls: 4,
  showRate: 2,
} as const;

/* ── fleet roll-ups (Overview) ── */
export interface FleetTotals {
  revenue: number;
  cost: number;
  roi: number;
  net: number;
  calls: number;
  conversations: number;
  qualified: number;
  appointments: number;
  showed: number;
  deals: number;
  smsSent: number;
  optOuts: number;
  afterHours: number;
  talkMinutes: number;
  showRate: number;
  connectRate: number; // weighted by calls
}

export function fleetTotals(agents: AgentData[] = AGENTS): FleetTotals {
  const t = agents.reduce(
    (acc, a) => {
      const m = a.metrics;
      acc.revenue += m.revenue;
      acc.cost += m.cost;
      acc.calls += m.calls;
      acc.conversations += m.conversations;
      acc.qualified += m.qualified;
      acc.appointments += m.appointments;
      acc.showed += m.showed;
      acc.deals += m.deals;
      acc.smsSent += m.smsSent;
      acc.optOuts += m.optOuts;
      acc.afterHours += m.afterHours;
      acc.talkMinutes += m.talkMinutes;
      return acc;
    },
    { revenue: 0, cost: 0, calls: 0, conversations: 0, qualified: 0, appointments: 0, showed: 0, deals: 0, smsSent: 0, optOuts: 0, afterHours: 0, talkMinutes: 0 },
  );
  return {
    ...t,
    roi: t.cost > 0 ? t.revenue / t.cost : 0,
    net: t.revenue - t.cost,
    showRate: t.appointments > 0 ? t.showed / t.appointments : 0,
    connectRate: t.calls > 0 ? t.conversations / t.calls : 0,
  };
}

/* Whole-dealer funnel — monotonic, derived from fleet roll-ups. */
export function fleetFunnel(agents: AgentData[] = AGENTS): { label: string; value: number }[] {
  const f = fleetTotals(agents);
  return [
    { label: "Outreach & calls", value: f.calls + f.smsSent },
    { label: "Conversations", value: f.conversations },
    { label: "Qualified / engaged", value: f.qualified },
    { label: "Appointments set", value: f.appointments },
    { label: "Showed", value: f.showed },
    { label: "Deals & ROs", value: f.deals },
  ];
}

/* ── Overview-only datasets ── */
export const TOP_CAMPAIGNS: { name: string; agent: string; dispatched: number; connect: number; conversions: number; revenue: number }[] = [
  { name: "Service-Drive Trade-In", agent: "Sales OB", dispatched: 210, connect: 34, conversions: 18, revenue: 21400 },
  { name: "Recall (safety)", agent: "Service OB", dispatched: 286, connect: 41, conversions: 38, revenue: 9100 },
  { name: "Equity Mining", agent: "Sales OB", dispatched: 302, connect: 33, conversions: 14, revenue: 14900 },
  { name: "Aged-Lead Re-Engagement", agent: "Sales OB", dispatched: 468, connect: 26, conversions: 11, revenue: 8800 },
  { name: "Due-Service Reminder", agent: "Service OB", dispatched: 402, connect: 33, conversions: 21, revenue: 6300 },
];

// Money left on the table — what the dealer is losing, with a $ estimate.
export const MISSED_OPPORTUNITIES: { title: string; detail: string; value: string }[] = [
  { title: "Missed callbacks", detail: "Inbound voicemails with no follow-up within 24h", value: "~$7.2k" },
  { title: "Low show-rate windows", detail: "Tue/Thu PM appointments showing 12% below average", value: "~$4.5k" },
  { title: "After-hours not yet automated", detail: "Service IB demand 7–9pm running to voicemail", value: "~$3.8k" },
  { title: "Wrong-number / bad data", detail: "Aged-lead list — 22% undeliverable, wasted dials", value: "~$1.9k" },
];

// Compliance posture — the audit-grade hygiene a dealer must be able to show.
export const COMPLIANCE: { label: string; value: string; status: RAG }[] = [
  { label: "DNC scrub coverage", value: "100%", status: "green" },
  { label: "10DLC A2P registration", value: "Registered", status: "green" },
  { label: "Opt-outs honored", value: "40 / 40", status: "green" },
  { label: "Silent-hours violations", value: "0", status: "green" },
  { label: "Exempt (recall) handling", value: "OK", status: "green" },
  { label: "Calls recorded + consented", value: "100%", status: "green" },
];

// Data health — completeness of the data layer the agents run on (ties to missing-data handling).
export const DATA_HEALTH: { label: string; pct: number; status: RAG; note: string }[] = [
  { label: "Phone on file", pct: 99, status: "green", note: "deliverable contact" },
  { label: "Email on file", pct: 71, status: "amber", note: "limits SMS→email fallback" },
  { label: "Owned-vehicle linked", pct: 64, status: "amber", note: "gates equity/lease/trade" },
  { label: "Equity computed (Black Book)", pct: 58, status: "amber", note: "needs Black Book coverage" },
  { label: "Current mileage <6mo", pct: 47, status: "red", note: "stale → low-confidence equity" },
  { label: "Opt-in status known", pct: 96, status: "green", note: "compliance gate" },
];
