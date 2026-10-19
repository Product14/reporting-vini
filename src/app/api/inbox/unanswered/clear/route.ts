/* Unanswered queue — a human clears an episode without a console reply (PRD R2):
 *   "Handled elsewhere" (answered in the CRM, by phone, in person) or "No reply needed".
 * Actor and time are stored server-side; the episode leaves the queue.
 *
 *   POST /api/inbox/unanswered/clear?team_id=   { episodeId, kind: "handled_elsewhere" | "no_reply_needed" }
 */
import { requireTeamAuth, spyneTokenFrom, spyneEnvFrom } from "@/lib/reports/auth";
import { spyneServiceSend, svcIdOk } from "@/lib/spyne/conversationApi";
import { UNANSWERED_UPSTREAM, unansweredEnabledFor, unansweredSourceIsLive } from "@/lib/unanswered/flag";
import { sampleClear } from "@/lib/unanswered/sample";
import type { ClearKind } from "@/lib/unanswered/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KINDS: ClearKind[] = ["handled_elsewhere", "no_reply_needed"];

export async function POST(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const teamId = (searchParams.get("team_id") || "").trim();
  if (!svcIdOk(teamId)) return Response.json({ error: "valid team_id is required" }, { status: 400 });

  const auth = requireTeamAuth(request, teamId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  let body: { episodeId?: unknown; kind?: unknown };
  try { body = await request.json(); } catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
  const episodeId = typeof body.episodeId === "string" ? body.episodeId.trim() : "";
  const kind = body.kind as ClearKind;
  if (!svcIdOk(episodeId)) return Response.json({ error: "valid episodeId is required" }, { status: 400 });
  if (!KINDS.includes(kind)) return Response.json({ error: "kind must be handled_elsewhere or no_reply_needed" }, { status: 400 });

  if (!unansweredEnabledFor(teamId, "sales") && !unansweredEnabledFor(teamId, "service")) {
    return Response.json({ error: "unanswered view is off for this rooftop" }, { status: 404 });
  }

  if (!unansweredSourceIsLive()) {
    return sampleClear(episodeId, kind)
      ? Response.json({ ok: true })
      : Response.json({ error: "episode not found or already cleared" }, { status: 404 });
  }

  const res = await spyneServiceSend<unknown>(
    UNANSWERED_UPSTREAM.clear,
    spyneTokenFrom(request),
    spyneEnvFrom(request),
    "POST",
    { teamId, episodeId, clearedBy: kind },
  );
  if (!res.ok) return Response.json({ error: res.error }, { status: res.status });
  return Response.json({ ok: true });
}
