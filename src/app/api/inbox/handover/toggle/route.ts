/* Inbox — SMS human-handover claim / hand-back (RETCONVAI-2997). Proxies:
 *   POST /conversation/twilio/sms/handover/toggle   body: { conversationId }
 * The endpoint looks at the conversation's current phase and does whichever action fits (PENDING→ACTIVE
 * claim, or ACTIVE→NONE hand-back); enterpriseId/teamId/userId are read from the bearer server-side.
 *
 *   POST /api/inbox/handover/toggle?team_id=   body: { conversationId }
 *
 * UAT-ONLY: this feature is not live on prod, so the proxy hard-refuses any non-UAT env (the UI is also
 * gated). Auth REQUIRED (token team_id must equal the requested team_id).
 */
import { requireTeamAuth, spyneTokenFrom, spyneEnvFrom } from "@/lib/reports/auth";
import { spyneServiceSend, svcIdOk } from "@/lib/spyne/conversationApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const teamId = (searchParams.get("team_id") || "").trim();
  if (!svcIdOk(teamId)) return Response.json({ error: "valid team_id is required" }, { status: 400 });
  // GA: the handover backend is live on prod + uat, so this forwards to whichever env the request targets
  // (previously hard-gated to uat). Auth is still required.

  const auth = requireTeamAuth(request, teamId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
  // conversationId travels in the JSON body (not the URL path), so path-escape isn't a concern here — a
  // plain non-empty/length check is correct; svcIdOk would wrongly reject ids containing '.'/':'.
  const conversationId = String((body as { conversationId?: unknown } | null)?.conversationId ?? "").trim();
  if (!conversationId || conversationId.length > 256) return Response.json({ error: "conversationId is required" }, { status: 400 });

  const res = await spyneServiceSend<unknown>(
    `/conversation/twilio/sms/handover/toggle`,
    spyneTokenFrom(request),
    spyneEnvFrom(request),
    "POST",
    { conversationId },
  );
  // Forward the upstream status verbatim (200/400/404/409) so the client can read `phase` / handle races.
  if (!res.ok) return Response.json({ error: res.error, degraded: true }, { status: res.status });
  return Response.json(res.data, { status: res.status });
}
