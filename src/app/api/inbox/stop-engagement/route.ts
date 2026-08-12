/* Inbox — STOP AI ENGAGEMENT for a lead, so Vini stops all further automated outreach. Proxies:
 *   crm-core  PATCH  /crm-service/v1/internal/sales/leads/:sales_lead_id/stop-ai-engagement
 *                    body: { stop_ai_engagement: true }
 *   legacy    DELETE /conversation/sequence-workflows/workflows/delete-by-lead   body: { leadId }
 *
 *   POST /api/inbox/stop-engagement?team_id=      body: { leadId }
 * (Exposed as POST from the browser; the proxy issues the upstream PATCH/DELETE with the body.)
 *
 * ⚠️ NOT the same operation on both sides, by design of the migration: crm-core records the
 * AI-engagement flag ON THE LEAD (and mirrors it to dealer-leads), whereas legacy DELETED the
 * lead's sequence workflows. Observable behaviour may differ — that's a backend-team question, not
 * something to compensate for here. It also changes what a 404 means; see below.
 *
 * The `/internal` segment in the crm-core path is correct and deliberate — that route is
 * bearer-only despite the prefix and takes no api key. Do not "fix" it.
 *
 * Auth REQUIRED — this is a WRITE, so a Spyne session token scoped to this team (or the service secret).
 */
import { requireTeamAuth, spyneTokenFrom, spyneEnvFrom } from "@/lib/reports/auth";
import { spyneServiceSend, svcIdOk } from "@/lib/spyne/conversationApi";
import { CRM_CORE_ENABLED } from "@/lib/spyne/crmCore";

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

  const token = spyneTokenFrom(request);
  const env = spyneEnvFrom(request);

  if (CRM_CORE_ENABLED) {
    // `stop_ai_engagement: false` would RESUME. The Inbox only ever stops, so we always send true
    // (crm-core also defaults to true on an omitted body — we're explicit rather than relying on it).
    const res = await spyneServiceSend<{ stop_ai_engagement?: boolean; message?: string }>(
      `/crm-service/v1/internal/sales/leads/${encodeURIComponent(leadId)}/stop-ai-engagement`,
      token,
      env,
      "PATCH",
      { stop_ai_engagement: true },
    );
    // NOTE: deliberately NO 404→success translation on this branch. On crm-core a 404 means "no
    // such lead in your enterprise/team", which is a real error — unlike legacy's 404, which meant
    // "no workflows to delete" i.e. already stopped. Forwarding it keeps a missing lead visible
    // instead of silently reporting a stop that never happened.
    if (!res.ok) return Response.json({ error: res.error }, { status: res.status });
    // Any 2xx is a success — including one whose `message` says the write is "queued for
    // reconciliation" (the authoritative write landed; only a secondary mirror is catching up).
    return Response.json({ ok: true, stopAiEngagement: res.data?.stop_ai_engagement !== false });
  }

  // ── legacy path (rollback) — behaviour unchanged ──
  const res = await spyneServiceSend<unknown>(
    `/conversation/sequence-workflows/workflows/delete-by-lead`,
    token,
    env,
    "DELETE",
    { leadId },
  );
  // A 404 from delete-by-lead means the lead has NO active workflows/tasks/meetings to delete — so
  // engagement is already in the desired (stopped) state. Treat that as idempotent SUCCESS instead of
  // surfacing a "couldn't stop engagement" error for what is actually a no-op stop.
  if (!res.ok) {
    if (res.status === 404) return Response.json({ ok: true, stopAiEngagement: true, alreadyStopped: true });
    return Response.json({ error: res.error }, { status: res.status });
  }
  return Response.json({ ok: true, stopAiEngagement: true });
}
