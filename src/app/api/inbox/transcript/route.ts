/* Inbox — full CALL transcript (agent/user turns + tool calls) from the endCallReport. Proxies:
 *   GET /conversation/customers/conversations/call/:callId/transcript
 *
 *   /api/inbox/transcript?team_id=&callId=
 *
 * PII endpoint — auth REQUIRED (Spyne session token scoped to this team, or the service secret).
 * The team scope is authorized here; callId is validated and forwarded as a path segment.
 */
import { requireTeamAuth, spyneTokenFrom, spyneEnvFrom } from "@/lib/reports/auth";
import { spyneServiceGet, svcIdOk } from "@/lib/spyne/conversationApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const teamId = (searchParams.get("team_id") || "").trim();
  const callId = (searchParams.get("callId") || "").trim();
  if (!svcIdOk(teamId)) return Response.json({ error: "valid team_id is required" }, { status: 400 });
  if (!svcIdOk(callId)) return Response.json({ error: "valid callId is required" }, { status: 400 });

  const auth = requireTeamAuth(request, teamId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const res = await spyneServiceGet<unknown>(
    `/conversation/customers/conversations/call/${encodeURIComponent(callId)}/transcript`,
    spyneTokenFrom(request),
    spyneEnvFrom(request),
  );
  // A missing report is an expected 404 (call had no transcript) — forward it so the UI can say so.
  if (!res.ok) return Response.json({ error: res.error, degraded: true }, { status: res.status });
  return Response.json(res.data, { headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=300" } });
}
