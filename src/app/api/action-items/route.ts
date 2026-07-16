/* Per-event ACTION-ITEM feed for the action-item + overdue transactional emails.
 *
 * Row-level action items for a rooftop, from dealer_leads.actionItems (the only row-level source).
 * Three scopes:
 *   • recent   — created in the last N minutes → "new action item assigned" email (poll pass)
 *   • open     — all not-completed → the stacked "pending" list shown in those emails
 *   • overdue  — not completed AND past due_date → the SLA-breach escalation email
 *   • created  — created within [start,end) → the daily-digest "Action required" list (grouped by
 *                intent client-side). This is the faithful successor to the old getActionItems()
 *                "createdAt BETWEEN start AND end GROUP BY intent" query — a per-window count, unlike
 *                the current-state `open` snapshot which dealers drain to near-zero.
 *
 * "All actionable intents" (product decision) → no intent allow-list; we only drop blank intents.
 * Degrades to an empty list — never 502s the pipeline.
 *
 *   /api/action-items?team_id=&serviceType=sales|service|both&scope=recent|open|overdue|created[&minutes=15][&start=&end=][&limit=50][&offset=0]
 *
 * PAGINATION: `limit` is hard-capped at 200 server-side regardless of what's requested, so a caller
 * that assumes "one fetch gets everything" silently truncates any rooftop with a bigger backlog than
 * the limit it asked for (hit vini-daily-calls' eventRunner.cjs, 2026-07 — a rooftop with 80+ overdue
 * action items only ever saw the newest 50). `offset` + the response's `hasMore` flag let a caller
 * page through the full result set instead of guessing a big-enough single limit.
 */
