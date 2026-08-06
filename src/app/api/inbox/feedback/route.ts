/* Inbox — per-message feedback (§03 thumbs up/down + note). Proxies Spyne's feedback API:
 *   GET  /conversation/feedbacks/messages/conversation/:conversationId   → all feedback on a thread
 *   POST /conversation/feedbacks/messages                                → create-or-update one
 *
 *   GET  /api/inbox/feedback?team_id=&conversationId=
 *   POST /api/inbox/feedback?team_id=            (body = the feedback record)
 *
 * Auth REQUIRED (Spyne session token scoped to this team, or the service secret). team_id authorizes
 * the request; conversationId / body are forwarded downstream.
 */
import { requireTeamAuth, spyneTokenFrom, spyneEnvFrom } from "@/lib/reports/auth";
import { spyneServiceGet, spyneServiceSend, svcIdOk } from "@/lib/spyne/conversationApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const teamId = (searchParams.get("team_id") || "").trim();
  const conversationId = (searchParams.get("conversationId") || "").trim();
  if (!svcIdOk(teamId)) return Response.json({ error: "valid team_id is required" }, { status: 400 });
  if (!svcIdOk(conversationId)) return Response.json({ error: "valid conversationId is required" }, { status: 400 });

  const auth = requireTeamAuth(request, teamId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const res = await spyneServiceGet<unknown>(
    `/conversation/feedbacks/messages/conversation/${encodeURIComponent(conversationId)}`,
    spyneTokenFrom(request),
    spyneEnvFrom(request),
  );
  if (!res.ok) return Response.json({ error: res.error, degraded: true }, { status: res.status });
  return Response.json(res.data);
}

export async function POST(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const teamId = (searchParams.get("team_id") || "").trim();
  if (!svcIdOk(teamId)) return Response.json({ error: "valid team_id is required" }, { status: 400 });

  const auth = requireTeamAuth(request, teamId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || !svcIdOk(String((body as { conversationId?: unknown }).conversationId ?? ""))) {
    return Response.json({ error: "conversationId is required in the body" }, { status: 400 });
  }

  const res = await spyneServiceSend<unknown>(
    `/conversation/feedbacks/messages`,
    spyneTokenFrom(request),
    spyneEnvFrom(request),
    "POST",
    body,
  );
  if (!res.ok) return Response.json({ error: res.error, degraded: true }, { status: res.status });
  return Response.json(res.data, { status: res.status === 201 ? 201 : 200 });
}
