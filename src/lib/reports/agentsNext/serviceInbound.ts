/* SERVICE INBOUND: THE SERVICE OVERVIEW PAGE'S NUMBERS, IN ITS OWN WINDOW.
 *
 * The console's Service Overview (Service → Overview, the Service AI landing page) shows three numbers on
 * its "Inbound agent" block: calls, qualified, visits booked. Reports > Agent performance's Service
 * Inbound card disagreed with it. Decided 2026-10-08: that card takes the Overview's definitions AND its
 * window, so the counts are the same on every rooftop at every moment.
 *
 *   Callers → Qualified → Visits booked, plus the Overview's Calls in a tile. Qualified, Visits booked and
 *   Calls are the Overview's own. Callers is not on the Overview: it is the customers on those same calls
 *   (the Overview's own "engaged" set), widened to include every booked customer so it is never below
 *   Qualified.
 *
 * WINDOW. The Overview has no date picker and always asks for last_30_days: from local midnight 30 days
 * ago to 23:59:59 today, in the rooftop's timezone (enterprise_team_details.timezone, UTC when missing).
 * serviceOverviewWindow() is that window.
 *
 * SOURCE. Ports of conversational-ai-backend `ViniOverviewService.inboundMetrics` for department
 * 'service' (src/vini-overview/vini-overview.service.ts, release @52d30bf) and the constants it imports
 * (src/database/clickhouse/analytics-queries.ts: REAL_CALL, IS_CALLBACK_FROM_OUTBOUND,
 * AGENT_BOOKED_MEETING, AGENT_BOOKED_SOURCE, BUYING_INTENT_ACTIONS), copied as they are, FINAL and all:
 * the backend reads some of these tables without FINAL, and so does this. The live inbound agents come
 * from the warehouse copy of Mongo's teamAgentMappings/agentTypes, and the timezone from the warehouse
 * copy of enterprise_team_details, the same records the Overview reads. If the backend query changes,
 * change this file to match; the Service Overview is the reference.
 *
 * Read straight from ClickHouse. Any failed query makes the result null, and the card keeps the numbers
 * it had, rather than mixing definitions. */

import { chEsc } from "@/lib/spyne/clickhouse";
import { queryRows as runRows } from "@/lib/reports/agentsNext/clickhouseRows";
import type { NamedAppt } from "@/components/reports/data";

const DB = "dealer_leads";

/** The Overview's window: UTC instants, both ends inclusive, plus the local dates for the label. */
export interface ServiceOverviewWindow {
  /** 'YYYY-MM-DD HH:MM:SS', UTC. */
  startUtc: string;
  endUtc: string;
  /** Rooftop-local calendar dates, inclusive. */
  startLocal: string;
  endLocal: string;
  timezone: string;
}

/** Service Inbound on the Overview's definitions. `booked` is the length of `appointments` (one row per
 * booked customer, as the Overview counts them), so the list cannot disagree with the number. */
export interface ServiceInboundNumbers {
  window: ServiceOverviewWindow;
  /** No live Service inbound agent: the Overview shows its upsell banner and no numbers. */
  hasLiveAgent: boolean;
  calls: number;
  callers: number;
  qualified: number;
  booked: number;
  appointments: NamedAppt[];
}

/* ── constants, as in analytics-queries.ts ──────────────────────────────────────────────────────────── */

