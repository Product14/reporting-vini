/* Unanswered queue — manager view for one rooftop + department (PRD R7). Per owner: open and aged
 * counts, oldest in-hours wait, click clears with actor and time, replies per member; No owner /
 * Unmapped / Stale rows; deferred and failed texts; "escalation not configured" where it applies.
 *
 *   /api/inbox/unanswered/manager?team_id=&enterprise_id=&department=sales|service
 *
 * Access is the manager list only (settings.managerUserIds, else console admins); the backend enforces it
 * and answers 403 for anyone else, 404 when the view is off.
 */
import { requireTeamAuth, spyneTokenFrom, spyneEnvFrom } from "@/lib/reports/auth";
import { spyneServiceGet, svcIdOk } from "@/lib/spyne/conversationApi";
import { UNANSWERED_UPSTREAM, unansweredEnabledFor, unansweredSourceIsLive } from "@/lib/unanswered/flag";
import { sampleManagerPage } from "@/lib/unanswered/sample";
import type { ManagerPage } from "@/lib/unanswered/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const teamId = (searchParams.get("team_id") || "").trim();
  const enterpriseId = (searchParams.get("enterprise_id") || "").trim();
  if (!svcIdOk(teamId)) return Response.json({ error: "valid team_id is required" }, { status: 400 });

  const auth = requireTeamAuth(request, teamId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const department = searchParams.get("department") === "service" ? "service" : "sales";
  if (!unansweredSourceIsLive()) {
    if (!unansweredEnabledFor(teamId, department)) return Response.json({ error: "unanswered view is off for this rooftop" }, { status: 404 });
    return Response.json(sampleManagerPage(department), { headers: { "Cache-Control": "no-store" } });
  }

  if (!svcIdOk(enterpriseId)) return Response.json({ error: "valid enterprise_id is required" }, { status: 400 });
  const up = new URLSearchParams({ enterpriseId, teamId, department });
  const res = await spyneServiceGet<Omit<ManagerPage, "source">>(
    `${UNANSWERED_UPSTREAM.manager}?${up.toString()}`,
    spyneTokenFrom(request),
    spyneEnvFrom(request),
  );
  if (!res.ok) return Response.json({ error: res.error, degraded: true }, { status: res.status });
  return Response.json({ ...(res.data as Omit<ManagerPage, "source">), source: "live" }, { headers: { "Cache-Control": "no-store" } });
}
