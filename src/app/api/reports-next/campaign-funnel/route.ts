import { fetchCampaignFunnel } from "@/lib/reports/agentsNext/campaignFunnel";
import { requireTeamAuth } from "@/lib/reports/auth";

/* GET /api/reports-next/campaign-funnel?team_id=…
 *
 * The Campaigns page's Service funnel for the Service outbound card on Reports > Agent performance
 * (next), over the Campaigns page's own window (campaignFunnel.ts): the last 30 UTC days ending
 * yesterday. Same queries, same window, same warehouse as that page, so the counts are the same on every
 * rooftop. Service only; Sales is untouched.
 *
 * Its own route, not part of /api/reports-next, so the long browser cache on that response cannot hold
 * these numbers back: the Campaigns page recomputes on every load, and so does this (behind a 60s memo).
 * The body carries customer names and phones (the Booked list), so it is authorized like every other
 * rooftop read and never cached. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Up to three or four multi-second warehouse queries, two at a time.
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  const sp = new URL(request.url).searchParams;
  const teamId = (sp.get("team_id") ?? "").trim();
  if (!teamId) return Response.json({ error: "team_id is required" }, { status: 400 });

  const auth = requireTeamAuth(request, teamId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const funnel = await fetchCampaignFunnel(teamId);
  return Response.json({ funnel }, { headers: { "Cache-Control": "no-store" } });
}
