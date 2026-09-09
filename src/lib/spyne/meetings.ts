/* Live appointment/meeting records from the Spyne product API (leads/dealer/v3/meetings).
 *
 * Powers two things Q12227 can't:
 *   • the "Upcoming appointments" card (future bookings, customer + vehicle), and
 *   • the drill-down behind any appointment count — click "10 appts" → the 10 leads behind it.
 *
 * Server-only. Like the other spyne helpers it degrades to an empty list (never throws) when auth is
 * unconfigured or the call fails, so the report keeps rendering. See client.ts for the auth model. */

import { spyneGet, resolveToken } from "./client";
import { runClickhouse, chEsc, hasClickhouseCreds } from "./clickhouse";
import type { Meeting, MeetingsResult } from "@/components/reports/data";

export type ServiceType = "sales" | "service";

/* The Spyne session token is a base64-encoded JSON blob carrying enterprise_id + team_id (it is NOT a
 * signed JWT). The meetings endpoint needs `enterpriseId` as a query param, so decode it from whichever
 * token we hold (request-forwarded in prod, env in local dev). Falls back to SPYNE_ENTERPRISE_ID. */
export function enterpriseIdFromToken(token?: string | null): string | null {
  const t = resolveToken(token);
  if (t) {
    try {
      const payload = JSON.parse(Buffer.from(t, "base64").toString("utf8")) as { enterprise_id?: string };
      if (payload?.enterprise_id) return payload.enterprise_id;
    } catch {
      /* not a decodable token — fall through to the env override */
    }
  }
  return process.env.SPYNE_ENTERPRISE_ID || null;
}

// ── raw API shapes (only the fields we read) ──
interface RawVin { dealerVinId?: string; make?: string; year?: number | string; model?: string; trim?: string }
interface RawMeeting {
  id?: string;
  meetingId?: string;
  leadId?: string;
  assignedTo?: { userId?: string; userName?: string | null } | null;
  intent?: string;
  meetingStartTime?: string;
  timezone?: string;
  status?: string;
  serviceType?: string;
  createdAt?: string; // when the appointment was booked
  source?: string; // who booked it: "spyne" = the AI agent, "bdc" = the dealer's own staff, etc.
  proposedVinsData?: RawVin[];
  customerData?: { name?: string; extractedName?: string; mobileNumber?: string } | null;
  /* WHICH AGENT booked it. This is the only place the live API states the agent split, and it is what
   * lets an appointment number be served live instead of from the aggregate: agentType is Sales/Service
   * and callType is inbound/outbound, which together are exactly the report's agent_type. Present on
   * 325 of 326 rows measured on Honda Universe, and it agreed with serviceType on every one. */
  agentData?: { agentName?: string | null; agentType?: string | null; callType?: string | null } | null;
}

/* This report attributes value to the AI agent, so every appointment number in it (the tiles, from
 * Q12227) counts only AI-booked appointments. The meetings endpoint, by contrast, returns the rooftop's
 * ENTIRE appointment book — including the ones the dealer's own BDC booked (often the majority). Filter
 * to AI-booked so the drill-down matches the count it sits behind; otherwise the list dwarfs the tile
 * (e.g. Honda DTLA: 152 meetings booked on a day, but only ~23 by the AI). The API ignores a `source`
 * query param, so we filter client-side. */
const AI_SOURCE = "spyne";

/* …and `source='spyne'` alone is NOT proof the AI booked it. `meta.source` says HOW the row came to
 * exist. 'warm_transfer' AND 'callback' rows are the customer's EXISTING appointments pulled in around
 * a transfer or callback — records we did not create, whose start times are often the customer's own PAST
 * visits. Listing one invents an appointment (Honda of Downtown Los Angeles 2026-08-14: a manager was
 * shown 7 "appointments" for ONE customer, all 7 warm_transfer, start times Jul-2024 → Jan-2026).
 *
 * ★ 'callback' joined the exclusion 2026-09-09: fleet 30d it runs 1.40 meetings/lead with 53.6% of start
 * times in the PAST (ordinary rows: 1.10 and 2.8%). See detailQueries.ts notPulledInHistory().
 *
 * The Spyne meetings API doesn't return `meta` at all, so it's resolved from ClickHouse, keyed on the
 * ids the API hands back — the same lookup vini-daily-calls' send path does
 * (server/roi-cron/leadCaptureCH.cjs fetchMeetingMetaSource). The ClickHouse-sourced snapshot path
 * (report_appointments, see detailQueries.ts appointmentsSql) filters this at the source; this covers
 * the live path (the console's inbound/outbound drill-down, and the snapshot-empty fallback).
 *
 * BEST-EFFORT BY DESIGN: no creds or a failed/empty lookup drops nothing, so a ClickHouse outage can
 * never silently blank a rooftop's real appointment list. TEAM-SCOPED: a meeting id that isn't this
 * rooftop's returns no row, so the lookup can't leak or act on another dealer's records. */
