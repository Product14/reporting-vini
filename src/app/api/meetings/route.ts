import { fetchMeetings, type ServiceType } from "@/lib/spyne/meetings";
import { getStoreTimeZone } from "@/lib/spyne/teamContext";
import { getSupabase, AGENT_LEAD_DAYS } from "@/lib/reports/supabase";
import { rangeFor } from "@/components/reports/liveData";
import type { Bucket } from "@/components/reports/data";

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

  // Spyne token: prod forwards it (Authorization header or auth_key/spyne_token/token query param);
  // local dev omits it and the client falls back to SPYNE_API_TOKEN. Strip any "Bearer " prefix.
  const tokenSource = request.headers.get("authorization")
    || searchParams.get("auth_key") || searchParams.get("spyne_token") || searchParams.get("token") || "";
  const spyneToken = tokenSource.replace(/^Bearer\s+/i, "").trim() || null;

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
    const booked = await bookedLeadIds(teamId, agentType, service, start, end);
    if (booked) {
      leadIds = booked;
    } else {
      bookedStartISO = dayToISO(start);
      bookedEndISO = dayToISO(end);
    }
  }

  const result = await fetchMeetings({ teamId, service, startISO, endISO, sortOrder, bookedStartISO, bookedEndISO, leadIds, enterpriseId, token: spyneToken });
  return Response.json(result, {
    headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=120" },
  });
}
