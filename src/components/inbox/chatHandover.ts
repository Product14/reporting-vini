/* Client-side data layer for CHATBOT / RECEPTIONIST human-takeover (the NEW chat-service surface).
 *
 * This is a DIFFERENT backend from the Twilio SMS handover in api.ts. Chatbot + receptionist conversations
 * are owned by chat-service (`/chat/sessions/:sessionId/*`) and are addressed by a `sessionId`, not the
 * mirrored `conversationId` the console already holds. A web-chat conversation has no SMS number, so the
 * SMS `/twilio/sms/send` path can't reach it (the Inver Grove Ford P0); chat-service is the real path —
 * claim/hand-back via /handover/toggle, reply via /handover/message, and a live SSE console-stream.
 *
 * Everything here hits our own /api/inbox/chat/* proxy (which authorizes the team + forwards the Spyne
 * token, exactly like the rest of /api/inbox/*), and degrades to a safe empty value on any error. A chat
 * conversation only has a sessionId once the backend adds it to the list/v2 payload, so this whole surface
 * is naturally inert (no chatbot row is driven by it) until then. Ref: ~/Downloads/chatbot-console-integration.md.
 */
import { handoverEnabled } from "@/lib/inbox/handover";
import type { InboxAuth, SmsMessage, ConvRecord } from "./api";

// A chat-service session id lives on a `type:"chat"` ConvRecord once the backend ships it. `chatSessionId`
// is an accepted alias. Returns null for non-chat rows and chat rows that don't (yet) carry one.
export function sessionIdOf(rec: Pick<ConvRecord, "type" | "sessionId" | "chatSessionId">): string | null {
  if (rec.type !== "chat") return null;
  const s = (rec.sessionId || rec.chatSessionId || "").trim();
  return s || null;
}

// Enabled wherever the handover feature switch is on and a team is scoped (mirrors api.ts HANDOVER_ENABLED).
export const chatHandoverEnabled = (a: InboxAuth): boolean => handoverEnabled() && Boolean(a.teamId);

function authHeaders(a: InboxAuth): HeadersInit | undefined {
  return a.spyneToken ? { Authorization: `Bearer ${a.spyneToken}` } : undefined;
}
function base(a: InboxAuth, extra: Record<string, string> = {}): URLSearchParams {
  const p = new URLSearchParams({ team_id: a.teamId, enterprise_id: a.enterpriseId, ...extra });
  if (a.spyneEnv) p.set("env", a.spyneEnv);
  return p;
}

/* One turn as it arrives from `GET messages` or an SSE `turn_result` / `turn_failed`. All fields optional /
 * read defensively — the console route is the only consumer that gets the internal authorUserId/authorName. */
export interface ChatTurn {
  messageId?: string;
  conversationId?: string;
  turnId?: string;
  role?: "assistant" | "user" | "system" | string;
  rowType?: string; // "text" = a normal bubble · "handover_changed" = a claim/release system chip
  status?: string; // "done" | "failed" | …
  content?: string;
  authorType?: string; // "ai" | "human" | "system"  (absent on old rows ⇒ treat as "ai")
  authorDisplayName?: string; // customer-facing name (e.g. "Vini")
  authorUserId?: string | null; // rep's raw id — internal only
  authorName?: string | null; // rep's internal name — internal only
  metadata?: { event?: string; userId?: string; userName?: string; authorDisplayName?: string; [k: string]: unknown } | null;
  error?: string | null;
  createdAt?: string;
}
export interface ChatMessagesResult {
  messages: ChatTurn[];
  phase: "NONE" | "PENDING" | "ACTIVE" | string;
  claimedByUserId?: string | null;
  claimedByName?: string | null;
}
const EMPTY_MESSAGES: ChatMessagesResult = { messages: [], phase: "NONE" };

