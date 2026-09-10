import { getSupabase, AGENT_DAILY, AGENT_DAILY_BREAKDOWN, REPORT_CALLBACKS, REPORT_CAMPAIGNS, REPORT_OUTCOMES, REPORT_APPOINTMENTS, REPORT_WARM_LEADS, SYNC_STATE } from "@/lib/reports/supabase";
import { buildResult, AGENT_TYPE_BY_ID } from "@/lib/reports/build";
import type { AgentDailyRow, BreakdownRow, CallbackRow, CampaignRow, OutcomeRow, ReportAppointmentRow, WarmLeadRow } from "@/lib/reports/schema";
import { assistedApptLeads, assistedInWindow } from "@/lib/reports/assistedAppts";
import { fetchLiveAppointments, countByAgent } from "@/lib/reports/liveAppointments";
import { rangeFor } from "@/components/reports/liveData";
import type { Bucket } from "@/components/reports/data";
import { getStoreTimeZone, getOnboardedSlots, getOnboardedNames, getOnboardedPhotos } from "@/lib/spyne/teamContext";
import { requireTeamAuth, spyneTokenFrom, spyneEnvFrom } from "@/lib/reports/auth";
// Same helper the ETL buckets agent_daily / agent_lead_days with, so the appointment LIST is windowed
// in the identical day space as the COUNTS shown above it.
import { storeLocalDay } from "@/lib/reports/tzMap";

