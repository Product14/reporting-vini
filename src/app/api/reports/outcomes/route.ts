/* Conversation-outcome evals for the report — SALES only, one direction per call.
 *
 *   GET /api/reports/outcomes?team_id=&enterprise_id=&dir=inbound|outbound[&bucket=last30|&start=&end=]
 *
 * Server-side wrapper around the Spyne eval-pipeline API (see src/lib/spyne/evalPipeline.ts for why it
 * reads the paginated list endpoint rather than the three dashboard endpoints, and how the window is
 * re-derived from conversation time). Doing it here rather than in the browser keeps the Spyne token
 * server-side, lets the 10-minute cache be shared across page loads, and means the Overview and the
 * By-agent tab hit one URL each.
 *
 * SCOPE: agentType=sales only. Service is intentionally never requested — a Service-scoped report hides
 * these panels rather than showing sales evals (and the eval pipeline's service cohort has its own
 * funnels, which this report doesn't model).
 *
 * Degrades to `{ outcomes: null, degraded: true }` rather than a non-2xx whenever the upstream is
 * unreachable, so a hiccup hides the panel instead of breaking the report. */
import { requireTeamAuth, spyneTokenFrom, spyneEnvFrom } from "@/lib/reports/auth";
import { getStoreTimeZone } from "@/lib/spyne/teamContext";
import { spyneConfigured, cached } from "@/lib/spyne/client";
import { enterpriseIdFromToken } from "@/lib/spyne/meetings";
import { resolveTeams } from "@/lib/spyne/enterpriseTeams";
import { fetchSalesOutcomes, type EvalDirection } from "@/lib/spyne/evalPipeline";
import { rangeFor } from "@/components/reports/liveData";
import type { Bucket } from "@/components/reports/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BUCKETS = new Set<Bucket>(["today", "yesterday", "last7", "last14", "last30", "mtd", "lifetime"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const idOk = (s: string) => /^[A-Za-z0-9_-]{1,64}$/.test(s);

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const teamId = searchParams.get("team_id") || "";
  if (!idOk(teamId)) return Response.json({ error: "valid team_id is required" }, { status: 400 });

  /* Department, not a constant. The eval pipeline scores service conversations too; pinning this to
   * sales meant the Service space could never have a conversation report at all. */
  const svcRaw = (searchParams.get("serviceType") || searchParams.get("service_type") || "sales").toLowerCase();
  const agentType: "sales" | "service" = svcRaw === "service" ? "service" : "sales";

  const dirRaw = (searchParams.get("dir") || "inbound").toLowerCase();
  if (dirRaw !== "inbound" && dirRaw !== "outbound") {
    return Response.json({ error: "dir must be inbound or outbound" }, { status: 400 });
  }
  const dir = dirRaw as EvalDirection;

  // Same auth choke point as the other per-event routes: a Spyne session token scoped to this team, or
  // the service secret. Eval rows carry conversation summaries, so this is not public.
  const auth = requireTeamAuth(request, teamId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const token = spyneTokenFrom(request);
  const env = spyneEnvFrom(request);
  // No Spyne credential → nothing to call. Loud `degraded` so a missing token reads as "unavailable",
  // never as "this rooftop has no scored conversations".
  if (!spyneConfigured(token)) {
    return Response.json({ outcomes: null, degraded: true, note: "spyne api not configured" });
  }

  /* ENTERPRISE RESOLUTION — the eval API needs enterpriseId, but the console does not always put it on
   * the iframe URL (a By-agent deep link is routinely just ?team_id=&serviceType=&agent=). Requiring the
   * param made the panels silently absent on any such URL. Resolution ladder:
   *   1. ?enterprise_id= when the host forwarded it,
   *   2. eventila.enterprise_team_details keyed by THIS team_id — authoritative, and verified to match
   *      the enterpriseId the eval documents themselves carry (49a06313cf→7d06f7427, eba56ec9aa→aa323b917),
   *   3. decoded from the Spyne session token, last resort for when ClickHouse creds are absent.
   *
   * The team map deliberately OUTRANKS the token. The token names the enterprise of whoever is holding
   * it, which is not necessarily the enterprise that owns the rooftop being read — a back-office/cron
   * caller, or a local env token, resolves an enterprise the team doesn't belong to, and the eval query
   * then returns nothing at all (observed locally: token said 06e65fbde for a 7d06f7427 rooftop).
   * requireTeamAuth has already authorized this team_id, so deriving its enterprise widens nothing. */
  const paramEnt = searchParams.get("enterprise_id") || "";
  let enterpriseId = idOk(paramEnt) ? paramEnt : "";
  if (!enterpriseId) {
    // A rooftop never changes enterprise; cache it (10 min, shared TTL cache) so the two per-page
    // requests — and every subsequent page load — don't each pay a ClickHouse round-trip.
    enterpriseId = (await cached(`ent:${teamId}`, async () => {
      const [meta] = await resolveTeams({ teamIds: [teamId], includeTest: true });
      return meta?.enterpriseId || null;
    })) || "";
  }
  if (!idOk(enterpriseId)) enterpriseId = (enterpriseIdFromToken(token) || "").trim();
  if (!idOk(enterpriseId)) {
    return Response.json({ outcomes: null, degraded: true, note: "enterprise_id could not be resolved for this team" });
  }

  // Window: explicit start/end (exclusive end, as the rest of the report passes it) wins; otherwise
  // resolve the preset bucket in the ROOFTOP's timezone so "last 7 days" is the dealer's last 7 days —
  // the same resolution /api/conversations and /api/reports use.
  const startRaw = searchParams.get("start") || "";
  const endRaw = searchParams.get("end") || "";
  let start = DATE_RE.test(startRaw) ? startRaw : "";
  let end = DATE_RE.test(endRaw) ? endRaw : "";
  if (!start || !end) {
    const bucketRaw = (searchParams.get("bucket") || "last30") as Bucket;
    const bucket = BUCKETS.has(bucketRaw) ? bucketRaw : "last30";
    const tz = await getStoreTimeZone(teamId, token, env);
    const r = rangeFor(bucket, tz ?? undefined);
    start = r.start;
    end = r.end;
  }

  try {
    const outcomes = await fetchSalesOutcomes(
      { enterpriseId, teamId, dir, agentType, startISO: `${start}T00:00:00.000Z`, endISO: `${end}T00:00:00.000Z` },
      token,
      env,
    );
    if (!outcomes) return Response.json({ outcomes: null, degraded: true, note: "eval api unavailable" });
    return Response.json({ outcomes, window: { start, end }, degraded: false });
  } catch (e) {
    console.error(`[outcomes] ${teamId}/${dir} failed: ${e instanceof Error ? e.message : String(e)}`);
    return Response.json({ outcomes: null, degraded: true, note: "eval fetch failed" });
  }
}
