/* SERVICE OUTBOUND: THE CAMPAIGNS PAGE'S FUNNEL, IN ITS OWN WINDOW.
 *
 * The console's Campaigns page (Pipeline → Campaigns) opens on a rooftop funnel per department, and
 * Reports > Agent performance shows the same ground on the Service outbound card. The two disagreed.
 * Decided 2026-10-08: that card takes the Campaigns definitions AND the Campaigns window, so the counts
 * are the same on every rooftop at every moment. Service only; Sales is untouched (user, 2026-10-08).
 *
 *   Enrolled → Connected → Engaged → Booked. Enrolled, Engaged and Booked are the Campaigns funnel's own.
 *   Connected is not on the Campaigns page: it is the backend's service-metrics "reached" rule
 *   (src/service-metrics/connected.util.ts) — a real person answered the call or replied to a text —
 *   widened to include every Engaged customer, so it is never below Engaged. No Qualified step.
 *
 * WINDOW. The Campaigns page has no date picker: Service reads `[today() - 30, today())` in ClickHouse's
 * server zone, UTC. campaignsWindow() is that window. The page's date picker does not move these numbers,
 * and the page says so.
 *
 * SOURCE. Ports of conversational-ai-backend `campaignOverallAnalytics`
 * (src/campaign/campaign-analytics.service.ts, release @52d30bf) and its Service fragments
 * (src/database/clickhouse/analytics-queries.ts `buildServiceFunnelSql`), with the window passed as
 * explicit dates. If the backend query changes, change this file to match; the Campaigns page is the
 * reference. Verified 2026-10-08 against the backend's own SQL on every rooftop with Service outbound
 * activity.
 *
 * Read straight from ClickHouse, like /api/conversations and /api/action-items. Any failed query makes
 * the funnel null, and the card keeps the numbers it had, rather than mixing definitions. */

import { chEsc } from "@/lib/spyne/clickhouse";
import { queryRows as runRows } from "@/lib/reports/agentsNext/clickhouseRows";
import type { NamedAppt } from "@/components/reports/data";

const DB = "dealer_leads";

/** The window the funnel was counted over: UTC calendar dates, end-exclusive. */
export interface CampaignFunnelWindow {
  start: string;
  end: string;
}

/** Service outbound's Campaigns funnel. `booked` is the length of `appointments`, the meetings
 * themselves, so the list behind the number cannot disagree with it. */
export interface CampaignFunnel {
  window: CampaignFunnelWindow;
  enrolled: number;
  connected: number;
  engaged: number;
  booked: number;
  appointments: NamedAppt[];
}

export interface FunnelWindow {
  /** Store-local calendar dates, end-exclusive, as the report resolves them. */
  start: string;
  end: string;
  /** IANA zone the days are in. Null reads as UTC, like the rest of the report. */
  timezone: string | null;
}

const utcDay = (d: Date): string => d.toISOString().slice(0, 10);
const shiftUtc = (iso: string, days: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return utcDay(d);
};

/** The Campaigns page's own Service window as of `now`: the 30 UTC days before today
 * (campaignOverallAnalytics' `[today() - 30, today())`). */
export function campaignsWindow(now: Date = new Date()): CampaignFunnelWindow {
  const today = utcDay(now);
  return { start: shiftUtc(today, -30), end: today };
}

/* "A real person was on the line": the backend's canonical connected end reasons minus silence_timeout
 * and no_audio (METRICS_CONNECTED_REASONS, src/service-metrics/connected.util.ts). */
const CONNECTED_REASONS = ["completed", "customer_hangup", "assistant_ended", "transferred", "max_duration", "transfer_failed"];

const list = (xs: string[]): string => xs.map((x) => `'${chEsc(x)}'`).join(", ");

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const TEAM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TZ = /^[A-Za-z0-9_+\-/]{1,64}$/;

export interface ServiceFunnelSql {
  /** One row: `n`. */
  enrolled: string;
  /** One row: `engaged`, `connected`. One pass, so Connected ⊇ Engaged by construction. */
  reach: string;
  /** One row per booked meeting. */
  booked: string;
}

function windowFn(w: FunnelWindow): (col: string) => string {
  if (!ISO_DAY.test(w.start) || !ISO_DAY.test(w.end)) throw new Error("campaignFunnelSql: bad window");
  const tz = w.timezone && TZ.test(w.timezone) ? w.timezone : "UTC";
  // The window predicate on one timestamp column, as calendar days in that zone.
  return (col) =>
    `(toDate(toTimeZone(${col}, '${tz}')) >= toDate('${w.start}') AND toDate(toTimeZone(${col}, '${tz}')) < toDate('${w.end}'))`;
}

function teamLiteral(teamId: string): string {
  if (!TEAM_ID.test(teamId)) throw new Error("campaignFunnelSql: bad team id");
  return `'${chEsc(teamId)}'`;
}

