/* Inbox — RIGHT PANE conversation feed for one customer. Proxies Spyne's Conversations V2 API:
 *   GET /conversation/customers/conversations/v2
 * Returns conversations (call/sms records), next appointments/action-items/scheduled tasks,
 * the lead-journey milestone timeline, and the customer's leads (with temperature + stage).
 *
 *   /api/inbox/conversations?team_id=&enterprise_id=&customer_id=[&type=call|sms][&page=1][&limit=20]
 *
 * PII endpoint — auth REQUIRED (Spyne session token scoped to this team, or the service secret).
 */
import { requireTeamAuth, spyneTokenFrom, spyneEnvFrom } from "@/lib/reports/auth";
import { spyneServiceGet, svcIdOk } from "@/lib/spyne/conversationApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // big teams: conversations/v2 can take ~14s upstream — don't let the function time out


export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const teamId = (searchParams.get("team_id") || "").trim();
  const enterpriseId = (searchParams.get("enterprise_id") || "").trim();
  const customerId = (searchParams.get("customer_id") || "").trim();
  if (!svcIdOk(teamId)) return Response.json({ error: "valid team_id is required" }, { status: 400 });
  if (!svcIdOk(enterpriseId)) return Response.json({ error: "valid enterprise_id is required" }, { status: 400 });
  if (!svcIdOk(customerId)) return Response.json({ error: "valid customer_id is required" }, { status: 400 });

  const auth = requireTeamAuth(request, teamId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const up = new URLSearchParams();
  up.set("customer_id", customerId);
  up.set("enterprise_id", enterpriseId);
  up.set("team_id", teamId);
  up.set("page", String(Math.max(1, Number(searchParams.get("page")) || 1)));
  up.set("limit", String(Math.max(1, Math.min(100, Number(searchParams.get("limit")) || 20))));
  const type = (searchParams.get("type") || "").toLowerCase();
  if (type === "call" || type === "sms") up.set("type", type);
  // Forward serviceType: conversations/v2 DEFAULTS to sales when it's absent, so Service customers come
  // back empty ("No conversation history") without it. Sales space → sales thread, Service → service.
  const dept = (searchParams.get("serviceType") || "").toLowerCase();
  if (dept === "sales" || dept === "service") up.set("serviceType", dept);

  const res = await spyneServiceGet<unknown>(
    `/conversation/customers/conversations/v2?${up.toString()}`,
    spyneTokenFrom(request),
    spyneEnvFrom(request),
  );
  if (!res.ok) return Response.json({ error: res.error, degraded: true }, { status: res.status });
  return Response.json(res.data, { headers: { "Cache-Control": "s-maxage=10, stale-while-revalidate=30" } });
}
