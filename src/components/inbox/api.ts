/* Client-side data layer for the Inbox tab. Types mirror the Spyne V2 API responses (see the dev API
 * doc); every fetcher hits our own /api/inbox/* proxy (which authorizes the team + forwards the Spyne
 * token downstream) and degrades to a safe empty value on any error, exactly like liveData.ts. */

export interface InboxAuth {
  teamId: string;
  enterpriseId: string;
  spyneToken?: string;
  spyneEnv?: string;
}

function authHeaders(a: InboxAuth): HeadersInit | undefined {
  return a.spyneToken ? { Authorization: `Bearer ${a.spyneToken}` } : undefined;
}
function withEnv(q: URLSearchParams, a: InboxAuth): void {
  if (a.spyneEnv) q.set("env", a.spyneEnv);
}

/* ── Leads V2 — left-pane customer list ─────────────────────────────────────── */
export interface UnreadCounts {
  totalUnread: number;
  chatUnread: number;
  callUnread: number;
  emailUnread: number;
  smsUnread: number;
}
export interface InboxCustomer {
  customer_id: string;
  customer_name: string;
  email_id: string | null;
  mobile_number: string | null;
  createdAt: string;
  lastInteractionTime: string | null;
  unreadCounts?: UnreadCounts;
  // Optional fields some responses include; rendered only when present (the documented shape omits them).
  lastMessage?: string | null;
  temperature?: string | null;
}
export interface LeadsPage {
  customers: InboxCustomer[];
  pagination: {
    currentPage: number;
    totalPages: number;
    totalCustomers: number;
    hasNext: boolean;
    hasPrevious: boolean;
    limit: number;
    unreadCount: number;
  };
}

export interface LeadsQuery {
  page?: number;
  limit?: number;
  unreadOnly?: boolean;
  searchTerm?: string;
  startDate?: string;
  endDate?: string;
  leadType?: string[];
  leadSource?: string[];
  department?: "sales" | "service";
}

const EMPTY_PAGE: LeadsPage = {
  customers: [],
  pagination: { currentPage: 1, totalPages: 1, totalCustomers: 0, hasNext: false, hasPrevious: false, limit: 25, unreadCount: 0 },
};

export async function fetchInboxCustomers(a: InboxAuth, q: LeadsQuery = {}): Promise<LeadsPage> {
  if (!a.teamId || !a.enterpriseId) return EMPTY_PAGE;
  const p = new URLSearchParams({ team_id: a.teamId, enterprise_id: a.enterpriseId });
  p.set("page", String(q.page ?? 1));
  p.set("limit", String(q.limit ?? 25));
  if (q.unreadOnly) p.set("unreadOnly", "1");
  if (q.searchTerm) p.set("searchTerm", q.searchTerm);
  if (q.startDate) p.set("startDate", q.startDate);
  if (q.endDate) p.set("endDate", q.endDate);
  for (const t of q.leadType ?? []) p.append("leadType", t);
  for (const s of q.leadSource ?? []) p.append("leadSource", s);
  if (q.department) p.set("department", q.department);
  withEnv(p, a);
  try {
    const r = await fetch(`/api/inbox/customers?${p}`, { cache: "no-store", headers: authHeaders(a) });
    const j = (await r.json().catch(() => null)) as LeadsPage | null;
    if (!r.ok || !j || !Array.isArray(j.customers)) return EMPTY_PAGE;
    return { customers: j.customers, pagination: { ...EMPTY_PAGE.pagination, ...j.pagination } };
  } catch {
    return EMPTY_PAGE;
  }
}

