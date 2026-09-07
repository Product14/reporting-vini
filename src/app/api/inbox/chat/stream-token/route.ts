/* Inbox — chatbot/receptionist handover: mint the short-lived stream token the SSE console-stream needs.
 *   POST /chat/sessions/:sessionId/stream-token   (Bearer) → { token, expiresInSeconds }
 * Proxied as:
 *   POST /api/inbox/chat/stream-token?team_id=&enterprise_id=&env=&session_id=
 * The token is scoped to (sessionId, userId) server-side and lasts 30 min — the client re-mints it before
 * expiry (the SSE can't refresh its own credential). Auth REQUIRED.
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

  const res = await spyneServiceSend<unknown>(
    `/chat/sessions/${encodeURIComponent(sessionId)}/stream-token`,
    spyneTokenFrom(request),
    spyneEnvFrom(request),
    "POST",
    {},
  );
  if (!res.ok) return Response.json({ error: res.error, degraded: true }, { status: res.status });
  return Response.json(res.data, { status: res.status });
}
