/* DRILL-DOWN behind a segment of the conversation flow.
 *
 *   GET /api/reports/conversation-drill?team_id=&serviceType=&direction=&callType=&primaryIntent=&outcome=
 *
 * The flow card says "12 calls asked for the sales department and 58% were transferred". This returns the
 * calls behind one of those segments so a manager can listen to them — which is where coaching actually
 * happens, and the only way a share like 58% becomes something you can act on rather than argue about.
 *
 * SOURCE. Read from the warehouse copy of the review pipeline (conversationEval) rather than through the
 * eval API. Two reasons: the API has no endpoint that returns the conversations behind a bucket, and this
 * way the drill keeps working when the API's token has expired — the panels above it currently do not.
 *
 * The call facts (time, length, recording) come from endcallreports, which is what /api/conversations
 * reads and therefore what the drawer this list opens into will show. An earlier version took them from
 * dealer_leads.conversations and its callData_callDuration, which is NOT a call length in any unit — it
 * read 17,943 on a 269-second call and 136,168 on a 161-second one. The panel and the drawer disagreed on
 * the same call. Length here is endedAt − startedAt, the console's definition everywhere else.
 *
 * JOIN KEY is callId, not conversationId: the eval's conversationId matched only 4 of 500 call records on
 * the rooftop this was built against, while callId matched 496. Fleet-wide the join resolves 129,597 of
 * 129,641 sales call evals, so a segment that cannot be opened is rare rather than routine — the panel
 * still says so when the list comes back short of the count on the chart.
 *
 * WINDOW. The chart above windows on the conversationId's UUIDv7 timestamp; this windows on the call
 * record's own createdAt. Measured over 5,362 rows they agree to a median of 118s and never differ by a
 * day, so the two select the same calls except within an hour of a boundary.
 *
 * PII (names, numbers, recordings) so it is auth-gated like the other per-event routes. */
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

