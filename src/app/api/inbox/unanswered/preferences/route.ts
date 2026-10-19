/* Unanswered queue — the member's landing view (PRD R11): Unanswered, All or Needs Attention.
 *
 *   GET /api/inbox/unanswered/preferences?team_id=            → { landingView, source }
 *   PUT /api/inbox/unanswered/preferences?team_id=  { landingView }
 *
 * Live: stored per member by conversational-ai-backend (the member is the console token's user), so it
 * follows them across browsers. Sample: { source: "sample" } and the screen keeps it in this browser.
 */
import { requireTeamAuth, spyneTokenFrom, spyneEnvFrom } from "@/lib/reports/auth";
import { spyneServiceGet, spyneServiceSend, svcIdOk } from "@/lib/spyne/conversationApi";
import { UNANSWERED_UPSTREAM, unansweredSourceIsLive } from "@/lib/unanswered/flag";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VIEWS = ["all", "unanswered", "needs_attention"] as const;
type View = (typeof VIEWS)[number];

function team(request: Request): string | Response {
  const teamId = (new URL(request.url).searchParams.get("team_id") || "").trim();
  if (!svcIdOk(teamId)) return Response.json({ error: "valid team_id is required" }, { status: 400 });
  const auth = requireTeamAuth(request, teamId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  return teamId;
}

export async function GET(request: Request): Promise<Response> {
  const teamId = team(request);
  if (teamId instanceof Response) return teamId;
  if (!unansweredSourceIsLive()) return Response.json({ landingView: null, source: "sample" });
  const res = await spyneServiceGet<{ landingView?: string }>(
    `${UNANSWERED_UPSTREAM.preferences}?${new URLSearchParams({ teamId })}`,
    spyneTokenFrom(request),
    spyneEnvFrom(request),
  );
  if (!res.ok) return Response.json({ landingView: null, source: "live", degraded: true });
  const v = res.data?.landingView;
  return Response.json({ landingView: VIEWS.includes(v as View) ? v : "all", source: "live" }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: Request): Promise<Response> {
  const teamId = team(request);
  if (teamId instanceof Response) return teamId;
  let body: { landingView?: unknown };
  try { body = await request.json(); } catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
  if (!VIEWS.includes(body.landingView as View)) return Response.json({ error: "landingView must be all, unanswered or needs_attention" }, { status: 400 });
  if (!unansweredSourceIsLive()) return Response.json({ landingView: body.landingView, source: "sample" });
  const res = await spyneServiceSend<{ landingView: string }>(
    UNANSWERED_UPSTREAM.preferences,
    spyneTokenFrom(request),
    spyneEnvFrom(request),
    "PUT",
    { teamId, landingView: body.landingView },
  );
  if (!res.ok) return Response.json({ error: res.error }, { status: res.status });
  return Response.json({ landingView: body.landingView, source: "live" });
}
