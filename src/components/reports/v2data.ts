/* ────────────────── Reporting V2 — the narrative ("Impact") report ──────────────────
 * V2 reframes reporting from a metric grid into the story the dealer needs to hear,
 * in order, across the first 90 days:
 *
 *   1. TRUST            — "Is the AI as good as my human? Is it breaking anything?"
 *   2. CAUGHT FOR YOU   — "What was leaking before Vini that we now capture?"
 *   3. GROWTH           — insights (numbers → an automatic fix-list) + what to turn on / launch next.
 *
 * Distilled from the 03 Jun reporting working session (Reporting subhav.m4a) and the
 * Reporting V1 one-pager. Quantitative heroes derive live from the existing fleet data
 * (src/components/reports/data.ts); the narrative blocks below are authored Phase-1
 * content, swapped for live aggregation in Phase 2 — same as the rest of /reports.
 * ──────────────────────────────────────────────────────────────────────────────────── */

import { AGENTS, type RAG } from "./data";

/* One tab per agent (plus an All-agents rollup) — the report scopes to the selected agent. */
export type Lens = "all" | "sales_ib" | "sales_ob" | "service_ib" | "service_ob";
export const LENSES: { id: Lens; label: string; sub: string; icon: string }[] = [
  { id: "all", label: "All agents", sub: "Every agent", icon: "🏢" },
  { id: "sales_ib", label: "Sales Inbound", sub: "Sales · Inbound", icon: "📞" },
  { id: "sales_ob", label: "Sales Outbound", sub: "Sales · Outbound", icon: "🚀" },
  { id: "service_ib", label: "Service Inbound", sub: "Service · Inbound", icon: "🛎️" },
  { id: "service_ob", label: "Service Outbound", sub: "Service · Outbound", icon: "🔧" },
];

export interface LensTotals {
  calls: number;
  conversations: number;
  qualified: number;
  appointments: number;
  showed: number;
  deals: number;
  revenue: number;
  cost: number;
  smsSent: number;
  afterHours: number;
  talkMinutes: number;
  roi: number;
  cpa: number; // cost per appointment
}

/* Per-lens fleet roll-up. Volume fields are per-day base numbers — the page scales them
 * by the active time-bucket factor, exactly like the other report tabs. */
export function lensTotals(lens: Lens): LensTotals {
  const ags = AGENTS.filter((a) => (lens === "all" ? true : a.id === lens));
  const t = ags.reduce(
    (acc, a) => {
      const m = a.metrics;
      acc.calls += m.calls;
      acc.conversations += m.conversations;
      acc.qualified += m.qualified;
      acc.appointments += m.appointments;
      acc.showed += m.showed;
      acc.deals += m.deals;
      acc.revenue += m.revenue;
      acc.cost += m.cost;
      acc.smsSent += m.smsSent;
      acc.afterHours += m.afterHours;
      acc.talkMinutes += m.talkMinutes;
      return acc;
    },
    { calls: 0, conversations: 0, qualified: 0, appointments: 0, showed: 0, deals: 0, revenue: 0, cost: 0, smsSent: 0, afterHours: 0, talkMinutes: 0 },
  );
  return {
    ...t,
    roi: t.cost > 0 ? t.revenue / t.cost : 0,
    cpa: t.appointments > 0 ? t.cost / t.appointments : 0,
  };
}

/* Which agent is the lens pointing at (null = All), and its direction — drives the
 * inbound/outbound-specific sections without hard-coding the old inbound/outbound lens. */
export function lensAgent(lens: Lens) {
  return lens === "all" ? null : AGENTS.find((a) => a.id === lens) ?? null;
}
export function lensHasInbound(lens: Lens): boolean {
  return lens === "all" || lensAgent(lens)?.dir === "Inbound";
}
export function lensHasOutbound(lens: Lens): boolean {
  return lens === "all" || lensAgent(lens)?.dir === "Outbound";
}
export function lensIsInbound(lens: Lens): boolean {
  return lensAgent(lens)?.dir === "Inbound";
}

