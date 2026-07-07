/* Customer / lead book for a rooftop — powers the Customers page.
 *
 * Recent leads for a team from dealer_leads.leads, de-duped to the latest CDC row per lead_id
 * (argMax over _version), joined to dealer_leads.customer for the customer's name + phone. Carries
 * the CRM lead status (external_lead_status) bucketed for filtering, the acquisition source, and the
 * last-activity timestamp. SOLD_DELIVERED → `sold` (the canonical "AI-engaged lead now sold" signal).
 *
 *   /api/customers?team_id=&bucket=active|sold|lost|service|all&q=&limit=50
 *
 * PII endpoint (names / phones) — auth REQUIRED, same contract as /api/action-items. Degrades to an
 * empty list; never 502s.
 */
import { runClickhouse, chEsc, hasClickhouseCreds } from "@/lib/spyne/clickhouse";
import { requireTeamAuth } from "@/lib/reports/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idOk = (s: string) => /^[A-Za-z0-9_-]{1,64}$/.test(s);
// Status buckets → external_lead_status prefixes. Kept coarse so the free-form CRM statuses collapse to
// the four buckets a dealer reasons about, plus the canonical SOLD signal.
const BUCKET = new Set(["active", "sold", "lost", "service", "all"]);
function bucketOf(status: string): "active" | "sold" | "lost" | "service" | "other" {
  const s = (status || "").toUpperCase();
  if (!s) return "other"; // no CRM status yet
  if (s === "SOLD_DELIVERED") return "sold";
  if (s.startsWith("SERVICE")) return "service";
  if (s.startsWith("LOST") || s.startsWith("BAD")) return "lost";
  // Everything else non-terminal is an in-progress lead — ACTIVE_*, but also NEW / WORKING / CONTACTED /
  // APPT_SET etc. that don't start with "ACTIVE". Bucketing these as "active" makes the Active tab match
  // real live leads instead of only the ACTIVE-prefixed ones.
  return "active";
}
// SQL predicate for a bucket, over the deduped alias `l.status`. Mirrors bucketOf so the DB filter and
// the display label agree. "all" → no predicate. "active" = any non-blank, non-terminal status.
function bucketSql(bucket: string): string {
  switch (bucket) {
    case "sold": return " AND upper(ifNull(l.status,''))='SOLD_DELIVERED'";
    case "service": return " AND upper(ifNull(l.status,'')) LIKE 'SERVICE%'";
    case "lost": return " AND (upper(ifNull(l.status,'')) LIKE 'LOST%' OR upper(ifNull(l.status,'')) LIKE 'BAD%')";
    case "active": return " AND ifNull(l.status,'')!='' AND upper(ifNull(l.status,''))!='SOLD_DELIVERED'"
      + " AND upper(ifNull(l.status,'')) NOT LIKE 'SERVICE%' AND upper(ifNull(l.status,'')) NOT LIKE 'LOST%' AND upper(ifNull(l.status,'')) NOT LIKE 'BAD%'";
    default: return "";
  }
}

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const teamId = searchParams.get("team_id") || "";
  if (!idOk(teamId)) return Response.json({ error: "valid team_id is required" }, { status: 400 });

  const auth = requireTeamAuth(request, teamId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  if (!hasClickhouseCreds()) return Response.json({ customers: [], total: 0, degraded: true, note: "clickhouse not configured" });

  const bucketRaw = (searchParams.get("bucket") || "all").toLowerCase();
  const bucket = BUCKET.has(bucketRaw) ? bucketRaw : "all";
  const limit = Math.max(1, Math.min(200, Number(searchParams.get("limit")) || 50));
  // Free-text search on the customer name (optional). Sanitized to alphanumerics + spaces so it's safe
  // to inline; empty → no search.
  // Keep letters/digits/space/.'- (apostrophes are common in names), then escape for the SQL literal via
  // chEsc — WITHOUT escaping, an apostrophe (O'Brien) closes the quote and 400s the query → silent empty
  // results. chEsc doubles the quote so the search is both correct and injection-safe.
  const q = (searchParams.get("q") || "").replace(/[^A-Za-z0-9 .'-]/g, "").trim().slice(0, 60);

  // Latest lead row per lead_id, then join the customer's identity. lastActivity = external CRM
  // timestamp when present (the lead's real recency), else our created_at.
  const sql =
    "SELECT l.lead_id AS leadId, ifNull(c.name,'') AS customer, coalesce(nullIf(c.mobile_number,'')) AS phone," +
    " ifNull(l.source,'') AS source, ifNull(l.status,'') AS status, ifNull(l.crmLeadId,'') AS crmLeadId," +
    " formatDateTime(coalesce(l.extCreated, l.created), '%Y-%m-%dT%H:%i:%SZ') AS lastActivity" +
    " FROM (" +
    "  SELECT lead_id," +
    "   argMax(customer_id,_version) AS cid, argMax(source,_version) AS source," +
    "   argMax(external_lead_status,_version) AS status, argMax(external_crm_lead_id,_version) AS crmLeadId," +
    "   argMax(external_created_at,_version) AS extCreated, argMax(created_at,_version) AS created," +
    "   argMax(__deleted,_version) AS del" +
    `  FROM dealer_leads.leads WHERE team_id='${chEsc(teamId)}' GROUP BY lead_id` +
    " ) l" +
    " LEFT JOIN (SELECT customer_id, any(name) name, any(mobile_number) mobile_number FROM dealer_leads.customer GROUP BY customer_id) c ON l.cid=c.customer_id" +
    " WHERE l.del=0 AND ifNull(c.name,'') != ''" +
    bucketSql(bucket) +
    (q ? ` AND positionCaseInsensitive(c.name, '${chEsc(q)}') > 0` : "") +
    " ORDER BY coalesce(l.extCreated, l.created) DESC" +
    ` LIMIT ${limit}`;

  const rows = await runClickhouse<Record<string, string | number>>(sql);
  const customers = rows.map((r) => {
    const status = String(r.status || "");
    return {
      leadId: r.leadId ? String(r.leadId) : null,
      customer: String(r.customer || "—"),
      phone: r.phone ? String(r.phone) : null,
      source: String(r.source || ""),
      status,
      statusBucket: bucketOf(status),
      sold: status.toUpperCase() === "SOLD_DELIVERED",
      crmLeadId: r.crmLeadId ? String(r.crmLeadId) : null,
      lastActivity: String(r.lastActivity || ""),
    };
  });
  return Response.json(
    { customers, total: customers.length, bucket },
    { headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=120" } },
  );
}
