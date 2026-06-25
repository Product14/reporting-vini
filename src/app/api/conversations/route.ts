/* Per-event CONVERSATION feed for the post-conversation transactional email.
 *
 * Recent AI call conversations for a rooftop, straight from dealer_leads.endcallreports (the only
 * row-level source). The poll pass calls this every few minutes with ?minutes= to get conversations
 * since its last run, then emails one per (gated by rooftop config). SMS-only conversations aren't
 * here yet (calls first) — endcallreports is call reports.
 *
 *   /api/conversations?team_id=&serviceType=sales|service|both[&minutes=15][&since=ISO][&limit=50][&actionableOnly=1]
 *
 * Degrades to an empty list — never 502s the pipeline.
 */
import { runClickhouse, chEsc, hasClickhouseCreds } from "@/lib/spyne/clickhouse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SERVICE = new Set(["sales", "service", "both"]);
const ISO_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?Z?)?$/;
const idOk = (s: string) => /^[A-Za-z0-9_-]{1,64}$/.test(s);

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const teamId = searchParams.get("team_id") || "";
  if (!idOk(teamId)) return Response.json({ error: "valid team_id is required" }, { status: 400 });
  if (!hasClickhouseCreds()) return Response.json({ conversations: [], total: 0, note: "clickhouse not configured" });

  const svc = (searchParams.get("serviceType") || "both").toLowerCase();
  const service = SERVICE.has(svc) ? svc : "both";
  const minutes = Math.max(1, Math.min(10_080, Number(searchParams.get("minutes")) || 15)); // ≤7d
  const since = searchParams.get("since");
  const limit = Math.max(1, Math.min(200, Number(searchParams.get("limit")) || 50));
  const actionableOnly = searchParams.get("actionableOnly") === "1";

  const where: string[] = [
    `e.teamId='${chEsc(teamId)}'`,
    "e.isActive=1", "e.__deleted=0", "e.isTestCall=0",
  ];
  where.push(since && ISO_RE.test(since) ? `e.createdAt >= parseDateTimeBestEffort('${chEsc(since)}')` : `e.createdAt >= now() - INTERVAL ${minutes} MINUTE`);
  if (service !== "both") where.push(`lower(e.callDetails_agentInfo_agentType)='${service}'`);
  // "actionable" = the call produced an action item, scheduled an appointment, or left a query unresolved.
  if (actionableOnly) where.push("(ifNull(e.report_actionItems,'') NOT IN ('','[]','{}') OR lower(ifNull(e.report_overview_appointmentScheduled,''))='true' OR lower(ifNull(e.report_queryResolved,''))='false')");

  // Identity (lead→customer) + AI-quality joins so the per-event email carries the customer name and
  // call grade — the SAME data the digest reads, sourced once here instead of a second ClickHouse query
  // in vini-daily-calls (eventPreviewCH). Without these the sent post-conversation email had no customer.
  const sql =
    "SELECT e.id AS id, e.leadId AS leadId, e.callId AS callId," +
    " coalesce(nullIf(c.mobile_number,''), e.callDetails_mobile) AS phone, ifNull(c.name,'') AS customer," +
    " e.callDetails_agentInfo_agentType AS agentType," +
    " lower(ifNull(e.report_inOutType,'')) AS direction, ifNull(e.report_title,'') AS title," +
    " ifNull(e.report_summary, ifNull(e.callDetails_analysis_summary,'')) AS summary," +
    " lower(ifNull(e.report_overview_appointmentScheduled,'')) AS apptScheduled," +
    " lower(ifNull(e.report_queryResolved,'')) AS queryResolved," +
    " ifNull(e.report_actionItems,'') AS actionItems," +
    " q.score AS aiScore, q.grade AS grade, q.frustrated AS frustrated," +
    " formatDateTime(e.createdAt,'%Y-%m-%dT%H:%i:%SZ') AS at" +
    " FROM dealer_leads.endcallreports e" +
    " LEFT JOIN (SELECT lead_id, any(customer_id) cid FROM dealer_leads.leads GROUP BY lead_id) l ON e.leadId=l.lead_id" +
    " LEFT JOIN (SELECT customer_id, any(name) name, any(mobile_number) mobile_number FROM dealer_leads.customer GROUP BY customer_id) c ON l.cid=c.customer_id" +
    " LEFT JOIN (SELECT callId, any(scorePercentage) score, any(overallGrade) grade, any(customerFrustrated) frustrated FROM dealer_leads.conversationQualities WHERE createdAt >= now()-INTERVAL 30 DAY GROUP BY callId) q ON e.callId=q.callId" +
    " WHERE " + where.join(" AND ") +
    ` ORDER BY e.createdAt DESC LIMIT ${limit}`;

  const rows = await runClickhouse<Record<string, string>>(sql);
  const conversations = rows.map((r) => ({
    id: r.id,
    leadId: r.leadId || null,
    phone: r.phone || null,
    customer: r.customer || null,
    dept: /service/i.test(r.agentType || "") ? "service" : "sales",
    direction: r.direction === "outbound" ? "outbound" : "inbound",
    title: r.title || "",
    summary: r.summary || "",
    appointmentScheduled: r.apptScheduled === "true",
    queryResolved: r.queryResolved === "true",
    hasActionItem: !!(r.actionItems && !["", "[]", "{}"].includes(r.actionItems)),
    aiScore: r.aiScore != null && r.aiScore !== "" ? Number(r.aiScore) : null,
    grade: r.grade || null,
    frustrated: Number(r.frustrated) === 1,
    at: r.at || "",
  }));
  return Response.json({ conversations, total: conversations.length }, {
    headers: { "Cache-Control": "s-maxage=30, stale-while-revalidate=60" },
  });
}
