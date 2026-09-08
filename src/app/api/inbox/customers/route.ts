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
export const maxDuration = 60; // big teams: conversations/v2 can take ~14s upstream — don't let the function time out


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
  // Phone-like searchTerm is reduced to DIGITS ONLY so any format/prefix (+1, 1, +, none) matches the
  // stored number (leads/v2 substring-searches the raw string). Names / customer-IDs / call-IDs /
  // conversation-IDs contain letters, so they're left untouched. Done here too (not just client-side).
  let search = (searchParams.get("searchTerm") || "").trim();
  const sd = search.replace(/\D/g, "");
  if (search && /^[+\d\s().\-]+$/.test(search) && sd.length >= 4 && sd.length <= 15) {
    search = sd;
  }
  if (search) up.set("searchTerm", search.slice(0, 120));
  const startDate = (searchParams.get("startDate") || "").trim();
  const endDate = (searchParams.get("endDate") || "").trim();
  if (startDate) up.set("startDate", startDate);
  if (endDate) up.set("endDate", endDate);
  // Repeated params: leadType / leadSource (the upstream reads them case-insensitively).
  for (const t of searchParams.getAll("leadType")) if (t.trim()) up.append("leadType", t.trim());
  for (const s of searchParams.getAll("leadSource")) if (s.trim()) up.append("leadSource", s.trim());
  // Lead-level filters (get-customers-list): temperature / externalType / outcome (exact-match value lists),
  // engagementJourneys (enum — bad value 400s upstream), appointmentBooked (true|false; omit = both). All
  // forwarded verbatim; any the backend rejects are dropped on the 400-retry below so the list never empties.
  for (const t of searchParams.getAll("temperature")) if (t.trim()) up.append("temperature", t.trim());
  for (const t of searchParams.getAll("externalType")) if (t.trim()) up.append("externalType", t.trim());
  for (const o of searchParams.getAll("outcome")) if (o.trim()) up.append("outcome", o.trim());
  for (const j of searchParams.getAll("engagementJourneys")) if (j.trim()) up.append("engagementJourneys", j.trim());
  const appt = (searchParams.get("appointmentBooked") || "").toLowerCase();
  if (appt === "true" || appt === "false") up.set("appointmentBooked", appt);
  // sortBy switches which date field startDate/endDate filter on: lead createdAt vs last_contacted_at.
  const sortBy = (searchParams.get("sortBy") || "").toLowerCase();
  if (sortBy === "lead" || sortBy === "conversation") up.set("sortBy", sortBy);
  // Department scope (sales|service) — leads/v2 gained serviceType support. GRACEFUL: older backends
  // (e.g. prod before this deploys) 400 on it, so if the scoped call fails we retry WITHOUT serviceType
  // rather than showing an empty list. Once every env has it, the retry never fires.
  const dept = (searchParams.get("serviceType") || "").toLowerCase();
  if (dept === "sales" || dept === "service") up.set("serviceType", dept);
  // Handover filter (RETCONVAI-2997, UAT): PENDING / ACTIVE / NONE (comma-separated). UI only sends it on
  // UAT where it's supported; if an older backend 400s on it, the retry below drops it.
  const phase = (searchParams.get("humanTransferPhase") || "").trim();
  if (/^(NONE|PENDING|ACTIVE)(,(NONE|PENDING|ACTIVE))*$/i.test(phase)) up.set("humanTransferPhase", phase.toUpperCase());

  const token = spyneTokenFrom(request);
  const env = spyneEnvFrom(request);
  const NEW_PARAMS = ["serviceType", "humanTransferPhase", "temperature", "externalType", "outcome", "engagementJourneys", "appointmentBooked"];
  let res = await spyneServiceGet<unknown>(`/conversation/leads/v2/get-customers-list?${up.toString()}`, token, env);
  if (!res.ok && res.status === 400 && NEW_PARAMS.some((k) => up.has(k))) {
    // An older backend 400s on a param it doesn't know (or a genuinely bad enum). Drop the newer params and
    // retry so the list degrades to the still-valid filters instead of emptying — same guard the
    // serviceType/humanTransferPhase rollout used, widened to the lead-level filters.
    for (const k of NEW_PARAMS) up.delete(k);
    res = await spyneServiceGet<unknown>(`/conversation/leads/v2/get-customers-list?${up.toString()}`, token, env);
  }
  if (!res.ok) return Response.json({ error: res.error, degraded: true }, { status: res.status });
  return Response.json(res.data, { headers: { "Cache-Control": "s-maxage=15, stale-while-revalidate=45" } });
}