const AGENT_BOOKED_SOURCE = "spyne";
const AGENT_BOOKED_MEETING = `lower(JSONExtractString(ifNull(meta, ''), 'source')) NOT IN (
  'warm_transfer', 'callback'
)`;
const IS_CALLBACK_FROM_OUTBOUND = `(
  isCallbackFromOutbound = 1
  OR ifNull(callbackCampaignId, '') != ''
  OR ifNull(callbackOutboundTaskId, '') != ''
)`;
const REAL_CALL = `(
  (isTestCall = 0 OR isTestCall IS NULL)
  AND NOT (
    report LIKE '%"spam":"Yes"%'
    AND JSONExtractString(ifNull(report, '{}'), 'spam') = 'Yes'
  )
)`;
const BUYING_INTENT_ACTIONS = [
  "ScheduleAppointment",
  "RescheduleAppointment",
  "SALES_SCHEDULE_SHOWROOM_VISIT",
  "CheckVehicleAvailability",
  "CheckVehiclePrice",
  "InquireFinanceStatus",
  "SALES_CONNECT_TO_FINANCE",
  "InquireTradeInValue",
  "SALES_TRADE_IN_FOLLOW_UP",
  "ScheduleTestDrive",
  "SALES_SCHEDULE_TEST_DRIVE",
  "InquireLeaseOptions",
  "SALES_FOLLOW_UP_WITH_QUOTE",
  "SERVICE_SCHEDULE_APPOINTMENT",
  "SERVICE_SEND_ESTIMATE",
  "SALES_SCHEDULE_APPOINTMENT",
  "SALES_SEND_VEHICLE_INFO",
  "SALES_FOLLOW_UP_BE_BACK",
  "SEND_VEHICLE_PHOTO",
  "SendVehicleImages",
  "SendVehicleDetails",
  "SendVehicleCatalog",
  "SendVehicleInformation",
  "SendVehicleLink",
  "CheckVehicleCondition",
];

const lit = (v: string): string => `'${chEsc(v)}'`;
const list = (xs: string[]): string => xs.map(lit).join(", ");
const TEAM_ID = /^[A-Za-z0-9_-]{1,64}$/;

/* ── the window ─────────────────────────────────────────────────────────────────────────────────────── */

/** Milliseconds `tz` is ahead of UTC at instant `t`. */
function tzOffsetMs(t: number, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(t)).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(t / 1000) * 1000;
}

/** The UTC instant of local midnight on `isoDay` in `tz` (DST-safe: offset re-read at the result). */
function zonedMidnight(isoDay: string, tz: string): number {
  const guess = Date.parse(`${isoDay}T00:00:00Z`);
  const first = guess - tzOffsetMs(guess, tz);
  return guess - tzOffsetMs(first, tz);
}

const localDay = (t: number, tz: string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
const shiftDay = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const chTime = (t: number): string => new Date(t).toISOString().slice(0, 19).replace("T", " ");

/** The Overview's last_30_days in `timezone` as of `now`: dayjs().tz(tz).subtract(30, 'days')
 * .startOf('day') to .endOf('day') of today, second precision (toClickHouseDateTime). */
export function serviceOverviewWindow(timezone: string, now: Date = new Date()): ServiceOverviewWindow {
  let tz = timezone || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    tz = "UTC";
  }
  const today = localDay(now.getTime(), tz);
  const startLocal = shiftDay(today, -30);
  const start = zonedMidnight(startLocal, tz);
  const end = zonedMidnight(shiftDay(today, 1), tz) - 1000; // 23:59:59 local today
  return { startUtc: chTime(start), endUtc: chTime(end), startLocal, endLocal: today, timezone: tz };
}

/* ── queries ────────────────────────────────────────────────────────────────────────────────────────── */

/** Pure. Rooftop identity: enterprise and timezone, from the warehouse copy of enterprise_team_details. */
export function teamDetailsSql(teamId: string, enterpriseId: string | null): string {
  if (!TEAM_ID.test(teamId)) throw new Error("serviceInbound: bad team id");
  const ent = enterpriseId && TEAM_ID.test(enterpriseId) ? `AND enterprise_id = ${lit(enterpriseId)}` : "";
  return `
    SELECT enterprise_id, ifNull(timezone, '') AS timezone
    FROM eventila.enterprise_team_details FINAL
    WHERE _peerdb_is_deleted = 0 AND team_id = ${lit(teamId)} ${ent}
    LIMIT 1`;
}

/** Pure. The live Service inbound agents (fetchAgentIdentity + `isActive` filter): agent types named
 * 'Service' whose call type is not 'outbound', mapped to this rooftop and active. */
export function liveInboundMappingsSql(teamId: string, enterpriseId: string): string {
  return `
    SELECT DISTINCT teamAgentMappingId AS id
    FROM ${DB}.teamAgentMappings FINAL
    WHERE __deleted = 0 AND enterpriseId = ${lit(enterpriseId)} AND teamId = ${lit(teamId)}
      AND isActive = 1 AND ifNull(teamAgentMappingId, '') != ''
      AND agentTypeId IN (
        SELECT agentTypeId FROM ${DB}.agentTypes FINAL
        WHERE __deleted = 0 AND agentType = 'Service'
          AND lower(ifNull(agentCallType, '')) != 'outbound'
      )`;
}

