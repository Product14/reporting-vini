/* Rooftop × agent usage — one row per (rooftop, agent) for a rolling window, answering exactly three
 * questions: how many leads did this agent touch, how many did it qualify, how many appointments did
 * it book.
 *
 *   GET  /api/reports/agent-usage?teamIds=t1,t2&days=30&page=1&pageSize=25
 *   POST /api/reports/agent-usage  { teamIds:[], enterpriseIds:[], agentTypes:[], days, page, pageSize,
 *                                    start, end, includeTest, includeTeamTotals }
 *
 * Deliberately SEPARATE from /api/reports/bulk rather than a groupBy on it: /bulk is a director-facing
 * rooftop scorecard (calls answered, avg duration, MoM growth) whose response shape external callers
 * already consume. This route is the agent-grain usage grid and is free to evolve on its own.
 *
 * AUTH — SERVICE ONLY, identical to /bulk. A dealer's Spyne session token is scoped to a single team and
 * can never authorize a cross-tenant read, so the accepted credentials are the read-only BULK_API_KEY or
 * the CRON_SECRET (`Authorization: Bearer <key>` or `?key=<key>`). See requireBulkAuth.
 *
 * DATA SOURCE. `agent_lead_days` in the Supabase aggregate — the canonical lead-day grain, already
 * materialized by the sync from the ClickHouse spine (agentBaseFact.sql). It is keyed
 * (team_id, agent_type, lead_id, activity_day) with boolean qualified/appointment columns, so all three
 * metrics are window-DISTINCT counts over one read. Summing agent_daily's per-day distincts instead
 * would over-count any lead worked on more than one day. The enterprise_id↔team_id map and the display
 * names come from ClickHouse (eventila.enterprise_team_details); the Supabase aggregate carries only an
 * enterprise_NAME, never the id.
 *
 * DEFINITIONS (canonical — same rules the console and the digest apply):
 *   Touched leads     = distinct leads with ≥1 AI touch (call, SMS or web chat) in the window. A row
 *                       lands in agent_lead_days for EVERY conversation the spine emits with a lead_id,
 *                       regardless of channel or whether anyone answered. Note these are the dealer's
 *                       OWN leads that the AI worked — nothing is generated, so this is not a
 *                       lead-generation number. (/bulk calls the same quantity `leadsGenerated`.)
 *   Qualified leads   = distinct leads qualified in the window, per the canonical PER-AGENT rule the
 *                       spine applies: Sales Outbound → the campaign-outcome rule; Sales Inbound → the
 *                       AI's own verdict (report.qualified / the conversationAnalytics allowlist);
 *                       Service → intent match. The rules differ by agent BY DESIGN.
 *                       ⚠️ Qualified is NOT nested inside connected on Sales Inbound — it is a model
 *                       verdict, not a transcript test, and ~3% of qualified leads never engaged. Never
 *                       build a turn rate or a "share of conversations" on this column; it can exceed
 *                       100% and the chart will look broken because the metric, not the data, is.
 *   Appointments      = distinct AI-booked appointment leads (meetings.source='spyne', warm_transfer
 *                       rows already excluded upstream in the spine). AI-ASSISTED (CRM) appointments are
 *                       a separate, smaller metric and are deliberately NOT folded in here.
 *
 * WINDOW. `days=N` → rolling [today−N, today), default 30. Today is EXCLUDED: a partial day drags every
 * rate down and makes the number non-comparable from one pull to the next — the same [today−30, today)
 * convention the canonical metric spec locks. "Today" is anchored to each rooftop's own persisted
 * timezone (team_tz) so a Pacific rooftop's window doesn't start 7-8 hours early off UTC. Explicit
 * start/end override `days` and are taken as-is (the caller already chose unambiguous calendar dates).
 *
 * ROLL-UP. Counts are set-UNIONS on lead_id, so a lead worked by two agents counts once per agent but
 * ONCE overall. Summing the agent rows therefore OVER-counts the rooftop; ask for
 * `includeTeamTotals=true` to get the correctly de-duplicated rooftop line instead of adding them up.
 *
 * SCALE. Paginate FIRST on the deterministic (enterprise_id, team_id) rooftop universe, then read
 * metrics only for that page's rooftops — O(pageSize) per request regardless of fleet size. `total` and
 * `totalPages` therefore count ROOFTOPS, while `data` carries one row per (rooftop, agent); read
 * `rowCount` for the number of rows actually returned.
 */