/* Calls split by when they came in — after-hours vs during-hours — with appointments booked
 * in each (client ask: bifurcation + appts per bucket). Derived from agent metrics; `afterHours`
 * is captured per agent, during-hours = calls − afterHours. Per-day base — page scales by bucket. */
export function callBifurcation(lens: Lens): {
  afterCalls: number;
  duringCalls: number;
  afterAppts: number;
  duringAppts: number;
} {
  const ags = AGENTS.filter((a) => (lens === "all" ? true : a.id === lens));
  let afterCalls = 0,
    duringCalls = 0,
    afterAppts = 0,
    duringAppts = 0;
  for (const a of ags) {
    const after = a.metrics.afterHours;
    const during = Math.max(0, a.metrics.calls - after);
    const apptRate = a.metrics.calls > 0 ? a.metrics.appointments / a.metrics.calls : 0;
    const aAppts = Math.round(after * apptRate);
    afterCalls += after;
    duringCalls += during;
    afterAppts += aAppts;
    duringAppts += Math.max(0, a.metrics.appointments - aAppts);
  }
  return { afterCalls, duringCalls, afterAppts, duringAppts };
}

/* "If 15 were appointments, what were the rest about?" — intent mix for the lens.
 * The appointment slice is exact; the remaining calls fan out across typical intents. */
export interface IntentBreakdownSlice {
  label: string;
  value: number; // per-day base
  color: string;
  drill: string; // drill-down category key
}
export function intentBreakdown(lens: Lens): IntentBreakdownSlice[] {
  const t = lensTotals(lens);
  const rest = Math.max(0, t.calls - t.appointments);
  const mix = lensHasInbound(lens)
    ? [
        { label: "Pricing / payment", color: "#6366f1", weight: 0.28, drill: "pricing" },
        { label: "Inventory / availability", color: "#813fed", weight: 0.22, drill: "inventory" },
        { label: "Service status", color: "#f59e0b", weight: 0.2, drill: "service-status" },
        { label: "General info", color: "#94a3b8", weight: 0.18, drill: "info" },
        { label: "Callback requested", color: "#0ea5e9", weight: 0.12, drill: "callback" },
      ]
    : [
        { label: "Interested · nurturing", color: "#6366f1", weight: 0.34, drill: "nurturing" },
        { label: "Not now", color: "#f59e0b", weight: 0.3, drill: "not-now" },
        { label: "Not interested", color: "#94a3b8", weight: 0.22, drill: "not-interested" },
        { label: "Callback requested", color: "#0ea5e9", weight: 0.14, drill: "callback" },
      ];
  return [
    { label: "Appointment booked", value: t.appointments, color: "#10b981", drill: "appointments" },
    ...mix.map((m) => ({ label: m.label, value: Math.round(rest * m.weight), color: m.color, drill: m.drill })),
  ];
}

/* Mock customers behind a clickable count — names + call recordings (client ask: drill-down).
 * Seeded by category so SSR and client render identically (no hydration drift). */
const SAMPLE_FIRST = ["Helen", "Robert", "Amit", "James", "Jessica", "Tommy", "Dana", "Luis", "Priya", "Greg", "Sara", "Marcus", "Nina", "Carlos", "Wendy", "Derek", "Maria", "Darnell"];
const SAMPLE_LAST = ["Carter", "Kim", "Lal", "Wu", "Parker", "Lee", "Foster", "Romero", "Nair", "Mason", "Pearce", "Hall", "Ortiz", "Reed", "Singh", "Brooks", "Rivera", "Price"];
const SAMPLE_VEHICLES = ["2024 RAV4 Hybrid", "Certified Camry", "Highlander XLE", "Tacoma TRD", "2021 Camry · 38k", "2019 RAV4 · recall", "2022 Highlander", "Corolla Cross"];
const AFTER_HOURS_WHEN = ["Yesterday · 7:48 PM", "Yesterday · 9:21 PM", "Yesterday · 11:03 PM", "Today · 6:12 AM", "Yesterday · 8:40 PM", "Yesterday · 10:15 PM"];
const DURING_WHEN = ["Today · 9:12 AM", "Today · 11:40 AM", "Today · 2:05 PM", "Today · 8:34 AM", "Today · 3:50 PM", "Today · 1:18 PM"];

