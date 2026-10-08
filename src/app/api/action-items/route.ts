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
 * "All actionable intents" (product decision) → no intent allow-list; we drop blank intents and the
 * freeform 'custom' catch-all (uncategorized, no dealer-actionable meaning — RETCONVAI QA).
 * Degrades to an empty list — never 502s the pipeline.
 *
 *   /api/action-items?team_id=&serviceType=sales|service|both&scope=recent|open|overdue|created[&minutes=15][&start=&end=][&limit=50][&offset=0][&excludeIntents=a,b][&enterprise_id=]
 *
 * INTENT FILTER BEFORE THE PER-LEAD COLLAPSE (2026-10-09, audit A3-07/A3-09). Blank, 'custom' and any
 * `excludeIntents` the caller passes are dropped at the ITEM level, before rows collapse to one per lead.
 * Filtering after the collapse (as the email poller had to) let a lead's newest, non-actionable item
 * (a voicemail note) hide its older actionable one, and made every count a count of the wrong rows.
 *
 * UNCAPPED `total` for scope=open|overdue: the number of LEADS matching, from one COUNT, not the length
 * of the page. `returned` is the page length. (Other scopes keep `total` = page length, as before.)
 *
 * PAGINATION: `limit` is hard-capped at 200 server-side regardless of what's requested, so a caller
 * that assumes "one fetch gets everything" silently truncates any rooftop with a bigger backlog than
 * the limit it asked for (hit vini-daily-calls' eventRunner.cjs, 2026-07 — a rooftop with 80+ overdue
 * action items only ever saw the newest 50). `offset` + the response's `hasMore` flag let a caller
 * page through the full result set instead of guessing a big-enough single limit.
 */
import { runClickhouse, chEsc, hasClickhouseCreds } from "@/lib/spyne/clickhouse";
import { requireTeamAuth, spyneTokenFrom, spyneEnvFrom, isServiceRequest } from "@/lib/reports/auth";
import { getStoreTimeZone } from "@/lib/spyne/teamContext";
import { fetchCanonicalActionItemStats } from "@/lib/spyne/consoleReports";
import { resolveRequestEnterprise } from "@/lib/reports/enterprise";
import { rangeFor } from "@/components/reports/liveData";
import type { Bucket } from "@/components/reports/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/* Matches the other canonical fan-out routes (reports, outcomes, conversation-drill). This route now
   makes a gated canonical call too, so without it alone it would run at the Vercel project default —
   the tightest budget of the group, on the one route that was not given a deadline. */
export const maxDuration = 60;

const SERVICE = new Set(["sales", "service", "both"]);
const SCOPE = new Set(["recent", "open", "overdue", "stats", "created"]);
const idOk = (s: string) => /^[A-Za-z0-9_-]{1,64}$/.test(s);
const dateOk = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
// An IANA zone name ("America/Los_Angeles", "Etc/GMT+5") — validated before it is inlined into SQL.
const tzOk = (s: string) => /^[A-Za-z]+(?:[/_+-][A-Za-z0-9]+)*$/.test(s) && s.length <= 64;
// One caller-supplied intent to exclude ("sales_left_voicemail"). Lower-cased, validated, inlined quoted.
const intentOk = (s: string) => /^[a-z0-9_ .:-]{1,64}$/.test(s);
/* PRIVATE on every response: list scopes carry names and phone numbers, and even the stats scoreboard is
 * a credential-gated read that a shared cache (which keys on the URL alone) would replay to anyone. */
