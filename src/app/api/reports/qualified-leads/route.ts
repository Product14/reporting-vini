/* NAMED "qualified, not yet booked" leads for a rooftop + window — the third bucket of the ROI export.
 *
 *   GET /api/reports/qualified-leads?team_id=&serviceType=sales|service|both[&bucket=|&start=&end=][&limit=]
 *
 * WHY THIS EXISTS RATHER THAN /api/reports/lead-drill?bucket_stage=qualified. That route answers the same
 * question but is built from endcallreports, i.e. leads that were CALLED. On a texting-heavy rooftop that
 * is a small slice of the truth: Dream Nissan Kansas City, 30 days — the drill returns 61 leads where the
 * real figure is 235, because most of its qualification happens over SMS. The ROI export is a document a
 * dealer is handed, so it has to count every channel.
 *
 * The set is taken from agent_lead_days (the same lead-grain table every qualified count on the report is
 * built from) so the list length matches the tile above it by construction: distinct leads flagged
 * qualified in the window, minus distinct leads that booked. Names and numbers are resolved from
 * ClickHouse, which is the only place they live.
 *
 * PII: customer names and phone numbers, so this is auth-gated exactly like the other per-customer routes.
 */
import { runClickhouse, chEsc, hasClickhouseCreds } from "@/lib/spyne/clickhouse";
import { requireTeamAuth, spyneTokenFrom, spyneEnvFrom } from "@/lib/reports/auth";
import { enterpriseIdFromToken } from "@/lib/spyne/meetings";
import { fetchCanonicalHotLeads } from "@/lib/spyne/consoleReports";
import { getSupabase, AGENT_LEAD_DAYS } from "@/lib/reports/supabase";
import { rangeFor } from "@/components/reports/liveData";
import type { Bucket } from "@/components/reports/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BUCKETS = new Set<Bucket>(["today", "yesterday", "last7", "last14", "last30", "mtd", "lifetime"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const idOk = (s: string) => /^[A-Za-z0-9_-]{1,64}$/.test(s);

const AGENT_TYPES: Record<string, string[]> = {
  sales: ["Sales Inbound", "Sales Outbound"],
  service: ["Service Inbound", "Service Outbound"],
};

export interface QualifiedLead {
  leadId: string;
  customer: string;
  phone: string;
  source: string;
  lastTouch: string;
}