/* Reads the materialized aggregate from Supabase and returns the same FetchResult the reporting UI
 * already consumes — one fast query instead of the ~84 Metabase round-trips fetchAgents() used to do.
 * Falls back to all-mock agents (buildResult does this) when Supabase is unconfigured or empty.
 *
 * Round-trips per call are kept minimal (was ~11, now ~4): agent_daily is read ONCE across the
 * combined [prior.start, end) range and split in-memory; the six report_* detail tables come back in
 * ONE report_detail() rpc; and both lead-count windows come from ONE report_lead_counts_2() rpc. Each
 * rpc degrades to the prior multi-read behavior on error, so an un-migrated DB still works. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A cold invocation cold-starts the function AND opens a fresh Supabase connection before running five
// sequential round-trips (readFacts → detail + lead-counts + source-counts + ever-live). Under Vercel's
// short default timeout that cold path can 504, which the client can't distinguish from "never live" and
// shows "report is on its way". Give the cold path room to finish so the first load succeeds.
export const maxDuration = 30;

// Equal-length window immediately before [start, end) — basis for period deltas.
function priorWindow(start: string, end: string): { start: string; end: string } {
  const s = new Date(`${start}T00:00:00Z`), e = new Date(`${end}T00:00:00Z`);
  const days = Math.max(1, Math.round((e.getTime() - s.getTime()) / 86_400_000));
  const ps = new Date(s);
  ps.setUTCDate(ps.getUTCDate() - days);
  return { start: ps.toISOString().slice(0, 10), end: start };
}

// canonical: apptLeads = AI-booked (source='spyne', PRIMARY); apptLeadsAssisted = AI-assisted (CRM, SECONDARY).
export type LeadCounts = Record<string, { contacted: number; dialed: number; connected: number; qualified: number; apptLeads: number; apptLeadsAssisted: number; transferLeads: number; transferFailedLeads: number }>;

function leadRow(r: Record<string, unknown>): LeadCounts[string] {
  return {
    contacted: Number(r.leads_contacted) || 0,
    dialed: Number(r.leads_dialed) || 0,
    connected: Number(r.leads_connected) || 0,
    qualified: Number(r.leads_qualified) || 0,
    apptLeads: Number(r.appt_leads) || 0,
    apptLeadsAssisted: Number(r.appt_leads_assisted) || 0, // canonical: AI-assisted (CRM) — SECONDARY
    transferLeads: Number(r.transfer_leads) || 0, // canonical: window-distinct completed transfers (headline)
    transferFailedLeads: Number(r.transfer_failed_leads) || 0, // reported separately
  };
}

/* EXACT window-distinct lead counts for the CURRENT and PRIOR window in one rpc (report_lead_counts_2,
 * counts DISTINCT lead_id per window so a lead touched on N days counts once). Returns {} on error/absence
 * so each window degrades to undefined → buildResult falls back to summing per-day distincts (the prior,
 * inflated behavior) rather than breaking. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function leadCountsBoth(sb: any, teamId: string, start: string, end: string, priorStart: string, priorEnd: string): Promise<{ cur?: LeadCounts; prior?: LeadCounts }> {
  try {
    const { data, error } = await sb.rpc("report_lead_counts_2", {
      p_team: teamId, p_cur_start: start, p_cur_end: end, p_prior_start: priorStart, p_prior_end: priorEnd,
    });
    if (error || !Array.isArray(data)) return {};
    const cur: LeadCounts = {}, prior: LeadCounts = {};
    for (const r of data as Array<Record<string, unknown>>) {
      (String(r.win) === "prior" ? prior : cur)[String(r.agent_type)] = leadRow(r);
    }
    return { cur, prior };
  } catch {
    return {};
  }
}

/* sync_state.last_run_at — when the ETL last finished. null when unavailable, in which case the UI
 * falls back to its previous behaviour rather than claiming a freshness it cannot prove. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function lastSyncAt(sb: any): Promise<string | null> {
  try {
    const { data, error } = await sb.from(SYNC_STATE).select("last_run_at").eq("id", 1).maybeSingle();
    if (error || !data?.last_run_at) return null;
    return String(data.last_run_at);
  } catch {
    return null;
  }
}

// Window-distinct "Leads by source" per agent_type (report_source_counts → COUNT(DISTINCT lead_id) per
// source). Keyed by agent_type label; each entry is the source rows, biggest-first. {} on error/absence
// → buildResult falls back to the per-day breakdown rollup (lead-days, the inflated behavior).
export type SourceCounts = Record<string, { source: string; total: number; interacted: number; booked: number }[]>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sourceCountsFor(sb: any, teamId: string, start: string, end: string): Promise<SourceCounts | undefined> {
  try {
    const { data, error } = await sb.rpc("report_source_counts", { p_team: teamId, p_start: start, p_end: end });
    if (error || !Array.isArray(data)) return undefined;
    const out: SourceCounts = {};
    for (const r of data as Array<Record<string, unknown>>) {
      const type = String(r.agent_type);
      (out[type] ??= []).push({
        source: String(r.lead_source ?? ""),
        total: Number(r.total_leads) || 0,
        interacted: Number(r.interacted_leads) || 0,
        booked: Number(r.booked_leads) || 0,
      });
    }
    for (const type of Object.keys(out)) out[type].sort((a, b) => b.total - a.total);
    return out;
  } catch {
    return undefined;
  }
}

type Detail = { callbacks: CallbackRow[]; campaigns: CampaignRow[]; outcomes: OutcomeRow[]; appointments: ReportAppointmentRow[]; warmLeads: WarmLeadRow[] };
const EMPTY_DETAIL: Detail = { callbacks: [], campaigns: [], outcomes: [], appointments: [], warmLeads: [] };

/* The per-team detail tables in ONE report_detail() rpc (callbacks / campaigns / outcomes + the v3
 * named appointments / warm leads — all fed directly from ClickHouse by scripts/backfill.ts). On any
 * error returns null so the caller falls back to the independent reads — output identical. An
 * un-migrated DB (pre-0017 rpc) simply omits the two new keys → []. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchDetailCombined(sb: any, teamId: string): Promise<Detail | null> {
  try {
    const { data, error } = await sb.rpc("report_detail", { p_team: teamId });
    if (error || !data || typeof data !== "object") return null;
    const d = data as Record<string, unknown>;
    return {
      callbacks: (d.callbacks ?? []) as CallbackRow[],
      campaigns: (d.campaigns ?? []) as CampaignRow[],
      outcomes: (d.outcomes ?? []) as OutcomeRow[],
      appointments: (d.appointments ?? []) as ReportAppointmentRow[],
      warmLeads: (d.warmLeads ?? []) as WarmLeadRow[],
    };
  } catch {
    return null;
  }
}

/* Has this rooftop EVER produced agent activity (any day, any agent)? This — NOT whether the selected
 * window has rows — is what gates the full-surface "Coming soon" placeholder. A brand-new account that
 * has never run shows it; a LIVE account whose *selected window* merely happens to be empty (e.g.
 * "Today" before the first call of the day, or a quiet weekend) does NOT — it renders the real report
 * with zeros. Cheap existence probe (one row). Degrades to false on error → same as prior behavior. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function teamEverLive(sb: any, teamId: string): Promise<boolean> {
  try {
    const { data, error } = await sb.from(AGENT_DAILY).select("activity_day").eq("team_id", teamId).limit(1);
    // A transient probe error must NEVER demote a rooftop to "Coming soon": on error degrade to true
    // (assume live). A clean read with zero rows is the only signal that means "never live".
    if (error) return true;
    return Array.isArray(data) && data.length > 0;
  } catch {
    return true;
  }
}

/* PostgREST caps a single read at db-max-rows — 1000 on this project (measured: a request for 2000 rows
 * of report_appointments returns exactly 1000). A plain `.select("*").eq("team_id", …)` therefore
 * TRUNCATES SILENTLY once a rooftop's snapshot passes that many rows: no error, no flag, the list just
 * ends early and every count derived from it reads low.
 *
 * Not hypothetical. report_appointments is a trailing ~120d snapshot and Honda of Downtown Los Angeles
 * held 1,012 rows on 2026-09-09 — over the cap — before the meta.source='callback' exclusion trimmed it
 * to 900. Fleet-wide the table is 9,727 rows and the per-team maximum is 900 today, so nothing is
 * truncated right now, but the largest rooftop has already crossed the line once and grows back toward
 * it every day.
 *
 * The PRIMARY path (report_detail, above) is unaffected — it jsonb_agg's server-side and returns ONE
 * row, so the row cap never applies. This is the fallback that runs when that rpc is missing or errors,
 * which is exactly when nobody is watching.
 *
 * `.range()` needs a stable `.order()` or pages can repeat and drop rows between requests, so each table
 * pages on its own key. appointments/warm_leads use their natural unique id; the other three page on a
 * best-available column and are orders of magnitude under the cap (outcomes is a handful of buckets per
 * team, campaigns tens, callbacks hundreds), so a tie there cannot cost a row in practice.
 *
 * Each table still degrades to [] independently — a missing table must not fail the report. */
