/* Bulk rooftop metrics — director/exec fleet view across many enterprises & rooftops in one paginated
 * call. Answers "Calls Answered · Leads Generated · Appointments Booked · Avg Call Duration ·
 * Lead→Appointment · MoM Growth" per team OR rolled up per enterprise.
 *
 *   GET  /api/reports/bulk?enterpriseIds=e1,e2&teamIds=t1&groupBy=team|enterprise&page=1&pageSize=25
 *   POST /api/reports/bulk   { enterpriseIds:[], teamIds:[], groupBy, page, pageSize, start, end, includeTest }
 *
 * AUTH — SERVICE ONLY. A dealer's Spyne session token is scoped to a single team and can never authorize
 * a cross-tenant read, so the only accepted credential is the shared CRON_SECRET (Authorization: Bearer
 * <secret> or ?key=<key>). Accepts a dedicated read-only BULK_API_KEY or the CRON_SECRET. See requireBulkAuth.
 *
 * DATA SOURCE. Metrics come from the Supabase aggregate (canonical, already materialized):
 *   - agent_lead_days  → WINDOW-DISTINCT lead counts (a lead touched on N days counts ONCE). This is the
 *                        only correct source for "Leads Generated" and "Appointments Booked" over a
 *                        multi-day window; summing agent_daily's per-day distincts would over-count.
 *   - agent_daily      → call-level sums (Σ connected = Calls Answered, Σ talk_seconds for avg duration).
 * The enterprise_id↔team_id map + display names come from ClickHouse (eventila.enterprise_team_details);
 * the Supabase aggregate carries only enterprise_NAME, never the id.
 *
 * SCALE. We paginate FIRST on the deterministic (enterprise_id, team_id) team universe, then fetch
 * metrics ONLY for the page's teams — so each request is O(pageSize) regardless of fleet size. The
 * Supabase reads page through .range() because the default 1000-row cap would otherwise silently
 * truncate the lead-day grain and corrupt the distinct counts.
 *
 * DEFINITIONS (locked with the requester):
 *   Calls Answered      = Σ connected calls in the window.
 *   Leads Generated     = distinct leads worked (any AI touch, call or SMS) in the window.
 *   Appointments Booked = distinct AI-booked appt leads (meetings.source='spyne') in the window.
 *   Avg Call Duration   = Σ talk_seconds ÷ Calls Answered (seconds).
 *   Lead → Appointment  = Appointments Booked ÷ Leads Generated (whole-funnel conversion).
 *   MoM Growth          = % change in Appointments Booked, current calendar-month-to-date vs the aligned
 *                         same-day span of the previous calendar month. (Custom start/end → the
 *                         immediately-preceding equal-length window.)
 */
import { getSupabase, AGENT_DAILY, AGENT_LEAD_DAYS } from "@/lib/reports/supabase";
import { requireBulkAuth } from "@/lib/reports/auth";
import { resolveTeams, type TeamMeta } from "@/lib/spyne/enterpriseTeams";
import { loadTzMap } from "@/lib/reports/tzStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

type GroupBy = "team" | "enterprise";

interface Params {
  enterpriseIds: string[];
  teamIds: string[];
  groupBy: GroupBy;
  page: number;
  pageSize: number;
  start: string | null;
  end: string | null;
  includeTest: boolean;
}

// ── date helpers (UTC calendar) ──────────────────────────────────────────────
function ymd(d: Date): string { return d.toISOString().slice(0, 10); }
function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
}
function monthStart(day: string): string { return `${day.slice(0, 7)}-01`; }
function daysBetween(a: string, b: string): number {
  return Math.max(0, Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000));
}
// "Today" in a given IANA zone (falls back to UTC when tz is unknown) — same technique
// /api/reports uses (components/reports/liveData.ts todayIn) so the two routes' default
// "today"/MTD boundary agree for the same rooftop instead of one reading UTC and the other local.
function todayInTz(tz?: string): string {
  const now = new Date();
  if (!tz) return ymd(now);
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now); }
  catch { return ymd(now); }
}

/* The current metrics window and the MoM comparison window.
 *  - No explicit dates → current calendar-month-to-date [monthStart(today), today+1), and the prior
 *    window is the ALIGNED same-day span at the start of the previous calendar month. "Today" is
 *    anchored to `tz` when given (a rooftop's persisted timezone) — otherwise UTC.
 *  - Explicit start/end → taken as-is (the caller already gave unambiguous calendar dates, so no
 *    timezone anchoring is needed); prior = the immediately-preceding equal-length window. */
