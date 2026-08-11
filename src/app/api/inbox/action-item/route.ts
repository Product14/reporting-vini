/* Inbox — resolve (mark complete) / re-open an action item. Proxies:
 *   crm-core  PUT /crm-service/v1/action-items/mark-completed   body: { actionItemId, isCompleted }
 *   legacy    PUT /conversation/action-items/mark-completed      body: { actionItemId, isCompleted }
 *
 *   POST /api/inbox/action-item?team_id=   body: { actionItemId, isCompleted }
 * (Exposed as POST from the browser; the proxy issues the upstream PUT.)
 *
 * A 1:1 migration — same host, same bearer, same verb, same body — so only the path moves, picked
 * by CRM_CORE_ENABLED (default true). The legacy path is the rollback; keep it reachable.
 * `isCompleted` (with the "d") is correct for this route: false REOPENS the item. Do not confuse it
 * with mark-resolved/mark-incorrect's `isComplete`.
 *
 * Auth REQUIRED — a WRITE; Spyne session token scoped to this team, or the service secret.
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
  const actionItemId = String((body as { actionItemId?: unknown })?.actionItemId ?? "").trim();
  const isCompleted = (body as { isCompleted?: unknown })?.isCompleted !== false; // default true
  if (!actionItemId) return Response.json({ error: "actionItemId is required" }, { status: 400 });

  const path = CRM_CORE_ENABLED
    ? `/crm-service/v1/action-items/mark-completed`
    : `/conversation/action-items/mark-completed`;

  const res = await spyneServiceSend<unknown>(
    path,
    spyneTokenFrom(request),
    spyneEnvFrom(request),
    "PUT",
    { actionItemId, isCompleted },
  );
  if (!res.ok) return Response.json({ error: res.error }, { status: res.status });
  // Any 2xx is a success — including one whose `message` says the write is "queued for
  // reconciliation" (the authoritative write landed; only a secondary mirror is catching up).
  // Normalised so the client sees one shape regardless of which backend answered.
  return Response.json({ ok: true, data: res.data ?? null });
}
