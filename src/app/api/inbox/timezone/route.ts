/* Inbox — the rooftop's IANA timezone, so every timestamp (thread stamps, due dates, the "Today"
 * date filter) renders in the DEALER's local day rather than the viewer's. Same source the reports/
 * overview already use: Spyne's working-days endpoint via fetchTeamTz.
 *
 *   GET /api/inbox/timezone?team_id=&env=   ->   { timezone: "America/Los_Angeles" | null }
 *
 * Auth REQUIRED (Spyne session token scoped to this team, or the service secret). No PII in the
 * response, but it's team-scoped so we gate it like the rest of /api/inbox/*.
 */
import { requireTeamAuth, spyneTokenFrom, spyneEnvFrom } from "@/lib/reports/auth";
import { svcIdOk } from "@/lib/spyne/conversationApi";
import { fetchTeamTz } from "@/lib/reports/tzMap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const teamId = (searchParams.get("team_id") || "").trim();
  if (!svcIdOk(teamId)) return Response.json({ error: "valid team_id is required" }, { status: 400 });

  const auth = requireTeamAuth(request, teamId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const timezone = await fetchTeamTz(teamId, spyneTokenFrom(request), spyneEnvFrom(request));
  return Response.json({ timezone: timezone ?? null }, { headers: { "Cache-Control": "s-maxage=3600, stale-while-revalidate=86400" } });
}