function windows(startQ: string | null, endQ: string | null, tz?: string): {
  cur: { start: string; end: string };
  prior: { start: string; end: string };
} {
  if (startQ && endQ) {
    const n = Math.max(1, daysBetween(startQ, endQ));
    return { cur: { start: startQ, end: endQ }, prior: { start: addDays(startQ, -n), end: startQ } };
  }
  const today = todayInTz(tz);
  const curStart = monthStart(today);
  const curEnd = addDays(today, 1); // include today (exclusive upper bound)
  const elapsed = daysBetween(curStart, curEnd);
  const priorStart = monthStart(addDays(curStart, -1)); // first of previous month
  const priorEnd = addDays(priorStart, elapsed); // aligned same-day span, month-over-month to date
  return { cur: { start: curStart, end: curEnd }, prior: { start: priorStart, end: priorEnd } };
}

// ── param parsing (GET query OR POST JSON body) ──────────────────────────────
function csv(v: string | null): string[] {
  return (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}
function asStrArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string") return csv(v);
  return [];
}
function clampPage(v: unknown): number { return Math.max(1, Math.floor(Number(v) || 1)); }
function clampSize(v: unknown): number { return Math.max(1, Math.min(200, Math.floor(Number(v) || 25))); }
function normDate(v: unknown): string | null { const s = String(v ?? "").trim(); return isDate(s) ? s : null; }

// Dedupe-merge two id lists (case as-is, ids are opaque).
function mergeIds(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}
function fromQuery(url: URL): Params {
  const gb = url.searchParams.get("groupBy") === "enterprise" ? "enterprise" : "team";
  return {
    // Every sibling route (`/api/reports`, `/api/action-items`, `/api/conversations`, …) uses
    // `team_id`/`enterprise_id` (snake_case) — this route alone used `teamIds`/`enterpriseIds`
    // (camelCase, plural). A caller using the dominant convention got BOTH parsed to [], which
    // resolveTeams() treats as "no restriction" → the entire unscoped fleet, silently, with no
    // error. Accept both spellings (each may be a CSV of one or more ids).
    enterpriseIds: mergeIds(csv(url.searchParams.get("enterpriseIds")), csv(url.searchParams.get("enterprise_id"))),
    teamIds: mergeIds(csv(url.searchParams.get("teamIds")), csv(url.searchParams.get("team_id"))),
    groupBy: gb,
    page: clampPage(url.searchParams.get("page")),
    pageSize: clampSize(url.searchParams.get("pageSize")),
    start: normDate(url.searchParams.get("start")),
    end: normDate(url.searchParams.get("end")),
    includeTest: url.searchParams.get("includeTest") === "true",
  };
}
function fromBody(b: Record<string, unknown>): Params {
  return {
    // Same dual-convention acceptance as fromQuery above.
    enterpriseIds: mergeIds(asStrArray(b.enterpriseIds), asStrArray(b.enterprise_id)),
    teamIds: mergeIds(asStrArray(b.teamIds), asStrArray(b.team_id)),
    groupBy: b.groupBy === "enterprise" ? "enterprise" : "team",
    page: clampPage(b.page),
    pageSize: clampSize(b.pageSize),
    start: normDate(b.start),
    end: normDate(b.end),
    includeTest: b.includeTest === true,
  };
}

// ── Supabase reads (page through the 1000-row cap so distinct counts stay exact) ──────────────
interface LeadDayRow { team_id: string; lead_id: string; activity_day: string; appointment: boolean }
interface DailyRow { team_id: string; connected: number; talk_seconds: number }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: any; error: any }>): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw error;
    const batch = (data ?? []) as T[];
    out.push(...batch);
    if (batch.length < PAGE) break;
  }
  return out;
}

// Per-team accumulator over the fetched window.
interface Acc {
  callsAnswered: number;
  talkSeconds: number;
  leadsWorked: Set<string>;
  apptLeadsCur: Set<string>;
  apptLeadsPrior: Set<string>;
}
function newAcc(): Acc {
  return { callsAnswered: 0, talkSeconds: 0, leadsWorked: new Set(), apptLeadsCur: new Set(), apptLeadsPrior: new Set() };
}

