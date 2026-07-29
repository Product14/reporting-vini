/* Inbox — resolve (mark complete) / re-open an action item. Proxies Spyne's:
 *   PUT /conversation/action-items/mark-completed   body: { actionItemId, isCompleted }
 *
 *   POST /api/inbox/action-item?team_id=   body: { actionItemId, isCompleted }
 * (Exposed as POST from the browser; the proxy issues the upstream PUT.)
 *
 * Auth REQUIRED — a WRITE; Spyne session token scoped to this team, or the service secret.
 */
import { requireTeamAuth, spyneTokenFrom, spyneEnvFrom } from "@/lib/reports/auth";
import { spyneServiceSend, svcIdOk } from "@/lib/spyne/conversationApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const teamId = (searchParams.get("team_id") || "").trim();
  if (!svcIdOk(teamId)) return Response.json({ error: "valid team_id is required" }, { status: 400 });

  const auth = requireTeamAuth(request, teamId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
  const actionItemId = String((body as { actionItemId?: unknown })?.actionItemId ?? "").trim();
  const isCompleted = (body as { isCompleted?: unknown })?.isCompleted !== false; // default true
  if (!actionItemId) return Response.json({ error: "actionItemId is required" }, { status: 400 });

  const res = await spyneServiceSend<unknown>(
    `/conversation/action-items/mark-completed`,
    spyneTokenFrom(request),
    spyneEnvFrom(request),
    "PUT",
    { actionItemId, isCompleted },
  );
  if (!res.ok) return Response.json({ error: res.error }, { status: res.status });
  return Response.json(res.data ?? { ok: true });
}