/* Distinct lead ids carrying `flag` in the window. Paged: PostgREST caps a response at 1,000 rows and a
 * busy rooftop's 30 days runs well past that, so a single unpaged read would silently truncate the set
 * and under-report the very number this route exists to list. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function leadIdsWith(sb: any, teamId: string, types: string[] | null, start: string, end: string, flag: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (let from = 0; ; from += 1000) {
    let q = sb.from(AGENT_LEAD_DAYS).select("lead_id").eq("team_id", teamId)
      .eq(flag, true).gte("activity_day", start).lt("activity_day", end).range(from, from + 999);
    if (types) q = q.in("agent_type", types);
    const { data, error } = await q;
    if (error || !Array.isArray(data)) break;
    for (const r of data) {
      const id = String((r as { lead_id?: string }).lead_id ?? "");
      if (id) out.add(id);
    }
    if (data.length < 1000) break;
  }
  return out;
}

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const teamId = searchParams.get("team_id") || "";
  if (!idOk(teamId)) return Response.json({ error: "valid team_id is required" }, { status: 400 });

  const auth = requireTeamAuth(request, teamId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const dept = (searchParams.get("serviceType") || "both").toLowerCase();
  const types = AGENT_TYPES[dept] ?? null; // "both"/unknown → every agent type

  let start = searchParams.get("start") || "";
  let end = searchParams.get("end") || "";
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    const b = (searchParams.get("bucket") || "last30") as Bucket;
    const r = rangeFor(BUCKETS.has(b) ? b : "last30");
    start = r.start; end = r.end;
  }
  // Generous but bounded: the PDF prints every row it is given, and an unbounded list would produce a
  // document nobody can use and a ClickHouse IN() clause to match.
  const limit = Math.min(Math.max(parseInt(searchParams.get("limit") || "400", 10) || 400, 1), 800);

  /* SALES COMES FROM THE CANONICAL API, NOT agent_lead_days.
   *
   * The header above says agent_lead_days is "the same lead-grain table every qualified count on the
   * report is built from", and that stopped being true when the console moved onto the canonical
   * endpoints. Qualified is now rule V12 (eval-based); agent_lead_days still carries the old spine
   * rule, and the two agree on only 89 leads (spine 190, eval 149 -- decisions.md:130). Leaving this
   * on Supabase would hand a dealer an ROI PDF whose list matches the tile printed above it on under
   * half its rows. Everything below -- the ClickHouse name/phone/source/lastTouch lookup, the limit,
   * the ordering, the degraded shapes -- is untouched; only where the SET comes from changed.
   *
   * SERVICE AND "both" STAY ON SUPABASE. The canonical endpoint is sales-only, and mixing one
   * department's new rule with another's old rule inside a single list would be worse than either.
   */
  let qualified: Set<string> | null = null;
  let total = 0;

  if (dept === "sales") {
    const token = spyneTokenFrom(request);
    const canon = await fetchCanonicalHotLeads(
      { enterpriseId: enterpriseIdFromToken(token) ?? "", teamId, dept: "sales", start, end },
      token,
      spyneEnvFrom(request),
    );
    if (canon) {
      qualified = new Set(canon.leads.map((l) => l.leadId).filter(Boolean));
      // `count` is the rooftop figure the tile shows; `leads` may be a capped sample, so the TOTAL is
      // the API's count, never the length of the list we happen to have resolved names for.
      total = canon.count;
    }
    // canon === null → the API is unreachable; fall through to the aggregate rather than hand back an
    // empty export. The numbers will be the old rule's, which is why the caller flags `degraded`.
  }

  const sb = getSupabase();
  if (!qualified) {
    if (!sb) return Response.json({ leads: [], total: 0, degraded: true, note: "supabase not configured" });
    const [q, booked] = await Promise.all([
      leadIdsWith(sb, teamId, types, start, end, "qualified"),
      leadIdsWith(sb, teamId, types, start, end, "appointment"),
    ]);
    for (const id of booked) q.delete(id);
    qualified = q;
    total = q.size;
  }
  if (!total) return Response.json({ leads: [], total: 0, start, end });

  // Names live only in ClickHouse. Without creds the count is still honest — the list is simply empty,
  // and the caller can say so rather than silently reporting a smaller bucket.
  if (!hasClickhouseCreds()) {
    return Response.json({ leads: [], total, start, end, degraded: true, note: "clickhouse not configured" });
  }

  const ids = [...qualified].slice(0, limit);
  const inList = ids.map((i) => `'${chEsc(i)}'`).join(",");
  const sql = `
    SELECT
      l.lead_id AS leadId,
      ifNull(any(cu.name), '') AS customer,
      ifNull(any(cu.mobile_number), '') AS phone,
      ifNull(any(l.source), '') AS source,
      toString(max(c.createdAt)) AS lastTouch
    FROM dealer_leads.leads AS l FINAL
    LEFT JOIN dealer_leads.customer AS cu FINAL
      ON cu.customer_id = l.customer_id AND cu.__deleted = 0
    LEFT JOIN dealer_leads.conversations AS c FINAL
      ON c.leadId = l.lead_id AND c.__deleted = 0 AND ifNull(c.isTest, 0) = 0
    WHERE l.team_id = '${chEsc(teamId)}' AND l.__deleted = 0 AND l.is_deleted = 0
      AND l.lead_id IN (${inList})
    GROUP BY l.lead_id
    ORDER BY lastTouch DESC`;

  try {
    const rows = await runClickhouse<QualifiedLead>(sql);
    return Response.json({ leads: rows, total, shown: rows.length, start, end });
  } catch {
    // Never 502 an export: the caller prints the count and says the names could not be loaded.
    return Response.json({ leads: [], total, start, end, degraded: true, note: "lookup failed" });
  }
}
