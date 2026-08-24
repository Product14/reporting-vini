/* Client-side data layer for the Inbox tab. Types mirror the Spyne V2 API responses (see the dev API
 * doc); every fetcher hits our own /api/inbox/* proxy (which authorizes the team + forwards the Spyne
 * token downstream) and degrades to a safe empty value on any error, exactly like liveData.ts. */

export interface InboxAuth {
  teamId: string;
  enterpriseId: string;
  spyneToken?: string;
  spyneEnv?: string;
  serviceType?: "sales" | "service"; // department space this iframe is scoped to (?serviceType=)
  userEmail?: string; // logged-in operator — attributes feedback (submittedByEmail)
  userName?: string;  // operator display name (else derived from the email)
  teamName?: string;  // rooftop display name (feedback teamName)
}

function authHeaders(a: InboxAuth): HeadersInit | undefined {
  return a.spyneToken ? { Authorization: `Bearer ${a.spyneToken}` } : undefined;
}

// In-flight request coalescing: when the same resource is requested again while the first request is
// still running (e.g. the thread pane AND the right panel both load a customer's conversations/persona
// at the same instant), they share ONE network call instead of firing duplicates. No caching once it
// resolves — the next request re-fetches fresh — so there's no staleness, only de-duplication.
const _inflight = new Map<string, Promise<unknown>>();
function coalesce<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = _inflight.get(key);
  if (existing) return existing as Promise<T>;
  const p = fn().finally(() => { _inflight.delete(key); });
  _inflight.set(key, p);
  return p as Promise<T>;
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
  // Which date field startDate/endDate filter on (and the sort): lead createdAt vs last_contacted_at.
  sortBy?: "lead" | "conversation";
  // Handover filter (RETCONVAI-2997, UAT): "PENDING" (needs a rep) / "ACTIVE" / "PENDING,ACTIVE" / "NONE".
  humanTransferPhase?: string;
}

const EMPTY_PAGE: LeadsPage = {
  customers: [],
  pagination: { currentPage: 1, totalPages: 1, totalCustomers: 0, hasNext: false, hasPrevious: false, limit: 25, unreadCount: 0 },
};

// A formatted phone ("+1 (952) 261-4576") never matches the stored "+19522614576" because the API
// searches the raw string. When the query is PHONE-LIKE (only digits + phone punctuation), reduce it to
// DIGITS ONLY — the backend substring-matches, so 9522614576 / 19522614576 / +19522614576 all resolve
// regardless of +1, 1, +, or no prefix. Names / customer-IDs / call-IDs / conversation-IDs contain
// letters, so they fail the phone-like test and pass through untouched. (Verified: raw "+3146881478" and
// "+1 3146881478" → 0 results; digits-only → 1.)
function normalizeSearchTerm(raw: string): string {
  const t = raw.trim();
  const digits = t.replace(/\D/g, "");
  const phoneLike = digits.length >= 4 && digits.length <= 15 && /^[+\d\s().\-]+$/.test(t);
  return phoneLike ? digits : t;
}