interface Metrics {
  callsAnswered: number;
  leadsGenerated: number;
  appointmentsBooked: number;
  appointmentsPrior: number;
  avgCallDurationSec: number;
  leadToAppointmentPct: number | null; // null when no leads (avoid a misleading rounded 0%)
  momGrowthPct: number | null;         // null when prior=0 (growth undefined)
}
function finalize(a: Acc): Metrics {
  const calls = a.callsAnswered;
  const leads = a.leadsWorked.size;
  const appts = a.apptLeadsCur.size;
  const prior = a.apptLeadsPrior.size;
  return {
    callsAnswered: calls,
    leadsGenerated: leads,
    appointmentsBooked: appts,
    appointmentsPrior: prior,
    avgCallDurationSec: calls > 0 ? Math.round(a.talkSeconds / calls) : 0,
    leadToAppointmentPct: leads > 0 ? Math.round((appts / leads) * 1000) / 10 : null,
    momGrowthPct: prior > 0 ? Math.round(((appts - prior) / prior) * 1000) / 10 : null,
  };
}
function mergeAcc(into: Acc, from: Acc): void {
  into.callsAnswered += from.callsAnswered;
  into.talkSeconds += from.talkSeconds;
  from.leadsWorked.forEach((v) => into.leadsWorked.add(v));
  from.apptLeadsCur.forEach((v) => into.apptLeadsCur.add(v));
  from.apptLeadsPrior.forEach((v) => into.apptLeadsPrior.add(v));
}

