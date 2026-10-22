/* Customer-facing metric definitions, shown in the (i) hover card next to a tile's label (InfoTip in
 * kit.tsx). Written for the dealer, in plain words — no internal terms, formulas or display rules.
 *
 *   summary     one sentence: what the number is
 *   example     a short, everyday situation that would count (never a statistic)
 *   counts      what's included            notCounted   what's left out
 *
 * The meaning behind each Sales one is DESIGN_CONTENT_SPEC.md §3, the canonical glossary: if the meaning
 * changes there, change it here too. Service metrics are defined by Om's /appointment contract
 * (src/lib/serviceOm/contract.ts) and are NOT the same as the Sales ones — e.g. AI-assisted (CRM) on Sales
 * vs Spyne-assisted on Service — so they get their own keys rather than sharing one. */
export interface MetricDefinition {
  title: string;
  summary: string;
  example?: string;
  counts?: string[];
  notCounted?: string[];
}

export const METRIC_DEFINITIONS = {
  /* ── Sales (DESIGN_CONTENT_SPEC.md §3) ── */
  leadsTouched: {
    title: "Leads reached",
    summary: "How many of your leads the AI called or texted.",
    example: "A new internet lead comes in and the AI texts them within minutes.",
  },
  realConversations: {
    title: "Real conversations",
    summary: "Times a customer actually talked with the AI.",
    counts: ["They picked up and spoke", "They texted back"],
    notCounted: ["Voicemails", "Missed or silent calls"],
  },
  qualifiedLeads: {
    title: "Qualified leads",
    summary: "Customers who showed real interest in buying.",
    example: "“Is the white RAV4 still available, and can I trade in my Civic?”",
    counts: ["Asked about a specific car or its price", "Asked about financing or a trade-in", "Wanted a test drive or an appointment"],
    notCounted: ["A reply like “ok” or “thanks” with no buying interest"],
  },
  qualifiedNotBooked: {
    title: "Additional qualified leads",
    summary: "Interested customers who haven't booked an appointment yet.",
    example: "A shopper asked about monthly payments but didn't pick a time to visit.",
    counts: ["Good candidates for a follow-up from your team"],
  },
  closeRate: {
    title: "Close rate",
    summary: "Out of the interested customers, the share who booked an appointment with the AI.",
    example: "10 interested customers and 3 of them booked → 30%.",
  },
  aiBooked: {
    title: "Booked by the AI",
    summary: "Appointments the AI booked by itself.",
    example: "A customer calls at 9 pm, asks about a truck, and the AI books them for Saturday 10 am.",
    counts: ["Booked on a call", "Booked over text"],
  },
  aiAssistedCrm: {
    title: "AI-assisted appointments",
    summary: "Appointments your team booked with a customer the AI had already called or texted.",
    example: "The AI answered a shopper's questions by text; the next day your BDC called them and set the appointment.",
  },
  handoffs: {
    title: "Hand-offs to your team",
    summary: "Times the AI passed a customer to a person on your team.",
    counts: ["Calls the AI transferred to your staff", "Callbacks the customer asked for"],
  },
  responseTime: {
    title: "Speed-to-lead",
    summary: "How quickly the AI reaches out after a new lead comes in, on average.",
    example: "A lead arrives at 2:00 pm and the AI texts them at 2:01 pm — that's 1 minute.",
  },
  callsTexts: {
    title: "Calls & texts",
    summary: "Every conversation the AI handled.",
    counts: ["Phone calls", "Text conversations", "Website chats"],
    notCounted: ["Each individual text message — a whole text thread counts once"],
  },
  talkTime: {
    title: "Talk time",
    summary: "Total time the AI spent on the phone with your customers.",
    example: "That's phone time your staff got back for other work.",
  },
  afterHours: {
    title: "Captured after-hours",
    summary: "Customers the AI handled while your store was closed.",
    example: "A shopper calls on Sunday night — instead of voicemail, the AI answers.",
  },

  /* ── Service (Om /appointment contract) ── */
  bookedBySpyne: {
    title: "Booked by Spyne",
    summary: "Service appointments Spyne booked by itself.",
    example: "A customer calls about an oil change and Spyne books them for Tuesday morning.",
    counts: ["Booked on a call", "Booked over text", "Booked when calling a customer back"],
  },
  // TODO(product): confirm the attribution rule (which bookings count, and within what time) before
  // describing it further. The only source today is the B5 comment in serviceOm/mock.ts, not a signed-off rule.
  spyneAssisted: {
    title: "Spyne-assisted",
    summary: "Service appointments your team booked with a customer Spyne had already helped.",
    example: "Spyne answered the call and transferred it to your service advisor, who booked the visit.",
    counts: ["After Spyne transferred the call", "After Spyne took a callback request", "After the customer told Spyne they wanted to come in"],
  },
} satisfies Record<string, MetricDefinition>;

export type MetricKey = keyof typeof METRIC_DEFINITIONS;
