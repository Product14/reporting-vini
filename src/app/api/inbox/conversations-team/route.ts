/* Inbox — FLAT (ungrouped) team conversation list. Proxies Spyne's team-conversations API:
 *   GET /conversation/customers/conversations/team
 * Returns paginated conversations for an enterprise + team (latest-first), each with a nested customer.
 * Powers the "Group by: None" view + channel tabs. Empty/test conversations are excluded upstream.
 *
 *   /api/inbox/conversations-team?team_id=&enterprise_id=&page=1&limit=25[&type=sms|call|email|chat][&unreadOnly=1]
 *
 * NOTE: this endpoint uses snake_case query keys (enterprise_id/team_id), unlike leads/v2 (camelCase).
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
  up.set("enterprise_id", enterpriseId); // snake_case per this endpoint's contract
  up.set("team_id", teamId);
  up.set("page", String(Math.max(1, Number(searchParams.get("page")) || 1)));
  up.set("limit", String(Math.max(1, Math.min(100, Number(searchParams.get("limit")) || 25))));
  // Exact channel match (sms ≠ chat). Omit for all types.
  const type = (searchParams.get("type") || "").toLowerCase();
  if (["call", "sms", "email", "chat"].includes(type)) up.set("type", type);
  if (["1", "true"].includes((searchParams.get("unreadOnly") || "").toLowerCase())) up.set("unreadOnly", "true");
  // Department scope (sales|service). GRACEFUL: if the upstream doesn't know serviceType and 400s, retry
  // without it (mirrors the customers route) rather than showing an empty list.
  const dept = (searchParams.get("serviceType") || "").toLowerCase();
  if (dept === "sales" || dept === "service") up.set("serviceType", dept);

  const token = spyneTokenFrom(request);
  const env = spyneEnvFrom(request);
  const path = `/conversation/customers/conversations/team`;
  let res = await spyneServiceGet<unknown>(`${path}?${up.toString()}`, token, env);
  if (!res.ok && res.status === 400 && up.has("serviceType")) {
    up.delete("serviceType");
    res = await spyneServiceGet<unknown>(`${path}?${up.toString()}`, token, env);
  }
  if (!res.ok) return Response.json({ error: res.error, degraded: true }, { status: res.status });
  return Response.json(res.data, { headers: { "Cache-Control": "s-maxage=15, stale-while-revalidate=45" } });
}
