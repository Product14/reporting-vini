import { fetchMeetings, type ServiceType } from "@/lib/spyne/meetings";
import { getStoreTimeZone } from "@/lib/spyne/teamContext";
import { requireTeamAuth, spyneTokenFrom } from "@/lib/reports/auth";
import { getSupabase, AGENT_LEAD_DAYS, REPORT_APPOINTMENTS } from "@/lib/reports/supabase";
import { rangeFor } from "@/components/reports/liveData";
import type { Bucket, Meeting } from "@/components/reports/data";

// Report slot id → the agent_type string the aggregate stores. The meetings API has no inbound/outbound
// field, so we recover that split by looking up which leads each agent_type booked in agent_lead_days.
const SLOT_TO_AGENT_TYPE: Record<string, string> = {
  sales_ib: "Sales Inbound",
  sales_ob: "Sales Outbound",
  service_ib: "Service Inbound",
  service_ob: "Service Outbound",
};

// serviceType → the agent_type slots that belong to it. Used to scope booked leads to one department
// when no specific agent slot is requested (the digest passes serviceType, not agent_type).
const SERVICE_TO_AGENT_TYPES: Record<string, string[]> = {
  sales: ["Sales Inbound", "Sales Outbound"],
  service: ["Service Inbound", "Service Outbound"],
};

/* ── report_appointments (Supabase) read path ──────────────────────────────────────────────────────
 * The digest's appointment LIST + "top vehicles" now read from the ClickHouse-sourced report_appointments
 * snapshot (see scripts/backfill.ts / migration 0016) instead of the live Spyne meetings API, which 401s
 * silently when its session token expires and blanks the list. Only the rooftop-wide / serviceType-scoped
 * reads (the digest) use this — the console's inbound/outbound drill-down keeps the live lead-scoped path,
 * since report_appointments carries no call-direction split. Falls back to the live API when the snapshot
 * has no rows (e.g. before the first sync). */
interface ApptRow {
  meeting_id: string | null; lead_id: string | null; customer_name: string | null; phone: string | null;
  vehicle: string | null; intent: string | null; service_type: string | null;
  meeting_start: string | null; booked_at: string | null;
}
function toMeeting(r: ApptRow): Meeting {
  return {
    id: r.meeting_id || "", leadId: r.lead_id || null,
    customer: (r.customer_name || "").trim() || "—", phone: r.phone || null,
    vehicle: (r.vehicle || "").trim(), when: r.meeting_start || "", tz: null,
    status: "scheduled", serviceType: r.service_type || "", assignedTo: null,
    intent: r.intent || null, bookedAt: r.booked_at || null,
  };
}
/* Appointments for a rooftop from the snapshot. mode='window' → booked_at ∈ [startISO,endISO), newest
 * booking first (matches "booked in period"); mode='upcoming' → meeting_start ≥ now, soonest first.
 * Returns null (not []) when the table is unavailable so the caller can fall back to the live API. */
async function sbAppointments(
  teamId: string, service: ServiceType | "both",
  mode: "window" | "upcoming", startISO: string, endISO: string,
): Promise<Meeting[] | null> {
  const sb = getSupabase();
  if (!sb) return null;
  try {
    let q = sb.from(REPORT_APPOINTMENTS).select("*").eq("team_id", teamId);
    if (service !== "both") q = q.eq("service_type", service);
    if (mode === "window") q = q.gte("booked_at", startISO).lt("booked_at", endISO).order("booked_at", { ascending: false });
    else q = q.gte("meeting_start", startISO).order("meeting_start", { ascending: true });
    const { data, error } = await q;
    if (error || !Array.isArray(data)) return null;
    return (data as ApptRow[]).map(toMeeting);
  } catch {
    return null;
  }
}
/* Top vehicles = AI-booked appointments over a trailing window grouped by vehicle. Returns null when the
 * table is unavailable so the caller falls back to the live API. */
async function sbTopVehicles(
  teamId: string, service: ServiceType | "both", sinceISO: string, limit: number,
): Promise<{ name: string; count: number }[] | null> {
  const sb = getSupabase();
  if (!sb) return null;
  try {
    let q = sb.from(REPORT_APPOINTMENTS).select("vehicle").eq("team_id", teamId).gte("booked_at", sinceISO);
    if (service !== "both") q = q.eq("service_type", service);
    const { data, error } = await q;
    if (error || !Array.isArray(data)) return null;
    const counts = new Map<string, number>();
    for (const r of data as { vehicle: string | null }[]) {
      const name = (r.vehicle || "").trim();
      if (name) counts.set(name, (counts.get(name) || 0) + 1);
    }
    return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, limit);
  } catch {
    return null;
  }
}

