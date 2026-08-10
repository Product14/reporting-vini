/* Inbox — conversation feedback (thumbs up/down + report). Proxies Spyne's feedback API:
 *   POST /conversation/feedbacks/entries   → create a feedback record (reporter/enterprise/team attached)
 *
 *   POST /api/inbox/feedback?team_id=       (body = the feedbacks/entries record, built client-side)
 *
 * The client attaches submittedByEmail (the logged-in operator), enterpriseId, teamId + teamName so the
 * feedback reporting table (Metabase) has who reported it and for which rooftop. Auth REQUIRED.
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
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || !svcIdOk(String((body as { conversationId?: unknown }).conversationId ?? ""))) {
    return Response.json({ error: "conversationId is required in the body" }, { status: 400 });
  }
  // Force teamId to the authorized team (never trust a body-supplied one).
  const finalBody = { ...(body as Record<string, unknown>), teamId };

  const res = await spyneServiceSend<unknown>(
    `/conversation/feedbacks/entries`,
    spyneTokenFrom(request),
    spyneEnvFrom(request),
    "POST",
    finalBody,
  );
  if (!res.ok) return Response.json({ error: res.error, degraded: true }, { status: res.status });
  return Response.json(res.data, { status: res.status === 201 ? 201 : 200 });
}
