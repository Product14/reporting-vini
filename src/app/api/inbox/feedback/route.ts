/* Inbox — conversation feedback (thumbs up/down + report). Proxies Spyne's feedback API.
 *
 *   POST /api/inbox/feedback?team_id=      (body = the feedbacks/entries record, built client-side)
 *
 * Two upstream endpoints, tried in order:
 *   1. POST /conversation/feedbacks/entries    — the intended contract: reporter (submittedByEmail),
 *      enterprise, and team land as first-class columns so the reporting table (Metabase) has them.
 *   2. POST /conversation/feedbacks/messages    — FALLBACK when /entries isn't deployed yet (404). This
 *      per-message endpoint is live everywhere but uses a strict field whitelist that 400-rejects any
 *      top-level submittedByEmail / enterpriseId / teamId. Its `metadata` field IS free-form, so we
 *      carry reporter/enterprise/team INSIDE metadata there — nothing is lost while /entries ships, and
 *      the moment /entries goes live these move up to real columns with zero frontend change.
 *
 * Auth REQUIRED (the token's team_id must equal the requested team_id).
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
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  if (!b || !svcIdOk(String(b.conversationId ?? ""))) {
    return Response.json({ error: "conversationId is required in the body" }, { status: 400 });
  }

  const token = spyneTokenFrom(request);
  const env = spyneEnvFrom(request);
  // Force teamId to the authorized team (never trust a body-supplied one).
  const entriesBody = { ...b, teamId };

  // 1) Intended contract — reporter/enterprise/team as first-class columns.
  let res = await spyneServiceSend<unknown>(
    `/conversation/feedbacks/entries`,
    token,
    env,
    "POST",
    entriesBody,
  );

  // 2) Fallback — /entries not deployed here yet (404). Record via the live per-message endpoint,
  //    carrying reporter/enterprise/team inside the free-form `metadata` so they're still captured.
  if (res.status === 404) {
    const channel = b.conversationType === "voice_call" ? "call" : "sms";
    const turnIndex = typeof b.turnIndex === "number" ? b.turnIndex : -1;
    const rating = b.rating === "up" ? "up" : "down";
    const comment = typeof b.comment === "string" ? b.comment.trim() : "";
    const message =
      (typeof b.messageText === "string" && b.messageText.trim()) ||
      (typeof b.conversationTitle === "string" && b.conversationTitle.trim()) ||
      "(conversation-level feedback)";
    const messagesBody = {
      conversationId: String(b.conversationId),
      channel, // upstream enum is lowercase 'sms' | 'call'
      messageIndex: turnIndex >= 0 ? turnIndex : 0,
      message: String(message).slice(0, 2000),
      feedback: comment || (rating === "up" ? "Marked as a good reply" : "Marked as a poor reply"),
      status: "pending",
      priority: "medium",
      reportedBy: teamId,
      metadata: {
        rating,
        source: "inbox",
        feedbackScope: b.feedbackScope,
        submittedByEmail: b.submittedByEmail,
        submittedByName: b.submittedByName,
        enterpriseId: b.enterpriseId,
        teamId,
        teamName: b.teamName,
        agentName: b.agentName,
      },
    };
    res = await spyneServiceSend<unknown>(
      `/conversation/feedbacks/messages`,
      token,
      env,
      "POST",
      messagesBody,
    );
  }

  if (!res.ok) return Response.json({ error: res.error, degraded: true }, { status: res.status });
  return Response.json(res.data, { status: res.status === 201 ? 201 : 200 });
}
