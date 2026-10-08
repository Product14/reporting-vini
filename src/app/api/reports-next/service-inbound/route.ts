import { fetchServiceInbound } from "@/lib/reports/agentsNext/serviceInbound";
import { requireTeamAuth } from "@/lib/reports/auth";

/* GET /api/reports-next/service-inbound?team_id=…[&enterprise_id=…]
 *
 * The console Service Overview's Service Inbound numbers (calls, qualified, visits booked) for the
 * Service Inbound card on Reports > Agent performance (next), over the Overview's own window
 * (serviceInbound.ts): the last 30 days plus today, rooftop-local. Same queries, same window, same
 * warehouse as that page, so the counts are the same on every rooftop.
 *
 * Its own route, apart from /api/reports-next's long browser cache, because the Overview recomputes on
 * every load (this does too, behind a 60s memo). The body carries customer names and phones (the booked
 * list), so it is authorized like every other rooftop read and never cached. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  const sp = new URL(request.url).searchParams;
  const teamId = (sp.get("team_id") ?? "").trim();
  if (!teamId) return Response.json({ error: "team_id is required" }, { status: 400 });

  const auth = requireTeamAuth(request, teamId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const inbound = await fetchServiceInbound(teamId, (sp.get("enterprise_id") ?? "").trim() || null);
  return Response.json({ inbound }, { headers: { "Cache-Control": "no-store" } });
}
