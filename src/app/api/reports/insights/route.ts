/* INSIGHTS — the report-library datasets that live only in ClickHouse, in one round trip.
 *
 *   GET /api/reports/insights?team_id=[&bucket=last30|&start=&end=]
 *
 * These four answer questions the materialised aggregate can't, because the aggregate is keyed by agent
 * and day and these are keyed by lead, by destination, by thread and by hour:
 *
 *   sold      — AI-touched leads and where they ended up in the CRM. The ROI question ("did the AI's
 *               work turn into cars?"), and the only one that reads leads.external_lead_status.
 *   routing   — where transfers were actually sent (department / destination type).
 *   sms       — text volume and how often customers replied.
 *   hours     — inbound calls by hour × weekday, in the rooftop's own timezone: the coverage map.
 *
 * Every dataset degrades to null independently — one slow or failing query never blanks the others, and
 * the library simply doesn't offer that report. */
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

export interface InsightsPayload {
  sold: { status: string; label: string; leads: number }[] | null;
  soldTotals: { touched: number; sold: number; active: number; lost: number } | null;
  routing: { department: string; destinationType: string; transfers: number }[] | null;
  sms: { outbound: number; inbound: number; threads: number; repliedThreads: number } | null;
  hours: { hour: number; weekday: number; calls: number }[] | null;
  vehicles: { make: string; model: string; key: string; leads: number; newCount: number; usedCount: number; years: string }[] | null;
  /* Call handling on the FULL sales-call population (not the reviewed sample): how each connected call
   * ended, and the talk minutes behind it. Drives end-to-end handling and minutes saved. */
  handling: { reason: string; calls: number; minutes: number }[] | null;
  /* Per-intent resolution from the intent-resolution analysis: did the customer's question get answered? */
  resolution: { intent: string; raised: number; resolved: number }[] | null;
  /* Units currently listed for sale, by model — pairs with `vehicles` to show demand against stock. */
  stock: { make: string; model: string; key: string; units: number }[] | null;
  /* Outbound dials per lead: how hard a lead is worked before it connects (or is given up on). */
  effort: { attempts: number; leads: number }[] | null;
  /* Service-desk tool activity: what the AI actually DID in the drive — booked, rescheduled, cancelled,
   * checked a recall, offered a loaner — and how often each of those failed. */
  serviceTools: { tool: string; ok: number; failed: number }[] | null;
}

/* CRM status → the bucket a dealer thinks in. Statuses are free-form per CRM, so this matches on the
 * documented prefixes and leaves anything unrecognised in "other" rather than guessing. */
function statusBucket(s: string): "sold" | "active" | "lost" | "other" {
  const v = (s || "").toUpperCase();
  if (v.startsWith("SOLD")) return "sold";
  if (v.startsWith("ACTIVE")) return "active";
  if (v.startsWith("BAD") || v.startsWith("LOST")) return "lost";
  return "other";
}