export interface SampleCall {
  name: string;
  vehicle: string;
  when: string;
  intent: string;
  durationLabel: string;
}
export function sampleCalls(seed: string, n: number, opts?: { intent?: string; afterHours?: boolean }): SampleCall[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = (Math.imul(h ^ seed.charCodeAt(i), 16777619)) >>> 0;
  const rnd = () => {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    return h / 4294967296;
  };
  const whenPool = opts?.afterHours ? AFTER_HOURS_WHEN : DURING_WHEN;
  return Array.from({ length: n }).map(() => {
    const mins = 1 + Math.floor(rnd() * 6);
    const secs = Math.floor(rnd() * 60);
    return {
      name: `${SAMPLE_FIRST[Math.floor(rnd() * SAMPLE_FIRST.length)]} ${SAMPLE_LAST[Math.floor(rnd() * SAMPLE_LAST.length)]}`,
      vehicle: SAMPLE_VEHICLES[Math.floor(rnd() * SAMPLE_VEHICLES.length)],
      when: whenPool[Math.floor(rnd() * whenPool.length)],
      intent: opts?.intent ?? "Appointment booked",
      durationLabel: `${mins}m ${secs.toString().padStart(2, "0")}s`,
    };
  });
}

/* "3,000 calls would've taken your team 3 years" — the session's headline framing.
 * Grounded in a realistic BDC dialing rate so the math holds up in the room. */
export const DIALS_PER_REP_DAY = 60; // effective outbound attempts a rep makes in a day
export const REP_WORKING_DAYS_PER_YEAR = 230;
export function humanEquivalent(calls: number): { repDays: number; repYears: number } {
  const repDays = calls / DIALS_PER_REP_DAY;
  return { repDays: Math.round(repDays), repYears: repDays / REP_WORKING_DAYS_PER_YEAR };
}

/* ─────────────────────────── 1 · TRUST ─────────────────────────── */

export interface TrustSignal {
  icon: string;
  title: string;
  value: string;
  caption: string;
  status: RAG;
  proof: string;
  trend: number[]; // last 6 periods — drives the inline sparkline (report, not billboard)
  delta: number; // % vs prior period (0 = flat / not meaningful for this metric)
  source: string; // where the number is computed from — see the data-collection spec
}

// "How do I trust the AI isn't making things worse?" — only good, true signals, no jargon.
// `source` ties each one to a real backend signal (see REPORTING_V2_DATA_SPEC.md).
export const TRUST_SIGNALS: TrustSignal[] = [
  {
    icon: "🎯",
    title: "Query resolution held",
    value: "91%",
    caption: "Routine questions resolved without a human — slightly above your team's 88%.",
    status: "green",
    proof: "No drop in resolution since switch-on.",
    trend: [88, 89, 90, 90, 91, 91],
    delta: 1,
    source: "conversation-quality · scores.domain2QueryResolution",
  },
  {
    icon: "😊",
    title: "Customer sentiment",
    value: "82% positive",
    caption: "How callers actually felt — scored on every single conversation.",
    status: "green",
    proof: "Rated 4.5 / 5 across 1,180 calls.",
    trend: [76, 78, 79, 80, 81, 82],
    delta: 2,
    source: "conversation-quality · customerFrustrated (inverse)",
  },
  {
    icon: "⏱️",
    title: "Healthy conversations",
    value: "3m 41s avg",
    caption: "Long enough to help, never rushed — and almost no abrupt hang-ups.",
    status: "green",
    proof: "0.4% calls cut short · no 'quick-back' pattern.",
    trend: [3.2, 3.4, 3.5, 3.6, 3.7, 3.7],
    delta: 0,
    source: "call-performance-metrics · duration + end-reason",
  },
  {
    icon: "📋",
    title: "Follows your playbook",
    value: "100%",
    caption: "Asked for price 214× — Vini followed your 'don't quote' rule every time and offered a callback.",
    status: "green",
    proof: "Your rules, enforced on every call.",
    trend: [100, 100, 99, 100, 100, 100],
    delta: 0,
    source: "conversation-quality · flags / criticalFailures",
  },
  {
    icon: "🧠",
    title: "Context-aware",
    value: "96%",
    caption: "Remembered the prior conversation and picked up where it left off with repeat callers.",
    status: "green",
    proof: "Lead memory on by default.",
    trend: [90, 92, 93, 94, 95, 96],
    delta: 3,
    source: "lead-memory · summary loaded on repeat contact",
  },
  {
    icon: "🔗",
    title: "Your CRM stays in sync",
    value: "0 failures",
    caption: "4,820 CRM updates and 3,140 notes written back — your existing system untouched.",
    status: "green",
    proof: "We add to your CRM — we never break it.",
    trend: [3, 1, 2, 0, 1, 0],
    delta: 0,
    source: "CRM write log vs external_crm_integrations/failed-leads",
  },
];

