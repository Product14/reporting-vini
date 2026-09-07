/* Inbox — chatbot/receptionist handover: send a rep's reply into an ACTIVE, claimed chat-service session.
 *   POST /chat/sessions/:sessionId/handover/message   (Bearer)   body: { body }  → { sessionId, messageId }
 * 400 = the session isn't claimed (toggle first); 409 = claimed by a DIFFERENT rep — both forwarded verbatim.
 * Unlike the SMS send path this does NOT put a Twilio SMS in front of the customer — it posts into the chat
 * widget / receptionist session, which is exactly why web-chat replies work here and not via /twilio/sms/send.
 * Proxied as:
 *   POST /api/inbox/chat/message?team_id=&enterprise_id=&env=&session_id=   body: { sessionId, body }
 * Auth REQUIRED (token team_id must equal the requested team_id).
 */
import { requireTeamAuth, spyneTokenFrom, spyneEnvFrom } from "@/lib/reports/auth";
import { handoverEnabled } from "@/lib/inbox/handover";
import { spyneServiceSend, svcIdOk } from "@/lib/spyne/conversationApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const teamId = (searchParams.get("team_id") || "").trim();
  const sessionId = (searchParams.get("session_id") || "").trim();
  if (!svcIdOk(teamId)) return Response.json({ error: "valid team_id is required" }, { status: 400 });
  if (!svcIdOk(sessionId)) return Response.json({ error: "valid session_id is required" }, { status: 400 });
  if (!handoverEnabled()) return Response.json({ error: "not_available" }, { status: 404 });

  const auth = requireTeamAuth(request, teamId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
  const text = String((body as { body?: unknown } | null)?.body ?? "").trim();
  if (!text) return Response.json({ error: "message body is required" }, { status: 400 });

  const res = await spyneServiceSend<unknown>(
    `/chat/sessions/${encodeURIComponent(sessionId)}/handover/message`,
    spyneTokenFrom(request),
    spyneEnvFrom(request),
    "POST",
    { body: text.slice(0, 4000) },
  );
  if (!res.ok) return Response.json({ error: res.error, degraded: true }, { status: res.status });
  return Response.json(res.data, { status: res.status });
}