/* ── Conversations V2 — right-pane feed for one customer ────────────────────── */
// One SMS bubble. The AI side ("assistant") wraps its text in a JSON envelope
// {text, message_reason}; the customer side ("user") is plain text. `_ts` is epoch-ms.
export interface SmsMessage {
  role: "assistant" | "user" | string;
  content: string;
  toolCallId?: string | null;
  toolCalls?: ToolCall[] | null;
  _ts?: number;
}
export interface CallData {
  callDuration?: string; // seconds, as a string ("81.206")
  agentName?: string | null;
  transcript?: string; // "AI: …\nCustomer: …" newline-separated
  recordingUrl?: string | null; // presigned S3 mp3 (range-enabled, ~24h TTL)
  callType?: string; // "inboundPhoneCall" | "outboundPhoneCall"
  endedReason?: string; // "customer_hangup", "voicemail", …
  interestedVehicles?: unknown[];
}
export interface ConvRecord {
  conversationId: string;
  type: "call" | "sms";
  status: string;
  createdAt: string;
  updatedAt: string;
  isAI?: boolean;
  isUnread?: boolean;
  aiMode?: string; // "auto" = Vini driving; other = a human took over
  replied?: boolean;
  callId?: string | null;
  callTitle?: string | null;
  callData?: CallData;
  smsMessages?: SmsMessage[];
  serviceNumberE164?: string | null;
  customerDetails?: { customerId: string; name: string; email?: string[]; phone?: string; createdAt?: string };
  stats?: { message_count: number; email_count: number; sms_count: number; last_activity: string; duration_days: number };
  direction?: string | null;
}
export interface LeadJourneyEvent {
  eventType: string;
  timestamp: string;
  leadId?: string;
  campaignName?: string;
  source?: string;
  channel?: string;
  status?: string;
  outcome?: string;
}
export interface LeadSummary {
  lead_id: string;
  temperature?: string | null;
  stage?: string | null;
  source?: string | null;
  service_type?: string | null;
  ai_score?: number | null;
  stopAiEngagement?: boolean;
  createdAt?: string;
  updatedAt?: string;
}
export interface AppointmentItem {
  meeting_id?: string;
  intent?: string; // e.g. "schedule_test_drive"
  meeting_start_time?: string;
  meeting_end_time?: string;
  timezone?: string;
  status?: string;
  tags?: string[];
  proposed_vins?: string[];
  source?: string;
  conversation_id?: string; // the conversation that booked it → used for inbound/outbound attribution
  assigned_to?: string;
  [k: string]: unknown;
}
export interface ActionItem {
  _id?: string;
  id?: string;
  action_item_id?: string;
  actionItemId?: string;
  intent?: string;
  description?: string;
  summary?: string | null;
  priority?: string;
  due_date?: string;
  is_active?: boolean;
  is_completed?: boolean;
  service_type?: string;
  meta?: { vehicle_details?: { make?: string; model?: string; year?: string; trim?: string } };
  [k: string]: unknown;
}
export interface ConversationsV2 {
  conversations: ConvRecord[];
  nextActionItems: ActionItem[];
  nextAppointments: AppointmentItem[];
  nextScheduledTasks: unknown[];
  leadJourney: LeadJourneyEvent[];
  leads: LeadSummary[];
}

const EMPTY_CONV: ConversationsV2 = {
  conversations: [], nextActionItems: [], nextAppointments: [], nextScheduledTasks: [], leadJourney: [], leads: [],
};

export async function fetchInboxConversations(
  a: InboxAuth,
  customerId: string,
  opts: { type?: "call" | "sms"; page?: number; limit?: number } = {},
): Promise<ConversationsV2> {
  if (!a.teamId || !a.enterpriseId || !customerId) return EMPTY_CONV;
  const p = new URLSearchParams({ team_id: a.teamId, enterprise_id: a.enterpriseId, customer_id: customerId });
  if (opts.type) p.set("type", opts.type);
  p.set("page", String(opts.page ?? 1));
  p.set("limit", String(opts.limit ?? 30));
  withEnv(p, a);
  try {
    const r = await fetch(`/api/inbox/conversations?${p}`, { cache: "no-store", headers: authHeaders(a) });
    const j = (await r.json().catch(() => null)) as { data?: ConversationsV2 } & Partial<ConversationsV2> | null;
    if (!r.ok || !j) return EMPTY_CONV;
    // The upstream wraps the payload in { status, message, data }; our proxy forwards it verbatim.
    const d = (j.data ?? j) as Partial<ConversationsV2>;
    return {
      conversations: Array.isArray(d.conversations) ? d.conversations : [],
      nextActionItems: Array.isArray(d.nextActionItems) ? d.nextActionItems : [],
      nextAppointments: Array.isArray(d.nextAppointments) ? d.nextAppointments : [],
      nextScheduledTasks: Array.isArray(d.nextScheduledTasks) ? d.nextScheduledTasks : [],
      leadJourney: Array.isArray(d.leadJourney) ? d.leadJourney : [],
      leads: Array.isArray(d.leads) ? d.leads : [],
    };
  } catch {
    return EMPTY_CONV;
  }
}

