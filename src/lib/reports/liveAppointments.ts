/* AI-BOOKED APPOINTMENTS, READ LIVE FROM THE MEETINGS API.
 *
 * The rest of this report comes from an aggregate that a GitHub Actions job rebuilds from ClickHouse.
 * Appointments do not, because they are the number dealers check against the appointments console, and
 * that console reads this same API. Anything between the two shows up as one screen contradicting
 * another about how many cars are coming in.
 *
 * There are two lags between a booking and the aggregate, and this bypasses both:
 *   • Mongo → ClickHouse (CDC): p50 0 min, p90 1 min, but p99 5.5 DAYS and max 12.6 days. Heiser
 *     Chevrolet had 24 service appointments booked Sep 1-8 that only reached ClickHouse on Sep 9 at
 *     18:05 — the reporting console could not have counted them however fresh its own sync was.
 *   • ClickHouse → Supabase (our ETL): scheduled hourly, actually fires every 1.4-5.5h.
 *
 * WHAT THIS DOES NOT COVER. AI-assisted (CRM) appointments are not in this set — they are meetings the
 * dealer's own staff booked, which this API returns under a different source and which only count as
 * assisted once we know the AI worked that lead in the window (a fact that lives in the aggregate).
 * Assisted therefore stays on the aggregate and stays subject to its lag. The headline AI-booked number
 * is the one that moves.
 *
 * DEFINITIONS ARE ALREADY IDENTICAL, so this changes freshness and nothing else. Verified id-for-id on
 * Honda Universe (team 5895de05b): the API's source='spyne' set is exactly our rule — meetings.source
 * 'spyne' minus meta.source 'warm_transfer' and 'callback' — 326 = 326, with no row on either side the
 * other lacks. The API applies those exclusions server-side and does not expose meta.source.
 *
 * CANCELLED BOOKINGS ARE DROPPED HERE (2026-10-06), client-side, because the API returns them under
 * source=spyne like any other — the same exclusion the spine and the snapshot apply (appointmentStatus.ts).
 * Without it the tile kept a cancelled booking that its own drill-down listed in red. */
import { spyneGet } from "@/lib/spyne/client";
import { enterpriseIdFromToken, classifyMeetingIds } from "@/lib/spyne/meetings";
import { isCancelledMeeting } from "@/lib/reports/appointmentStatus";
import { storeLocalDay } from "@/lib/reports/tzMap";
import type { Meeting } from "@/components/reports/data";

/** agent_type label the report uses, e.g. "Service Outbound". Null when the API omitted agentData. */
function agentTypeOf(m: Meeting): string | null {
  const svc = (m.agentType || m.serviceType || "").toLowerCase();
  const dir = (m.direction || "").toLowerCase();
  if (svc !== "sales" && svc !== "service") return null;
  if (dir !== "inbound" && dir !== "outbound") return null;
  return `${svc === "sales" ? "Sales" : "Service"} ${dir === "inbound" ? "Inbound" : "Outbound"}`;
}

export interface LiveAppointments {
  /** Every AI-booked meeting booked in the fetched range, newest booking first. */
  meetings: Meeting[];
}

/* ★ THE STORE'S DAY, NOT THE UTC DAY (fixed 2026-10-09, audit A2 F2). `bookedAt` is a UTC instant and
 * [start, end) are store-local calendar days. These used to compare the instant's UTC date prefix, so a
 * Pacific booking made after 5pm local (after 7pm Central) landed on the NEXT day: Honda of Downtown Los
 * Angeles, Service, 2026-10-07 — four bookings at 17:33-18:40 PT counted 1 on the Overview against 4 in
 * the digest and the appointments console. The snapshot path (route.ts) and the ETL already bucket with
 * storeLocalDay; this puts the live path in the same day space. tz null/invalid → the raw UTC prefix,
 * storeLocalDay's own contract and exactly the previous behaviour. */
export function bookedInStoreWindow(bookedAt: string | null | undefined, tz: string | null | undefined, start: string, end: string): boolean {
  const raw = (bookedAt ?? "").slice(0, 10);
  if (!raw) return false;
  const day = storeLocalDay(bookedAt as string, tz ?? undefined, raw);
  return day >= start && day < end;
}

/* Count per agent_type over one sub-window. One fetch covers the report window AND the prior one, so a
 * period delta compares two live numbers rather than a live one against a stale one. Windowed by the
 * store-local booking day (bookedInStoreWindow), identical to the named-appointment list in the route. */
export function countByAgent(meetings: Meeting[], start: string, end: string, tz?: string | null): { byAgent: Record<string, number>; unattributed: number } {
  const byAgent: Record<string, number> = {};
  let unattributed = 0;
  for (const m of meetings) {
    if (!bookedInStoreWindow(m.bookedAt, tz, start, end)) continue;
    const at = agentTypeOf(m);
    if (at) byAgent[at] = (byAgent[at] ?? 0) + 1;
    else unattributed++;
  }
  return { byAgent, unattributed };
}

/* Distinct booked customers per agent_type over one sub-window, by the same day test and agent rule as
 * countByAgent. A meeting with no lead id cannot be matched to another, so it is tallied separately as
 * one customer each. Used for the Reports close-rate basis (route.ts applyCustomerBasis). */
