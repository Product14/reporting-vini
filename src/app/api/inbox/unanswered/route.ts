/* Unanswered queue — open or aged episodes for one rooftop + department (PRD R3, R13).
 *
 *   /api/inbox/unanswered?team_id=&enterprise_id=&department=sales|service&bucket=open|aged&sort=oldest|newest&scope=team|mine
 *
 * Source: UNANSWERED_SOURCE=live → conversational-ai-backend GET /conversation/unanswered/episodes, whose
 * per-rooftop settings decide `enabled` (R8); otherwise the built-in FICTIONAL sample rooftop, labelled
 * source:"sample". PII when live — auth like every inbox route.
 */
import { requireTeamAuth, spyneTokenFrom, spyneEnvFrom } from "@/lib/reports/auth";
import { spyneServiceGet, svcIdOk } from "@/lib/spyne/conversationApi";
import { UNANSWERED_UPSTREAM, unansweredEnabledFor, unansweredSourceIsLive } from "@/lib/unanswered/flag";
import { sampleUnansweredPage } from "@/lib/unanswered/sample";
import type { UnansweredPage, UnansweredQuery } from "@/lib/unanswered/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const teamId = (searchParams.get("team_id") || "").trim();
  const enterpriseId = (searchParams.get("enterprise_id") || "").trim();
  if (!svcIdOk(teamId)) return Response.json({ error: "valid team_id is required" }, { status: 400 });

  const auth = requireTeamAuth(request, teamId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const q: UnansweredQuery = {
    department: searchParams.get("department") === "service" ? "service" : "sales",
    bucket: searchParams.get("bucket") === "aged" ? "aged" : "open",
    sort: searchParams.get("sort") === "newest" ? "newest" : "oldest",
    scope: searchParams.get("scope") === "mine" ? "mine" : "team",
  };

  const off = (source: "live" | "sample"): UnansweredPage => ({
    enabled: false,
    source,
    department: q.department,
    openCount: 0,
    agedCount: 0,
    episodes: [],
    config: { mineAvailable: false, escalationConfigured: false, textsAllowed: false, agedLabel: "", viewerIsManager: false, viewerConsoleUserId: null },
    generated_at: new Date().toISOString(),
  });

  if (unansweredSourceIsLive()) {
    if (!svcIdOk(enterpriseId)) return Response.json({ error: "valid enterprise_id is required" }, { status: 400 });
    const up = new URLSearchParams({ enterpriseId, teamId, department: q.department, bucket: q.bucket, sort: q.sort, scope: q.scope });
    const res = await spyneServiceGet<Omit<UnansweredPage, "source">>(
      `${UNANSWERED_UPSTREAM.list}?${up.toString()}`,
      spyneTokenFrom(request),
      spyneEnvFrom(request),
    );
    // Unreadable flag → no view and no badge (A14), never an error banner on the Conversations screen.
    if (!res.ok) return Response.json({ ...off("live"), degraded: true }, { headers: { "Cache-Control": "no-store" } });
    const page = res.data as Omit<UnansweredPage, "source">;
    return Response.json(page.enabled ? { ...page, source: "live" } : off("live"), { headers: { "Cache-Control": "no-store" } });
  }

  // Sample mode: the env team list stands in for the backend view flag.
  if (!unansweredEnabledFor(teamId, q.department)) {
    return Response.json(off("sample"), { headers: { "Cache-Control": "no-store" } });
  }

  return Response.json(sampleUnansweredPage(q), { headers: { "Cache-Control": "no-store" } });
}