/** Pure. Service outbound: Enrolled, Engaged + Connected, and the booked meetings. */
export function serviceFunnelSql(teamId: string, w: FunnelWindow): ServiceFunnelSql {
  const team = teamLiteral(teamId);
  const inWindow = windowFn(w);
  const callbackCallIds = `
    SELECT callId FROM ${DB}.endcallreports FINAL
    WHERE __deleted = 0 AND teamId = ${team} AND ifNull(callId, '') != ''
      AND ${inWindow("createdAt")}
      AND (isCallbackFromOutbound = 1 OR ifNull(callbackCampaignId, '') != ''
           OR ifNull(callbackOutboundTaskId, '') != '')`;
  // svcCohort: one row per Service conversation in the window, outbound or a callback to outbound.
  const cohort = `
    SELECT DISTINCT c.leadId AS leadId, c.callId AS callId,
           c.conversationId AS conversationId, l.customer_id AS customer_id
    FROM ${DB}.conversations c FINAL
    INNER JOIN ${DB}.leads l FINAL ON l.lead_id = c.leadId AND l.team_id = c.teamId
    LEFT JOIN ${DB}.teamAgentMappings tam FINAL
      ON c.teamAgentMappingId = tam.teamAgentMappingId AND tam.__deleted = 0
    LEFT JOIN ${DB}.agentTypes at FINAL
      ON tam.agentTypeId = at.agentTypeId AND at.__deleted = 0
    WHERE c.teamId = ${team} AND c.__deleted = 0 AND ifNull(c.isTest, 0) = 0
      AND c.status != 'failed' AND lower(c.type) IN ('sms', 'call', 'chat')
      AND ifNull(c.leadId, '') != ''
      AND l.is_deleted = 0 AND l.service_type = 'service'
      AND ${inWindow("c.createdAt")}
      AND (lower(at.agentCallType) = 'outbound' OR c.callId IN (${callbackCallIds}))`;
  // svcValidCall AND svcRealCall: not spam, a real agent and call type, not voicemail or a machine, and
  // the customer spoke. This is the Campaigns page's engaged call.
  const engagedCall = `(
    JSONExtractString(ecr.report, 'spam') = 'No'
    AND lower(ecr.callDetails_agentInfo_agentType) IN ('sales', 'service')
    AND ecr.callDetails_callType IN ('webCall', 'inboundPhoneCall', 'outboundPhoneCall')
    AND lower(ifNull(ecr.callDetails_endedReason, '')) NOT LIKE '%voicemail%'
    AND lower(ifNull(ecr.callDetails_endedReason, '')) NOT LIKE '%machine%'
    AND arrayExists(x -> JSONExtractString(x, 'role') = 'user',
                    JSONExtractArrayRaw(ifNull(ecr.callDetails_messages, '[]'))))`;

  return {
    enrolled: `SELECT countDistinct(leadId) AS n FROM (${cohort})`,
    /* Engaged is exactly the Campaigns query (an engaged call, or a customer SMS reply), counted with a
       flag instead of a WHERE so Connected comes out of the same pass. */
    reach: `
      WITH coh AS (${cohort})
      SELECT countDistinctIf(leadId, eng = 1) AS engaged,
             countDistinctIf(leadId, eng = 1 OR conn = 1) AS connected
      FROM (
        SELECT ecr.leadId AS leadId,
               toUInt8(${engagedCall}) AS eng,
               toUInt8(lower(ifNull(ecr.callDetails_endedReason, '')) IN (${list(CONNECTED_REASONS)})) AS conn
        FROM ${DB}.endcallreports ecr FINAL
        WHERE ecr.__deleted = 0 AND ecr.teamId = ${team} AND ecr.isTestCall = false
          AND ecr.callId IN (SELECT callId FROM coh)
        UNION ALL
        SELECT c.leadId AS leadId, toUInt8(1) AS eng, toUInt8(1) AS conn
        FROM ${DB}.smsMessages sm FINAL
        JOIN ${DB}.conversations c FINAL ON c.conversationId = sm.conversationId
        WHERE sm.__deleted = 0 AND c.conversationId IN (SELECT conversationId FROM coh)
          AND lower(ifNull(sm.authorType, '')) = 'human'
          AND lower(ifNull(sm.direction, '')) = 'in'
      )`,
    /* The Campaigns Booked filter, one row per meeting (its count is uniqExact(meeting_id)): AI-created
       (source='spyne'), not a warm_transfer/callback pull-in, created in the window, linked to a cohort
       conversation. Cancelled meetings are NOT removed, because the Campaigns count keeps them. */
    booked: `
      WITH coh AS (${cohort})
      SELECT m.meeting_id AS meeting_id,
             any(cu.name) AS customer,
             any(cu.mobile_number) AS phone,
             any(formatDateTime(m.meeting_start_time, '%Y-%m-%dT%H:%i:%SZ', 'UTC')) AS meeting_start,
             any(formatDateTime(m.created_at, '%Y-%m-%dT%H:%i:%SZ', 'UTC')) AS booked_at,
             any(ifNull(m.status, '')) AS status,
             any(ifNull(m.intent, '')) AS intent,
             max(toUInt8(m.call_id IN (SELECT callId FROM coh))) AS on_call
      FROM ${DB}.meetings m FINAL
      LEFT JOIN ${DB}.customer cu FINAL ON cu.customer_id = m.customer_id AND cu.__deleted = 0
      WHERE m.team_id = ${team} AND m.__deleted = 0 AND m.is_active = 1
        AND m.service_type = 'service'
        AND m.source = 'spyne'
        AND lower(JSONExtractString(ifNull(m.meta, ''), 'source'))
            NOT IN ('warm_transfer', 'callback')
        AND ${inWindow("m.created_at")}
        AND ( m.conversation_id IN (SELECT conversationId FROM coh)
              OR m.call_id IN (SELECT callId FROM coh) )
        AND m.meeting_id IS NOT NULL
      GROUP BY m.meeting_id
      ORDER BY booked_at DESC`,
  };
}

