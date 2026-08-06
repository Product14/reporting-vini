/* Inbox — full call detail + intelligence (AI Review): outcome, summary, query resolution, AI quality
 * score/grade, sentiment, intent. Proxies Spyne's:
 *   GET /conversation/calls/:callUid   (analysis + messages + recordingUrl)
 *
 *   GET /api/inbox/call?team_id=&callId=
 *
 * Auth REQUIRED (Spyne session token scoped to this team, or the service secret).
 */
import { requireTeamAuth, spyneTokenFrom, spyneEnvFrom } from "@/lib/reports/auth";
import { spyneServiceGet, svcIdOk } from "@/lib/spyne/conversationApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // big teams: conversations/v2 can take ~14s upstream — don't let the function time out


export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const teamId = (searchParams.get("team_id") || "").trim();
  const callId = (searchParams.get("callId") || "").trim();
  if (!svcIdOk(teamId)) return Response.json({ error: "valid team_id is required" }, { status: 400 });
  if (!svcIdOk(callId)) return Response.json({ error: "valid callId is required" }, { status: 400 });

  const auth = requireTeamAuth(request, teamId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const res = await spyneServiceGet<unknown>(
    `/conversation/calls/${encodeURIComponent(callId)}`,
    spyneTokenFrom(request),
    spyneEnvFrom(request),
  );
  if (!res.ok) return Response.json({ error: res.error, degraded: true }, { status: res.status });
  return Response.json(res.data, { headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=300" } });
}