const PRIVATE_LONG = { "Cache-Control": "private, max-age=900, stale-while-revalidate=1800" };
const PRIVATE_SHORT = { "Cache-Control": "private, max-age=60, stale-while-revalidate=120" };

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

  const svc = (searchParams.get("serviceType") || "both").toLowerCase();
  const service = SERVICE.has(svc) ? svc : "both";
  const scopeRaw = (searchParams.get("scope") || "recent").toLowerCase();
  const scope = SCOPE.has(scopeRaw) ? scopeRaw : "recent";
  const minutes = Math.max(1, Math.min(10_080, Number(searchParams.get("minutes")) || 15));
  const limit = Math.max(1, Math.min(200, Number(searchParams.get("limit")) || 50));
  const offset = Math.max(0, Number(searchParams.get("offset")) || 0);
  const spyneToken = spyneTokenFrom(request);
  const spyneEnv = spyneEnvFrom(request);
  const bucketRaw = searchParams.get("bucket") || "";
  const BUCKETS = new Set(["today", "yesterday", "last7", "last14", "last30", "mtd", "lifetime"]);

  // Store-local window for the windowed scopes (stats/created). Resolved server-side from `bucket` via the
  // rooftop timezone — the SAME resolution /api/reports uses — so the Action Items tab's Today/Yesterday
  // land on the dealer's calendar day and match the Overview card instead of drifting to UTC (the tab used
  // to compute the window client-side with no tz → UTC, RETCONVAI-4144). Explicit start/end (custom
  // picker) win; neither given → trailing 30 days. tz resolution costs one Spyne call, so it only runs for
  // the windowed scopes (never for recent/open/overdue).
  /* Also returns the resolved calendar dates + timezone, not just the ClickHouse expressions, so the
     dealer-leads API below can be asked for the IDENTICAL window rather than re-deriving it. */
  /* ★ EXPLICIT start/end ARE STORE-LOCAL DATES TOO (fixed 2026-10-09, audit A2 F22). The timezone used to
     be resolved only for a `bucket`, so an explicit window — every digest call and every Overview custom
     range — reached dealer-leads with timezone=null and was compared in ClickHouse as UTC midnights. The
     zone is now resolved whenever there is a window, and the ClickHouse bounds are the store's midnights.
     Unknown zone → the previous UTC behaviour. */
  async function windowExprs(): Promise<{
    startExpr: string;
    endExpr: string;
    start: string;
    end: string;
    tz: string | null;
  }> {
    let s = dateOk(searchParams.get("start") || "") ? (searchParams.get("start") as string) : "";
    let e = dateOk(searchParams.get("end") || "") ? (searchParams.get("end") as string) : "";
    let tz: string | null = null;
    const wantsBucket = (!s || !e) && BUCKETS.has(bucketRaw);
    if (s || e || wantsBucket) {
      const resolved = await getStoreTimeZone(teamId, spyneToken, spyneEnv);
      tz = resolved && tzOk(resolved) ? resolved : null;
    }
    if (wantsBucket) {
      const w = rangeFor(bucketRaw as Bucket, tz ?? undefined);
      if (!s) s = w.start;
      if (!e) e = w.end;
    }
    const tzArg = tz ? `,'${tz}'` : "";
    return {
      startExpr: s ? `toDateTime64('${s} 00:00:00',3${tzArg})` : "now() - INTERVAL 30 DAY",
      endExpr: e ? `toDateTime64('${e} 00:00:00',3${tzArg})` : "now()",
      start: s,
      end: e,
      tz,
    };
  }

  /* The ClickHouse guard is checked per-path rather than up front, because `scope=stats` is now served
   * by the dealer-leads API and needs no ClickHouse at all — prod Vercel has none, and the blanket
   * guard turned that scope into an empty 200 there.
   *
   * degraded:true stays a LOUD signal for every path that DOES need ClickHouse: a missing CLICKHOUSE_*
   * env otherwise returns an empty 200 that is indistinguishable from "no action items", silently
   * disabling the transactional cron. */
  const noCh = () =>
    Response.json({ actionItems: [], total: 0, degraded: true, note: "clickhouse not configured" }, { headers: PRIVATE_SHORT });

  // ── scope=stats: rooftop action-item scoreboard (created/closed in-window + open/overdue/due-today
  //    now + a who-closed-most leaderboard). All from dealer_leads.actionItems, de-duped to the latest
  //    CDC row per _id (argMax over _version) so triplicate rows don't inflate the counts. created &
  //    closed are windowed by start/end (store-local dates, exclusive end); open/overdue/due-today are
  //    current-state. Window defaults to the trailing 30 days. Times compared in ClickHouse server time
  //    — a minor TZ skew vs the dealer-local report window, acceptable for these operational counts. ──
  if (scope === "stats") {
    const svcFilter = service !== "both" ? ` AND lower(ifNull(service_type,'')) LIKE '${service}%'` : "";
    const { startExpr, endExpr, start: winStart, end: winEnd, tz: winTz } = await windowExprs();

    /* DEALER-LEADS FIRST (2026-09-29). Action items are WRITTEN in Mongo; everything below reads the
     * ClickHouse CDC replica of them. Same roll-up, same grain — verified equal on the reference
     * rooftop, 559/558/1/1/1 both ways — so this is a change of SOURCE, not of number: no CDC lag, and
     * the window is resolved in the rooftop's own timezone instead of ClickHouse server time.
     *
     * The ClickHouse path stays underneath, unchanged, as the fallback. The row-level scopes further
     * down are deliberately NOT moved: they also feed the transactional-email pipeline, which depends
     * on their current shape. */
    /* ★ THE ROOFTOP'S ENTERPRISE, NOT THE ENV TOKEN'S (fixed 2026-10-09, audit A2 F1). The digest cron
       sends CRON_SECRET and no dealer token; this used to resolve the enterprise from the env
       SPYNE_API_TOKEN, and dealer-leads answered that mismatched (enterprise, team) pair with a clean
       200 of zeros — 0 of 335 digests since 10-01 showed an overdue count. resolveRequestEnterprise
       never uses the env token for a service caller: it takes ?enterprise_id= checked against the
       team's own enterprise (or the team's mapped enterprise), and returns null when neither is
       trustworthy, which sends the request to the ClickHouse roll-up below. */
    const ent = winStart && winEnd ? await resolveRequestEnterprise(request, teamId, spyneToken) : null;
    let upstreamZero = false;
    if (winStart && winEnd && ent?.enterpriseId) {
      const viaApi = await fetchCanonicalActionItemStats(
        { enterpriseId: ent.enterpriseId, teamId, serviceType: service === "both" ? undefined : service, start: winStart, end: winEnd, timezone: winTz },
        spyneToken,
        spyneEnv,
      );
      if (viaApi?.stats) {
        const st = viaApi.stats;
        const allZero = !st.created && !st.completed && !st.open && !st.overdue && !st.dueToday;
        /* A SERVICE caller has no dealer token, so this call ran on the env token for another rooftop's
           enterprise — exactly the pairing that produced the fake zeros. An all-zero answer on that path
           is checked against ClickHouse below before it is believed; a dealer's own token is trusted as
           before, so the Overview is unchanged. */
        if (!(allZero && isServiceRequest(request) && !spyneToken)) {
          return Response.json(
            { scope: "stats", stats: viaApi.stats, closers: viaApi.closers ?? [], source: "dealer-leads", timezone: winTz },
            { headers: PRIVATE_SHORT },
          );
        }
        upstreamZero = true;
      }
    }
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
      ` FROM (${byId}) WHERE deleted=0 AND intent != '' AND lower(intent) != 'custom' GROUP BY lead_id`;
    const statsSql =
      "SELECT sum(created_in_win) AS created, sum(completed_in_win) AS completed," +
      " sum(open_any) AS open, sum(overdue_any) AS overdue, sum(dueToday_any) AS dueToday" +
      ` FROM (${perLead})`;
    // Who-closed-most: distinct LEADS with an item completed in-window, grouped by that item's assignee.
    const closersSql =
      "SELECT assigned_to AS assignedTo, uniqExact(lead_id) AS closed" +
      ` FROM (${byId}) WHERE deleted=0 AND intent != '' AND lower(intent) != 'custom' AND is_completed=1` +
      ` AND updatedAt >= ${startExpr} AND updatedAt < ${endExpr}` +
      " GROUP BY assigned_to ORDER BY closed DESC LIMIT 10";
    if (!hasClickhouseCreds()) return noCh();
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
        source: "clickhouse",
        timezone: winTz,
        // The dealer-leads API said all-zero on the service path and ClickHouse was asked instead.
        ...(upstreamZero ? { upstreamZeroChecked: true } : {}),
        // Why the dealer-leads path was not used, when it was skipped for want of an enterprise.
        ...(ent && !ent.enterpriseId ? { enterpriseUnresolved: ent.reason ?? "unknown" } : {}),
      },
      { headers: PRIVATE_SHORT },
    );
  }

  if (!hasClickhouseCreds()) return noCh();

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
  // Drop the freeform 'custom' intent — it's an uncategorized AI catch-all with no actionable meaning to
  // the dealer (RETCONVAI QA: "custom intent looks meaningless"). Applied here (list) AND in the stats
  // roll-up above so the tab count and the rows stay consistent.
  const itemWhere: string[] = ["is_active=1", "__deleted=0", "intent != ''", "lower(intent) != 'custom'"];
  // Prefix match, not exact: 'sales' must also catch 'sales spanish' etc. `service`/`both` validated above.
  if (service !== "both") itemWhere.push(`service_type LIKE '${service}%'`);
  // Caller-excluded intents (e.g. the email poller's non-actionable voicemail/lost set), item-level and
  // therefore BEFORE the per-lead collapse below — see the header note.
  const excluded = [...new Set((searchParams.get("excludeIntents") || "").split(",").map((x) => x.trim().toLowerCase()).filter(intentOk))].slice(0, 50);
  if (excluded.length) itemWhere.push(`lower(intent) NOT IN (${excluded.map((x) => `'${chEsc(x)}'`).join(",")})`);
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
    // TENANT-SCOPE BOTH JOIN SUBQUERIES. Without the team_id predicate each of these aggregates the
    // WHOLE fleet — leads (1.37M) + customer (1.20M) — to resolve names for at most `limit` rows, so a
    // 200-row page built a ~2.5M-row hash table and peaked at ~850 MiB. Measured A/B on the busiest
    // rooftop: 296ms/775 MiB → 57ms/151 MiB, same rows out. Verified lossless: across the 8 busiest
    // teams, ZERO leads resolve to a customer row belonging to a different team, so scoping drops
    // nothing that used to match.
    ` LEFT JOIN (SELECT lead_id, any(customer_id) cid FROM dealer_leads.leads WHERE team_id='${chEsc(teamId)}' GROUP BY lead_id) l ON a.lead_id=l.lead_id` +
    ` LEFT JOIN (SELECT customer_id, any(name) name, any(mobile_number) mobile_number FROM dealer_leads.customer WHERE team_id='${chEsc(teamId)}' GROUP BY customer_id) c ON l.cid=c.customer_id` +
    ` ORDER BY a.createdAt DESC LIMIT ${limit} OFFSET ${offset}`;

  /* The uncapped count for the current-state scopes: LEADS with ≥1 matching item, the same grain and the
     same predicates as the rows. One COUNT, run beside the page read. */
  const wantsTotal = scope === "open" || scope === "overdue";
  const [rows, countRows] = await Promise.all([
    runClickhouse<Record<string, string | number>>(sql),
    wantsTotal ? runClickhouse<{ n?: string | number }>(`SELECT count() AS n FROM (${dedupedList})`) : Promise.resolve([] as { n?: string | number }[]),
  ]);
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
  // A failed COUNT (empty result) falls back to the page length rather than reporting 0.
  const counted = countRows.length ? Number(countRows[0].n) : NaN;
  const total = wantsTotal && Number.isFinite(counted) ? Math.max(counted, offset + actionItems.length) : actionItems.length;
  return Response.json({ actionItems, total, returned: actionItems.length, scope, hasMore: actionItems.length === limit }, {
    /* PRIVATE, not s-maxage. This payload carries customer names and phone numbers, and `s-maxage`
         targets SHARED caches — a CDN keys on URL alone and would ignore the bearer token this
         route is gated by. Matches /api/reports, which already says the same thing. */
      headers: PRIVATE_LONG,
  });
}