export interface ServiceInboundSql {
  /** One row: `n`. */
  calls: string;
  /** One row: `qualified`, `callers`. */
  leads: string;
  /** One row per booked customer. */
  booked: string;
}

/** Pure. inboundMetrics for department 'service', over `w`, for `mappingIds` (non-empty). */
export function serviceInboundSql(teamId: string, enterpriseId: string, mappingIds: string[], w: ServiceOverviewWindow): ServiceInboundSql {
  if (!TEAM_ID.test(teamId) || !TEAM_ID.test(enterpriseId)) throw new Error("serviceInbound: bad ids");
  const team = lit(teamId), ent = lit(enterpriseId);
  const start = lit(w.startUtc), end = lit(w.endUtc);
  const realCallsFilter = `
      enterpriseId = ${ent} AND teamId = ${team}
      AND __deleted = 0 AND isActive = 1
      AND (isTestCall = 0 OR isTestCall IS NULL)
      AND teamAgentMappingId IN (${list(mappingIds)})
      AND createdAt >= toDateTime(${start}, 'UTC')
      AND createdAt <= toDateTime(${end}, 'UTC')
      AND ${REAL_CALL}
      AND NOT ${IS_CALLBACK_FROM_OUTBOUND}`;
  const bookedInWindowFilter = `
      enterprise_id = ${ent} AND team_id = ${team}
      AND __deleted = 0 AND is_active = 1
      AND service_type = 'service'
      AND source = '${AGENT_BOOKED_SOURCE}'
      AND ${AGENT_BOOKED_MEETING}
      AND created_at >= toDateTime(${start}, 'UTC')
      AND created_at <= toDateTime(${end}, 'UTC')`;
  // bookedLeadIds(inboundBookedLink(realCallsFilter)).
  const bookedLeads = `
      SELECT DISTINCT lead_id FROM ${DB}.meetings FINAL
      WHERE ${bookedInWindowFilter}
        AND ifNull(lead_id, '') != ''
        AND call_id IN (SELECT callId FROM ${DB}.endcallreports WHERE ${realCallsFilter})`;
  const buyingIntent = `
      SELECT DISTINCT lead_id
      FROM ${DB}.actionItems
      WHERE __deleted = 0
        AND enterprise_id = ${ent} AND team_id = ${team}
        AND service_type = 'service'
        AND ifNull(intent, '') IN (${list(BUYING_INTENT_ACTIONS)})
        AND createdAt >= toDateTime(${start}, 'UTC')
        AND createdAt <= toDateTime(${end}, 'UTC')`;
  const engaged = `
      SELECT DISTINCT leadId AS lead_id FROM ${DB}.endcallreports
      WHERE ${realCallsFilter} AND ifNull(leadId, '') != ''`;

  return {
    calls: `SELECT count() AS n FROM ${DB}.endcallreports FINAL WHERE ${realCallsFilter}`,
    /* serviceQualified, with the booked arm as the same query instead of a fetched id list. Callers is
       the engaged set plus the booked one, from the same CTEs in the same pass. */
    leads: `
      WITH buying_intent AS (${buyingIntent}),
           engaged AS (${engaged}),
           booked AS (${bookedLeads})
      SELECT
        (SELECT countDistinct(lead_id) FROM (
           SELECT e.lead_id AS lead_id FROM engaged e WHERE e.lead_id IN (SELECT lead_id FROM buying_intent)
           UNION DISTINCT
           SELECT lead_id FROM booked
        )) AS qualified,
        (SELECT countDistinct(lead_id) FROM (
           SELECT lead_id FROM engaged
           UNION DISTINCT
           SELECT lead_id FROM booked
        )) AS callers`,
    /* One row per booked customer (visitsBooked counts DISTINCT lead_id), carrying their latest booking
       in the window. The meetings filter is the Overview's, verbatim; names are joined after it. */
    booked: `
      SELECT b.lead_id AS lead_id, any(cu.name) AS customer, any(cu.mobile_number) AS phone,
             b.meeting_start AS meeting_start, b.booked_at AS booked_at, b.status AS status, b.intent AS intent
      FROM (
        SELECT lead_id,
               argMax(customer_id, created_at) AS customer_id,
               argMax(formatDateTime(meeting_start_time, '%Y-%m-%dT%H:%i:%SZ', 'UTC'), created_at) AS meeting_start,
               formatDateTime(max(created_at), '%Y-%m-%dT%H:%i:%SZ', 'UTC') AS booked_at,
               argMax(ifNull(status, ''), created_at) AS status,
               argMax(ifNull(intent, ''), created_at) AS intent
        FROM ${DB}.meetings FINAL
        WHERE ${bookedInWindowFilter}
          AND ifNull(lead_id, '') != ''
          AND call_id IN (SELECT callId FROM ${DB}.endcallreports WHERE ${realCallsFilter})
        GROUP BY lead_id
      ) b
      LEFT JOIN ${DB}.customer cu FINAL ON cu.customer_id = b.customer_id AND cu.__deleted = 0
      GROUP BY b.lead_id, b.meeting_start, b.booked_at, b.status, b.intent
      ORDER BY b.booked_at DESC`,
  };
}