/* The distinct leads this agent (or the whole rooftop, when agentType is omitted) booked an appointment
 * with in [start, end) — i.e. exactly the leads behind the "Appointments booked" tile. Returns null when
 * the table/query is unavailable, so the caller falls back to the booking-date meeting filter.
 *
 * `service` scopes the leads to one department when no specific agent slot is given. This MUST mirror the
 * serviceType passed to fetchMeetings: that call lists only same-service meetings, so without this filter
 * cross-service booked leads inflate `total` while matching no listed meeting — an empty list with a
 * non-zero count (the daily digest's "appointments booked, but no rows/dates" bug). */
async function bookedLeadIds(teamId: string, agentType: string | undefined, service: ServiceType | "both", start: string, end: string): Promise<string[] | null> {
  const sb = getSupabase();
  if (!sb) return null;
  try {
    let q = sb.from(AGENT_LEAD_DAYS).select("lead_id").eq("team_id", teamId).eq("appointment", true)
      .gte("activity_day", start).lt("activity_day", end);
    if (agentType) q = q.eq("agent_type", agentType);
    else if (service !== "both") q = q.in("agent_type", SERVICE_TO_AGENT_TYPES[service]);
    const { data, error } = await q;
    if (error || !Array.isArray(data)) return null;
    return [...new Set(data.map((r) => String((r as { lead_id?: string }).lead_id || "")).filter(Boolean))];
  } catch {
    return null;
  }
}