// Read the phase + claim fields wherever the upstream nests them (handover / handoverState / session / flat).
function readHandover(d: Record<string, unknown>): { phase: string; claimedByUserId?: string | null; claimedByName?: string | null } {
  const h = (d.handover ?? d.handoverState ?? d.session ?? d) as Record<string, unknown>;
  const phase = String(h?.phase ?? d?.phase ?? "NONE") || "NONE";
  return {
    phase,
    claimedByUserId: (h?.claimedByUserId ?? d?.claimedByUserId ?? null) as string | null,
    claimedByName: (h?.claimedByName ?? d?.claimedByName ?? null) as string | null,
  };
}

/* GET /chat/sessions/:sessionId/messages — history + current handover state, in one call. */
export async function fetchChatMessages(a: InboxAuth, sessionId: string): Promise<ChatMessagesResult> {
  if (!chatHandoverEnabled(a) || !sessionId) return EMPTY_MESSAGES;
  const p = base(a, { session_id: sessionId });
  try {
    const r = await fetch(`/api/inbox/chat/messages?${p}`, { cache: "no-store", headers: authHeaders(a) });
    const j = (await r.json().catch(() => null)) as { data?: unknown } & Record<string, unknown> | null;
    if (!r.ok || !j) return EMPTY_MESSAGES;
    const d = ((j.data ?? j) as Record<string, unknown>) || {};
    const raw = (d.messages ?? d.turns ?? d.history) as unknown;
    const messages = Array.isArray(raw) ? (raw as ChatTurn[]) : [];
    return { messages, ...readHandover(d) };
  } catch {
    return EMPTY_MESSAGES;
  }
}

/* POST /chat/sessions/:sessionId/stream-token — mint the short-lived (30-min) token the SSE needs. */
export interface ChatStreamToken { token: string; expiresInSeconds: number; }
export async function mintChatStreamToken(a: InboxAuth, sessionId: string): Promise<ChatStreamToken | null> {
  if (!chatHandoverEnabled(a) || !sessionId) return null;
  const p = base(a, { session_id: sessionId });
  try {
    const r = await fetch(`/api/inbox/chat/stream-token?${p}`, { method: "POST", cache: "no-store", headers: authHeaders(a) });
    const j = (await r.json().catch(() => null)) as { token?: string; expiresInSeconds?: number; data?: { token?: string; expiresInSeconds?: number } } | null;
    if (!r.ok || !j) return null;
    const token = j.token ?? j.data?.token;
    if (!token) return null;
    return { token, expiresInSeconds: Number(j.expiresInSeconds ?? j.data?.expiresInSeconds ?? 1800) || 1800 };
  } catch {
    return null;
  }
}

/* The /api/inbox/chat/stream proxy URL for an EventSource. The stream token rides in `stream_token` (NOT
 * `token` — that param name collides with the Spyne-token reader in requireTeamAuth); the proxy forwards it
 * to chat-service as `?token=`. `since` = ISO of the newest turn already applied, for gapless replay. */
export function chatStreamUrl(a: InboxAuth, sessionId: string, streamToken: string, since?: string): string {
  const p = base(a, { session_id: sessionId, stream_token: streamToken });
  if (since) p.set("since", since);
  return `/api/inbox/chat/stream?${p}`;
}

export interface ChatToggleResult { ok: boolean; status: number; phase?: string | null; claimedByUserId?: string | null; claimedByName?: string | null; error?: string; }
/* POST /chat/sessions/:sessionId/handover/toggle — claim (→ACTIVE) or hand back (→NONE); phase decides. */
export async function postChatToggle(a: InboxAuth, sessionId: string): Promise<ChatToggleResult> {
  if (!chatHandoverEnabled(a)) return { ok: false, status: 404, error: "not_available" };
  if (!a.teamId || !sessionId) return { ok: false, status: 400, error: "missing params" };
  const p = base(a, { session_id: sessionId });
  try {
    const r = await fetch(`/api/inbox/chat/toggle?${p}`, {
      method: "POST", cache: "no-store",
      headers: { "content-type": "application/json", ...(a.spyneToken ? { Authorization: `Bearer ${a.spyneToken}` } : {}) },
      body: JSON.stringify({ sessionId }),
    });
    const j = (await r.json().catch(() => null)) as { phase?: string; claimedByUserId?: string; claimedByName?: string; data?: { phase?: string; claimedByUserId?: string; claimedByName?: string }; error?: string } | null;
    const d = j?.data ?? j ?? {};
    return { ok: r.ok, status: r.status, phase: d.phase ?? null, claimedByUserId: d.claimedByUserId ?? null, claimedByName: d.claimedByName ?? null, error: r.ok ? undefined : (j?.error || `HTTP ${r.status}`) };
  } catch (e) {
    return { ok: false, status: 0, error: String(e) };
  }
}