/* ── rows → appointments ─────────────────────────────────────────────────────────────────────────────── */



interface BookedRow {
  lead_id: string;
  customer: string | null;
  phone: string | null;
  meeting_start: string | null;
  booked_at: string | null;
  status: string;
  intent: string;
}

function toNamedAppt(r: BookedRow): NamedAppt {
  return {
    customer: (r.customer ?? "").trim() || "—",
    phone: r.phone ?? "",
    channel: "Inbound",
    how: "AI-booked, on call",
    vehicle: "",
    when: r.meeting_start || null,
    bookedAt: r.booked_at || null,
    status: r.status ?? "",
    intent: (r.intent ?? "").trim(),
    assisted: false,
    serviceType: "service",
  };
}

/* The Overview recomputes on every load; a short memo absorbs a page asking more than once. */
const MEMO_TTL_MS = 60_000;
const memo = new Map<string, { at: number; value: ServiceInboundNumbers }>();
const inflight = new Map<string, Promise<ServiceInboundNumbers | null>>();

/** Service Inbound on the Service Overview's definitions and window, or null when any part could not be
 * read. `enterpriseId` narrows the rooftop lookup when the caller knows it. */
export async function fetchServiceInbound(teamId: string, enterpriseId: string | null = null, now: Date = new Date()): Promise<ServiceInboundNumbers | null> {
  if (!TEAM_ID.test(teamId)) return null;
  const details = await runRows<{ enterprise_id: string; timezone: string }>(teamDetailsSql(teamId, enterpriseId), "serviceInbound");
  if (!details || details.length !== 1) return null;
  const ent = details[0].enterprise_id;
  const window = serviceOverviewWindow(details[0].timezone, now);
  const key = `${teamId}:${ent}:${window.startUtc}:${window.endUtc}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.value;
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = compute(teamId, ent, window).finally(() => inflight.delete(key));
  inflight.set(key, p);
  const value = await p;
  if (value) memo.set(key, { at: Date.now(), value });
  return value;
}

async function compute(teamId: string, enterpriseId: string, window: ServiceOverviewWindow): Promise<ServiceInboundNumbers | null> {
  try {
    const mappings = await runRows<{ id: string }>(liveInboundMappingsSql(teamId, enterpriseId), "serviceInbound");
    if (!mappings) return null;
    const ids = mappings.map((m) => m.id).filter(Boolean);
    if (ids.length === 0) {
      return { window, hasLiveAgent: false, calls: 0, callers: 0, qualified: 0, booked: 0, appointments: [] };
    }
    const sql = serviceInboundSql(teamId, enterpriseId, ids, window);
    const [calls, leads] = await Promise.all([runRows<{ n: number | string }>(sql.calls, "serviceInbound"), runRows<{ qualified: number | string; callers: number | string }>(sql.leads, "serviceInbound")]);
    const booked = await runRows<BookedRow>(sql.booked, "serviceInbound");
    if (!calls || calls.length !== 1 || !leads || leads.length !== 1 || !booked) return null;
    const appointments = booked.map(toNamedAppt);
    return {
      window,
      hasLiveAgent: true,
      calls: Number(calls[0].n) || 0,
      callers: Number(leads[0].callers) || 0,
      qualified: Number(leads[0].qualified) || 0,
      booked: appointments.length,
      appointments,
    };
  } catch {
    return null;
  }
}