import { getSupabase, AGENT_LEAD_DAYS } from "@/lib/reports/supabase";
import { requireBulkAuth } from "@/lib/reports/auth";
import { resolveTeams, type TeamMeta } from "@/lib/spyne/enterpriseTeams";
import { loadTzMap } from "@/lib/reports/tzStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// The four canonical agent labels the spine emits (see lib/reports/build.ts AGENT_TYPE_BY_ID).
const AGENT_TYPES = ["Sales Inbound", "Sales Outbound", "Service Inbound", "Service Outbound"] as const;
const DEFAULT_DAYS = 30;

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

interface Params {
  enterpriseIds: string[];
  teamIds: string[];
  agentTypes: string[] | null; // null = every agent type; [] = filter given but nothing matched
  days: number;
  start: string | null;
  end: string | null;
  page: number;
  pageSize: number;
  includeTest: boolean;
  includeTeamTotals: boolean;
}

// ── date helpers (UTC calendar) ──────────────────────────────────────────────
function ymd(d: Date): string { return d.toISOString().slice(0, 10); }
function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
}
// "Today" in a given IANA zone (falls back to UTC when tz is unknown) — same technique /api/reports and
// /api/reports/bulk use, so all three agree on the day boundary for the same rooftop.
function todayInTz(tz?: string): string {
  const now = new Date();
  if (!tz) return ymd(now);
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now); }
  catch { return ymd(now); }
}
/** The half-open [start, end) window for one rooftop. Explicit dates win; otherwise rolling `days`. */
function windowFor(p: Params, tz?: string): { start: string; end: string } {
  if (p.start && p.end) return { start: p.start, end: p.end };
  const today = todayInTz(tz);
  return { start: addDays(today, -p.days), end: today };
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
function mergeIds(a: string[], b: string[]): string[] { return [...new Set([...a, ...b])]; }
function clampPage(v: unknown): number { return Math.max(1, Math.floor(Number(v) || 1)); }
function clampSize(v: unknown): number { return Math.max(1, Math.min(200, Math.floor(Number(v) || 25))); }
function normDate(v: unknown): string | null { const s = String(v ?? "").trim(); return isDate(s) ? s : null; }
function isTrue(v: unknown): boolean { return v === true || String(v ?? "").toLowerCase() === "true"; }
// Rolling-window length. Absent/garbage → the 30-day default. Capped at 365 so a typo can't ask the
// lead-day reader to page through a multi-year span nobody intended to pay for.
function normDays(v: unknown): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(365, n) : DEFAULT_DAYS;
}
/* Agent-type filter. Matched case-insensitively against the four canonical labels and normalized TO the
 * canonical casing, so `agentTypes=sales outbound` works. Returns null when no filter was asked for; an
 * UNRECOGNIZED label returns [] (match nothing) rather than falling through to "all agents" — silently
 * widening a typo'd filter would answer a Sales question with Service volume folded in. */
function normAgentTypes(raw: string[]): string[] | null {
  if (!raw.length) return null;
  const out = new Set<string>();
  for (const r of raw) {
    const hit = AGENT_TYPES.find((a) => a.toLowerCase() === r.toLowerCase());
    if (hit) out.add(hit);
  }
  return [...out];
}

function fromQuery(url: URL): Params {
  const q = url.searchParams;
  return {
    // Accept both the camelCase plural spelling /bulk uses and the snake_case singular every other
    // route uses (`/api/reports`, `/api/action-items`, …). Getting this wrong parses to [], which
    // resolveTeams() reads as "no restriction" → the entire unscoped fleet, silently and with no error.
    enterpriseIds: mergeIds(csv(q.get("enterpriseIds")), csv(q.get("enterprise_id"))),
    teamIds: mergeIds(csv(q.get("teamIds")), csv(q.get("team_id"))),
    agentTypes: normAgentTypes(mergeIds(csv(q.get("agentTypes")), csv(q.get("agent_type")))),
    days: normDays(q.get("days")),
    start: normDate(q.get("start")),
    end: normDate(q.get("end")),
    page: clampPage(q.get("page")),
    pageSize: clampSize(q.get("pageSize")),
    includeTest: isTrue(q.get("includeTest")),
    includeTeamTotals: isTrue(q.get("includeTeamTotals")),
  };
}
function fromBody(b: Record<string, unknown>): Params {
  return {
    enterpriseIds: mergeIds(asStrArray(b.enterpriseIds), asStrArray(b.enterprise_id)),
    teamIds: mergeIds(asStrArray(b.teamIds), asStrArray(b.team_id)),
    agentTypes: normAgentTypes(mergeIds(asStrArray(b.agentTypes), asStrArray(b.agent_type))),
    days: normDays(b.days),
    start: normDate(b.start),
    end: normDate(b.end),
    page: clampPage(b.page),
    pageSize: clampSize(b.pageSize),
    includeTest: isTrue(b.includeTest),
    includeTeamTotals: isTrue(b.includeTeamTotals),
  };
}