// Honest about the one thing we can't show yet (raised explicitly in the session).
export const TRUST_GAP = {
  title: "Customers who asked for a human instead of AI",
  body: "The one signal we most want to show you — we're adding this measurement in an upcoming update.",
};

/* The core question from the room: "Is the AI doing everything my human did?"
 * Answer, line by line: at par or better — and honest where a human still wins. */
export interface AtParRow {
  metric: string;
  human: string;
  vini: string;
  verdict: "par" | "better" | "below";
}
export const AT_PAR_ROWS: AtParRow[] = [
  { metric: "Calls answered", human: "61%", vini: "100%", verdict: "better" },
  { metric: "Speed to first touch", human: "~3 hrs", vini: "47 sec", verdict: "better" },
  { metric: "Follow-ups per lead", human: "2", vini: "9", verdict: "better" },
  { metric: "After-hours coverage", human: "None", vini: "24 / 7", verdict: "better" },
  { metric: "Notes logged to CRM", human: "~40%", vini: "100%", verdict: "better" },
  { metric: "Routine questions resolved", human: "88%", vini: "91%", verdict: "better" },
  { metric: "Customer satisfaction", human: "4.4 / 5", vini: "4.5 / 5", verdict: "par" },
  { metric: "Complex, one-off requests", human: "Handled in person", vini: "Routed to your team", verdict: "below" },
];

// Being straight: where Vini isn't winning yet — demonstrates honest down/worse handling.
// Each links to the fix, so a soft spot reads as "being handled," not "broken."
export interface WatchItem {
  item: string;
  detail: string;
  value: string;
  status: RAG;
  action: string;
}
export const WATCH_LIST: WatchItem[] = [
  { item: "Warm-transfer connect rate", detail: "12% of transfers didn't reach a person on the first try.", value: "88%", status: "amber", action: "Set up your employee directory — see Grow" },
  { item: "Long calls on complex trade-ins", detail: "A handful of calls ran past 8 minutes.", value: "6 calls", status: "amber", action: "We're tuning the trade-in flow this week" },
];

// Concerns: sourced from the feedback module — aspects[].status (reported|resolved) + resolvedAt/By.
export const CONCERNS = { raised: 18, resolved: 18, medianHours: 19, source: "feedbacks" };

/* ─────────────────────── 2 · CAUGHT FOR YOU ─────────────────────── */

