/* Per-event ACTION-ITEM feed for the action-item + overdue transactional emails.
 *
 * Row-level action items for a rooftop, from dealer_leads.actionItems (the only row-level source).
 * Three scopes:
 *   • recent   — created in the last N minutes → "new action item assigned" email (poll pass)
 *   • open     — all not-completed → the stacked "pending" list shown in those emails
 *   • overdue  — not completed AND past due_date → the SLA-breach escalation email
 *
 * "All actionable intents" (product decision) → no intent allow-list; we only drop blank intents.
 * Degrades to an empty list — never 502s the pipeline.
 *
 *   /api/action-items?team_id=&serviceType=sales|service|both&scope=recent|open|overdue[&minutes=15][&limit=50]
 */
import { runClickhouse, chEsc, hasClickhouseCreds } from "@/lib/spyne/clickhouse";
import { requireTeamAuth } from "@/lib/reports/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SERVICE = new Set(["sales", "service", "both"]);
const SCOPE = new Set(["recent", "open", "overdue"]);
const idOk = (s: string) => /^[A-Za-z0-9_-]{1,64}$/.test(s);

// Explicit dept label from the service-type string. Prefix-based and exhaustive: only a value that
// actually starts with "service"/"sales" maps to that dept — blank/receptionist/sms → "other" (the old
// `/service/.test ? service : sales` mislabeled all of those as sales).
function deptOf(s: string): "sales" | "service" | "other" {
  const v = (s || "").trim().toLowerCase();
  if (v.startsWith("service")) return "service";
  if (v.startsWith("sales")) return "sales";
  return "other";
}

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const teamId = searchParams.get("team_id") || "";
  if (!idOk(teamId)) return Response.json({ error: "valid team_id is required" }, { status: 400 });

  // PII endpoint (customer names / phones / action-item detail) — auth is REQUIRED. A valid Spyne session
  // token scoped to this team, or the service CRON_SECRET. No credential → 401; wrong team scope → 403.
  const auth = requireTeamAuth(request, teamId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  // degraded:true is a LOUD signal — a missing CLICKHOUSE_* env otherwise returns an empty 200 that's
  // indistinguishable from "no action items", silently disabling the transactional cron.
  if (!hasClickhouseCreds()) return Response.json({ actionItems: [], total: 0, degraded: true, note: "clickhouse not configured" });

  const svc = (searchParams.get("serviceType") || "both").toLowerCase();
  const service = SERVICE.has(svc) ? svc : "both";
  const scopeRaw = (searchParams.get("scope") || "recent").toLowerCase();
  const scope = SCOPE.has(scopeRaw) ? scopeRaw : "recent";
  const minutes = Math.max(1, Math.min(10_080, Number(searchParams.get("minutes")) || 15));
  const limit = Math.max(1, Math.min(200, Number(searchParams.get("limit")) || 50));

  const where: string[] = [
    `a.team_id='${chEsc(teamId)}'`,
    "ifNull(a.is_active,1)=1", "a.__deleted=0",
    "ifNull(a.intent,'') != ''",
  ];
  // Prefix match, not exact: 'sales' must also catch 'sales spanish' etc. (an exact '=' dropped those
  // valid rows). `service`/`both` are validated against the SERVICE allow-list above, so the literal is safe.
  if (service !== "both") where.push(`lower(ifNull(a.service_type,'')) LIKE '${service}%'`);
  if (scope === "recent") where.push(`a.createdAt >= now() - INTERVAL ${minutes} MINUTE`);
  if (scope === "open") where.push("ifNull(a.is_completed,0)=0");
  if (scope === "overdue") where.push("ifNull(a.is_completed,0)=0 AND a.due_date > toDateTime('1971-01-01') AND a.due_date < now()");

  // Identity join (lead→customer) so the action-item / overdue email names the customer — same source
  // as the digest, not a second ClickHouse query in vini-daily-calls.
  const sql =
    "SELECT a._id AS id, ifNull(a.intent,'') AS intent, a.lead_id AS leadId, ifNull(a.assigned_to,'') AS assignedTo," +
    " ifNull(a.description,'') AS description, ifNull(a.priority,'') AS priority," +
    " ifNull(a.is_completed,0) AS completed, lower(ifNull(a.service_type,'')) AS serviceType," +
    " ifNull(c.name,'') AS customer, coalesce(nullIf(c.mobile_number,'')) AS phone," +
    " formatDateTime(a.due_date,'%Y-%m-%dT%H:%i:%SZ') AS dueAt," +
    " formatDateTime(a.createdAt,'%Y-%m-%dT%H:%i:%SZ') AS at" +
    " FROM dealer_leads.actionItems a" +
    " LEFT JOIN (SELECT lead_id, any(customer_id) cid FROM dealer_leads.leads GROUP BY lead_id) l ON a.lead_id=l.lead_id" +
    " LEFT JOIN (SELECT customer_id, any(name) name, any(mobile_number) mobile_number FROM dealer_leads.customer GROUP BY customer_id) c ON l.cid=c.customer_id" +
    " WHERE " + where.join(" AND ") +
    ` ORDER BY a.createdAt DESC LIMIT ${limit}`;

  const rows = await runClickhouse<Record<string, string | number>>(sql);
  const actionItems = rows.map((r) => ({
    id: String(r.id),
    intent: String(r.intent || ""),
    leadId: r.leadId ? String(r.leadId) : null,
    assignedTo: r.assignedTo ? String(r.assignedTo) : null,
    description: String(r.description || ""),
    priority: String(r.priority || ""),
    completed: Number(r.completed) === 1,
    dept: deptOf(String(r.serviceType || "")),
    customer: r.customer ? String(r.customer) : null,
    phone: r.phone ? String(r.phone) : null,
    dueAt: String(r.dueAt || ""),
    at: String(r.at || ""),
  }));
  return Response.json({ actionItems, total: actionItems.length, scope }, {
    headers: { "Cache-Control": "s-maxage=30, stale-while-revalidate=60" },
  });
}
