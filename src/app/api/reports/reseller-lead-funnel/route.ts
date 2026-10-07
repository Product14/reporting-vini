/* Reseller lead funnel for MANY rooftops in one call — authenticated, NOT team-scoped.
 *
 *   GET /api/reports/reseller-lead-funnel?team_ids=t1,t2,t3&bucket=lifetime&env=prod
 *   (also accepts start=YYYY-MM-DD&end=YYYY-MM-DD instead of bucket, and `team_id` as an alias of `team_ids`)
 *
 * WHY THIS EXISTS. GET /api/reports authorizes with requireTeamAuth: the team_id in the query must equal
 * the team scope baked into the bearer token, so a reseller / partner / enterprise session can only ever
 * read the one rooftop its token names — change team_id and it 403s. The partner and enterprise home need
 * the funnel for every rooftop under them, so this route asks a different question: "is this a live,
 * logged-in Spyne session?" — the same isAuth check spyne-console-backend runs on every call (a live
 * user-management /v1/user/validate-user) — and does NOT ask "may this session see this team".
 *
 * AUTH. Live validate-user against the Spyne API for the request's env. Not the unsigned-token decode that
 * requireTeamAuth uses: that check trusts a self-asserted claim, and with the team match removed it would
 * let a hand-built base64 blob read every rooftop. 401 = missing/rejected session; 503 = the auth service
 * itself is unreachable (never reported as 401, so a caller doesn't log the user out over an outage).
 *
 * DATA. Per team, the leadFunnel of each agent and nothing else — counts only, none of the customer rows
 * (names, phones, appointments) the full report carries. Computed by lib/reports/leadFunnel.ts: the same
 * buildResult the report uses, fed only the inputs that decide leadFunnel (the Supabase aggregate, the
 * window-distinct lead counts and the sales canonical overview) — not the whole report page, which is
 * 40-60s cold per rooftop. The caller's own Spyne token is used for the canonical call.
 *
 * SHAPE.
 *   { bucket, start?, end?, teams: { "<team_id>": { ok: true, degraded: boolean,
 *                                                  totals: { connected, qualified },
 *                                                  agents: [{ id, leadFunnel }] }
 *                                                 | { ok: false, status, error } } }
 * `totals` is what the partner dashboard shows as Vini "Leads contacted" (= leadFunnel.connected) and "Leads
 * qualified" (= leadFunnel.qualified), each summed over the rooftop's agents exactly as the console's Vini home
 * sums them (useCoreIntegrationStats), so the two screens agree. `agents` is unchanged.
 * One failing team never fails the call; it comes back as { ok: false } under its own key. */
import { leadFunnelFor } from "@/lib/reports/leadFunnel";
import { readBearer } from "@/lib/reports/auth";
import { apiBaseForEnv } from "@/lib/spyne/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Per team: 3 Supabase reads + ONE sales canonical call. The canonical fetchers share a gate of two per
// instance, so cold teams beyond the first two queue behind each other — keep the batch inside this.
export const maxDuration = 60;

const MAX_TEAMS = 25;
const CONCURRENCY = 5;
const TEAM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BUCKET = /^[A-Za-z0-9_]{1,32}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

type AuthCheck = { ok: true } | { ok: false; status: 401 | 503; error: string };

/* isAuth: is this a live Spyne session? Mirrors spyne-console-backend/api/policies/isAuth.js — a 2xx with
 * error:false from validate-user is a yes; the service answering 401/403 is a no; anything else (network,
 * timeout, 5xx) is "could not check", surfaced as 503. */
async function isAuth(token: string, env: string | null): Promise<AuthCheck> {
  try {
    const r = await fetch(`${apiBaseForEnv(env)}/user-management/v1/user/validate-user`, {
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (r.status === 401 || r.status === 403) return { ok: false, status: 401, error: "invalid or expired session" };
    if (!r.ok) return { ok: false, status: 503, error: `auth service returned HTTP ${r.status}` };
    const body = (await r.json().catch(() => null)) as { error?: unknown } | null;
    if (!body || body.error) return { ok: false, status: 401, error: "invalid or expired session" };
    return { ok: true };
  } catch (e) {
    return { ok: false, status: 503, error: `auth service unreachable: ${e instanceof Error ? e.message : String(e)}` };
  }
}

type FunnelAgent = { id: string; leadFunnel: unknown };
type FunnelTotals = { connected: number; qualified: number };
type TeamResult =
  | { ok: true; degraded: boolean; totals: FunnelTotals; agents: FunnelAgent[] }
  | { ok: false; status: number; error: string };

const count = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/* connected / qualified summed over the agents; a missing figure counts as 0. */
function totalsOf(agents: FunnelAgent[]): FunnelTotals {
  let connected = 0;
  let qualified = 0;
  for (const a of agents) {
    const f = a.leadFunnel as { connected?: unknown; qualified?: unknown } | null;
    connected += count(f?.connected);
    qualified += count(f?.qualified);
  }
  return { connected, qualified };
}

async function funnelFor(teamId: string, token: string, params: URLSearchParams): Promise<TeamResult> {
  const env = params.get("env");
  try {
    const { degraded, agents } = await leadFunnelFor({
      teamId,
      token,
      env: env === "uat" || env === "stag" || env === "prod" ? env : null,
      bucket: params.get("bucket"),
      start: params.get("start"),
      end: params.get("end"),
    });
    return { ok: true, degraded, totals: totalsOf(agents), agents };
  } catch (e) {
    console.error(`[/api/reports/reseller-lead-funnel] team ${teamId} failed: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, status: 500, error: "failed to build funnel" };
  }
}

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);

  const raw = searchParams.get("team_ids") ?? searchParams.get("team_id") ?? "";
  const teamIds = Array.from(new Set(raw.split(",").map((s) => s.trim()).filter(Boolean)));
  if (teamIds.length === 0) return Response.json({ error: "team_ids is required (comma-separated)" }, { status: 400 });
  if (teamIds.length > MAX_TEAMS) return Response.json({ error: `at most ${MAX_TEAMS} team_ids per request` }, { status: 400 });
  const badId = teamIds.find((t) => !TEAM_ID.test(t));
  if (badId !== undefined) return Response.json({ error: "team_ids contains an invalid id" }, { status: 400 });

  const start = searchParams.get("start");
  const end = searchParams.get("end");
  const bucket = searchParams.get("bucket");
  if ((start || end) && !(start && end && DAY.test(start) && DAY.test(end))) {
    return Response.json({ error: "start and end must both be YYYY-MM-DD" }, { status: 400 });
  }
  if (!start && !bucket) return Response.json({ error: "bucket (or start and end) is required" }, { status: 400 });
  if (bucket && !BUCKET.test(bucket)) return Response.json({ error: "invalid bucket" }, { status: 400 });

  const token = readBearer(request);
  if (!token) return Response.json({ error: "authentication required" }, { status: 401 });

  const envParam = searchParams.get("env");
  const auth = await isAuth(token, envParam === "uat" || envParam === "stag" || envParam === "prod" ? envParam : null);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const teams: Record<string, TeamResult> = {};
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, teamIds.length) }, async () => {
      while (next < teamIds.length) {
        const teamId = teamIds[next++];
        teams[teamId] = await funnelFor(teamId, token, searchParams);
      }
    }),
  );

  return Response.json({
    ...(bucket ? { bucket } : {}),
    ...(start && end ? { start, end } : {}),
    teams: Object.fromEntries(teamIds.map((t) => [t, teams[t]])),
  });
}
