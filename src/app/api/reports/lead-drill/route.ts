/* DRILL-DOWN behind a number in "Leads by type and source".
 *
 *   GET /api/reports/lead-drill?team_id=&type=&source=&bucket=&serviceType=[&bucket window]
 *
 * A count on a report is only trustworthy if you can open it. This returns the actual leads behind one
 * cell — the four buckets are the same mutually-exclusive stages the bar is drawn from — so a reader can
 * go from "43 reached but never qualified" to the individual customers and, from there, to the call
 * itself. The conversation and its recording are fetched per lead by the existing /api/conversations
 * lead-scoped path, so this route stays a lead lookup and nothing here duplicates that.
 *
 * PII: names and phone numbers, so it is auth-gated exactly like the other per-event routes. */
import { runClickhouse, chEsc, hasClickhouseCreds } from "@/lib/spyne/clickhouse";
import { requireTeamAuth, spyneTokenFrom, spyneEnvFrom } from "@/lib/reports/auth";
import { getStoreTimeZone } from "@/lib/spyne/teamContext";
import { rangeFor } from "@/components/reports/liveData";
import type { Bucket } from "@/components/reports/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BUCKETS = new Set<Bucket>(["today", "yesterday", "last7", "last14", "last30", "mtd", "lifetime"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const idOk = (s: string) => /^[A-Za-z0-9_-]{1,64}$/.test(s);

/** The four stages a lead can be in, best first. Mirrors the bar exactly — see the report. */
export type LeadStageBucket = "appt" | "qualified" | "reached" | "not_reached";
const STAGE_SQL: Record<LeadStageBucket, string> = {
  appt: "isNotNull(ap.lid)",
  qualified: "isNull(ap.lid) AND lq.q = 1",
  reached: "isNull(ap.lid) AND lq.q != 1 AND conv.reached = 1",
  not_reached: "isNull(ap.lid) AND lq.q != 1 AND conv.reached = 0",
};

export interface DrillLead {
  leadId: string;
  customer: string;
  phone: string;
  type: string;
  source: string;
  lastCallAt: string;
  calls: number;
}

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const teamId = searchParams.get("team_id") || "";
  if (!idOk(teamId)) return Response.json({ error: "valid team_id is required" }, { status: 400 });

  const auth = requireTeamAuth(request, teamId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  if (!hasClickhouseCreds()) return Response.json({ leads: [], degraded: true });

  const bucketKey = (searchParams.get("bucket_stage") || "") as LeadStageBucket;
  if (!STAGE_SQL[bucketKey]) return Response.json({ error: "unknown stage" }, { status: 400 });

  const dept = (searchParams.get("serviceType") || "").toLowerCase();
  const useCase = dept === "service" ? "Service" : dept === "sales" ? "Sales" : null;
  const deptCall = useCase ? ` AND ifNull(report_useCase,'')='${chEsc(useCase)}'` : "";

  const tz = (await getStoreTimeZone(teamId, spyneTokenFrom(request), spyneEnvFrom(request))) || "UTC";
  let start = searchParams.get("start") || "";
  let end = searchParams.get("end") || "";
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    const b = (searchParams.get("bucket") || "last30") as Bucket;
    const r = rangeFor(BUCKETS.has(b) ? b : "last30", tz);
    start = r.start;
    end = r.end;
  }

  /* Optional DIRECTION scope. The library shows a department; a By-agent card shows ONE agent, and an
   * "Inbound operations" card carrying outbound leads would be wrong. Absent = both directions. */
  const dirRaw2 = (searchParams.get("direction") || "").toLowerCase();
  const dirCall = dirRaw2 === "inbound"
    ? " AND callDetails_callType='inboundPhoneCall'"
    : dirRaw2 === "outbound"
      ? " AND callDetails_callType='outboundPhoneCall'"
      : "";

  const T = chEsc(teamId);
  const TZ = chEsc(tz);
  const win = `toTimeZone(createdAt,'${TZ}') >= toDateTime('${start} 00:00:00','${TZ}') AND toTimeZone(createdAt,'${TZ}') < toDateTime('${end} 00:00:00','${TZ}')`;
  // Optional narrowing: a click on a TYPE row has no source, a click on a source row has both.
  const type = searchParams.get("type") || "";
  const source = searchParams.get("source") || "";
  const typeSql = type ? ` AND ld.type = '${chEsc(type)}'` : "";
  const sourceSql = source ? ` AND ld.source = '${chEsc(source)}'` : "";

  const sql = `
    WITH
    conv AS (
      SELECT leadId AS lid,
             toUInt8(ifNull(maxIf(1, callDetails_endedReason NOT IN ('voicemail','voicemail_full','no_answer','customer_declined','number_not_found','busy','machine_ivr')), 0)) AS reached,
             count() AS calls,
             max(createdAt) AS lastCallAt
      FROM dealer_leads.endcallreports FINAL
      WHERE teamId='${T}' AND isTestCall=0 AND ifNull(leadId,'') != ''${deptCall}${dirCall} AND ${win}
      GROUP BY leadId
    ),
    ld AS (
      SELECT lead_id AS lid, customer_id,
             upper(replaceAll(replaceAll(ifNull(external_type,'Unknown'),' ','_'),'-','_')) AS type,
             ifNull(source,'Unknown') AS source
      FROM dealer_leads.leads FINAL WHERE team_id='${T}'
    ),
    lq AS (SELECT toString(doc.leadId) AS lid, max(toString(doc.qualified)='true') AS q FROM dealer_leads_raw.conversationLeadEval WHERE _peerdb_is_deleted=0 AND toString(doc.teamId)='${T}' GROUP BY lid),
    ap AS (SELECT DISTINCT lead_id AS lid FROM dealer_leads.meetings FINAL WHERE team_id='${T}' AND source='spyne' AND lower(JSONExtractString(ifNull(meta,''),'source')) != 'warm_transfer'),
    cu AS (SELECT customer_id AS cid, any(name) AS name, any(mobile_number) AS phone FROM dealer_leads.customer FINAL WHERE team_id='${T}' GROUP BY customer_id)
    SELECT conv.lid AS leadId,
           ifNull(cu.name,'') AS customer,
           ifNull(cu.phone,'') AS phone,
           ld.type AS type, ld.source AS source,
           toString(conv.lastCallAt) AS lastCallAt,
           conv.calls AS calls
    FROM conv
    INNER JOIN ld ON ld.lid = conv.lid
    LEFT JOIN lq ON lq.lid = conv.lid
    LEFT JOIN ap ON ap.lid = conv.lid
    LEFT JOIN cu ON cu.cid = ld.customer_id
    WHERE (${STAGE_SQL[bucketKey]})${typeSql}${sourceSql}
    ORDER BY conv.lastCallAt DESC
    LIMIT 200`;

  try {
    const rows = await runClickhouse<Record<string, string | number>>(sql);
    const leads: DrillLead[] = rows.map((r) => ({
      leadId: String(r.leadId || ""),
      customer: String(r.customer || "").trim(),
      phone: String(r.phone || "").trim(),
      type: String(r.type || ""),
      source: String(r.source || ""),
      lastCallAt: String(r.lastCallAt || ""),
      calls: Number(r.calls) || 0,
    }));
    return Response.json({ leads, window: { start, end }, degraded: false });
  } catch (e) {
    console.error(`[lead-drill] ${teamId}: ${e instanceof Error ? e.message : String(e)}`);
    return Response.json({ leads: [], degraded: true });
  }
}
