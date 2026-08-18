/* Inbox — send a manual SMS as the rep during an ACTIVE handover (RETCONVAI-2997). Proxies:
 *   POST /conversation/twilio/sms/send   body: { conversationId, body }
 * Requires the conversation to be phase === "ACTIVE" (claim first via /handover/toggle); the author is
 * read from the bearer server-side.
 *
 *   POST /api/inbox/handover/send?team_id=   body: { conversationId, body }
 *
 * UAT-ONLY: hard-refuses any non-UAT env (this also sends a REAL SMS, so it must never fire on prod).
 * Auth REQUIRED (token team_id must equal the requested team_id).
 */
import { requireTeamAuth, spyneTokenFrom, spyneEnvFrom } from "@/lib/reports/auth";
import { spyneServiceSend, svcIdOk } from "@/lib/spyne/conversationApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const teamId = (searchParams.get("team_id") || "").trim();
  if (!svcIdOk(teamId)) return Response.json({ error: "valid team_id is required" }, { status: 400 });
  if (spyneEnvFrom(request) !== "uat") return Response.json({ error: "not_available" }, { status: 404 });

  const auth = requireTeamAuth(request, teamId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
  const b = body as { conversationId?: unknown; body?: unknown } | null;
  // conversationId travels in the JSON body (not the URL path) — non-empty/length check, not svcIdOk.
  const conversationId = String(b?.conversationId ?? "").trim();
  const text = String(b?.body ?? "").trim();
  if (!conversationId || conversationId.length > 256) return Response.json({ error: "conversationId is required" }, { status: 400 });
  if (!text) return Response.json({ error: "message body is required" }, { status: 400 });

  const res = await spyneServiceSend<unknown>(
    `/conversation/twilio/sms/send`,
    spyneTokenFrom(request),
    spyneEnvFrom(request),
    "POST",
    { conversationId, body: text.slice(0, 2000) },
  );
  if (!res.ok) return Response.json({ error: res.error, degraded: true }, { status: res.status });
  return Response.json(res.data, { status: res.status });
}