const DETAIL_PAGE = 1000;
const DETAIL_ORDER: Record<string, string> = {
  [REPORT_APPOINTMENTS]: "meeting_id", // one row per meeting — unique
  [REPORT_WARM_LEADS]: "lead_id",      // one row per lead — unique
  [REPORT_CAMPAIGNS]: "campaign",
  [REPORT_OUTCOMES]: "outcome_bucket",
  [REPORT_CALLBACKS]: "callback_due",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function pageAll<T>(sb: any, table: string, teamId: string): Promise<T[]> {
  const out: T[] = [];
  // Safety ceiling: 50 pages (50k rows) is far beyond any rooftop's 120d snapshot and stops a
  // mis-ordered key from looping forever.
  for (let page = 0; page < 50; page++) {
    try {
      const { data, error } = await sb
        .from(table)
        .select("*")
        .eq("team_id", teamId)
        .order(DETAIL_ORDER[table] ?? "team_id", { ascending: true })
        .range(page * DETAIL_PAGE, (page + 1) * DETAIL_PAGE - 1);
      if (error) return out; // degrade to what we have, same as the previous `safe()`
      const rows = (data ?? []) as T[];
      out.push(...rows);
      if (rows.length < DETAIL_PAGE) return out; // short page ⇒ last page
    } catch {
      return out;
    }
  }
  console.warn(`[reports] ${table}: hit the ${50 * DETAIL_PAGE}-row paging ceiling for team ${teamId}`);
  return out;
}

/* Fallback: the original five independent reads, now paged. Only used when report_detail() is
 * unavailable. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchDetailPerTable(sb: any, teamId: string): Promise<Detail> {
  const [callbacks, campaigns, outcomes, appointments, warmLeads] = await Promise.all([
    pageAll<CallbackRow>(sb, REPORT_CALLBACKS, teamId),
    pageAll<CampaignRow>(sb, REPORT_CAMPAIGNS, teamId),
    pageAll<OutcomeRow>(sb, REPORT_OUTCOMES, teamId),
    pageAll<ReportAppointmentRow>(sb, REPORT_APPOINTMENTS, teamId),
    pageAll<WarmLeadRow>(sb, REPORT_WARM_LEADS, teamId),
  ]);
  return { callbacks, campaigns, outcomes, appointments, warmLeads };
}

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const teamId = searchParams.get("team_id");
  if (!teamId) return Response.json({ error: "team_id is required" }, { status: 400 });

  // Require a credential and validate team scope before returning any rooftop data: a valid Spyne
  // session token scoped to this team, or the service CRON_SECRET. No credential → 401; token scoped
  // to a different team → 403.
  const auth = requireTeamAuth(request, teamId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  // Spyne API token: PROD forwards it per-request from the host — via the Authorization header or an
  // `auth_key`/`spyne_token`/`token` query param (the host uses `auth_key`); LOCAL DEV omits it and the
  // client falls back to SPYNE_API_TOKEN (env). spyneTokenFrom skips the CRON_SECRET so the cron's
  // `Authorization: Bearer <secret>` doesn't shadow the real dealer token it sends as ?auth_key= — which
  // would silently drop timezone/onboarded-agent enrichment back to UTC/all-agents.
  const spyneToken = spyneTokenFrom(request);
  // Which Spyne backend the enrichment calls below hit — the console now embeds a rooftop with
  // ?env=uat|stag|prod, and a UAT dealer's token only works against the UAT API.
  const spyneEnv = spyneEnvFrom(request);

  // Resolve the rooftop's timezone + onboarded agents from the Spyne API (best-effort; both null when
  // auth is unavailable or the call fails → previous behavior: UTC windows, all agents shown).
  const [timezone, onboardedSlots, onboardedNames, onboardedPhotos] = await Promise.all([
    getStoreTimeZone(teamId, spyneToken, spyneEnv),
    getOnboardedSlots(teamId, spyneToken, spyneEnv),
    getOnboardedNames(teamId, spyneToken, spyneEnv),
    getOnboardedPhotos(teamId, spyneToken, spyneEnv),
  ]);

  // Relative buckets resolve to a window in the STORE's timezone (so a Pacific rooftop's "Today" is a
  // Pacific day, not a UTC day). Explicit start/end (the custom date picker) are taken as-is — they're
  // already store-local calendar dates.
  const startQ = searchParams.get("start");
  const endQ = searchParams.get("end");
  const { start, end } = startQ && endQ
    ? { start: startQ, end: endQ }
    : rangeFor((searchParams.get("bucket") as Bucket) ?? "last30", timezone ?? undefined);
  const prior = priorWindow(start, end);
  const meta = { start, end, timezone };

  const sb = getSupabase();
  if (!sb) {
    // No backend configured → return mock-shaped result so the UI still renders.
    return Response.json({ ...buildResult({ daily: [], breakdown: [], priorDaily: [], onboardedSlots, onboardedNames, onboardedPhotos }), ...meta });
  }

  // agent_daily is read ONCE across the combined [prior.start, end) range and split in-memory into the
  // current and prior windows (prior.end === start), replacing the old two separate window reads.
  const readFacts = () =>
    Promise.all([
      sb.from(AGENT_DAILY).select("*").eq("team_id", teamId).gte("activity_day", prior.start).lt("activity_day", end),
      sb.from(AGENT_DAILY_BREAKDOWN).select("*").eq("team_id", teamId).gte("activity_day", start).lt("activity_day", end),
    ]);

  // Retry a transient read error — a momentary connection blip usually clears on a fresh attempt. ALSO
  // retry a clean-but-EMPTY read: an established rooftop returning ZERO rows across the whole ~60-day
  // [prior.start, end) window is almost always a momentary empty result set, not "never live". Letting
  // it through flips a LIVE rooftop to the "Coming soon" gate until the user manually reloads — the bug
  // where dealers had to refresh many times before their report appeared. A genuinely brand-new rooftop
  // just re-confirms empty here (a little extra latency on a page it doesn't populate anyway).
  let res = await readFacts();
  const blank = () => !(res[0].error || res[1].error) && ((res[0].data?.length ?? 0) === 0);
  for (let attempt = 0; attempt < 3 && ((res[0].error || res[1].error) || blank()); attempt++) {
    await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    res = await readFacts();
  }
  const err = res[0].error || res[1].error;
  const [allDailyRes, bd] = res;

  if (err) {
    // A read failure must NOT 502 (that blanks the report). Degrade to the same mock-shaped result
    // the no-backend path serves so the UI still renders; flag it so the failure is observable.
    // `degraded: true` is in the BODY (not just the header) so the digest pipeline can tell an outage
    // from a genuinely quiet day and SUPPRESS the email instead of sending all-zeros. HTTP stays 200 so
    // existing healthy callers that rely on 200 don't break.
    console.error(`[/api/reports] Supabase read failed for team ${teamId}: ${err.message}`);
    return Response.json({ ...buildResult({ daily: [], breakdown: [], priorDaily: [], onboardedSlots, onboardedNames, onboardedPhotos }), ...meta, degraded: true }, {
      headers: { "X-Reports-Degraded": "supabase-read-error" },
    });
  }

  const allDaily = (allDailyRes.data ?? []) as AgentDailyRow[];
  const cur = allDaily.filter((r) => (r.activity_day as unknown as string) >= start);   // [start, end)
  const pri = allDaily.filter((r) => (r.activity_day as unknown as string) < start);     // [prior.start, start)

  // Detail tables (one rpc, fallback to six reads) + both lead-count windows (one rpc) + the
  // lifetime "ever live" probe in parallel.
  const [detail, lc, sourceCounts, everLive, assistedLeads, syncedAt, live] = await Promise.all([
    fetchDetailCombined(sb, teamId).then((d) => d ?? fetchDetailPerTable(sb, teamId)),
    leadCountsBoth(sb, teamId, start, end, prior.start, prior.end),
    sourceCountsFor(sb, teamId, start, end),
    teamEverLive(sb, teamId),
    assistedApptLeads(sb, teamId, start, end),
    lastSyncAt(sb),
    /* AI-booked appointments come from the meetings API, not the aggregate — the one number dealers
     * check against the appointments console, which reads that same API. Fetched across BOTH windows in
     * one call so the period delta compares live against live. Null = no credential or the call failed,
     * and every appointment number below then stays exactly as the aggregate had it. */
    fetchLiveAppointments({ teamId, start: prior.start, end, token: spyneToken, env: spyneEnv }),
  ]);
  const { callbacks, campaigns, outcomes, appointments, warmLeads } = detail ?? EMPTY_DETAIL;
  // Named appointments are shown for the report window — filter the ~120d snapshot by booking date.
  // ★ WINDOWED IN THE STORE'S OWN DAY SPACE (fixed 2026-09-09). `start`/`end` are resolved in the
  // rooftop's timezone a few lines above, and agent_lead_days (which the COUNTS come from) is bucketed
  // store-local by the ETL — but this filter used to slice `booked_at` as a raw UTC prefix. For a
  // Pacific rooftop that is a 7-8h shift, so every booking made after 5pm local landed on the next UTC
  // day and the list carried a different set of days than the number above it. Honda of Downtown Los
  // Angeles, trailing 30d: the UTC slice returned 107 rows / 89 Service-Inbound after dedupe against a
  // card of 84; re-bucketed store-local it returns 103 / 85. That single mismatch was 4 of the 5.
  // Falls back to the raw prefix when the rooftop's tz is unknown (storeLocalDay's own contract), which
  // is exactly the previous behavior.
  let windowedAppointments = appointments.filter((a) => {
    const raw = (a.booked_at ?? "").slice(0, 10);
    if (!raw) return false;
    const day = storeLocalDay(a.booked_at ?? "", timezone ?? undefined, raw);
    if (!(day >= start && day < end)) return false;
    // ★ AI-assisted rows must ALSO have an in-window AI touch — see assistedAppts.ts for why.
    return assistedInWindow(a, assistedLeads);
  });

  /* ── AI-BOOKED APPOINTMENTS, SWAPPED TO LIVE ──
   * The list and the tile must move together. Making the tile live while the list stayed on the
   * aggregate would just relocate the mismatch we set out to remove, so the AI-booked half of the list
   * is rebuilt from the same live meetings the tile counts. Assisted rows are untouched: they are not
   * in this API's set and depend on the aggregate to know the AI worked the lead.
   *
   * Detail the live API doesn't carry (booked_via — call / SMS / web chat) is enriched back from the
   * snapshot row with the same meeting_id, so a booking the aggregate already knows about keeps its
   * "AI-booked, via SMS" label and only a booking too new for the aggregate reads as plain "AI-booked". */
  let liveAppts = live?.meetings ?? null;
  const appointmentsLive = !!liveAppts;
  if (liveAppts) {
    const snapshotByMeeting = new Map(windowedAppointments.filter((a) => a.meeting_id).map((a) => [a.meeting_id as string, a]));
    /* ★ THE FEED'S `id` IS NOT ONE ID. It is meetings.meeting_id on some rows and the Mongo _id on
     * others — the same mixture meetings.ts:88 already keys both ways for the warm-transfer screen. The
     * snapshot only stores meeting_id, so a row arriving under its _id missed this lookup entirely and
     * lost the direction, the channel label and the vehicle the aggregate already knew. LEAD ID is the
     * one key both sides always carry, so it backs the meeting-id lookup up.
     *
     * Deliberately narrow: the lead-keyed row supplies DEPARTMENT and DIRECTION only, which are
     * properties of how the AI worked that lead. booked_via and vehicle stay keyed on the meeting,
     * because a lead with two bookings can have made one by call and one by text and guessing between
     * them would put a wrong channel on a named row. */
    const snapshotByLead = new Map<string, ReportAppointmentRow>();
    for (const a of windowedAppointments) {
      if (!a.assisted && a.lead_id && !snapshotByLead.has(a.lead_id)) snapshotByLead.set(a.lead_id, a);
    }
    const snapFor = (m: { id: string; leadId?: string | null }) =>
      (m.id ? snapshotByMeeting.get(m.id) : undefined) ?? (m.leadId ? snapshotByLead.get(m.leadId) : undefined);

    /* The API states the booking agent on ~99% of rows (agentData). For the rest, take the department
     * and direction the aggregate already resolved for that meeting. Without this the row still lists —
     * it is a real appointment — but belongs to no agent, so the tiles sum to one less than the list
     * beneath them. Anything still unresolved stays listed and uncounted rather than being guessed at. */
    liveAppts = liveAppts.map((m) => {
      if (m.agentType && m.direction) return m;
      const prev = snapFor(m);
      if (!prev) return m;
      return {
        ...m,
        agentType: m.agentType ?? (prev.service_type ? prev.service_type.toLowerCase() : null),
        direction: m.direction ?? (prev.direction ? prev.direction.toLowerCase() : null),
      };
    });
    const booked: ReportAppointmentRow[] = liveAppts
      .filter((m) => { const d = (m.bookedAt ?? "").slice(0, 10); return d >= start && d < end; })
      .map((m) => {
        const prev = m.id ? snapshotByMeeting.get(m.id) : undefined;
        return {
          team_id: teamId,
          enterprise_id: prev?.enterprise_id ?? null,
          service_type: (m.agentType || m.serviceType || "").toLowerCase() || null,
          lead_id: m.leadId,
          meeting_id: m.id,
          customer_name: m.customer,
          phone: m.phone,
          vehicle: m.vehicle || prev?.vehicle || null,
          intent: m.intent,
          meeting_start: m.when || null,
          booked_at: m.bookedAt,
          status: m.status || null,
          assisted: false,
          direction: m.direction ?? prev?.direction ?? null,
          booked_via: prev?.booked_via ?? null,
        } satisfies ReportAppointmentRow;
      });
    const assisted = windowedAppointments.filter((a) => a.assisted);
    windowedAppointments = [...booked, ...assisted];
  }
  // Invariant: a rooftop that returned real rows in THIS request can't be "never live" — don't let a
  // separate probe (even a clean-but-stale empty read) demote it. The probe still gates brand-new
  // rooftops whose selected window AND lifetime are both empty.
  const everLiveResolved = everLive || allDaily.length > 0;

  /* Per-agent, per-store-local-day counts from the same rows, so the day-on-day chart plots the
   * bookings the funnel counts rather than agent_daily's separate appointment column. */
  const apptDayCounts: Record<string, Record<string, number>> = {};
  for (const a of windowedAppointments) {
    if (a.assisted) continue;
    const svc = (a.service_type || "").toLowerCase();
    const dir = (a.direction || "").toLowerCase();
    if ((svc !== "sales" && svc !== "service") || (dir !== "inbound" && dir !== "outbound")) continue;
    const type = `${svc === "sales" ? "Sales" : "Service"} ${dir === "inbound" ? "Inbound" : "Outbound"}`;
    const raw = (a.booked_at ?? "").slice(0, 10);
    if (!raw) continue;
    const day = storeLocalDay(a.booked_at ?? "", timezone ?? undefined, raw);
    (apptDayCounts[type] ??= {})[day] = ((apptDayCounts[type] ??= {})[day] ?? 0) + 1;
  }

  const result = buildResult({
    daily: cur,
    breakdown: (bd.data ?? []) as BreakdownRow[],
    priorDaily: pri,
    callbacks,
    campaigns,
    outcomes,
    namedAppointments: windowedAppointments,
    apptDayCounts,
    warmLeads,
    onboardedSlots,
    onboardedNames,
    onboardedPhotos,
    leadCounts: lc.cur,
    priorLeadCounts: lc.prior,
    sourceCounts,
  });

  /* syncedAt = when the AGGREGATE was last rebuilt, not when this request ran. The header used to say
   * "Synced just now" off the client's own fetch time, over data that can be hours old: the sync
   * workflow is scheduled hourly but GitHub actually fires it every 1.4-5.5h. On Heiser Chevrolet that
   * read "Synced just now" beside 1 appointment while the appointments console, reading the live API,
   * showed 3 — the two missing ones were booked AFTER the last sync finished. Telling a dealer a number
   * is current when it is hours behind is how a sync lag gets mistaken for a bug. */
  /* ── ONE SOURCE FOR THE APPOINTMENT NUMBER ──
   * The per-agent AI-booked count is derived from the SAME rows the list shows — always, not only when
   * the live fetch succeeded. This is what stops the card and its own drill-down disagreeing.
   *
   * It used to come from agent_daily, i.e. the spine, which counts a meeting only once it attaches to a
   * conversation belonging to a lead that exists. That drops 5.2% of AI-booked meetings fleet-wide and
   * put the card under its own export: team 9923577d07 Service Inbound read 84 beside a sheet listing
   * 87. `windowedAppointments` is the meetings API when we have a credential and the meetings-table
   * snapshot when we don't, and both are a direct read of the booking records — neither needs a
   * conversation to exist. Whichever it is, the number and the list are now the same rows counted once.
   *
   * The prior window uses live rows when we have them and otherwise leaves the aggregate's basis alone —
   * the snapshot only covers the current window, so recomputing it from these rows would read zero. */
  const curByAgent: Record<string, number> = {};
  /* ★ SPLIT BY DEPARTMENT, NOT ONE ROOFTOP-WIDE NUMBER (fixed 2026-09-11). A booking no agent owns is
   * still added to the total the tile shows — but that tile is department-scoped whenever the header's
   * switcher is on Sales or Service, and this used to hand every scope the SAME rooftop-wide scalar.
   * Principle BMW MINI of San Antonio, service tab, 30d: Service Inbound 44 + Service Outbound 1 = 45
   * under a department total of 46, because one SALES booking with no resolvable direction was being
   * counted on the service tab (and on the sales tab, and on All — the same row three times over).
   * A row whose own department is unknown belongs to the rooftop and to neither department, so it is
   * kept apart in `unknown` and only "All" picks it up — which is exactly how the LIST beneath these
   * tiles already filters (`a.serviceType === dept`). Tile and list now scope identically. */
  const unattributedBy = { sales: 0, service: 0, unknown: 0 };
  for (const a of windowedAppointments) {
    if (a.assisted) continue;
    const svc = (a.service_type || "").toLowerCase();
    const dir = (a.direction || "").toLowerCase();
    const dept = svc === "sales" || svc === "service" ? svc : null;
    if (!dept || (dir !== "inbound" && dir !== "outbound")) {
      // Real bookings with no call, chat or conversation behind them — no agent owns them. Counted at
      // the scope that DOES own them (their department, or the rooftop when even that is unknown) and
      // listed there, never guessed onto an agent.
      unattributedBy[dept ?? "unknown"]++;
      continue;
    }
    const type = `${svc === "sales" ? "Sales" : "Service"} ${dir === "inbound" ? "Inbound" : "Outbound"}`;
    curByAgent[type] = (curByAgent[type] ?? 0) + 1;
  }
  const appointmentsUnattributed = unattributedBy.sales + unattributedBy.service + unattributedBy.unknown;
  const priByAgent = liveAppts ? countByAgent(liveAppts, prior.start, prior.end).byAgent : null;
  for (const agent of result.agents) {
    const type = AGENT_TYPE_BY_ID[agent.id];
    if (!type) continue;
    agent.metrics.appointments = curByAgent[type] ?? 0;
    const basis = result.prior?.[agent.id];
    if (priByAgent && basis && typeof basis.appointments === "number") basis.appointments = priByAgent[type] ?? 0;
  }

  return Response.json({ ...result, ...meta, syncedAt, appointmentsLive, appointmentsUnattributed, appointmentsUnattributedBy: unattributedBy, everLive: everLiveResolved }, {
    headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=120" },
  });
}