export interface ChatSendResult { ok: boolean; status: number; messageId?: string | null; error?: string; }
/* POST /chat/sessions/:sessionId/handover/message — reply while ACTIVE + claimed. The sent message comes
 * back over the SSE stream as a normal turn_result (authorType "human") — that's the render path, so the
 * caller should NOT render optimistically off this response (ordering vs an in-flight AI reply). */
export async function postChatMessage(a: InboxAuth, sessionId: string, body: string): Promise<ChatSendResult> {
  if (!chatHandoverEnabled(a)) return { ok: false, status: 404, error: "not_available" };
  const text = (body || "").trim();
  if (!a.teamId || !sessionId || !text) return { ok: false, status: 400, error: "missing params" };
  const p = base(a, { session_id: sessionId });
  try {
    const r = await fetch(`/api/inbox/chat/message?${p}`, {
      method: "POST", cache: "no-store",
      headers: { "content-type": "application/json", ...(a.spyneToken ? { Authorization: `Bearer ${a.spyneToken}` } : {}) },
      body: JSON.stringify({ sessionId, body: text.slice(0, 4000) }),
    });
    const j = (await r.json().catch(() => null)) as { messageId?: string; data?: { messageId?: string }; error?: string } | null;
    return { ok: r.ok, status: r.status, messageId: j?.messageId ?? j?.data?.messageId ?? null, error: r.ok ? undefined : (j?.error || `HTTP ${r.status}`) };
  } catch (e) {
    return { ok: false, status: 0, error: String(e) };
  }
}

/* Map a chat-service turn onto the SmsMessage shape the thread renderer already understands, so chatbot
 * conversations render through the SAME pipeline (bubbles, rep-highlight, handover chip) with no renderer
 * surgery. Keyed exactly to how InboxView's node builder reads a message:
 *   - role:"system" + human_assistant_id  → a claim / hand-back STATE CHIP (not a bubble). The builder does
 *       claim = !/handed it back/, so a RELEASE must carry "handed it back" in content; a CLAIM can carry
 *       anything (human_assistant_id present ⇒ chip).
 *   - out-side turn + authorUserId         → a highlighted REP bubble labelled authorName. An AI turn must
 *       therefore NOT carry authorUserId, or it'd be mislabelled as a human.
 *   - role:"user"                          → a customer (inbound) bubble. */
export function chatTurnToSms(turn: ChatTurn): SmsMessage {
  const rowType = (turn.rowType || "").toLowerCase();
  const authorType = (turn.authorType || "").toLowerCase();
  const ts = turn.createdAt ? (+new Date(turn.createdAt) || undefined) : undefined;
  if (rowType === "handover_changed") {
    const ev = String(turn.metadata?.event ?? "").toLowerCase();
    const who = (turn.metadata?.userName as string) || turn.authorName || turn.authorDisplayName || "A team member";
    const released = ev === "released" || ev === "hand_back" || ev === "handback";
    return {
      role: "system",
      content: released ? `${who} handed it back to Vini` : `${who} claimed this conversation`,
      human_assistant_id: String((turn.metadata?.userId as string) || turn.authorUserId || "system"),
      _ts: ts,
    };
  }
  const role = (turn.role || "assistant").toLowerCase();
  const outSide = role !== "user";
  const isHuman = authorType === "human" && outSide;
  return {
    role: role === "user" ? "user" : "assistant",
    content: typeof turn.content === "string" ? turn.content : "",
    _ts: ts,
    ...(isHuman
      ? { authorType: "human", authorUserId: String(turn.authorUserId || "rep"), authorName: turn.authorName || turn.authorDisplayName || "Team member" }
      : {}),
  };
}