const PULLED_IN_META_SOURCES = new Set(["warm_transfer", "callback"]);

async function dropPulledInHistoryMeetings(teamId: string, meetings: Meeting[]): Promise<Meeting[]> {
  const ids = [...new Set(meetings.map((m) => m.id).filter(Boolean))];
  if (!ids.length || !hasClickhouseCreds()) return meetings;
  const inList = `(${ids.map((i) => `'${chEsc(i)}'`).join(",")})`;
  const rows = await runClickhouse<{ meetingId?: string; rowId?: string; metaSource?: string }>(
    // The feed's `id` is meeting_id for some rows and _id for others, so key on both. SharedReplacing-
    // MergeTree keeps duplicate physical rows and an early version can carry an empty meta — prefer a
    // populated value across them rather than reading whichever row comes back first.
    `SELECT toString(m.meeting_id) AS meetingId, toString(m._id) AS rowId,
            anyIf(JSONExtractString(ifNull(m.meta,''),'source'),
                  notEmpty(JSONExtractString(ifNull(m.meta,''),'source'))) AS metaSource
     FROM dealer_leads.meetings AS m
     WHERE m.team_id = '${chEsc(teamId)}'
       AND (m.meeting_id IN ${inList} OR m._id IN ${inList})
     GROUP BY meetingId, rowId`,
  );
  const pulledIn = new Set<string>();
  for (const r of rows) {
    if (!PULLED_IN_META_SOURCES.has((r.metaSource || "").trim().toLowerCase())) continue;
    if (r.meetingId) pulledIn.add(r.meetingId);
    if (r.rowId) pulledIn.add(r.rowId);
  }
  if (!pulledIn.size) return meetings;
  return meetings.filter((m) => !pulledIn.has(m.id));
}
// The endpoint returns the meetings array directly under `data` (NOT data.meetings), with pagination alongside.
interface MeetingsResp { data?: RawMeeting[]; pagination?: { hasNextPage?: boolean; total?: number } }

/* "2026 Mercedes-Benz C-Class C 300" from the first VIN that has any fields populated; "" when none do
 * (service meetings, and some sales ones, carry no vehicle data). */
function vehicleLabel(vins?: RawVin[]): string {
  const v = (vins || []).find((x) => x.year || x.make || x.model || x.trim);
  if (!v) return "";
  return [v.year, v.make, v.model, v.trim]
    .map((x) => (x == null ? "" : String(x).trim()))
    .filter(Boolean)
    .join(" ");
}

function normalize(m: RawMeeting): Meeting {
  const c = m.customerData || {};
  return {
    id: m.id || m.meetingId || "",
    leadId: m.leadId || null,
    customer: (c.name || c.extractedName || "").trim() || "—",
    phone: c.mobileNumber || null,
    vehicle: vehicleLabel(m.proposedVinsData),
    when: m.meetingStartTime || "",
    tz: m.timezone || null,
    status: m.status || "scheduled",
    serviceType: m.serviceType || "",
    assignedTo: m.assignedTo?.userName || null,
    intent: m.intent || null,
    bookedAt: m.createdAt || null,
    agentType: (m.agentData?.agentType || "").trim().toLowerCase() || null,
    direction: (m.agentData?.callType || "").trim().toLowerCase() || null,
  };
}

const PAGE_SIZE = 200;
// Safety ceiling (≤5000 rows/serviceType). The endpoint returns the rooftop's ENTIRE book (BDC + AI),
// sorted by meeting_start_time, and we keep only source=spyne client-side. Busy rooftops (e.g. Honda
// DTLA books ~150 service meetings/day) overflow a small cap before we reach most AI meetings — the old
// 1000-row cap truncated the drill-down to ~117 of 530, far below the tile. We now page to the reported
// total (in one parallel burst) up to this ceiling; quiet rooftops still resolve in a single page.
const MAX_PAGES = 25;

