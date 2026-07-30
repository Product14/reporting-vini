/* Inbox — STOP AI ENGAGEMENT for a lead. Deletes the lead's sequence workflows so Vini stops all
 * further automated outreach. Proxies Spyne's:
 *   DELETE /conversation/sequence-workflows/workflows/delete-by-lead   body: { leadId }
 *
 *   POST /api/inbox/stop-engagement?team_id=      body: { leadId }
 * (Exposed as POST from the browser; the proxy issues the upstream DELETE with the body.)
 *
 * Auth REQUIRED — this is a WRITE, so a Spyne session token scoped to this team (or the service secret).
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
  const leadId = String((body as { leadId?: unknown })?.leadId ?? "").trim();
  if (!svcIdOk(leadId)) return Response.json({ error: "valid leadId is required in the body" }, { status: 400 });

  const res = await spyneServiceSend<unknown>(
    `/conversation/sequence-workflows/workflows/delete-by-lead`,
    spyneTokenFrom(request),
    spyneEnvFrom(request),
    "DELETE",
    { leadId },
  );
  // A 404 from delete-by-lead means the lead has NO active workflows/tasks/meetings to delete — so
  // engagement is already in the desired (stopped) state. Treat that as idempotent SUCCESS instead of
  // surfacing a "couldn't stop engagement" error for what is actually a no-op stop.
  if (!res.ok) {
    if (res.status === 404) return Response.json({ ok: true, alreadyStopped: true });
    return Response.json({ error: res.error }, { status: res.status });
  }
  return Response.json(res.data ?? { ok: true });
}