export async function fetchInboxCustomers(a: InboxAuth, q: LeadsQuery = {}): Promise<LeadsPage> {
  if (!a.teamId || !a.enterpriseId) return EMPTY_PAGE;
  const p = new URLSearchParams({ team_id: a.teamId, enterprise_id: a.enterpriseId });
  p.set("page", String(q.page ?? 1));
  p.set("limit", String(q.limit ?? 25));
  if (q.unreadOnly) p.set("unreadOnly", "1");
  if (q.searchTerm) p.set("searchTerm", normalizeSearchTerm(q.searchTerm));
  if (q.startDate) p.set("startDate", q.startDate);
  if (q.endDate) p.set("endDate", q.endDate);
  for (const t of q.leadType ?? []) p.append("leadType", t);
  if (q.sortBy) p.set("sortBy", q.sortBy);
  if (q.humanTransferPhase) p.set("humanTransferPhase", q.humanTransferPhase);
  if (a.serviceType) p.set("serviceType", a.serviceType); // department scope (sales|service)
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

/* ── Team conversations — FLAT (ungrouped) list, one row per conversation ─────
 * GET /conversation/customers/conversations/team — powers the "Group by: None" view and the
 * channel tabs (All/SMS/Calls/Email). Sorted latest-first; empty/test conversations excluded.
 * Exact `type` match (sms ≠ chat). customer.* may be null when the lead→customer lookup is missing. */
// The team endpoint MAY enrich each row with inline message content (newer API revision): calls get
// `transcript` (last ~10 turns), sms/chat get `smsMessages` (newest-first, ≤10). Both are optional — an
// older/simpler revision returns metadata only, so everything downstream treats them as best-effort.
export interface TeamTranscriptTurn {
  role?: string; // bot | user | tool
  message?: string | null;
  content?: string | null;
  time?: number; // ms epoch of the turn
  secondsFromStart?: number; // offset from call start — powers click-to-seek in the call drawer
  toolCalls?: ToolCall[] | null;
}
export interface TeamConversation {
  conversationId: string;
  type: "call" | "sms" | "email" | "chat" | string;
  status: string;
  leadId: string | null;
  isUnread: boolean;
  createdAt: string;
  updatedAt: string;
  callId?: string | null;
  customer: { customerId: string | null; name: string | null; mobileNumber: string | null };
  transcript?: TeamTranscriptTurn[]; // call rows (chronological)
  smsMessages?: SmsMessage[]; // sms/chat rows (newest-first)
}
export interface TeamConversationsPage {
  conversations: TeamConversation[];
  pagination: { total: number; page: number; limit: number; totalPages: number; hasNext: boolean; hasPrev: boolean };
}
export interface TeamConvQuery {
  page?: number;
  limit?: number;
  type?: "call" | "sms" | "email" | "chat";
  unreadOnly?: boolean;
}
const EMPTY_TEAM_PAGE: TeamConversationsPage = {
  conversations: [],
  pagination: { total: 0, page: 1, limit: 25, totalPages: 1, hasNext: false, hasPrev: false },
};
export async function fetchInboxTeamConversations(a: InboxAuth, q: TeamConvQuery = {}): Promise<TeamConversationsPage> {
  if (!a.teamId || !a.enterpriseId) return EMPTY_TEAM_PAGE;
  const p = new URLSearchParams({ team_id: a.teamId, enterprise_id: a.enterpriseId });
  p.set("page", String(q.page ?? 1));
  p.set("limit", String(q.limit ?? 25));
  if (q.type) p.set("type", q.type);
  if (q.unreadOnly) p.set("unreadOnly", "1");
  if (a.serviceType) p.set("serviceType", a.serviceType); // department scope (sales|service)
  withEnv(p, a);
  try {
    const r = await fetch(`/api/inbox/conversations-team?${p}`, { cache: "no-store", headers: authHeaders(a) });
    const j = (await r.json().catch(() => null)) as { data?: { conversations?: unknown }; pagination?: unknown } | null;
    if (!r.ok || !j) return EMPTY_TEAM_PAGE;
    const conversations = Array.isArray(j.data?.conversations) ? (j.data!.conversations as TeamConversation[]) : [];
    const pg = (j.pagination ?? {}) as Partial<TeamConversationsPage["pagination"]>;
    return { conversations, pagination: { ...EMPTY_TEAM_PAGE.pagination, ...pg } };
  } catch {
    return EMPTY_TEAM_PAGE;
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
  // Human-handover (RETCONVAI-2997, UAT-only): a rep's manual turn during an ACTIVE handover carries
  // authorUserId + authorName (resolved server-side). On v2 there's NO authorType/direction — detect a rep
  // turn by role "assistant" + a present authorUserId. authorType is the v1 shape. All read defensively.
  authorType?: string | null; // v1 only: "ai" | "human"
  authorUserId?: string | null; // present only on human-authored turns
  authorName?: string | null;
  human_assistant_id?: string | null; // marks the backend-injected role:"system" claim/hand-back notices
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
export interface EmailMessage {
  emailMessageId?: string;
  direction?: string; // "outbound" | "inbound"
  role?: string; // "ai" | "human"
  status?: string; // outbound: sent | opened | replied; inbound: received
  subject?: string | null;
  body?: string | null; // HTML on composed sends, plain text on replies
  from?: string | null;
  to?: string | null;
  sentAt?: string | null; // the send time (dev-confirmed); null on inbound replies — fall back to createdAt
  openedAt?: string | null;
  createdAt?: string | null;
}
// SMS human-handover state (RETCONVAI-2997, UAT-only). Lives on an sms/chat ConvRecord. `phase` drives the UI:
//   NONE = Vini owns replies · PENDING = Vini flagged for a rep (show "Take over") · ACTIVE = a rep is replying (Vini silent).
export interface HumanTransferDetails {
  phase?: "NONE" | "PENDING" | "ACTIVE" | string;
  triggerReason?: string | null; // why Vini escalated (e.g. "AI_CANNOT_HANDLE", "explicit_request")
  handoverSummary?: string | null; // Vini's short note to the rep on what the customer needs
  aiFlaggedAt?: string | null; // when Vini raised the flag (used to pick the newest PENDING)
  claimedByUserId?: string | null;
  claimedByName?: string | null;
  claimedAt?: string | null;
  requestedAt?: string | null;
  claimHistory?: unknown[];
}
export interface ConvRecord {
  conversationId: string;
  type: "call" | "sms" | "chat" | "email"; // chat = website widget (messages in smsMessages); email = bodies in emailMessages
  status: string;
  humanTransferDetails?: HumanTransferDetails | null; // UAT-only; present on sms/chat records when handover is in play
  createdAt: string;
  updatedAt: string;
  isAI?: boolean;
  isUnread?: boolean;
  aiMode?: string; // "auto" = Vini driving; other = a human took over
  replied?: boolean;
  callId?: string | null;
  callTitle?: string | null;
  callData?: CallData;
  smsMessages?: SmsMessage[]; // sms AND chat conversations both carry their bubbles here
  emailMessages?: EmailMessage[]; // email conversations only
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
  // meta carries the SOURCE conversation/call the item was created from — used to attribute it to an
  // inbound vs outbound touch (there's no top-level direction field). INVAI-4952/-4960.
  meta?: { conversationId?: string; callSid?: string; customer_id?: string; vehicle_details?: { make?: string; model?: string; year?: string; trim?: string } };
  [k: string]: unknown;
}
// Handover conflict (RETCONVAI-2997): a customer should only ever have ONE conversation needing a rep.
// If >1 in-progress conversation is PENDING/ACTIVE at once, that's a data inconsistency — show an error,
// not a picker. Scoped to the fetched page.
export interface HumanTransferConflict {
  hasConflict: boolean;
  conversationIds: string[];
}
export interface ConversationsV2 {
  conversations: ConvRecord[];
  nextActionItems: ActionItem[];
  nextAppointments: AppointmentItem[];
  nextScheduledTasks: unknown[];
  leadJourney: LeadJourneyEvent[];
  leads: LeadSummary[];
  stopAiEngagement?: boolean; // aggregate engagement-stopped flag from conversations/v2 (persisted state)
  humanTransferConflict?: HumanTransferConflict | null; // UAT handover conflict guard (flat on v2 data)
}

const EMPTY_CONV: ConversationsV2 = {
  conversations: [], nextActionItems: [], nextAppointments: [], nextScheduledTasks: [], leadJourney: [], leads: [], stopAiEngagement: false,
};

export async function fetchInboxConversations(
  a: InboxAuth,
  customerId: string,
  opts: { type?: "call" | "sms" | "chat" | "email"; page?: number; limit?: number; conversationId?: string } = {},
): Promise<ConversationsV2> {
  if (!a.teamId || !a.enterpriseId || !customerId) return EMPTY_CONV;
  const p = new URLSearchParams({ team_id: a.teamId, enterprise_id: a.enterpriseId, customer_id: customerId });
  if (opts.type) p.set("type", opts.type);
  if (opts.conversationId) p.set("conversation_id", opts.conversationId); // load ONE specific conversation

  p.set("page", String(opts.page ?? 1));
  p.set("limit", String(opts.limit ?? 30));
  // MUST send serviceType matching the space: conversations/v2 DEFAULTS to sales when it's absent, so a
  // Service customer (no sales data) comes back empty ("No conversation history") without it. Sales space
  // → sales thread, Service space → service thread. (The backend now handles this correctly post-deploy.)
  if (a.serviceType) p.set("serviceType", a.serviceType);
  withEnv(p, a);
  const key = `conv:${p.toString()}`;
  return coalesce(key, async () => {
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
        stopAiEngagement: d.stopAiEngagement === true, // aggregate flag (true if any matched lead is stopped)
        humanTransferConflict: d.humanTransferConflict ?? null, // UAT handover conflict (flat on v2 data)
      };
    } catch {
      return EMPTY_CONV;
    }
  });
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

// Derive a display name from an email local-part ("donald.blanchat@x.com" → "Donald Blanchat").
function nameFromEmail(email?: string): string {
  const local = (email || "").split("@")[0];
  if (!local) return "";
  return local.split(/[._-]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

export async function postInboxFeedback(
  a: InboxAuth,
  body: {
    conversationId: string;
    channel: "sms" | "call" | "chat";
    messageIndex: number;
    message: string;
    rating: "up" | "down";
    note?: string;
    reason?: string; // thumbs-down report category, e.g. "Gave wrong Information"
    callId?: string;
    conversationTitle?: string;
    agentName?: string;
  },
): Promise<boolean> {
  if (!a.teamId || !body.conversationId) return false;
  const p = new URLSearchParams({ team_id: a.teamId });
  withEnv(p, a);
  // New feedback contract: POST /conversation/feedbacks/entries. The reporter (submittedByEmail), the
  // enterprise, and the team are attached HERE (from the iframe scope) so the reporting table has them.
  const perTurn = body.channel !== "call"; // SMS thumbs are per-message; a call report is conversation-level
  const comment = [body.reason ? `[${body.reason}]` : "", (body.note || "").trim()].filter(Boolean).join(" ").trim();
  const payload = {
    conversationType: body.channel === "call" ? "voice_call" : body.channel, // enum: voice_call | sms | chat
    conversationId: body.conversationId,
    callId: body.callId || undefined,
    conversationTitle: body.conversationTitle || (!perTurn ? (body.message || undefined) : undefined),
    agentName: body.agentName || undefined,
    feedbackScope: perTurn ? "per_turn" : "conversation_level",
    turnIndex: perTurn ? body.messageIndex : -1,
    messageText: perTurn ? body.message.slice(0, 2000) : undefined,
    rating: body.rating,
    comment: comment || undefined,
    submittedByEmail: a.userEmail || undefined,
    submittedByName: a.userName || nameFromEmail(a.userEmail) || undefined,
    enterpriseId: a.enterpriseId || undefined,
    teamId: a.teamId,
    teamName: a.teamName || undefined,
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

/* A team's onboarded AI agent — real display name + avatar photo (imageUrl), split by department
 * (agentType) and direction (agentCallType). Used to label the AI side of a conversation. */
export interface OnboardedAgent {
  name?: string;
  imageUrl?: string;
  agentType?: string;     // "Sales" | "Service"
  agentCallType?: string; // "inbound" | "outbound"
  isOnboarded?: boolean;
  [k: string]: unknown;
}
export async function fetchInboxAgents(a: InboxAuth): Promise<OnboardedAgent[]> {
  if (!a.teamId) return [];
  const p = new URLSearchParams({ team_id: a.teamId });
  withEnv(p, a);
  try {
    const r = await fetch(`/api/inbox/agents?${p}`, { cache: "no-store", headers: authHeaders(a) });
    const j = (await r.json().catch(() => null)) as OnboardedAgent[] | { data?: OnboardedAgent[] } | null;
    const arr = Array.isArray(j) ? j : Array.isArray((j as { data?: OnboardedAgent[] })?.data) ? (j as { data: OnboardedAgent[] }).data : [];
    return arr;
  } catch {
    return [];
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

/* ── SMS human handover (RETCONVAI-2997) — UAT-ONLY ──────────────────────────────
 * Every fn short-circuits unless spyneEnv === "uat" so nothing can fire on prod even if a caller forgets
 * to gate the UI; the proxies enforce the same rule server-side. */
export interface HandoverResult {
  ok: boolean;
  status: number;
  phase?: string | null; // the conversation's phase AFTER the toggle (NONE | PENDING | ACTIVE)
  conversationId?: string | null; // echoed back — the conversation the toggle acted on
  error?: string;
}
const HANDOVER_ENABLED = (a: InboxAuth) => a.spyneEnv === "uat";

// The actionable handover for a customer, resolved server-side from the V1 endpoint (V2 lacks the field).
export interface HandoverState {
  phase: "NONE" | "PENDING" | "ACTIVE" | string;
  conversationId?: string; // the conversation /handover/toggle + /send operate on
  handoverSummary?: string | null;
  triggerReason?: string | null;
  claimedByName?: string | null;
}
const HANDOVER_NONE: HandoverState = { phase: "NONE" };

// UAT-only; degrades to NONE on prod / any error so the thread never breaks.
export async function fetchHandoverState(a: InboxAuth, customerId: string): Promise<HandoverState> {
  if (!HANDOVER_ENABLED(a) || !a.teamId || !a.enterpriseId || !customerId) return HANDOVER_NONE;
  const p = new URLSearchParams({ team_id: a.teamId, enterprise_id: a.enterpriseId, customer_id: customerId });
  withEnv(p, a);
  try {
    const r = await fetch(`/api/inbox/handover/state?${p}`, { cache: "no-store", headers: authHeaders(a) });
    const j = (await r.json().catch(() => null)) as HandoverState | null;
    if (!r.ok || !j || !j.phase) return HANDOVER_NONE;
    return { phase: j.phase, conversationId: j.conversationId, handoverSummary: j.handoverSummary, triggerReason: j.triggerReason, claimedByName: j.claimedByName };
  } catch {
    return HANDOVER_NONE;
  }
}

// Claim (PENDING→ACTIVE) or hand back (ACTIVE→NONE) — the endpoint picks the action from current phase.
export async function postHandoverToggle(a: InboxAuth, conversationId: string): Promise<HandoverResult> {
  if (!HANDOVER_ENABLED(a)) return { ok: false, status: 404, error: "not_available" };
  if (!a.teamId || !conversationId) return { ok: false, status: 400, error: "missing params" };
  const p = new URLSearchParams({ team_id: a.teamId });
  withEnv(p, a);
  try {
    const r = await fetch(`/api/inbox/handover/toggle?${p}`, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json", ...(a.spyneToken ? { Authorization: `Bearer ${a.spyneToken}` } : {}) },
      body: JSON.stringify({ conversationId }),
    });
    const j = (await r.json().catch(() => null)) as { phase?: string; conversationId?: string; data?: { phase?: string; conversationId?: string }; error?: string } | null;
    return { ok: r.ok, status: r.status, phase: j?.phase ?? j?.data?.phase ?? null, conversationId: j?.conversationId ?? j?.data?.conversationId ?? null, error: r.ok ? undefined : j?.error || `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, status: 0, error: String(e) };
  }
}

// Send a manual SMS as the rep — requires the conversation to already be ACTIVE (claim first).
export async function postHandoverSend(a: InboxAuth, conversationId: string, body: string): Promise<HandoverResult> {
  if (!HANDOVER_ENABLED(a)) return { ok: false, status: 404, error: "not_available" };
  const text = (body || "").trim();
  if (!a.teamId || !conversationId || !text) return { ok: false, status: 400, error: "missing params" };
  const p = new URLSearchParams({ team_id: a.teamId });
  withEnv(p, a);
  try {
    const r = await fetch(`/api/inbox/handover/send?${p}`, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json", ...(a.spyneToken ? { Authorization: `Bearer ${a.spyneToken}` } : {}) },
      body: JSON.stringify({ conversationId, body: text }),
    });
    const j = (await r.json().catch(() => null)) as { error?: string } | null;
    return { ok: r.ok, status: r.status, error: r.ok ? undefined : j?.error || `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, status: 0, error: String(e) };
  }
}

export async function fetchInboxPersona(a: InboxAuth, customerId: string): Promise<Persona | null> {
  if (!a.teamId || !customerId) return null;
  const p = new URLSearchParams({ team_id: a.teamId, customerId });
  withEnv(p, a);
  // Coalesced: the thread pane (summary) and both detail panels request the same persona at once.
  return coalesce(`persona:${p.toString()}`, async () => {
    try {
      const r = await fetch(`/api/inbox/persona?${p}`, { cache: "no-store", headers: authHeaders(a) });
      const j = (await r.json().catch(() => null)) as { data?: Persona } | Persona | null;
      if (!r.ok || !j) return null;
      return ((j as { data?: Persona }).data ?? (j as Persona)) || null;
    } catch {
      return null;
    }
  });
}