interface FetchOneOpts {
  teamId: string;
  enterpriseId: string;
  serviceType: ServiceType;
  startISO: string;
  endISO: string;
  sortOrder: "asc" | "desc";
  token?: string | null;
  env?: string | null;
}

/* One serviceType's meetings in [startISO, endISO). Reads page 1, then — using the reported total —
 * fetches the remaining pages (up to MAX_PAGES) in parallel so a high-volume book doesn't get truncated
 * by a low page cap and doesn't pay per-page latency. Falls back to sequential hasNextPage paging when
 * the API doesn't report a total. Returns [] on any failure (spyneGet logs + swallows errors). */
async function fetchOne(o: FetchOneOpts): Promise<Meeting[]> {
  const pageUrl = (page: number) =>
    `/leads/dealer/v3/meetings?${new URLSearchParams({
      enterpriseId: o.enterpriseId,
      teamId: o.teamId,
      serviceType: o.serviceType,
      sortBy: "meeting_start_time",
      sortOrder: o.sortOrder,
      page: String(page),
      pageSize: String(PAGE_SIZE),
      startDate: o.startISO,
      endDate: o.endISO,
      /* ★ SERVER-SIDE source FILTER (added 2026-09-09). The API honours this now — measured on Honda
       * Universe, the same request returns 4,529 rows without it and 326 with it, and the 326 are
       * exactly the AI-booked set we keep. The note below about the API ignoring `source` was true once
       * and is not any more.
       *
       * This is not only a speed fix. MAX_PAGES caps this read at 5,000 rows and that rooftop's full
       * book is already 4,529, so a busy rooftop was one good month away from silently truncating its
       * own appointment list. The client-side AI_SOURCE filter below stays as a belt-and-braces check. */
      source: AI_SOURCE,
    }).toString()}`;

  const first = await spyneGet<MeetingsResp>(pageUrl(1), o.token, o.env);
  const raw: RawMeeting[] = Array.isArray(first?.data) ? [...first!.data!] : [];
  if (raw.length) {
    const total = first?.pagination?.total;
    if (typeof total === "number" && total > PAGE_SIZE) {
      // Known total → fetch the rest in one parallel burst (capped). page 1 is done; pull 2..lastPage.
      const lastPage = Math.min(MAX_PAGES, Math.ceil(total / PAGE_SIZE));
      const rest = await Promise.all(
        Array.from({ length: lastPage - 1 }, (_, i) => spyneGet<MeetingsResp>(pageUrl(i + 2), o.token, o.env)),
      );
      for (const r of rest) if (Array.isArray(r?.data)) raw.push(...r!.data!);
    } else if (first?.pagination?.hasNextPage) {
      // No total reported → page sequentially while there's a next page.
      for (let page = 2; page <= MAX_PAGES; page++) {
        const resp = await spyneGet<MeetingsResp>(pageUrl(page), o.token, o.env);
        const rows = resp?.data;
        if (!Array.isArray(rows) || rows.length === 0) break;
        raw.push(...rows);
        if (!resp?.pagination?.hasNextPage) break;
      }
    }
  }
  // AI-booked only — drop the dealer's own BDC/CRM appointments so this matches the AI's count.
  const out: Meeting[] = [];
  for (const r of raw) if ((r.source || "").toLowerCase() === AI_SOURCE) out.push(normalize(r));
  return out;
}

/* Meetings for a rooftop, across one or both serviceTypes, merged. `service: "both"` fetches sales +
 * service in parallel. Never throws — returns an empty result (with an `error` note) on failure, and
 * an empty result when auth/enterpriseId can't be resolved.
 *
 * The API filters by meeting_start_time. Two modes:
 *   • UPCOMING — pass [startISO, endISO) as the meeting-time window; sorted soonest-first.
 *   • BOOKED-IN-PERIOD (the drill-down behind a count) — pass a WIDE meeting-time window AND a
 *     bookedStartISO/bookedEndISO; results are filtered to those *booked* (createdAt) in that range and
 *     sorted newest-booking-first. This matches "Appointments booked · {period}": a meeting booked in
 *     the period but scheduled for a future date still belongs in the list. */