// ── Supabase read ────────────────────────────────────────────────────────────
interface LeadDayRow {
  team_id: string;
  agent_type: string;
  lead_id: string;
  qualified: boolean;
  appointment: boolean;
}

/* Page through a Supabase read in 1000-row slices (the PostgREST default cap would otherwise silently
 * truncate the lead-day grain and quietly under-count every metric here).
 *
 * ⚠️ The caller MUST apply a TOTAL .order() on the table's primary key. `.range(from,to)` compiles to
 * OFFSET/LIMIT, and an unordered OFFSET query has no stable row order between calls — Postgres is free
 * to return page 2 in an order that repeats rows from page 1 and drops others entirely. The dropped
 * rows are silently missing leads, so the distinct counts come back LOW and NON-DETERMINISTIC: the same
 * rooftop and window can answer differently depending only on where the page boundaries happen to land.
 * Ordering on the PK makes each page a disjoint slice of one fixed sequence. */
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

/* Distinct-lead accumulator. Sets (not counters) because the same lead recurs across days and, for the
 * rooftop total, across agents — a union is the only way to count it once. */
interface Acc { touched: Set<string>; qualified: Set<string>; appointments: Set<string> }
function newAcc(): Acc { return { touched: new Set(), qualified: new Set(), appointments: new Set() }; }
function mergeAcc(into: Acc, from: Acc): void {
  from.touched.forEach((v) => into.touched.add(v));
  from.qualified.forEach((v) => into.qualified.add(v));
  from.appointments.forEach((v) => into.appointments.add(v));
}
function finalize(a: Acc) {
  return { touchedLeads: a.touched.size, qualifiedLeads: a.qualified.size, appointments: a.appointments.size };
}