/* ── Call transcript ────────────────────────────────────────────────────────── */
// A tool invocation as it appears on a `bot`/assistant turn. Real UAT payloads nest the name under
// `function.name` (OpenAI shape); the doc's flat `name` is kept as a fallback.
export interface ToolCall {
  id?: string;
  type?: string;
  name?: string;
  function?: { name?: string; arguments?: unknown };
}
export interface TranscriptTurn {
  role: "assistant" | "bot" | "agent" | "user" | "system" | "tool" | string;
  content?: string;
  secondsFromStart?: number; // offset from call start, for timestamped transcript lines
  time?: number;
  endTime?: number;
  duration?: number;
  // A `role:"tool"` turn carries its (often large, JSON) result here — never render this raw.
  message?: string;
  result?: unknown;
  toolCallId?: string;
  // The AI's tool invocations — the doc uses `toolCalls`; some payloads use snake_case `tool_calls`.
  toolCalls?: ToolCall[];
  tool_calls?: ToolCall[];
}
export async function fetchInboxTranscript(a: InboxAuth, callId: string): Promise<TranscriptTurn[]> {
  if (!a.teamId || !callId) return [];
  const p = new URLSearchParams({ team_id: a.teamId, callId });
  withEnv(p, a);
  try {
    const r = await fetch(`/api/inbox/transcript?${p}`, { cache: "no-store", headers: authHeaders(a) });
    const j = (await r.json().catch(() => null)) as { data?: TranscriptTurn[] } | TranscriptTurn[] | null;
    if (!r.ok || !j) return [];
    const arr = Array.isArray(j) ? j : Array.isArray(j.data) ? j.data : [];
    return arr as TranscriptTurn[];
  } catch {
    return [];
  }
}

/* ── Persona (View Details) ─────────────────────────────────────────────────── */
// Every persona attribute arrives as this envelope: the value plus how sure the AI is (confidence 0..1)
// and whether it was CONFIRMED by the customer or merely INFERRED. "NOT_DISCUSSED"/null ⇒ not captured.
export interface PField<T = string | number> {
  value?: T | null;
  status?: string | null;     // CONFIRMED | INFERRED | null
  confidence?: number | null; // 0..1
  updatedAt?: string | null;
}
// A vehicle the customer looked at beyond their primary interest (vehicleInterest.watchedOtherVehicles).
export interface WatchedVehicle {
  make?: string | null; model?: string | null; year?: number | null; color?: string | null;
  watchedPrice?: number | null; vin?: string | null; dealerVinId?: string | null;
  confidence?: number | null; createdAt?: string | null; lastEngagedAt?: string | null;
}
export interface Persona {
  customerId?: string;
  conversationMemory?: { summaryShort?: string; topMotivations?: string[]; topObjections?: string[]; doNotRepeat?: string[] };
  customerPreferences?: {
    finance?: {
      budgetMax?: PField<number | string>;
      monthlyBudgetMax?: PField<number | string>;
      paymentMethod?: PField<string>; // FINANCE | LEASE | CASH
    };
    vehicleInterest?: {
      make?: PField<string>; model?: PField<string>; year?: PField<number | string>; trim?: PField<string>;
      bodyType?: PField<string>; color?: PField<string>; price?: PField<number>; vin?: PField<string>;
      conditionPreference?: PField<string>; dealerVinId?: PField<string>;
      lastEngagedAt?: string | null;
      vehicleSignals?: { makes?: string[]; models?: string[]; bodyTypes?: string[]; colors?: string[]; trims?: string[]; years?: (number | string)[] };
      vehiclePreferences?: { featurePreference?: string[]; fuelTypePreference?: string | null; transmissionPreference?: string | null; useCase?: string | null };
      watchedOtherVehicles?: WatchedVehicle[];
    };
  };
  purchaseIntent?: { stage?: PField<string>; timelineToBuy?: PField<string>; hotLeadScore?: number | null };
  tradeVehicles?: { vehicle?: { make?: string; model?: string; year?: number } }[];
  decisionContext?: { motivations?: { value: string }[]; painPoints?: { value: string }[]; objections?: { value: string }[] };
  engagement?: { lastContactedAt?: string; lastSmsContactAt?: string; lastCallContactAt?: string };
  appointmentIntent?: { status?: PField<string> };
}
/* ── parsing helpers ────────────────────────────────────────────────────────── */
// Classify one SMS message's content.
//   kind "text"  → a real, customer-facing message. Assistant messages arrive as a JSON envelope
//                  {text, message_reason}; user messages are plain strings.
//   kind "tool"  → a tool RESULT payload the model emitted ({status:…}, {success:…}) — NOT customer-
//                  facing. Never render its raw JSON; surface a one-line `summary` as a trace instead.
export function parseSmsText(content: string): { kind: "text" | "tool"; text: string; reason?: string; summary?: string } {
  const raw = (content || "").trim();
  if (raw.startsWith("{")) {
    try {
      const j = JSON.parse(raw) as { text?: string; message_reason?: string; message?: string; status?: string; success?: boolean };
      if (typeof j.text === "string") return { kind: "text", text: j.text, reason: j.message_reason };
      // No customer-facing `text` → this is a tool result. Summarize it, don't dump the JSON.
      const summary = typeof j.message === "string" ? j.message : typeof j.status === "string" ? j.status : "Completed an action";
      return { kind: "tool", text: "", summary };
    } catch {
      /* not JSON — fall through to plain text */
    }
  }
  return { kind: "text", text: raw };
}

