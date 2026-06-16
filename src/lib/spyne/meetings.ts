/* Live appointment/meeting records from the Spyne product API (leads/dealer/v3/meetings).
 *
 * Powers two things Q12227 can't:
 *   • the "Upcoming appointments" card (future bookings, customer + vehicle), and
 *   • the drill-down behind any appointment count — click "10 appts" → the 10 leads behind it.
 *
 * Server-only. Like the other spyne helpers it degrades to an empty list (never throws) when auth is
 * unconfigured or the call fails, so the report keeps rendering. See client.ts for the auth model. */

import { spyneGet, resolveToken } from "./client";
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
  proposedVinsData?: RawVin[];
  customerData?: { name?: string; extractedName?: string; mobileNumber?: string } | null;
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
  };
}

const PAGE_SIZE = 200;
const MAX_PAGES = 5; // hard cap (≤1000 rows) so a huge window can't run away

interface FetchOneOpts {
  teamId: string;
  enterpriseId: string;
  serviceType: ServiceType;
  startISO: string;
  endISO: string;
  sortOrder: "asc" | "desc";
  token?: string | null;
}

/* One serviceType's meetings in [startISO, endISO), paging through up to MAX_PAGES. Returns [] on any
 * failure (spyneGet already logs + swallows network/auth errors). */
async function fetchOne(o: FetchOneOpts): Promise<Meeting[]> {
  const out: Meeting[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const qs = new URLSearchParams({
      enterpriseId: o.enterpriseId,
      teamId: o.teamId,
      serviceType: o.serviceType,
      sortBy: "meeting_start_time",
      sortOrder: o.sortOrder,
      page: String(page),
      pageSize: String(PAGE_SIZE),
      startDate: o.startISO,
      endDate: o.endISO,
    });
    const resp = await spyneGet<MeetingsResp>(`/leads/dealer/v3/meetings?${qs.toString()}`, o.token);
    const rows = resp?.data;
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) out.push(normalize(r));
    if (!resp?.pagination?.hasNextPage) break;
  }
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
  enterpriseId?: string | null; // explicit override (host-forwarded on the URL); else decoded from token
  token?: string | null;
}): Promise<MeetingsResult> {
  const { teamId, service, startISO, endISO, sortOrder = "asc", bookedStartISO, bookedEndISO, token } = opts;
  // Prefer an explicit enterpriseId (the host scopes the iframe with ?enterprise_id=&team_id=). Fall back
  // to decoding it from the token — both point at the same rooftop in prod; the override lets local dev
  // (one shared token) query any enterprise/team the token is allowed to read.
  const enterpriseId = (opts.enterpriseId && opts.enterpriseId.trim()) || enterpriseIdFromToken(token);
  if (!enterpriseId || !teamId) return { meetings: [], total: 0 };
  const types: ServiceType[] = service === "both" ? ["sales", "service"] : [service];
  try {
    const lists = await Promise.all(
      types.map((serviceType) => fetchOne({ teamId, enterpriseId, serviceType, startISO, endISO, sortOrder, token })),
    );
    let meetings = lists.flat();
    if (bookedStartISO && bookedEndISO) {
      // booked-in-period: keep meetings whose booking time falls in the window, newest booking first
      meetings = meetings
        .filter((m) => m.bookedAt && m.bookedAt >= bookedStartISO && m.bookedAt < bookedEndISO)
        .sort((a, b) => (b.bookedAt || "").localeCompare(a.bookedAt || ""));
    } else {
      meetings = meetings.sort((a, b) => {
        const cmp = (a.when || "").localeCompare(b.when || "");
        return sortOrder === "desc" ? -cmp : cmp;
      });
    }
    return { meetings, total: meetings.length };
  } catch (e) {
    return { meetings: [], total: 0, error: e instanceof Error ? e.message : String(e) };
  }
}
