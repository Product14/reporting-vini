/* Inbox — FLAT conversation feed ("Group by: None"). Proxies Spyne's team-wide conversations API:
 *   GET /conversation/customers/conversations/team
 * One row per conversation (latest first) with the customer resolved, plus per-type content:
 * calls carry `transcript` (last 10 turns), sms/chat carry `smsMessages` (10 newest-first).
 *
 *   /api/inbox/team-conversations?team_id=&enterprise_id=[&type=call|sms|chat|email][&unreadOnly=true][&page=1][&limit=30]
 *
 * PII endpoint — auth REQUIRED (Spyne session token scoped to this team, or the service secret).
 */
import { requireTeamAuth, spyneTokenFrom, spyneEnvFrom } from "@/lib/reports/auth";
import { spyneServiceGet, svcIdOk } from "@/lib/spyne/conversationApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const teamId = (searchParams.get("team_id") || "").trim();
  const enterpriseId = (searchParams.get("enterprise_id") || "").trim();
  if (!svcIdOk(teamId)) return Response.json({ error: "valid team_id is required" }, { status: 400 });
  if (!svcIdOk(enterpriseId)) return Response.json({ error: "valid enterprise_id is required" }, { status: 400 });

  const auth = requireTeamAuth(request, teamId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const up = new URLSearchParams();
  up.set("enterprise_id", enterpriseId);
  up.set("team_id", teamId);
  up.set("page", String(Math.max(1, Number(searchParams.get("page")) || 1)));
  up.set("limit", String(Math.max(1, Math.min(100, Number(searchParams.get("limit")) || 30))));
  const type = (searchParams.get("type") || "").toLowerCase();
  if (type === "call" || type === "sms" || type === "chat" || type === "email") up.set("type", type);
  if ((searchParams.get("unreadOnly") || "") === "true") up.set("unreadOnly", "true");

  const res = await spyneServiceGet<unknown>(
    `/conversation/customers/conversations/team?${up.toString()}`,
    spyneTokenFrom(request),
    spyneEnvFrom(request),
  );
  if (!res.ok) return Response.json({ error: res.error, degraded: true }, { status: res.status });
  return Response.json(res.data, { headers: { "Cache-Control": "s-maxage=10, stale-while-revalidate=30" } });
}