// What used to leak, and what Vini does with it now (after-hours, overflow, dead leads,
// follow-up persistence, slow response — straight from the session).
export interface RecoveredItem {
  icon: string;
  title: string;
  before: string;
  after: string;
  recovered: string;
  recoveredLabel: string;
}
export const RECOVERED: RecoveredItem[] = [
  {
    icon: "🌙",
    title: "After-hours leads",
    before: "Rang out to voicemail after 6 pm",
    after: "Answered and booked around the clock",
    recovered: "71",
    recoveredLabel: "captured / week",
  },
  {
    icon: "📞",
    title: "Overflow calls",
    before: "Dropped when every rep was busy",
    after: "Picked up instantly, in parallel",
    recovered: "9",
    recoveredLabel: "saved / day",
  },
  {
    icon: "🪦",
    title: "Dead leads in your CRM",
    before: "Sat untouched for 90+ days",
    after: "Re-engaged automatically",
    recovered: "312",
    recoveredLabel: "leads revived",
  },
  {
    icon: "🔁",
    title: "Follow-up persistence",
    before: "Your team stopped after 2 tries",
    after: "8–11 touches across days & channels",
    recovered: "5.5×",
    recoveredLabel: "the cadence",
  },
  {
    icon: "⚡",
    title: "Slow first response",
    before: "First touch ~3 hours later",
    after: "First touch in 47 seconds",
    recovered: "~230×",
    recoveredLabel: "faster",
  },
];

// Top wins — concrete day-by-day stories (multilingual, persistence, revival).
export interface WinStory {
  tag: string;
  customer: string;
  vehicle: string;
  outcome: string;
  steps: { day: string; text: string }[];
  footnote: string;
}
export const WIN_STORIES: WinStory[] = [
  {
    tag: "After-hours · Multilingual",
    customer: "Maria Rivera",
    vehicle: "2024 RAV4 Hybrid",
    outcome: "Booked & purchased",
    steps: [
      { day: "9:42 pm", text: "Called after closing — in Spanish. Vini answered in Spanish." },
      { day: "Same call", text: "Understood what she wanted and booked a 10 am test drive." },
      { day: "Next day", text: "Showed, test drove, signed." },
    ],
    footnote: "Before Vini: after-hours + Spanish meant voicemail — gone by morning.",
  },
  {
    tag: "Persistence",
    customer: "Darnell Price",
    vehicle: "Certified Tacoma",
    outcome: "Appointment booked Day 7",
    steps: [
      { day: "Day 1", text: "Web lead at 11 pm — no answer." },
      { day: "Day 2–4", text: "SMS, then two callbacks across the week." },
      { day: "Day 5", text: "Reached — asked for a weekend slot." },
      { day: "Day 7", text: "Saturday appointment booked." },
    ],
    footnote: "Your team averages 2 attempts. This win took 6.",
  },
  {
    tag: "Dead-lead revival",
    customer: "Priya Nair",
    vehicle: "2022 Highlander · service",
    outcome: "Service RO recovered",
    steps: [
      { day: "96 days cold", text: "Original inquiry never followed up." },
      { day: "Re-engaged", text: "Vini reached out when her service came due." },
      { day: "Booked", text: "Diagnostic appointment scheduled." },
    ],
    footnote: "Hadn't been touched since the very first call.",
  },
];

// Outbound-specific story (connect-rate lift, signal-vs-noise, lower BDC workload).
export const OUTBOUND_STORY = {
  connectBefore: 12,
  connectAfter: 31,
  listSize: 1000,
  qualified: 50,
  workloadBefore: 84,
  workloadAfter: 31,
  influencedAppts: 46,
};

/* ───────────────────────── 3 · GROWTH ───────────────────────── */

// Insight cards: the manual account review, surfaced automatically — finding → cause → fix → $.
export interface Insight {
  kind: "opportunity" | "fix" | "watch";
  finding: string;
  cause: string;
  fix: string;
  impact: string;
  cta: string;
}
export const INSIGHTS: Insight[] = [
  {
    kind: "fix",
    finding: "Tue & Thu PM appointments show up 12% below your average.",
    cause: "No reminder is going out in the 2 hours before those slots.",
    fix: "Send a text reminder 2 hours before each afternoon appointment.",
    impact: "+ ~$4.5k / mo recovered show-rate",
    cta: "Turn on reminders",
  },
  {
    kind: "opportunity",
    finding: "27 web leads last week got their first touch after 5 minutes.",
    cause: "Speed-to-Lead isn't enabled on your website form yet.",
    fix: "Connect the web form to Vini for instant first contact.",
    impact: "+ ~8 appointments / mo",
    cta: "Enable Speed-to-Lead",
  },
  {
    kind: "opportunity",
    finding: "Price was asked on 214 calls — 38% of those didn't book.",
    cause: "Pricing answers are locked by your current rule.",
    fix: "Let Vini share approved price ranges, then book.",
    impact: "+ ~$6k / mo in saved intent",
    cta: "Review pricing rule",
  },
  {
    kind: "watch",
    finding: "Your aged-lead list is running a 22% wrong-number rate.",
    cause: "Stale phone data on older CRM records — not an agent gap.",
    fix: "Refresh the phone numbers on those old records before the next round.",
    impact: "Recover ~$1.9k of wasted dials",
    cta: "Refresh numbers",
  },
];