/* Lists the actual appointment/meeting records behind an appointment count, straight from the Spyne
 * product API (leads/dealer/v3/meetings) — the token never reaches the browser. Used by:
 *   • the "Upcoming appointments" card  (?scope=upcoming → meetings from now forward), and
 *   • the drill-down behind any appointment count (?scope=window → meetings in the report's window).
 *
 * Window inputs mirror /api/reports: explicit start/end (store-local YYYY-MM-DD), or a relative bucket
 * resolved in the store's timezone. Degrades to an empty list — never 502s the card. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UPCOMING_HORIZON_DAYS = 60; // how far forward "upcoming" looks
const BOOKED_LOOKAHEAD_DAYS = 365; // meeting-time ceiling when listing booked-in-period appointments

// Treat a store-local calendar date as a UTC-midnight instant. Same simplification /api/reports uses
// for its date-bucketed reads.
function dayToISO(day: string): string {
  return `${day}T00:00:00.000Z`;
}

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const teamId = searchParams.get("team_id");
  if (!teamId) return Response.json({ error: "team_id is required" }, { status: 400 });

  // Require a credential and validate team scope: a valid Spyne session token scoped to this team, or
  // the service CRON_SECRET. No credential → 401; token scoped to a different team → 403. (Meetings
  // lists customer/vehicle records, so it must not be readable for an arbitrary team_id either.)
  const auth = requireTeamAuth(request, teamId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  // Spyne token for the live meetings call: prod forwards it (Authorization header or
  // auth_key/spyne_token/token query param); local dev omits it and the client falls back to
  // SPYNE_API_TOKEN. spyneTokenFrom skips the CRON_SECRET so the cron's `Authorization: Bearer
  // <secret>` (which authorizes the request) never shadows the real dealer token it sends as ?auth_key=.
  const spyneToken = spyneTokenFrom(request);

  const svcParam = (searchParams.get("serviceType") || "both").toLowerCase();
  const service: ServiceType | "both" = svcParam === "sales" || svcParam === "service" ? svcParam : "both";
  const scope = (searchParams.get("scope") || "window").toLowerCase();
  // The host scopes the iframe with ?enterprise_id=&team_id=. Honor it; else the lib decodes it from the token.
  const enterpriseId = searchParams.get("enterprise_id") || undefined;
  // Drill-down agent (report slot id). Maps to the agent_type whose booked leads we list, so an inbound
  // agent's modal shows only inbound appointments. Omitted on the rooftop-wide (Overview) drill.
  const agentType = SLOT_TO_AGENT_TYPE[searchParams.get("agent_type") || ""];

  // TOP VEHICLES OF INTEREST — AI-booked appointments over a trailing window, grouped by vehicle.
  // This is the single source for the daily digest's "Top vehicles" section: rather than the digest
  // running its own ClickHouse query (a second source of truth that can drift), it reads this. Same
  // meetings basis as every other appointment number here, so the two reports always agree.
  //   ?scope=top-vehicles&team_id=&enterprise_id=[&serviceType=sales|service][&days=30][&limit=5]
  if (scope === "top-vehicles") {
    const windowDays = Math.max(1, Math.min(180, Number(searchParams.get("days")) || 30));
    const limit = Math.max(1, Math.min(20, Number(searchParams.get("limit")) || 5));
    const now = Date.now();
    // Prefer the Supabase snapshot (no live-API dependency). Fall back to the live meetings API only when
    // the snapshot is unavailable/empty (e.g. before the first sync).
    const sbVeh = await sbTopVehicles(teamId, service, new Date(now - windowDays * 86_400_000).toISOString(), limit);
    if (sbVeh && sbVeh.length) {
      return Response.json(
        { vehicles: sbVeh, total: sbVeh.length, window: { days: windowDays } },
        { headers: { "Cache-Control": "s-maxage=300, stale-while-revalidate=600" } },
      );
    }
    // Wide meeting-time window so a meeting booked in-period but scheduled outside it still counts;
    // bookedStart/End then keep only the ones BOOKED in the trailing window (createdAt). Mirrors the
    // booked-in-period drill-down logic above.
    const result = await fetchMeetings({
      teamId,
      service,
      startISO: new Date(now - windowDays * 86_400_000).toISOString(),
      endISO: new Date(now + BOOKED_LOOKAHEAD_DAYS * 86_400_000).toISOString(),
      bookedStartISO: new Date(now - windowDays * 86_400_000).toISOString(),
      bookedEndISO: new Date(now + 86_400_000).toISOString(), // through end of today
      enterpriseId,
      token: spyneToken,
    });
    const counts = new Map<string, number>();
    for (const m of result.meetings) {
      const name = (m.vehicle || "").trim();
      if (name) counts.set(name, (counts.get(name) || 0) + 1);
    }
    const vehicles = [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
    return Response.json(
      { vehicles, total: vehicles.length, window: { days: windowDays } },
      { headers: { "Cache-Control": "s-maxage=300, stale-while-revalidate=600" } },
    );
  }

  let startISO: string;
  let endISO: string;
  let sortOrder: "asc" | "desc";
  let bookedStartISO: string | undefined;
  let bookedEndISO: string | undefined;
  let leadIds: string[] | undefined;

  if (scope === "upcoming") {
    // From now forward — soonest first. (new Date() is fine in a route; not a workflow.)
    const now = new Date();
    const horizon = new Date(now.getTime() + UPCOMING_HORIZON_DAYS * 86_400_000);
    startISO = now.toISOString();
    endISO = horizon.toISOString();
    sortOrder = "asc";
  } else {
    // Drill-down: the leads behind "Appointments booked · {period}". The count means *booked in the
    // period*, but the API filters by meeting_start_time — so we query a wide meeting-time window
    // (period start → +1yr; a meeting can't start before it was booked) and then keep the ones whose
    // booking date (createdAt) falls in the period. This way an appointment booked now for a future
    // date still shows, and the list isn't empty just because the meetings are scheduled ahead.
    const startQ = searchParams.get("start");
    const endQ = searchParams.get("end");
    let start: string;
    let end: string;
    if (startQ && endQ) {
      start = startQ;
      end = endQ;
    } else {
      const timezone = await getStoreTimeZone(teamId, spyneToken);
      ({ start, end } = rangeFor((searchParams.get("bucket") as Bucket) ?? "last30", timezone ?? undefined));
    }
    startISO = dayToISO(start);
    endISO = new Date(Date.now() + BOOKED_LOOKAHEAD_DAYS * 86_400_000).toISOString();
    sortOrder = "asc";

    // Preferred: list exactly the leads behind the tile (from agent_lead_days) so the count matches and
    // the inbound/outbound split is honored. Fall back to filtering meetings by booking date when the
    // aggregate is unavailable (older deploy / table missing).
    // Always carry the booked-in-period window too: when the tile counted booked leads but NONE of them
    // match a live meeting record's leadId (the id spaces can diverge for rescheduled/re-keyed leads),
    // fetchMeetings self-heals to this window instead of returning an empty list under a nonzero count —
    // the daily digest's "appointments booked, but no rows" bug.
    bookedStartISO = dayToISO(start);
    bookedEndISO = dayToISO(end);
    const booked = await bookedLeadIds(teamId, agentType, service, start, end);
    if (booked) leadIds = booked;
  }

  // Snapshot-first for the rooftop-wide / serviceType reads (the digest): serve from report_appointments,
  // which has no live-API dependency. The console's inbound/outbound drill-down (agentType set) keeps the
  // live lead-scoped path — the snapshot carries no call-direction split. Falls back to live when empty.
  if (!agentType) {
    const rows = scope === "upcoming"
      ? await sbAppointments(teamId, service, "upcoming", startISO, endISO)
      : await sbAppointments(teamId, service, "window", bookedStartISO as string, bookedEndISO as string);
    if (rows && rows.length) {
      return Response.json({ meetings: rows, total: rows.length }, { headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=120" } });
    }
  }

  const result = await fetchMeetings({ teamId, service, startISO, endISO, sortOrder, bookedStartISO, bookedEndISO, leadIds, enterpriseId, token: spyneToken });
  return Response.json(result, {
    headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=120" },
  });
}