// Split an inline call transcript ("AI: …\nCustomer: …") into speaker-attributed turns.
export function parseCallTranscript(transcript: string): { speaker: "AI" | "Customer" | string; text: string }[] {
  return (transcript || "")
    .split(/\n+/)
    .map((line) => {
      const m = line.match(/^\s*(AI|Assistant|Bot|Customer|User|Caller)\s*:\s*(.*)$/i);
      if (m) {
        const s = m[1].toLowerCase();
        return { speaker: s === "customer" || s === "user" || s === "caller" ? "Customer" : "AI", text: m[2].trim() };
      }
      return { speaker: "AI", text: line.trim() };
    })
    .filter((t) => t.text);
}

/* ── Message feedback (§03) ─────────────────────────────────────────────────── */
// Thumb direction isn't a first-class field in the feedback API, so we carry it in `metadata.rating`
// and use the free-text `feedback` for the optional thumbs-down note.
export interface MessageFeedback {
  _id?: string;
  conversationId: string;
  channel: string;
  messageIndex: number;
  message?: string;
  feedback?: string;
  status?: string;
  priority?: string;
  reportedBy?: string;
  metadata?: { rating?: "up" | "down"; [k: string]: unknown };
  createdAt?: string;
  updatedAt?: string;
}

export async function fetchInboxFeedback(a: InboxAuth, conversationId: string): Promise<MessageFeedback[]> {
  if (!a.teamId || !conversationId) return [];
  const p = new URLSearchParams({ team_id: a.teamId, conversationId });
  withEnv(p, a);
  try {
    const r = await fetch(`/api/inbox/feedback?${p}`, { cache: "no-store", headers: authHeaders(a) });
    const j = (await r.json().catch(() => null)) as { data?: MessageFeedback[] } | MessageFeedback[] | null;
    if (!r.ok || !j) return [];
    const arr = Array.isArray(j) ? j : Array.isArray((j as { data?: MessageFeedback[] }).data) ? (j as { data: MessageFeedback[] }).data : [];
    return arr;
  } catch {
    return [];
  }
}

