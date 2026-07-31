/* Inbox — "View Details" persona profile: persistent conversation memory, vehicle interests, budget,
 * trade-in, motivations/objections, purchase-intent stage, appointment intent. Proxies:
 *   GET /persona/api/v1/get-persona/:customerId
 *
 *   /api/inbox/persona?team_id=&customerId=
 *
 * PII endpoint — auth REQUIRED (Spyne session token scoped to this team, or the service secret).
 * NOTE: the persona service authenticates the dealer differently from the conversation service (the
 * upstream docs show a session cookie); we forward the bearer token we have and DEGRADE gracefully —
 * the details panel is secondary, so a non-2xx here must not break the thread. The route forwards the
 * upstream status so the client can show "details unavailable" rather than a hard error.
 */
import { requireTeamAuth, spyneTokenFrom, spyneEnvFrom } from "@/lib/reports/auth";
import { spyneServiceGet, svcIdOk } from "@/lib/spyne/conversationApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // big teams: conversations/v2 can take ~14s upstream — don't let the function time out


export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const teamId = (searchParams.get("team_id") || "").trim();
  const customerId = (searchParams.get("customerId") || searchParams.get("customer_id") || "").trim();
  if (!svcIdOk(teamId)) return Response.json({ error: "valid team_id is required" }, { status: 400 });
  if (!svcIdOk(customerId)) return Response.json({ error: "valid customerId is required" }, { status: 400 });

  const auth = requireTeamAuth(request, teamId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const res = await spyneServiceGet<unknown>(
    `/persona/api/v1/get-persona/${encodeURIComponent(customerId)}`,
    spyneTokenFrom(request),
    spyneEnvFrom(request),
  );
  if (!res.ok) return Response.json({ error: res.error, degraded: true }, { status: res.status });
  return Response.json(res.data, { headers: { "Cache-Control": "s-maxage=30, stale-while-revalidate=120" } });
}
