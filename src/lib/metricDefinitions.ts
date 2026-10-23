/* Customer-facing metric definitions, shown in the (i) hover card next to a tile's label (InfoTip in
 * kit.tsx). Written for the dealer, in plain words — no internal terms, formulas or display rules.
 * Keep them short: one line, at most three ticks.
 *
 *   summary     one sentence: what the number is
 *   example     a short, everyday situation that would count (never a statistic)
 *   counts      what's included            notCounted   what's left out
 *
 * The Sales ones describe the rules the numbers are actually computed by — the canonical ladder in
 * conversational-ai-backend (src/console-reports/canonical-metrics.sql.ts: Reached, Engaged, Qualified
 * rule V12) and the meetings API (AI-booked, AI-assisted). DESIGN_CONTENT_SPEC.md §3 is older than those
 * rules (it still counts a financing or trade-in question as qualified), so if the two disagree, follow
 * the backend. Service metrics are defined by Om's /appointment contract (src/lib/serviceOm/contract.ts)
 * and are NOT the same as the Sales ones — e.g. AI-assisted (CRM) on Sales vs Spyne-assisted on Service —
 * so they get their own keys rather than sharing one. */
export interface MetricDefinition {
  title: string;
  summary: string;
  example?: string;
  counts?: string[];
  notCounted?: string[];
}

export const METRIC_DEFINITIONS = {
  /* ── Sales (canonical backend rules) ── */
  leadsTouched: {
    title: "Leads reached",
    summary: "Customers who had any call or text with the AI, inbound or outbound.",
  },
  realConversations: {
    title: "Real conversations",
    summary: "Customers who actually spoke to the AI or texted back.",
    notCounted: ["Voicemails and missed calls", "STOP replies", "Wrong numbers"],
  },
  qualifiedLeads: {
    title: "Qualified leads",
    summary: "Customers who showed buying interest and gave us something concrete:",
    counts: ["Named a specific car", "Shared a budget", "Asked to visit, test drive, or speak to your team"],
    notCounted: ["A general question with no car, budget or visit"],
  },
  // The tile is labelled "qualified, not yet booked", but since FD-24439 the number is the backend's
  // hot-leads count (current temperature = hot). The label is a product call; this describes the number.
  qualifiedNotBooked: {
    title: "Additional qualified leads",
    summary: "Customers who look ready to buy right now, based on their latest conversations.",
  },
  closeRate: {
    title: "Close rate",
    summary: "AI-booked appointments ÷ qualified leads.",
    example: "3 bookings from 10 qualified leads = 30%.",
  },
  aiBooked: {
    title: "Booked by the AI",
    summary: "Appointments the AI booked on its own, by call or text.",
    notCounted: ["Cancelled appointments"],
  },
  aiAssistedCrm: {
    title: "AI-assisted appointments",
    summary: "Appointments your team booked for a customer who had already talked to or texted back the AI.",
  },
  handoffs: {
    title: "Hand-offs to your team",
    summary: "Times the AI passed a customer to your team: live transfers plus callback requests.",
    notCounted: ["Transfers that didn't connect"],
  },
  responseTime: {
    title: "Speed-to-lead",
    summary: "Average time from a new lead arriving to the AI's first call or text.",
  },
  callsTexts: {
    title: "Calls & texts",
    summary: "Every call, text thread and web chat the AI handled, answered or not.",
  },
  talkTime: {
    title: "Talk time",
    summary: "Total time the AI spent on calls with your customers.",
  },
  afterHours: {
    title: "Captured after-hours",
    summary: "Customers whose first contact came while your store was closed.",
  },

  /* ── Service (Om /appointment contract) ── */
  bookedBySpyne: {
    title: "Booked by Spyne",
    summary: "Service appointments Spyne booked on its own, by call, text or callback.",
  },
  // TODO(product): confirm the attribution rule (which bookings count, and within what time) before
  // describing it further. The only source today is the B5 comment in serviceOm/mock.ts, not a signed-off rule.
  spyneAssisted: {
    title: "Spyne-assisted",
    summary: "Booked by your team after Spyne helped first:",
    counts: ["Spyne transferred the call", "Spyne took a callback request", "The customer told Spyne they'd come in"],
  },
} satisfies Record<string, MetricDefinition>;

export type MetricKey = keyof typeof METRIC_DEFINITIONS;
