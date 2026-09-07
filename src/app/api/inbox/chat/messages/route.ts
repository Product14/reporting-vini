/* Inbox — chatbot/receptionist handover: load a chat-service session's history + current handover state.
 *   GET /chat/sessions/:sessionId/messages   (Bearer)
 * Proxied as:
 *   GET /api/inbox/chat/messages?team_id=&enterprise_id=&env=&session_id=
 * Auth REQUIRED (token team_id must equal the requested team_id). Degrades to the upstream status on error.
 */
import { requireTeamAuth, spyneTokenFrom, spyneEnvFrom } from "@/lib/reports/auth";
import { handoverEnabled } from "@/lib/inbox/handover";
import { spyneServiceGet, svcIdOk } from "@/lib/spyne/conversationApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const teamId = (searchParams.get("team_id") || "").trim();
  const sessionId = (searchParams.get("session_id") || "").trim();
  if (!svcIdOk(teamId)) return Response.json({ error: "valid team_id is required" }, { status: 400 });
  if (!svcIdOk(sessionId)) return Response.json({ error: "valid session_id is required" }, { status: 400 });
  if (!handoverEnabled()) return Response.json({ error: "not_available" }, { status: 404 });

  const auth = requireTeamAuth(request, teamId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const res = await spyneServiceGet<unknown>(
    `/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
    spyneTokenFrom(request),
    spyneEnvFrom(request),
  );
  if (!res.ok) return Response.json({ error: res.error, degraded: true }, { status: res.status });
  return Response.json(res.data, { status: res.status });
}