import { runClickhouse, chEsc, hasClickhouseCreds } from "@/lib/spyne/clickhouse";
import { requireTeamAuth, spyneTokenFrom } from "@/lib/reports/auth";
import { getStoreTimeZone } from "@/lib/spyne/teamContext";
import { rangeFor } from "@/components/reports/liveData";
import type { Bucket } from "@/components/reports/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SERVICE = new Set(["sales", "service", "both"]);
const SCOPE = new Set(["recent", "open", "overdue", "stats", "created"]);
const idOk = (s: string) => /^[A-Za-z0-9_-]{1,64}$/.test(s);
const dateOk = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

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
  const offset = Math.max(0, Number(searchParams.get("offset")) || 0);
  const spyneToken = spyneTokenFrom(request);
  const bucketRaw = searchParams.get("bucket") || "";
  const BUCKETS = new Set(["today", "yesterday", "last7", "last14", "last30", "mtd", "lifetime"]);

  // Store-local window for the windowed scopes (stats/created). Resolved server-side from `bucket` via the
  // rooftop timezone — the SAME resolution /api/reports uses — so the Action Items tab's Today/Yesterday
  // land on the dealer's calendar day and match the Overview card instead of drifting to UTC (the tab used
  // to compute the window client-side with no tz → UTC, RETCONVAI-4144). Explicit start/end (custom
  // picker) win; neither given → trailing 30 days. tz resolution costs one Spyne call, so it only runs for
  // the windowed scopes (never for recent/open/overdue).
  async function windowExprs(): Promise<{ startExpr: string; endExpr: string }> {
    let s = dateOk(searchParams.get("start") || "") ? (searchParams.get("start") as string) : "";
    let e = dateOk(searchParams.get("end") || "") ? (searchParams.get("end") as string) : "";
    if ((!s || !e) && BUCKETS.has(bucketRaw)) {
      const tz = await getStoreTimeZone(teamId, spyneToken);
      const w = rangeFor(bucketRaw as Bucket, tz ?? undefined);
      if (!s) s = w.start;
      if (!e) e = w.end;
    }
    return {
      startExpr: s ? `toDateTime64('${s} 00:00:00',3)` : "now() - INTERVAL 30 DAY",
      endExpr: e ? `toDateTime64('${e} 00:00:00',3)` : "now()",
    };
  }

  // ── scope=stats: rooftop action-item scoreboard (created/closed in-window + open/overdue/due-today
  //    now + a who-closed-most leaderboard). All from dealer_leads.actionItems, de-duped to the latest
  //    CDC row per _id (argMax over _version) so triplicate rows don't inflate the counts. created &
  //    closed are windowed by start/end (store-local dates, exclusive end); open/overdue/due-today are
  //    current-state. Window defaults to the trailing 30 days. Times compared in ClickHouse server time
  //    — a minor TZ skew vs the dealer-local report window, acceptable for these operational counts. ──
  if (scope === "stats") {
    const svcFilter = service !== "both" ? ` AND lower(ifNull(service_type,'')) LIKE '${service}%'` : "";
    const { startExpr, endExpr } = await windowExprs();
    // Two-level roll-up. Level 1 (byId): latest CDC row per _id (argMax over _version). Level 2 (perLead):
    // collapse to ONE row per LEAD. The AI re-creates the same action item on every touch — one Bridgeton
    // lead carried 115 'AskStaffMember/Manager' + 95 'RequestCallback' rows — so counting per _id inflated
    // "open"/"overdue" (4,141 vs ~1,730 real leads) and showed the same customer many times
    // (RETCONVAI-4143/4149). A lead counts as open/overdue/due-today when it has AT LEAST ONE item matching
    // (max() flag), so a lead with genuine open work is never missed even if its most-recent item is closed.
    // deleted/blank-intent are dropped BEFORE the roll-up.
    const byId =
      "SELECT _id," +
      " argMax(lead_id,_version) AS lead_id, argMax(ifNull(intent,''),_version) AS intent," +
      " argMax(ifNull(is_completed,0),_version) AS is_completed, argMax(ifNull(is_active,1),_version) AS is_active," +
      " argMax(createdAt,_version) AS created_ts, argMax(updatedAt,_version) AS updatedAt," +
      " argMax(due_date,_version) AS due_date, argMax(__deleted,_version) AS deleted," +
      " argMax(ifNull(assigned_to,''),_version) AS assigned_to" +
      ` FROM dealer_leads.actionItems WHERE team_id='${chEsc(teamId)}'${svcFilter} GROUP BY _id`;
    // Per-lead flags: 1 when the lead has ANY item satisfying the predicate. created/closed are windowed;
    // open/overdue/due-today are current-state. max(<bool>) → 1 if any row qualifies.
    const perLead =
      "SELECT lead_id," +
      ` max(created_ts >= ${startExpr} AND created_ts < ${endExpr}) AS created_in_win,` +
      ` max(is_completed=1 AND updatedAt >= ${startExpr} AND updatedAt < ${endExpr}) AS completed_in_win,` +
      " max(is_completed=0 AND is_active=1) AS open_any," +
      " max(is_completed=0 AND is_active=1 AND due_date > toDateTime('1971-01-01') AND due_date < now()) AS overdue_any," +
      " max(is_completed=0 AND is_active=1 AND toDate(due_date)=today()) AS dueToday_any" +
      ` FROM (${byId}) WHERE deleted=0 AND intent != '' GROUP BY lead_id`;
    const statsSql =
      "SELECT sum(created_in_win) AS created, sum(completed_in_win) AS completed," +
      " sum(open_any) AS open, sum(overdue_any) AS overdue, sum(dueToday_any) AS dueToday" +
      ` FROM (${perLead})`;
    // Who-closed-most: distinct LEADS with an item completed in-window, grouped by that item's assignee.
    const closersSql =
      "SELECT assigned_to AS assignedTo, uniqExact(lead_id) AS closed" +
      ` FROM (${byId}) WHERE deleted=0 AND intent != '' AND is_completed=1` +
      ` AND updatedAt >= ${startExpr} AND updatedAt < ${endExpr}` +
      " GROUP BY assigned_to ORDER BY closed DESC LIMIT 10";
    const [statRows, closerRows] = await Promise.all([
      runClickhouse<Record<string, string | number>>(statsSql),
      runClickhouse<Record<string, string | number>>(closersSql),
    ]);
    const s = statRows[0] ?? {};
    const num = (v: unknown) => Number(v) || 0;
    return Response.json(
      {
        scope: "stats",
        stats: {
          created: num(s.created),
          completed: num(s.completed),
          open: num(s.open),
          overdue: num(s.overdue),
          dueToday: num(s.dueToday),
        },
        closers: closerRows.map((r) => ({ assignedTo: String(r.assignedTo || ""), closed: num(r.closed) })),
      },
      { headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=120" } },
    );
  }

  // Two-level roll-up — SAME grain as the `stats` scope (one row per LEAD), so the list and the scoreboard
  // agree. Level 1 (byIdList): latest CDC row per _id. Level 2 (dedupedList): one row per lead = the latest
  // item that matches the scope. The old list read the CDC table raw, so one lead's 115 duplicate
  // 'RequestCallback' rows all surfaced as separate list entries and consumed the paged LIMIT, pushing
  // genuine leads off the page (RETCONVAI-4143). Scope/hygiene predicates are applied at the ITEM level
  // (itemWhere) BEFORE the per-lead collapse, so a lead is listed iff it has ANY matching item — the same
  // "any open" rule the scoreboard uses.
  const byIdList =
    "SELECT _id," +
    " argMax(lead_id,_version) AS lead_id, argMax(ifNull(intent,''),_version) AS intent," +
    " argMax(ifNull(assigned_to,''),_version) AS assigned_to, argMax(ifNull(description,''),_version) AS description," +
    " argMax(ifNull(priority,''),_version) AS priority, argMax(ifNull(is_completed,0),_version) AS is_completed," +
    " argMax(lower(ifNull(service_type,'')),_version) AS service_type, argMax(due_date,_version) AS due_date," +
    " argMax(createdAt,_version) AS created_ts, argMax(ifNull(is_active,1),_version) AS is_active," +
    " argMax(__deleted,_version) AS __deleted" +
    ` FROM dealer_leads.actionItems WHERE team_id='${chEsc(teamId)}' GROUP BY _id`;

  // Item-level predicates (scope + hygiene) applied to the deduped-per-_id rows BEFORE the per-lead
  // collapse — a lead is listed iff it has ≥1 item passing these (matches the scoreboard's "any" rule).
  const itemWhere: string[] = ["is_active=1", "__deleted=0", "intent != ''"];
  // Prefix match, not exact: 'sales' must also catch 'sales spanish' etc. `service`/`both` validated above.
  if (service !== "both") itemWhere.push(`service_type LIKE '${service}%'`);
  if (scope === "recent") itemWhere.push(`created_ts >= now() - INTERVAL ${minutes} MINUTE`);
  if (scope === "open") itemWhere.push("is_completed=0");
  if (scope === "overdue") itemWhere.push("is_completed=0 AND due_date > toDateTime('1971-01-01') AND due_date < now()");
  if (scope === "created") {
    // created within [start,end) — store-local window resolved the same way as `stats` (RETCONVAI-4144).
    const { startExpr, endExpr } = await windowExprs();
    itemWhere.push(`created_ts >= ${startExpr} AND created_ts < ${endExpr}`);
  }
  // Collapse matching items to one row per lead — the latest matching item (argMax over created_ts).
  // itemWhere is applied in an INNER non-aggregating subquery (SELECT * … WHERE …) so its predicates
  // resolve to the source columns; putting them in this level's WHERE would collide with the argMax
  // aliases of the same name (is_completed/service_type/due_date/intent) → ILLEGAL_AGGREGATION. created_ts
  // is the ordering key; `max(created_ts) AS createdAt` is the output (renamed to avoid the same collision).
  const dedupedList =
    "SELECT lead_id, argMax(_id,created_ts) AS _id, argMax(intent,created_ts) AS intent," +
    " argMax(assigned_to,created_ts) AS assigned_to, argMax(description,created_ts) AS description," +
    " argMax(priority,created_ts) AS priority, argMax(is_completed,created_ts) AS is_completed," +
    " argMax(service_type,created_ts) AS service_type, argMax(due_date,created_ts) AS due_date," +
    " max(created_ts) AS createdAt" +
    ` FROM (SELECT * FROM (${byIdList}) WHERE ${itemWhere.join(" AND ")}) GROUP BY lead_id`;

  // Identity join (lead→customer) so the action-item / overdue email names the customer — same source
  // as the digest, not a second ClickHouse query in vini-daily-calls. All filtering happened above, so
  // the outer query only joins + orders + pages.
  const sql =
    "SELECT a._id AS id, a.intent AS intent, a.lead_id AS leadId, a.assigned_to AS assignedTo," +
    " a.description AS description, a.priority AS priority," +
    " a.is_completed AS completed, a.service_type AS serviceType," +
    " ifNull(c.name,'') AS customer, coalesce(nullIf(c.mobile_number,'')) AS phone," +
    " formatDateTime(a.due_date,'%Y-%m-%dT%H:%i:%SZ') AS dueAt," +
    " formatDateTime(a.createdAt,'%Y-%m-%dT%H:%i:%SZ') AS at" +
    ` FROM (${dedupedList}) a` +
    " LEFT JOIN (SELECT lead_id, any(customer_id) cid FROM dealer_leads.leads GROUP BY lead_id) l ON a.lead_id=l.lead_id" +
    " LEFT JOIN (SELECT customer_id, any(name) name, any(mobile_number) mobile_number FROM dealer_leads.customer GROUP BY customer_id) c ON l.cid=c.customer_id" +
    ` ORDER BY a.createdAt DESC LIMIT ${limit} OFFSET ${offset}`;

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
  // hasMore is a cheap "got a full page" heuristic (no extra COUNT query) — a caller paginating with
  // offset should keep going while this is true, and stop as soon as a page comes back short.
  return Response.json({ actionItems, total: actionItems.length, scope, hasMore: actionItems.length === limit }, {
    headers: { "Cache-Control": "s-maxage=30, stale-while-revalidate=60" },
  });
}