export interface DrillConversation {
  callId: string;
  leadId: string;
  customer: string;
  phone: string;
  at: string;
  durationSec: number;
  summary: string;
  outcome: string;
  hasRecording: boolean;
}

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const teamId = searchParams.get("team_id") || "";
  if (!idOk(teamId)) return Response.json({ error: "valid team_id is required" }, { status: 400 });

  const auth = requireTeamAuth(request, teamId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  if (!hasClickhouseCreds()) return Response.json({ conversations: [], degraded: true });

  const dept = (searchParams.get("serviceType") || "").toLowerCase();
  const agentType = dept === "service" ? "service" : "sales";
  const dirRaw = (searchParams.get("direction") || "").toLowerCase();
  const dirSql = dirRaw === "inbound" || dirRaw === "outbound" ? ` AND toString(doc.agentCallType)='${chEsc(dirRaw)}'` : "";

  // Which cell was clicked. callType alone = a whole lane; + primaryIntent = one row inside it; + outcome
  // = one coloured segment. Each narrows the same set.
  const callType = searchParams.get("callType") || "";
  const primaryIntent = searchParams.get("primaryIntent") || "";
  const outcome = searchParams.get("outcome") || "";
  const ctSql = callType ? ` AND toString(doc.callType)='${chEsc(callType)}'` : "";
  const piSql = primaryIntent ? ` AND toString(doc.primaryIntent)='${chEsc(primaryIntent)}'` : "";
  const ocSql = outcome ? ` AND toString(doc.outcomeAchieved)='${chEsc(outcome)}'` : "";

  const tz = (await getStoreTimeZone(teamId, spyneTokenFrom(request), spyneEnvFrom(request))) || "UTC";
  let start = searchParams.get("start") || "";
  let end = searchParams.get("end") || "";
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    const b = (searchParams.get("bucket") || "last30") as Bucket;
    const r = rangeFor(BUCKETS.has(b) ? b : "last30", tz);
    start = r.start;
    end = r.end;
  }

  const T = chEsc(teamId);
  const TZ = chEsc(tz);

  /* Windowed on the CALL's own time, taken from the call record — not on when the reviewer scored it,
   * which lags the call by days and would put weeks-old calls in a 7-day window. */
  const sql = `
    WITH ev AS (
      SELECT toString(doc.callId) AS cid,
             toString(doc.leadId) AS leadId,
             toString(doc.outcomeAchieved) AS outcome,
             toString(doc.lastTouchSummary) AS summary
      FROM dealer_leads_raw.conversationEval
      WHERE _peerdb_is_deleted = 0
        AND toString(doc.teamId) = '${T}'
        AND toString(doc.agentType) = '${chEsc(agentType)}'
        AND toString(doc.channel) = 'call'${dirSql}${ctSql}${piSql}${ocSql}
        AND toString(doc.callId) != ''
    ),
    /* FINAL because endcallreports carries triplicate CDC rows per call; one row per callId out.
     * Restricting callId to the eval set is not an optimisation, it is what makes this run at all:
     * without it, FINAL over a lifetime window merges the whole call log and ClickHouse refuses the query
     * at its 57 GiB memory ceiling. The eval set is at most a few hundred ids, so scoping the scan to
     * them keeps the drill in single-digit seconds on any window. */
    ecr AS (
      SELECT callId,
             any(leadId) AS ecrLeadId,
             max(createdAt) AS at,
             ifNull(dateDiff('second',
               parseDateTimeBestEffortOrNull(any(callDetails_startedAt)),
               parseDateTimeBestEffortOrNull(any(callDetails_endedAt))), 0) AS durationSec,
             max(ifNull(callDetails_recordingUrl,'') != '') AS hasRecording
      FROM dealer_leads.endcallreports FINAL
      WHERE teamId = '${T}' AND isTestCall = 0 AND callId IN (SELECT cid FROM ev)
        AND toTimeZone(createdAt,'${TZ}') >= toDateTime('${start} 00:00:00','${TZ}')
        AND toTimeZone(createdAt,'${TZ}') <  toDateTime('${end} 00:00:00','${TZ}')
      GROUP BY callId
    ),
    leadIds AS (
      SELECT ecrLeadId AS lid FROM ecr WHERE ifNull(ecrLeadId,'') != ''
      UNION DISTINCT
      SELECT leadId AS lid FROM ev WHERE leadId != ''
    ),
    /* Scoped to those leads for the same reason as above. The inner aggregate renames the columns, so
     * the outer one must reference the ALIASES — selecting c.mobile_number here resolved against a
     * subquery that no longer exposes it and the whole query failed, silently, because the route catches
     * and returns an empty list. */
    cu AS (
      SELECT l.lead_id AS lid, any(c.cname) AS name, any(c.cphone) AS phone
      FROM (SELECT lead_id, customer_id FROM dealer_leads.leads FINAL WHERE team_id='${T}' AND lead_id IN (SELECT lid FROM leadIds)) AS l
      LEFT JOIN (SELECT customer_id, any(name) AS cname, any(mobile_number) AS cphone FROM dealer_leads.customer FINAL WHERE team_id='${T}' GROUP BY customer_id) AS c
        ON c.customer_id = l.customer_id
      GROUP BY l.lead_id
    )
    SELECT ev.cid AS callId,
           -- The eval's own leadId is the fallback; the call record's is preferred because that is the
           -- lead the drawer's /api/conversations lookup is keyed on.
           if(ifNull(ecr.ecrLeadId,'') != '', ecr.ecrLeadId, ev.leadId) AS leadId,
           ifNull(cu.name, '') AS customer,
           ifNull(cu.phone, '') AS phone,
           toString(ecr.at) AS at,
           ecr.durationSec AS durationSec,
           ev.summary AS summary,
           ev.outcome AS outcome,
           ecr.hasRecording AS hasRecording
    FROM ev
    INNER JOIN ecr ON ecr.callId = ev.cid
    LEFT JOIN cu ON cu.lid = if(ifNull(ecr.ecrLeadId,'') != '', ecr.ecrLeadId, ev.leadId)
    ORDER BY ecr.at DESC
    LIMIT 150`;

  try {
    const rows = await runClickhouse<Record<string, string | number>>(sql);
    const conversations: DrillConversation[] = rows.map((r) => ({
      callId: String(r.callId || ""),
      leadId: String(r.leadId || ""),
      customer: String(r.customer || "").trim(),
      phone: String(r.phone || "").trim(),
      at: String(r.at || ""),
      durationSec: Number(r.durationSec) || 0,
      summary: String(r.summary || "").trim(),
      outcome: String(r.outcome || ""),
      hasRecording: Number(r.hasRecording) === 1,
    }));
    return Response.json({ conversations, window: { start, end }, degraded: false });
  } catch (e) {
    console.error(`[conversation-drill] ${teamId}: ${e instanceof Error ? e.message : String(e)}`);
    return Response.json({ conversations: [], degraded: true });
  }
}
