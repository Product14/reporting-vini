/* Inbox — the team's ONBOARDED AI agents (real name + avatar photo), so the AI side of a conversation
 * shows e.g. "Emily Carter" + her photo instead of a generic "Vini" + icon. Proxies Spyne's:
 *   GET /conversation/agents/team/:teamId/onboarded-agents
 *
 *   GET /api/inbox/agents?team_id=&env=
 *
 * Auth REQUIRED (Spyne session token scoped to this team, or the service secret). No PII, but team-scoped.
 */
import { requireTeamAuth, spyneTokenFrom, spyneEnvFrom } from "@/lib/reports/auth";
import { spyneServiceGet, svcIdOk } from "@/lib/spyne/conversationApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const teamId = (searchParams.get("team_id") || "").trim();
  if (!svcIdOk(teamId)) return Response.json({ error: "valid team_id is required" }, { status: 400 });

  const auth = requireTeamAuth(request, teamId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const res = await spyneServiceGet<unknown>(
    `/conversation/agents/team/${encodeURIComponent(teamId)}/onboarded-agents`,
    spyneTokenFrom(request),
    spyneEnvFrom(request),
  );
  if (!res.ok) return Response.json({ error: res.error, degraded: true }, { status: res.status });
  return Response.json(res.data ?? [], { headers: { "Cache-Control": "s-maxage=300, stale-while-revalidate=3600" } });
}