export const BEST_CONTACT = {
  time: "Tue–Thu, 6–8 pm",
  channel: "SMS first, then call",
  note: "Vini already focuses on this window automatically.",
};

// Month-on-month impact — the "show me the last 3 months" view for the 90-day mark.
export const MONTH_ON_MONTH: { month: string; appts: number; revenue: number }[] = [
  { month: "Month 1", appts: 176, revenue: 142000 },
  { month: "Month 2", appts: 244, revenue: 198000 },
  { month: "Month 3", appts: 312, revenue: 261000 },
];

// Sparkline trends for the Grow hero stats — 6 periods, oldest → newest.
export const GROW_TRENDS = {
  appts: [186, 214, 232, 258, 286, 312],
  roi: [4.8, 5.1, 5.3, 5.6, 5.8, 6.0],
  cpa: [120, 108, 96, 88, 80, 74], // down is good
};

// Capability upsell — the features worth switching on next.
export interface FeatureUpsell {
  icon: string;
  name: string;
  pitch: string;
  proof: string;
  status: "available" | "soon";
  cta: string;
}
export const FEATURE_UPSELLS: FeatureUpsell[] = [
  { icon: "⚡", name: "Speed-to-Lead", pitch: "Touch every new lead in seconds, not minutes.", proof: "50 dealers cut first response 10 min → 10 sec.", status: "available", cta: "Enable" },
  { icon: "🌙", name: "24/7 coverage", pitch: "Let Vini answer every call — nights, weekends, and holidays.", proof: "After-hours is already 23% of captured leads.", status: "available", cta: "Go 24/7" },
  { icon: "💬", name: "Smart Visit widget", pitch: "Turn website visitors into booked appointments.", proof: "Engaged visitors book 2.4× more often.", status: "available", cta: "Add to site" },
  { icon: "💲", name: "Informative mode", pitch: "Let Vini answer pricing & inventory questions, then book.", proof: "38% of price-askers didn't book.", status: "available", cta: "Unlock answers" },
  { icon: "🛡️", name: "Recall Masters", pitch: "Auto-flag and book open safety recalls.", proof: "Compliance-grade, OEM-audit ready.", status: "available", cta: "Connect recalls" },
  { icon: "🤖", name: "Vini Chatbot", pitch: "Web chat with the same brain as your voice agent.", proof: "Goes live in ~15 days.", status: "soon", cta: "Join early access" },
];

// Product upsell — campaign opportunities sitting in the data right now.
export interface CampaignOpp {
  icon: string;
  name: string;
  audience: string;
  spend: string;
  expected: string;
  multiple: string;
  blurb: string;
}
export const CAMPAIGN_OPPS: CampaignOpp[] = [
  { icon: "📅", name: "Lease-expiry win-back", audience: "1,040 leases expiring in 90 days", spend: "$500", expected: "~$5,000", multiple: "10×", blurb: "Reach every expiring lease before the competition does." },
  { icon: "📂", name: "Aged-lead unlock", audience: "4,200 aged leads still unworked", spend: "$700", expected: "~$6,300", multiple: "9×", blurb: "Finish the list Vini already started — you capped at 3,000." },
  { icon: "🔔", name: "No-show win-back", audience: "186 no-shows in the last 30 days", spend: "$300", expected: "~$3,200", multiple: "10×", blurb: "Auto-trigger a rebook the moment a no-show is logged." },
];
