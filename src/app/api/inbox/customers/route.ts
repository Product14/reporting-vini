/* Inbox — LEFT PANE customer list. Proxies Spyne's Leads V2 API:
 *   GET /conversation/leads/v2/get-customers-list
 * Returns customers aggregated by interaction, with per-channel unread counts and pagination.
 *
 *   /api/inbox/customers?team_id=&enterprise_id=&page=1&limit=25[&unreadOnly=1][&searchTerm=]
 *     [&startDate=&endDate=][&leadType=HOT&leadType=WARM][&leadSource=internet]
 *
 * PII endpoint — auth REQUIRED (Spyne session token scoped to this team, or the service secret).
 */
import { requireTeamAuth, spyneTokenFrom, spyneEnvFrom } from "@/lib/reports/auth";
import { spyneServiceGet, svcIdOk } from "@/lib/spyne/conversationApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const teamId = (searchParams.get("team_id") || "").trim();
  const enterpriseId = (searchParams.get("enterprise_id") || "").trim();
  if (!svcIdOk(teamId)) return Response.json({ error: "valid team_id is required" }, { status: 400 });
  if (!svcIdOk(enterpriseId)) return Response.json({ error: "valid enterprise_id is required" }, { status: 400 });

  const auth = requireTeamAuth(request, teamId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  // Build the upstream query from the allow-listed params, coercing/bounding the numeric ones.
  const up = new URLSearchParams();
  up.set("enterpriseId", enterpriseId);
  up.set("teamId", teamId);
  up.set("page", String(Math.max(1, Number(searchParams.get("page")) || 1)));
  up.set("limit", String(Math.max(1, Math.min(100, Number(searchParams.get("limit")) || 25))));
  if (["1", "true"].includes((searchParams.get("unreadOnly") || "").toLowerCase())) up.set("unreadOnly", "true");
  const search = (searchParams.get("searchTerm") || "").trim();
  if (search) up.set("searchTerm", search.slice(0, 120));
  const startDate = (searchParams.get("startDate") || "").trim();
  const endDate = (searchParams.get("endDate") || "").trim();
  if (startDate) up.set("startDate", startDate);
  if (endDate) up.set("endDate", endDate);
  // Repeated params: leadType / leadSource (the upstream reads them case-insensitively).
  for (const t of searchParams.getAll("leadType")) if (t.trim()) up.append("leadType", t.trim());
  for (const s of searchParams.getAll("leadSource")) if (s.trim()) up.append("leadSource", s.trim());
  const dept = (searchParams.get("department") || "").toLowerCase();
  if (dept === "sales" || dept === "service") up.set("department", dept);
  // sortBy switches which date field startDate/endDate filter on: lead createdAt vs last_contacted_at.
  const sortBy = (searchParams.get("sortBy") || "").toLowerCase();
  if (sortBy === "lead" || sortBy === "conversation") up.set("sortBy", sortBy);

  const res = await spyneServiceGet<unknown>(
    `/conversation/leads/v2/get-customers-list?${up.toString()}`,
    spyneTokenFrom(request),
    spyneEnvFrom(request),
  );
  if (!res.ok) return Response.json({ error: res.error, degraded: true }, { status: res.status });
  return Response.json(res.data, { headers: { "Cache-Control": "s-maxage=15, stale-while-revalidate=45" } });
}