export async function fetchMeetings(opts: {
  teamId: string;
  service: ServiceType | "both";
  startISO: string;
  endISO: string;
  sortOrder?: "asc" | "desc";
  bookedStartISO?: string;
  bookedEndISO?: string;
  leadIds?: string[]; // when set, return one meeting per lead for exactly these leads (the leads the tile counted)
  enterpriseId?: string | null; // explicit override (host-forwarded on the URL); else decoded from token
  token?: string | null;
  env?: string | null; // host-forwarded ?env=uat|stag|prod — which Spyne backend to call
}): Promise<MeetingsResult> {
  const { teamId, service, startISO, endISO, sortOrder = "asc", bookedStartISO, bookedEndISO, leadIds, token, env } = opts;
  // Prefer an explicit enterpriseId (the host scopes the iframe with ?enterprise_id=&team_id=). Fall back
  // to decoding it from the token — both point at the same rooftop in prod; the override lets local dev
  // (one shared token) query any enterprise/team the token is allowed to read.
  const enterpriseId = (opts.enterpriseId && opts.enterpriseId.trim()) || enterpriseIdFromToken(token);
  if (!enterpriseId || !teamId) return { meetings: [], total: 0 };
  // Lead-scoped with no leads → the agent booked nothing in the window; show an empty list (don't fall
  // through to an unfiltered fetch).
  if (leadIds && leadIds.length === 0) return { meetings: [], total: 0 };
  const types: ServiceType[] = service === "both" ? ["sales", "service"] : [service];
  try {
    const lists = await Promise.all(
      types.map((serviceType) => fetchOne({ teamId, enterpriseId, serviceType, startISO, endISO, sortOrder, token, env })),
    );
    // Drop meta.source 'warm_transfer'/'callback' rows before any scoping/counting below — appointments
    // we did not create (see dropPulledInHistoryMeetings). Applied here so every branch's `total` and every
    // listed row honour it.
    let meetings = await dropPulledInHistoryMeetings(teamId, lists.flat());
    // `total` is the count the modal headlines. Defaults to the rows we list; the lead-scoped drill
    // overrides it with the authoritative booked-lead count so the number matches the tile even if a
    // lead's live meeting record didn't come back (deleted/rescheduled/non-spyne after Q12227 captured it).
    let total: number;
    if (leadIds && leadIds.length) {
      // lead-scoped: show exactly the leads the tile counted (resolved from agent_lead_days, which has
      // the inbound/outbound split the meetings API lacks). One row per lead — soonest meeting first — so
      // the listed rows align with the tile and an inbound agent never shows outbound's appointments.
      const set = new Set(leadIds);
      const seen = new Set<string>();
      const scoped = meetings
        .filter((m) => m.leadId && set.has(m.leadId))
        .sort((a, b) => (a.when || "").localeCompare(b.when || ""))
        .filter((m) => (seen.has(m.leadId as string) ? false : (seen.add(m.leadId as string), true)));
      if (scoped.length === 0 && bookedStartISO && bookedEndISO) {
        // Self-heal: the tile counted booked leads, but none matched a live meeting record's leadId (the
        // agent_lead_days lead_id and the meetings API leadId can diverge — rescheduled/re-keyed leads).
        // Rather than show an empty list under a nonzero count (the daily digest's "no rows" bug), list
        // the meetings actually BOOKED (createdAt) in the window, newest booking first.
        meetings = meetings
          .filter((m) => m.bookedAt && m.bookedAt >= bookedStartISO && m.bookedAt < bookedEndISO)
          .sort((a, b) => (b.bookedAt || "").localeCompare(a.bookedAt || ""));
        total = meetings.length || leadIds.length;
      } else {
        meetings = scoped;
        total = leadIds.length; // authoritative — same agent_lead_days basis as the "Appointments booked" tile
      }
    } else if (bookedStartISO && bookedEndISO) {
      // booked-in-period: keep meetings whose booking time falls in the window, newest booking first
      meetings = meetings
        .filter((m) => m.bookedAt && m.bookedAt >= bookedStartISO && m.bookedAt < bookedEndISO)
        .sort((a, b) => (b.bookedAt || "").localeCompare(a.bookedAt || ""));
      total = meetings.length;
    } else {
      meetings = meetings.sort((a, b) => {
        const cmp = (a.when || "").localeCompare(b.when || "");
        return sortOrder === "desc" ? -cmp : cmp;
      });
      total = meetings.length;
    }
    return { meetings, total };
  } catch (e) {
    return { meetings: [], total: 0, error: e instanceof Error ? e.message : String(e) };
  }
}