/** A single-row aggregate's numeric columns, or null when the query failed or returned no row. */
async function queryOne<K extends string>(sql: string, cols: K[]): Promise<Record<K, number> | null> {
  const rows = await runRows<Record<K, number | string>>(sql, "campaignFunnel");
  if (!rows || rows.length !== 1) return null;
  const out = {} as Record<K, number>;
  for (const c of cols) {
    const n = Number(rows[0][c]);
    if (!Number.isFinite(n)) return null;
    out[c] = n;
  }
  return out;
}

interface BookedRow {
  meeting_id: string;
  customer: string | null;
  phone: string | null;
  meeting_start: string | null;
  booked_at: string | null;
  status: string;
  intent: string;
  on_call: number | string;
}

function toNamedAppt(r: BookedRow): NamedAppt {
  // AI-booked by the query's own filter (source='spyne').
  const how = Number(r.on_call) === 1 ? "AI-booked, on call" : "AI-booked";
  return {
    customer: (r.customer ?? "").trim() || "—",
    phone: r.phone ?? "",
    channel: "Outbound",
    how,
    vehicle: "",
    when: r.meeting_start || null,
    bookedAt: r.booked_at || null,
    status: r.status ?? "",
    intent: (r.intent ?? "").trim(),
    assisted: false,
    serviceType: "service",
  };
}

/* Two queries at a time. All four at once on a big rooftop tripped the warehouse's memory limit
 * ("memory limit exceeded: would use 58.24 GiB") while measuring, and the cluster is shared. */
async function inPairs<T>(jobs: (() => Promise<T>)[]): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < jobs.length; i += 2) out.push(...(await Promise.all(jobs.slice(i, i + 2).map((j) => j()))));
  return out;
}

/* The Campaigns page recomputes on every load, so this keeps only a short memo: one rooftop's funnel is
 * a few multi-second warehouse queries, and a page load asks for it more than once. Successes only. */
const MEMO_TTL_MS = 60_000;
const memo = new Map<string, { at: number; value: CampaignFunnel }>();
const inflight = new Map<string, Promise<CampaignFunnel | null>>();

/** Service outbound's Campaigns funnel over the Campaigns window, or null when any part could not be
 * read (no creds, timeout, bad input). */
export async function fetchCampaignFunnel(teamId: string, now: Date = new Date()): Promise<CampaignFunnel | null> {
  const window = campaignsWindow(now);
  const key = `${teamId}:${window.start}:${window.end}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.value;
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = computeFunnel(teamId, window).finally(() => inflight.delete(key));
  inflight.set(key, p);
  const value = await p;
  if (value) memo.set(key, { at: Date.now(), value });
  return value;
}

async function computeFunnel(teamId: string, window: CampaignFunnelWindow): Promise<CampaignFunnel | null> {
  try {
    const sql = serviceFunnelSql(teamId, { start: window.start, end: window.end, timezone: "UTC" });
    const [enrolled, reach, booked] = await inPairs<unknown>([
      () => queryOne(sql.enrolled, ["n"]),
      () => queryOne(sql.reach, ["engaged", "connected"]),
      () => runRows<BookedRow>(sql.booked, "campaignFunnel"),
    ]) as [Record<"n", number> | null, Record<"engaged" | "connected", number> | null, BookedRow[] | null];
    if (!enrolled || !reach || !booked) return null;
    const appointments = booked.map(toNamedAppt);
    return { window, enrolled: enrolled.n, connected: reach.connected, engaged: reach.engaged, booked: appointments.length, appointments };
  } catch {
    return null;
  }
}
