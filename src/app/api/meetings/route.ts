import { fetchMeetings, type ServiceType } from "@/lib/spyne/meetings";
import { getStoreTimeZone } from "@/lib/spyne/teamContext";
import { rangeFor } from "@/components/reports/liveData";
import type { Bucket } from "@/components/reports/data";

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

  let startISO: string;
  let endISO: string;
  let sortOrder: "asc" | "desc";
  let bookedStartISO: string | undefined;
  let bookedEndISO: string | undefined;

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
    bookedStartISO = dayToISO(start);
    bookedEndISO = dayToISO(end);
    startISO = bookedStartISO;
    endISO = new Date(Date.now() + BOOKED_LOOKAHEAD_DAYS * 86_400_000).toISOString();
    sortOrder = "asc";
  }

  const result = await fetchMeetings({ teamId, service, startISO, endISO, sortOrder, bookedStartISO, bookedEndISO, enterpriseId, token: spyneToken });
  return Response.json(result, {
    headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=120" },
  });
}