async function handle(params: Params): Promise<Response> {
  const hasExplicitWindow = !!(params.start && params.end);

  // 1) Resolve the rooftop universe (with enterprise_id + names) from ClickHouse, sorted deterministically.
  let universe: TeamMeta[];
  try {
    universe = await resolveTeams({
      enterpriseIds: params.enterpriseIds,
      teamIds: params.teamIds,
      includeTest: params.includeTest,
    });
  } catch (e) {
    console.error(`[/api/reports/agent-usage] team resolution failed: ${e instanceof Error ? e.message : String(e)}`);
    universe = [];
  }

  // 2) Paginate on the rooftop universe BEFORE touching any metrics.
  const teamMeta = new Map(universe.map((t) => [t.teamId, t]));
  const teamKeys = universe.map((t) => t.teamId);
  const total = teamKeys.length;
  const totalPages = Math.max(1, Math.ceil(total / params.pageSize));
  const offset = (params.page - 1) * params.pageSize;
  const pageTeams = teamKeys.slice(offset, offset + params.pageSize);

  const base = {
    // Echo the effective scope so a caller can see at a glance what was actually asked of the data.
    agentTypes: params.agentTypes ?? [...AGENT_TYPES],
    window: hasExplicitWindow ? { start: params.start, end: params.end } : { days: params.days, note: "rolling [today−days, today) per rooftop timezone; today excluded" },
    page: params.page,
    pageSize: params.pageSize,
    // These count ROOFTOPS (the paginated unit) — `data` carries one row per (rooftop, agent).
    total,
    totalPages,
    hasMore: params.page < totalPages,
  };

  // A filter was given but matched none of the four canonical labels — answer empty rather than
  // silently reporting every agent under a scope the caller never asked for.
  if (params.agentTypes && params.agentTypes.length === 0) {
    return Response.json(
      { ...base, data: [], rowCount: 0, error: `no recognized agentTypes — expected one of: ${AGENT_TYPES.join(", ")}` },
      { status: 400 },
    );
  }
  if (!pageTeams.length) {
    return Response.json({ ...base, data: [], rowCount: 0, degraded: universe.length === 0 });
  }

  const sb = getSupabase();
  if (!sb) return Response.json({ ...base, data: [], rowCount: 0, degraded: true, note: "supabase not configured" });

  // 3) Resolve each rooftop's window. An explicit start/end is a calendar range the caller already
  //    chose and everyone shares; the DEFAULT rolling window anchors "today" to each rooftop's own
  //    persisted timezone, otherwise "today" is UTC today for a Pacific store too.
  let tzByTeam = new Map<string, string>();
  if (!hasExplicitWindow) {
    try { tzByTeam = await loadTzMap(sb); } catch { /* degrade to UTC via windowFor()'s no-tz branch */ }
  }

  // Group rooftops by their resolved window so we issue one query per DISTINCT window rather than per
  // rooftop — a fleet page realistically spans a handful of US timezones, not hundreds of windows.
  const groups = new Map<string, { start: string; end: string; teams: string[] }>();
  for (const teamId of pageTeams) {
    const w = windowFor(params, tzByTeam.get(teamId));
    const key = `${w.start}|${w.end}`;
    let g = groups.get(key);
    if (!g) { g = { start: w.start, end: w.end, teams: [] }; groups.set(key, g); }
    g.teams.push(teamId);
  }

  // 4) Read the lead-day grain and accumulate at (rooftop, agent).
  const perTeamAgent = new Map<string, Acc>();
  const agentsSeen = new Map<string, Set<string>>(); // team_id → agent types with activity in-window
  const windowByTeam = new Map<string, { start: string; end: string }>();
  const akey = (team: string, agent: string) => `${team} ${agent}`;
  const agentFilter = params.agentTypes ? new Set(params.agentTypes) : null;
  try {
    await Promise.all([...groups.values()].map(async (g) => {
      for (const t of g.teams) windowByTeam.set(t, { start: g.start, end: g.end });
      const rows = await fetchAll<LeadDayRow>((from, to) => {
        let q = sb.from(AGENT_LEAD_DAYS)
          .select("team_id,agent_type,lead_id,qualified,appointment")
          .in("team_id", g.teams)
          .gte("activity_day", g.start).lt("activity_day", g.end);
        if (agentFilter) q = q.in("agent_type", [...agentFilter]);
        // Total order on the agent_lead_days PK — see the fetchAll note. Without it the paged read
        // drops leads and the counts move when unrelated filters change.
        return q.order("team_id").order("agent_type").order("lead_id").order("activity_day").range(from, to);
      });
      for (const r of rows) {
        const k = akey(r.team_id, r.agent_type);
        let a = perTeamAgent.get(k);
        if (!a) { a = newAcc(); perTeamAgent.set(k, a); }
        let seen = agentsSeen.get(r.team_id);
        if (!seen) { seen = new Set(); agentsSeen.set(r.team_id, seen); }
        seen.add(r.agent_type);
        a.touched.add(r.lead_id);
        if (r.qualified) a.qualified.add(r.lead_id);
        if (r.appointment) a.appointments.add(r.lead_id);
      }
    }));
  } catch (e) {
    console.error(`[/api/reports/agent-usage] supabase read failed: ${e instanceof Error ? e.message : String(e)}`);
    return Response.json({ ...base, data: [], rowCount: 0, degraded: true, note: "supabase read error" }, {
      headers: { "X-Reports-Degraded": "supabase-read-error" },
    });
  }

  // 5) Assemble one row per (rooftop, agent) that had activity. A rooftop that never ran a given agent
  //    gets NO row for it rather than a zero row — an all-zero "Service Outbound" line reads as an agent
  //    that ran and produced nothing, which is a different and wrong statement. Agents come back in the
  //    canonical order so the grid is stable across pages and rooftops.
  const data: Record<string, unknown>[] = [];
  for (const teamId of pageTeams) {
    const m = teamMeta.get(teamId);
    const w = windowByTeam.get(teamId);
    const ident = {
      teamId,
      enterpriseId: m?.enterpriseId ?? "",
      teamName: m?.teamName ?? "",
      dealerName: m?.dealerName ?? "",
      windowStart: w?.start ?? "",
      windowEnd: w?.end ?? "",
    };
    const seen = agentsSeen.get(teamId) ?? new Set<string>();
    const known = AGENT_TYPES.filter((a) => seen.has(a) && (!agentFilter || agentFilter.has(a)));
    // Any agent_type the spine emits that isn't one of the four canonical labels still belongs to this
    // rooftop — surface it rather than dropping it silently.
    const extra = [...seen].filter((a) => !(AGENT_TYPES as readonly string[]).includes(a)).sort();
    for (const agentType of [...known, ...extra]) {
      data.push({ ...ident, agentType, ...finalize(perTeamAgent.get(akey(teamId, agentType)) ?? newAcc()) });
    }
    if (params.includeTeamTotals) {
      // De-duplicated rooftop line: a lead worked by two agents counts ONCE here but once under each
      // agent above, so this is deliberately ≤ the sum of that rooftop's agent rows.
      const roll = newAcc();
      for (const agentType of [...known, ...extra]) {
        const a = perTeamAgent.get(akey(teamId, agentType));
        if (a) mergeAcc(roll, a);
      }
      data.push({ ...ident, agentType: "All agents", isTeamTotal: true, ...finalize(roll) });
    }
  }

  return Response.json({ ...base, rowCount: data.length, data }, {
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