export function bookedLeadsByAgent(meetings: Meeting[], start: string, end: string, tz?: string | null): { leads: Record<string, Set<string>>; noLead: Record<string, number> } {
  const leads: Record<string, Set<string>> = {};
  const noLead: Record<string, number> = {};
  for (const m of meetings) {
    if (!bookedInStoreWindow(m.bookedAt, tz, start, end)) continue;
    const at = agentTypeOf(m);
    if (!at) continue;
    if (m.leadId) (leads[at] ??= new Set()).add(m.leadId);
    else noLead[at] = (noLead[at] ?? 0) + 1;
  }
  return { leads, noLead };
}

/* Bookings made in [start, end) — NOT appointments scheduled in it. Those are different sets and the
 * report means the first: an appointment booked today for next month belongs to today.
 *
 * PAGED NEWEST-BOOKING-FIRST, STOPPING AT THE WINDOW EDGE. The API's own startDate/endDate filter on
 * meetingStartTime, not on when the booking was made (checked: of 173 rows in a Sep 1-10 request, 172
 * had a start time in range but only 27 had a booking date in it). Sorting by createdAt instead lets us
 * read only as far back as the window needs and stop, rather than pulling a wide meeting-time window and
 * discarding most of it. On a 30-day window that is typically one or two pages.
 *
 * `source=spyne` is applied SERVER-side: the same request returns 4,529 rows without it and 326 with it,
 * and the 326 are exactly the AI-booked set — verified id-for-id against our own ClickHouse rule
 * (source='spyne' minus meta.source warm_transfer and callback). */
const PAGE_SIZE = 200;
const MAX_PAGES = 25; // 5,000 bookings in one window — far above any rooftop's real volume

interface RawAgentData { agentType?: string | null; callType?: string | null }
interface RawLiveMeeting {
  id?: string; meetingId?: string; leadId?: string; intent?: string;
  meetingStartTime?: string; timezone?: string; status?: string; serviceType?: string;
  createdAt?: string; source?: string;
  customerData?: { name?: string; extractedName?: string; mobileNumber?: string } | null;
  agentData?: RawAgentData | null;
  proposedVinsData?: { make?: string; year?: number | string; model?: string; trim?: string }[];
}
interface LiveResp { data?: RawLiveMeeting[]; pagination?: { hasNextPage?: boolean; total?: number } }

function toMeeting(m: RawLiveMeeting): Meeting {
  const c = m.customerData || {};
  const v = (m.proposedVinsData || [])[0];
  const ids = classifyMeetingIds(m.id, m.meetingId);
  return {
    id: m.id || m.meetingId || "",
    meetingId: ids.meetingId,
    mongoId: ids.mongoId,
    source: (m.source || "").trim().toLowerCase() || null,
    leadId: m.leadId || null,
    customer: (c.name || c.extractedName || "").trim() || "—",
    phone: c.mobileNumber || null,
    vehicle: v ? [v.year, v.make, v.model, v.trim].filter(Boolean).join(" ").trim() : "",
    when: m.meetingStartTime || "",
    tz: m.timezone || null,
    status: m.status || "scheduled",
    serviceType: (m.serviceType || "").toLowerCase(),
    assignedTo: null,
    intent: m.intent || null,
    bookedAt: m.createdAt || null,
    agentType: (m.agentData?.agentType || "").trim().toLowerCase() || null,
    direction: (m.agentData?.callType || "").trim().toLowerCase() || null,
  };
}

/** Null when there is no usable credential or the API failed — the caller keeps the aggregate's numbers. */
export async function fetchLiveAppointments(opts: {
  teamId: string;
  enterpriseId?: string | null;
  /** Store-local day strings, end exclusive — the same window the report is showing. */
  start: string;
  end: string;
  token?: string | null;
  env?: string | null;
  /** The rooftop's IANA timezone — the window is a STORE-LOCAL day range (bookedInStoreWindow). */
  timezone?: string | null;
}): Promise<LiveAppointments | null> {
  const { teamId, enterpriseId, start, end, token, env, timezone } = opts;
  const ent = (enterpriseId && enterpriseId.trim()) || enterpriseIdFromToken(token);
  if (!teamId || !token || !ent) return null;
  try {
    const out: Meeting[] = [];
    let ok = false;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const qs = new URLSearchParams({
        enterpriseId: ent,
        teamId,
        sortBy: "createdAt",
        sortOrder: "desc",
        page: String(page),
        pageSize: String(PAGE_SIZE),
        source: "spyne",
      });
      const res = await spyneGet<LiveResp>(`/leads/dealer/v3/meetings?${qs}`, token, env);
      // A failed FIRST page is a real failure → null, and the caller keeps the aggregate's numbers. A
      // failure mid-paging keeps what we have, so a blip can only under-count, never blank the tile.
      if (!res) return ok ? { meetings: out } : null;
      ok = true;
      const batch = Array.isArray(res.data) ? res.data : [];
      for (const r of batch) {
        if (bookedInStoreWindow(r.createdAt, timezone, start, end) && !isCancelledMeeting(r.status)) out.push(toMeeting(r));
      }
      // Sorted newest-booking-first, so once a page ends before the window we have everything. The
      // store-local day is monotonic in the UTC instant, so the same edge test holds in store days.
      const last = batch.length ? batch[batch.length - 1].createdAt ?? "" : "";
      const oldest = last ? storeLocalDay(last, timezone ?? undefined, last.slice(0, 10)) : "";
      if (!batch.length || !res.pagination?.hasNextPage || (oldest && oldest < start)) break;
    }
    return { meetings: out };
  } catch {
    return null;
  }
}