export async function postInboxFeedback(
  a: InboxAuth,
  body: {
    conversationId: string;
    channel: "sms" | "call";
    messageIndex: number;
    message: string;
    rating: "up" | "down";
    note?: string;
    reason?: string; // thumbs-down report category, e.g. "Gave wrong Information"
  },
): Promise<boolean> {
  if (!a.teamId || !body.conversationId) return false;
  const p = new URLSearchParams({ team_id: a.teamId });
  withEnv(p, a);
  const payload = {
    conversationId: body.conversationId,
    channel: body.channel,
    messageIndex: body.messageIndex,
    message: body.message.slice(0, 2000),
    // Upstream requires a non-empty `feedback` — use the note if given, else a default from the rating.
    feedback: (body.note || "").trim() || (body.rating === "up" ? "Marked as a good reply" : "Marked as a poor reply"),
    status: "pending",
    priority: "medium",
    reportedBy: a.teamId,
    metadata: { rating: body.rating, reason: body.reason || undefined, source: "inbox" },
  };
  try {
    const r = await fetch(`/api/inbox/feedback?${p}`, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json", ...(a.spyneToken ? { Authorization: `Bearer ${a.spyneToken}` } : {}) },
      body: JSON.stringify(payload),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/* Resolve (mark complete) or re-open an action item. */
export async function resolveInboxActionItem(a: InboxAuth, actionItemId: string, isCompleted = true): Promise<boolean> {
  if (!a.teamId || !actionItemId) return false;
  const p = new URLSearchParams({ team_id: a.teamId });
  withEnv(p, a);
  try {
    const r = await fetch(`/api/inbox/action-item?${p}`, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json", ...(a.spyneToken ? { Authorization: `Bearer ${a.spyneToken}` } : {}) },
      body: JSON.stringify({ actionItemId, isCompleted }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/* Call intelligence / AI review (GET /conversation/calls/:callUid). */
export interface CallAnalysis {
  outcome?: string | null;
  primaryOutcome?: string | null;
  customerIntent?: string | null;
  primaryIntent?: string | null;
  queryResolved?: boolean | null;
  qualified?: boolean | null;
  summary?: string | null;
  qualityScorePct?: number | null;
  qualityScore?: number | null;
  qualityGrade?: string | null;
  sentimentScore?: number | null;
  customerFrustrated?: boolean | null;
  appointmentScheduled?: boolean | null;
  [k: string]: unknown;
}
export interface CallDetail {
  callUid?: string;
  direction?: string;
  status?: string;
  durationMs?: number;
  recordingUrl?: string | null;
  analysis?: CallAnalysis;
}
export async function fetchInboxCall(a: InboxAuth, callId: string): Promise<CallDetail | null> {
  if (!a.teamId || !callId) return null;
  const p = new URLSearchParams({ team_id: a.teamId, callId });
  withEnv(p, a);
  try {
    const r = await fetch(`/api/inbox/call?${p}`, { cache: "no-store", headers: authHeaders(a) });
    const j = (await r.json().catch(() => null)) as { data?: CallDetail } | CallDetail | null;
    if (!r.ok || !j) return null;
    return ((j as { data?: CallDetail }).data ?? (j as CallDetail)) || null;
  } catch {
    return null;
  }
}

/* The rooftop's IANA timezone (e.g. "America/Los_Angeles") so the UI renders every timestamp in the
 * dealer's local day — same source the reports use. null when unresolved (UI falls back to local tz). */
export async function fetchInboxTimezone(a: InboxAuth): Promise<string | null> {
  if (!a.teamId) return null;
  const p = new URLSearchParams({ team_id: a.teamId });
  withEnv(p, a);
  try {
    const r = await fetch(`/api/inbox/timezone?${p}`, { cache: "no-store", headers: authHeaders(a) });
    const j = (await r.json().catch(() => null)) as { timezone?: string | null } | null;
    return r.ok && j ? j.timezone ?? null : null;
  } catch {
    return null;
  }
}

/* Stop AI engagement for a lead — deletes its sequence workflows (Vini stops outreach). */
export async function stopInboxEngagement(a: InboxAuth, leadId: string): Promise<boolean> {
  if (!a.teamId || !leadId) return false;
  const p = new URLSearchParams({ team_id: a.teamId });
  withEnv(p, a);
  try {
    const r = await fetch(`/api/inbox/stop-engagement?${p}`, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json", ...(a.spyneToken ? { Authorization: `Bearer ${a.spyneToken}` } : {}) },
      body: JSON.stringify({ leadId }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export async function fetchInboxPersona(a: InboxAuth, customerId: string): Promise<Persona | null> {
  if (!a.teamId || !customerId) return null;
  const p = new URLSearchParams({ team_id: a.teamId, customerId });
  withEnv(p, a);
  try {
    const r = await fetch(`/api/inbox/persona?${p}`, { cache: "no-store", headers: authHeaders(a) });
    const j = (await r.json().catch(() => null)) as { data?: Persona } | Persona | null;
    if (!r.ok || !j) return null;
    return ((j as { data?: Persona }).data ?? (j as Persona)) || null;
  } catch {
    return null;
  }
}