async function handle(params: Params): Promise<Response> {
  const hasExplicitWindow = !!(params.start && params.end);
  const { cur, prior } = windows(params.start, params.end); // UTC reference — also the reported meta.window
  const meta = { window: { current: cur, prior } };

  // 1) Resolve the team universe (with enterprise_id + names) from ClickHouse, sorted deterministically.
  let universe: TeamMeta[];
  try {
    universe = await resolveTeams({
      enterpriseIds: params.enterpriseIds,
      teamIds: params.teamIds,
      includeTest: params.includeTest,
    });
  } catch (e) {
    console.error(`[/api/reports/bulk] team resolution failed: ${e instanceof Error ? e.message : String(e)}`);
    universe = [];
  }

  // 2) Build the group list (teams, or enterprises rolled up) and paginate BEFORE touching metrics.
  const teamMeta = new Map(universe.map((t) => [t.teamId, t]));
  let groupKeys: string[];
  if (params.groupBy === "enterprise") {
    const seen = new Set<string>();
    groupKeys = [];
    for (const t of universe) if (t.enterpriseId && !seen.has(t.enterpriseId)) { seen.add(t.enterpriseId); groupKeys.push(t.enterpriseId); }
  } else {
    groupKeys = universe.map((t) => t.teamId);
  }
  const total = groupKeys.length;
  const totalPages = Math.max(1, Math.ceil(total / params.pageSize));
  const offset = (params.page - 1) * params.pageSize;
  const pageKeys = groupKeys.slice(offset, offset + params.pageSize);

  // Teams whose metrics we actually need this page.
  const pageTeamSet = params.groupBy === "enterprise"
    ? new Set(universe.filter((t) => pageKeys.includes(t.enterpriseId)).map((t) => t.teamId))
    : new Set(pageKeys);
  const pageTeams = [...pageTeamSet];

  const base = {
    ...meta,
    groupBy: params.groupBy,
    page: params.page,
    pageSize: params.pageSize,
    total,
    totalPages,
    hasMore: params.page < totalPages,
  };

  if (!pageTeams.length) {
    return Response.json({ ...base, data: [], degraded: universe.length === 0 });
  }

  const sb = getSupabase();
  if (!sb) return Response.json({ ...base, data: [], degraded: true, note: "supabase not configured" });

  // 3) Resolve each page team's window. An explicit start/end is an unambiguous calendar range the
  //    caller already chose, shared by everyone. The DEFAULT "month-to-date" window instead anchors
  //    "today" to each rooftop's own persisted timezone (team_tz) — otherwise "today" is always UTC
  //    today, which for a Pacific rooftop can start the month up to 7-8 hours later than /api/reports'
  //    store-local MTD for that same rooftop (the digest-vs-console class of bug).
  let tzByTeam = new Map<string, string>();
  if (!hasExplicitWindow) {
    try { tzByTeam = await loadTzMap(sb); } catch { /* degrade to UTC via windows()'s no-tz branch */ }
  }
  const windowFor = (teamId: string) => (hasExplicitWindow ? { cur, prior } : windows(null, null, tzByTeam.get(teamId)));

  // Group page teams by their resolved window so we issue one query pair per DISTINCT window rather
  // than per team — a fleet page realistically spans a handful of US timezones, not hundreds of teams.
  const groups = new Map<string, { cur: { start: string; end: string }; prior: { start: string; end: string }; teams: string[] }>();
  for (const teamId of pageTeams) {
    const w = windowFor(teamId);
    const key = `${w.cur.start}|${w.cur.end}|${w.prior.start}|${w.prior.end}`;
    let g = groups.get(key);
    if (!g) { g = { cur: w.cur, prior: w.prior, teams: [] }; groups.set(key, g); }
    g.teams.push(teamId);
  }

  // 4) Fetch + accumulate per group. One lead-day read spanning [min(start), max(end)) covers both
  //    windows for that group; one daily read over the group's current window covers the call sums.
  const perTeam = new Map<string, Acc>();
  const accOf = (t: string): Acc => { let a = perTeam.get(t); if (!a) { a = newAcc(); perTeam.set(t, a); } return a; };
  try {
    await Promise.all([...groups.values()].map(async (g) => {
      const ldStart = g.prior.start < g.cur.start ? g.prior.start : g.cur.start;
      const ldEnd = g.cur.end > g.prior.end ? g.cur.end : g.prior.end;
      const [leadDays, daily] = await Promise.all([
        fetchAll<LeadDayRow>((from, to) =>
          sb.from(AGENT_LEAD_DAYS)
            .select("team_id,lead_id,activity_day,appointment")
            .in("team_id", g.teams)
            .gte("activity_day", ldStart).lt("activity_day", ldEnd)
            .range(from, to)),
        fetchAll<DailyRow>((from, to) =>
          sb.from(AGENT_DAILY)
            .select("team_id,connected,talk_seconds")
            .in("team_id", g.teams)
            .gte("activity_day", g.cur.start).lt("activity_day", g.cur.end)
            .range(from, to)),
      ]);
      for (const r of leadDays) {
        const a = accOf(r.team_id);
        const day = String(r.activity_day).slice(0, 10);
        const inCur = day >= g.cur.start && day < g.cur.end;
        const inPrior = day >= g.prior.start && day < g.prior.end;
        if (inCur) {
          a.leadsWorked.add(r.lead_id);
          if (r.appointment) a.apptLeadsCur.add(r.lead_id);
        }
        if (inPrior && r.appointment) a.apptLeadsPrior.add(r.lead_id);
      }
      for (const r of daily) {
        const a = accOf(r.team_id);
        a.callsAnswered += Number(r.connected) || 0;
        a.talkSeconds += Number(r.talk_seconds) || 0;
      }
    }));
  } catch (e) {
    console.error(`[/api/reports/bulk] supabase read failed: ${e instanceof Error ? e.message : String(e)}`);
    return Response.json({ ...base, data: [], degraded: true, note: "supabase read error" }, {
      headers: { "X-Reports-Degraded": "supabase-read-error" },
    });
  }

  // 5) Assemble the page rows (roll up to enterprise if requested).
  let data: Record<string, unknown>[];
  if (params.groupBy === "enterprise") {
    data = pageKeys.map((entId) => {
      const teams = universe.filter((t) => t.enterpriseId === entId);
      const roll = newAcc();
      for (const t of teams) { const a = perTeam.get(t.teamId); if (a) mergeAcc(roll, a); }
      return {
        // No enterprise-level display name is reliably joinable to enterprise_team_details.enterprise_id
        // (eventila.enterprise_account uses a different id space), so the enterpriseId IS the identifier;
        // teamNames carries the member rooftops for a human-readable roll-up rather than misrepresenting
        // a multi-rooftop group with a single rooftop's name.
        enterpriseId: entId,
        teamCount: teams.length,
        teamNames: teams.map((t) => t.teamName).filter(Boolean),
        ...finalize(roll),
      };
    });
  } else {
    data = pageKeys.map((teamId) => {
      const m = teamMeta.get(teamId);
      return {
        teamId,
        enterpriseId: m?.enterpriseId ?? "",
        teamName: m?.teamName ?? "",
        dealerName: m?.dealerName ?? "",
        ...finalize(perTeam.get(teamId) ?? newAcc()),
      };
    });
  }

  return Response.json({ ...base, data }, {
    headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=120" },
  });
}

export async function GET(request: Request): Promise<Response> {
  const auth = requireBulkAuth(request);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  return handle(fromQuery(new URL(request.url)));
}

export async function POST(request: Request): Promise<Response> {
  const auth = requireBulkAuth(request);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  let body: Record<string, unknown> = {};
  try {
    const parsed = await request.json();
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  return handle(fromBody(body));
}