const PRETTY: Record<string, string> = {
  SOLD_DELIVERED: "Sold & delivered",
  ACTIVE_ACTIVE_LEAD: "Working the lead",
  ACTIVE_NEW_LEAD: "New lead",
  ACTIVE_WAITING_FOR_PROSPECT_RESPONSE: "Waiting on the customer",
  BAD_DUPLICATE_LEAD: "Duplicate",
  BAD_NO_INTENT_TO_BUY: "No intent to buy",
  NON_CUSTOMER_INITIATED_LEAD: "Not customer-initiated",
  SERVICE_APPOINTMENT_SCHEDULED: "Service appointment",
  SERVICE_COMPLETE: "Service complete",
};
const pretty = (s: string) => PRETTY[s] ?? (s || "Unknown").replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const teamId = searchParams.get("team_id") || "";
  if (!idOk(teamId)) return Response.json({ error: "valid team_id is required" }, { status: 400 });

  const auth = requireTeamAuth(request, teamId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  if (!hasClickhouseCreds()) return Response.json({ degraded: true, note: "clickhouse not configured" });

  // Window in the ROOFTOP's timezone, same resolution as every other route here.
  const tz = (await getStoreTimeZone(teamId, spyneTokenFrom(request), spyneEnvFrom(request))) || "UTC";
  let start = searchParams.get("start") || "";
  let end = searchParams.get("end") || "";
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    const b = (searchParams.get("bucket") || "last30") as Bucket;
    const r = rangeFor(BUCKETS.has(b) ? b : "last30", tz);
    start = r.start;
    end = r.end;
  }

  /* Demand records "Sportage Hybrid"; the stock book records "Sportage". Folding a trailing hybrid
   * variant into its base model is what lets the two be compared at all — without it every hybrid row
   * reads as "0 in stock". Deliberately only strips a trailing hybrid/PHEV: EV9 is its own model, not a
   * variant of anything. */
  const modelKey = (col: string) => `upper(trim(replaceRegexpOne(${col}, '(?i)[[:space:]]+(plug-?in[[:space:]]+)?hybrid$|(?i)[[:space:]]+phev$', '')))`;

  /* DEPARTMENT SCOPE. Sales and Service are separate P&Ls and are never blended in a report — and the
   * console hands us the scope on the URL. Without this these queries were pinned to 'Sales', so opening
   * the library in the Service space showed Sales calls under a Service header. Datasets that carry no
   * department (inventory stock, SMS threads) stay rooftop-wide and say so on the card. */
  const deptRaw = (searchParams.get("serviceType") || searchParams.get("service_type") || "").toLowerCase();
  const dept: "sales" | "service" | null = deptRaw === "service" ? "service" : deptRaw === "sales" ? "sales" : null;
  const useCase = dept === "service" ? "Service" : dept === "sales" ? "Sales" : null;
  // endcallreports carries report_useCase; an unscoped request stays rooftop-wide rather than guessing.
  const deptCall = useCase ? ` AND ifNull(report_useCase,'')='${chEsc(useCase)}'` : "";

  const T = chEsc(teamId);
  const TZ = chEsc(tz);
  // Window predicate shared by every query, expressed in the rooftop's local days.
  const win = (col: string) => `toTimeZone(${col},'${TZ}') >= toDateTime('${start} 00:00:00','${TZ}') AND toTimeZone(${col},'${TZ}') < toDateTime('${end} 00:00:00','${TZ}')`;

  /* AI-touched leads → their CRM status. `touched` is deliberately the DISTINCT lead ids the AI actually
   * called in this window; the status is read as-of now (a lead sold last week counts as sold today),
   * which is what "did our work convert?" means. */
  const soldSql = `
    WITH touched AS (
      SELECT DISTINCT leadId FROM dealer_leads.endcallreports FINAL
      WHERE teamId='${T}' AND isTestCall=0 AND leadId != ''${deptCall} AND ${win("createdAt")}
    )
    SELECT ifNull(l.external_lead_status,'') AS status, count() AS leads
    FROM (SELECT lead_id, external_lead_status FROM dealer_leads.leads FINAL WHERE team_id='${T}') AS l
    INNER JOIN touched AS t ON t.leadId = l.lead_id
    GROUP BY status ORDER BY leads DESC`;

  const routingSql = `
    SELECT ifNull(department,'(not set)') AS department,
           ifNull(destinationType,'(not set)') AS destinationType,
           count() AS transfers
    FROM dealer_leads.callTransferEvents
    WHERE teamId='${T}'${dept ? ` AND lower(ifNull(department,''))='${dept}'` : ""} AND ${win("createdAt")}
    GROUP BY department, destinationType ORDER BY transfers DESC LIMIT 25`;

  /* smsMessages carries no team column, so the thread set is scoped through conversations (same path
   * /api/conversations uses). "Replied" = a thread with at least one inbound message. */
  const smsSql = `
    WITH conv AS (
      SELECT conversationId FROM dealer_leads.conversations
      WHERE teamId='${T}' AND type='sms' AND ifNull(isTest,0)=0 AND ${win("createdAt")}
    )
    SELECT countIf(m.direction='out') AS outbound,
           countIf(m.direction='in') AS inbound,
           uniqExact(m.conversationId) AS threads,
           uniqExactIf(m.conversationId, m.direction='in') AS repliedThreads
    FROM (SELECT conversationId, direction FROM dealer_leads.smsMessages WHERE ${win("createdAt")}) AS m
    INNER JOIN conv AS c ON c.conversationId = m.conversationId`;

  /* VEHICLE OF INTEREST — what the AI's leads are actually shopping for, from the CRM's vehicle-of-interest
   * records (dealer_leads_raw.leadVehicleInterests, keyed sales_lead_id = leadId). Scoped to the same
   * AI-touched leads as `sold`, so it reads "what the people we talked to want", not the whole CRM.
   * `condition` is only populated on VOI events (not on plain webhook rows), so new/used is reported as a
   * known-subset rather than a split of the total. */
  const vehiclesSql = `
    WITH touched AS (
      SELECT DISTINCT leadId FROM dealer_leads.endcallreports FINAL
      WHERE teamId='${T}' AND isTestCall=0 AND leadId != ''${deptCall} AND ${win("createdAt")}
    )
    SELECT trim(toString(v.doc.make)) AS make,
           trim(toString(v.doc.model)) AS model,
           ${modelKey("trim(toString(v.doc.model))")} AS modelKeyOut,
           count() AS leads,
           countIf(upper(toString(v.doc.metadata.condition))='NEW') AS newCount,
           countIf(upper(toString(v.doc.metadata.condition))='USED') AS usedCount,
           -- Year is free text and includes '' and '0'; only aggregate values that look like a model year,
           -- otherwise a single junk row renders a range of "0–2026".
           minIf(toString(v.doc.year), match(toString(v.doc.year), '^(19|20)[0-9]{2}$')) AS minYear,
           maxIf(toString(v.doc.year), match(toString(v.doc.year), '^(19|20)[0-9]{2}$')) AS maxYear
    FROM (
      SELECT doc FROM dealer_leads_raw.leadVehicleInterests
      WHERE _peerdb_is_deleted=0 AND toString(doc.team_id)='${T}' AND toString(doc.is_active)='true'
    ) AS v
    INNER JOIN touched AS t ON t.leadId = toString(v.doc.sales_lead_id)
    WHERE make != '' AND model != ''
    GROUP BY make, model, modelKeyOut ORDER BY leads DESC LIMIT 25`;

  /* HANDLING — every call in scope by how it ended, with talk minutes. `report_useCase` scopes it to the
   * requested department, and
   * duration comes from the call's own start/end stamps. The caller decides which reasons count as
   * "connected" and which mean nobody was ever on the line; this returns the raw buckets so that rule
   * lives in one place in the UI rather than being baked into SQL. */
  const handlingSql = `
    SELECT ifNull(callDetails_endedReason,'(unknown)') AS reason,
           uniqExact(callId) AS calls,
           round(sum(dateDiff('second',
             parseDateTimeBestEffortOrNull(callDetails_startedAt),
             parseDateTimeBestEffortOrNull(callDetails_endedAt))) / 60) AS minutes
    FROM dealer_leads.endcallreports FINAL
    WHERE teamId='${T}' AND isTestCall=0${deptCall} AND ${win("createdAt")}
    GROUP BY reason ORDER BY calls DESC LIMIT 20`;

  /* RESOLUTION — the intent-resolution analysis records, per call, each intent the customer raised and
   * whether it was resolved. Array-joined so the report can rank by intent: which questions the AI
   * answers well, and which it does not. */
  const resolutionSql = `
    SELECT JSONExtractString(i,'intent_label') AS intent,
           count() AS raised,
           countIf(JSONExtractBool(i,'resolved')) AS resolved
    FROM (
      SELECT arrayJoin(JSONExtractArrayRaw(ifNull(resolution_block,''),'intents')) AS i
      FROM dealer_leads.intentResolutionAnalysis
      WHERE teamId='${T}' AND isActive=1${useCase ? ` AND ifNull(agentType,'')='${chEsc(useCase)}'` : ""} AND ${win("createdAt")}
    )
    WHERE intent != '' GROUP BY intent ORDER BY raised DESC LIMIT 25`;

  /* STOCK — vehicles listed for sale right now, counted as DISTINCT VINs.
   *
   * Two traps here, both of which silently inflate the count:
   *   1. `dealerVinMapping` holds several rows per vehicle (534 rows for 136 actual VINs on the rooftop
   *      this was built against) — counting rows overstates stock roughly 4x.
   *   2. The unsold flag alone leaves years of stale mappings in; `liveOnWeb=1` is what means "listed".
   * vinMaster is also filtered by the VIN set BEFORE grouping — grouping the whole table first ran past
   * the client's timeout and returned nothing at all. */
  const stockSql = `
    SELECT make AS mk,
           ${modelKey("model")} AS modelKeyOut,
           any(model) AS modelName,
           count() AS units
    FROM (
      SELECT vin, any(make) AS make, any(model) AS model
      FROM inventory.vinMaster
      WHERE vin IN (SELECT vin FROM inventory.dealerVinMapping WHERE teamId='${T}' AND sold=0 AND liveOnWeb=1)
      GROUP BY vin
    )
    WHERE ifNull(make,'') != '' AND ifNull(model,'') != ''
    GROUP BY mk, modelKeyOut ORDER BY units DESC LIMIT 60`;

  /* EFFORT — outbound dials per lead. Answers "how many attempts does it take to reach someone", and its
   * tail answers "are we calling the same person too many times". */
  const effortSql = `
    SELECT attempts, count() AS leads FROM (
      SELECT leadId, uniqExact(callId) AS attempts
      FROM dealer_leads.endcallreports FINAL
      WHERE teamId='${T}' AND isTestCall=0 AND leadId != ''
        AND callDetails_callType='outboundPhoneCall'${deptCall} AND ${win("createdAt")}
      GROUP BY leadId
    ) GROUP BY attempts ORDER BY attempts LIMIT 40`;

  /* SERVICE DESK — the service tool calls, success and failure. This is the only place that says what
   * happened in the drive rather than on the phone: an appointment booked, a recall checked, a loaner
   * offered. Scoped by tool NAME (every service tool is prefixed), so it needs no department column. */
  const serviceToolsSql = `
    SELECT toolName AS tool,
           countIf(status='success') AS ok,
           countIf(status!='success') AS failed
    FROM conversation_ai.tool_invocation_events
    WHERE teamId='${T}' AND toolName LIKE 'service%' AND ${win("timestamp")}
    GROUP BY tool ORDER BY (ok + failed) DESC LIMIT 30`;

  const hoursSql = `
    SELECT toHour(toTimeZone(createdAt,'${TZ}')) AS hour,
           toDayOfWeek(toTimeZone(createdAt,'${TZ}')) AS weekday,
           uniqExact(callId) AS calls
    FROM dealer_leads.endcallreports FINAL
    WHERE teamId='${T}' AND isTestCall=0 AND callDetails_callType='inboundPhoneCall'${deptCall} AND ${win("createdAt")}
    GROUP BY hour, weekday`;

  const safe = async <T,>(sql: string): Promise<T[] | null> => {
    try {
      return await runClickhouse<T>(sql);
    } catch (e) {
      console.error(`[insights] ${teamId}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };

  const [soldRows, routingRows, smsRows, hourRows, vehicleRows, handlingRows, resolutionRows, stockRows, effortRows, serviceToolRows] = await Promise.all([
    safe<{ status: string; leads: string | number }>(soldSql),
    safe<{ department: string; destinationType: string; transfers: string | number }>(routingSql),
    safe<{ outbound: string | number; inbound: string | number; threads: string | number; repliedThreads: string | number }>(smsSql),
    safe<{ hour: string | number; weekday: string | number; calls: string | number }>(hoursSql),
    safe<{ make: string; model: string; modelKeyOut: string; leads: string | number; newCount: string | number; usedCount: string | number; minYear: string; maxYear: string }>(vehiclesSql),
    safe<{ reason: string; calls: string | number; minutes: string | number }>(handlingSql),
    safe<{ intent: string; raised: string | number; resolved: string | number }>(resolutionSql),
    safe<{ mk: string; modelName: string; modelKeyOut: string; units: string | number }>(stockSql),
    safe<{ attempts: string | number; leads: string | number }>(effortSql),
    safe<{ tool: string; ok: string | number; failed: string | number }>(serviceToolsSql),
  ]);

  const n = (v: string | number | undefined) => Number(v ?? 0) || 0;

  const sold = soldRows
    ? soldRows.filter((r) => r.status).map((r) => ({ status: r.status, label: pretty(r.status), leads: n(r.leads) }))
    : null;
  const soldTotals = soldRows
    ? soldRows.reduce(
        (acc, r) => {
          const c = n(r.leads);
          acc.touched += c;
          const b = statusBucket(r.status);
          if (b === "sold") acc.sold += c;
          else if (b === "active") acc.active += c;
          else if (b === "lost") acc.lost += c;
          return acc;
        },
        { touched: 0, sold: 0, active: 0, lost: 0 },
      )
    : null;

  const payload: InsightsPayload = {
    sold,
    soldTotals,
    routing: routingRows ? routingRows.map((r) => ({ department: r.department, destinationType: r.destinationType, transfers: n(r.transfers) })) : null,
    sms: smsRows?.[0] ? { outbound: n(smsRows[0].outbound), inbound: n(smsRows[0].inbound), threads: n(smsRows[0].threads), repliedThreads: n(smsRows[0].repliedThreads) } : null,
    hours: hourRows ? hourRows.map((r) => ({ hour: n(r.hour), weekday: n(r.weekday), calls: n(r.calls) })) : null,
    vehicles: vehicleRows
      ? vehicleRows.map((r) => {
          const lo = (r.minYear || "").trim();
          const hi = (r.maxYear || "").trim();
          return {
            make: r.make,
            model: r.model,
            key: `${r.make}|${r.modelKeyOut}`.toUpperCase(),
            leads: n(r.leads),
            newCount: n(r.newCount),
            usedCount: n(r.usedCount),
            years: !lo && !hi ? "" : lo === hi ? lo : `${lo}–${hi}`,
          };
        })
      : null,
    handling: handlingRows ? handlingRows.map((r) => ({ reason: r.reason, calls: n(r.calls), minutes: n(r.minutes) })) : null,
    resolution: resolutionRows ? resolutionRows.map((r) => ({ intent: r.intent, raised: n(r.raised), resolved: n(r.resolved) })) : null,
    stock: stockRows ? stockRows.map((r) => ({ make: r.mk, model: r.modelName, key: `${r.mk}|${r.modelKeyOut}`.toUpperCase(), units: n(r.units) })) : null,
    effort: effortRows ? effortRows.map((r) => ({ attempts: n(r.attempts), leads: n(r.leads) })) : null,
    serviceTools: serviceToolRows ? serviceToolRows.map((r) => ({ tool: r.tool, ok: n(r.ok), failed: n(r.failed) })) : null,
  };

  return Response.json({ ...payload, window: { start, end, timezone: tz }, degraded: false });
}
