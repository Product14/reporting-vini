/* Live data layer — fetches the materialized report for a team + window in ONE request to
 * /api/reports (which reads the Supabase aggregate the sync maintains) and returns it as the
 * AgentData[] the reporting UI already consumes. Replaces the old ~84 Metabase card round-trips.
 * Used by /reports (Overview) and /reports/agents (By agent) — no component/JSX changes. */

import { type AgentData, type Bucket, type Meeting, type MeetingsResult, type NamedAppt, type WarmLeadItem } from "./data";

export type { NamedAppt, WarmLeadItem } from "./data";
import { type Account } from "./accounts";

// Maps the CSM sheet's agent-type labels to this report's agent ids.
export const ID_BY_AGENT_TYPE: Record<string, AgentData["id"]> = {
  "Sales Inbound": "sales_ib",
  "Sales Outbound": "sales_ob",
  "Service Inbound": "service_ib",
  "Service Outbound": "service_ob",
};

/* The funnel-entry stage (top of the "leads → conversations → qualified → appointments" funnel) as a
 * label + value. ONE source of truth so every surface (Overview agent cards, By-agent funnel, and the
 * agent-selector chips above them) shows the SAME number and the SAME noun for the same agent.
 *
 * ALWAYS `reached` — BOTH directions, changed 2026-10-05.
 *
 * Outbound used to open on `dialed`, which broke the funnel in two ways on a texting-heavy rooftop:
 *
 *   1. NOT A SUPERSET OF THE STAGE BELOW IT. `dialed` is uniqExactIf(lead_id, is_call = 1), while
 *      `engaged` has its own SMS branch — a lead that was only ever texted and replied is engaged
 *      WITHOUT ever being dialed. So "622 dialed → 302 real conversations · 49%" was a ratio between
 *      two partly-disjoint sets, not a funnel.
 *   2. IT CONTRADICTED THE CHIP ABOVE IT, which reads this same stage: 823 on the chip over a funnel
 *      opening at 622, because 201 of that agent's leads were texted and never called.
 *
 * The backend says the same thing at source — canonical-metrics.service.ts calls `dialed` "A CHANNEL
 * STAT, never a funnel head". It still has a home on the card's stat row (calls dispatched / total
 * SMS); it just is not the top of the funnel. */
export function leadEntryStage(
  dir: string,
  lf: { contacted: number; dialed: number; connected: number } | undefined,
  fallbackContacted: number,
): { label: string; value: number } {
  const contacted = lf?.contacted ?? fallbackContacted;
  // `dir` is no longer read — kept in the signature because every call site passes it and the
  // distinction may come back as a label-only difference ("reached" vs "contacted").
  void dir;
  return { label: "Leads reached", value: contacted };
}

/* Does this agent have ANY real activity in the window? Activity is ground truth for whether an agent
 * should appear — not just calls (an inbound agent can have a busy SMS/lead day with zero calls), so we
 * look across calls, conversations, qualified, appointments, SMS and unique leads touched. */
export function hasAgentActivity(a: AgentData): boolean {
  const m = a.metrics;
  const leads = a.leadFunnel?.contacted ?? a.report?.leadsAttempted ?? 0;
  return m.calls + m.conversations + m.qualified + m.appointments + m.smsSent + leads > 0;
}

/* Scope an agent list to the agents a rooftop actually runs. We keep the agents the CSM sheet lists for
 * this rooftop PLUS any agent with real activity in the window — the sheet goes stale, so activity is
 * the source of truth. Without this, an agent that runs live but was never added to the sheet (e.g. a
 * rooftop's Sales-OB) is silently hidden from BOTH the overview and the by-agent view. A rooftop not in
 * the tracker (no agents listed) shows all, so an unmapped team never renders an empty report. */
export function agentsForAccount(agents: AgentData[], account: Account | undefined): AgentData[] {
  const ids = new Set((account?.agents ?? []).map((t) => ID_BY_AGENT_TYPE[t]).filter(Boolean));
  if (!ids.size) return agents;
  return agents.filter((a) => ids.has(a.id) || hasAgentActivity(a));
}

export const DEFAULT_TEAM_ID = "9923577d07"; // Honda of Downtown LA — overridable per call

// Today's calendar date (YYYY-MM-DD). When a store IANA timezone is given, anchor to THAT zone's
// "today" so a Pacific rooftop's day boundaries are Pacific midnight, not UTC midnight — otherwise a
// UTC day spans ~5pm-prev-day → ~5pm Pacific and bleeds the previous evening into "today". With no
// timezone we fall back to UTC (the historical behavior).
function todayIn(timeZone?: string): string {
  const now = new Date();
  if (!timeZone) return now.toISOString().slice(0, 10);
  // en-CA renders as YYYY-MM-DD; timeZone shifts it to the store's local calendar day.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
// Shift a YYYY-MM-DD date by n whole days, returning YYYY-MM-DD. Date-only math (UTC midnight) so it's
// timezone-agnostic — it just adds/subtracts whole days to a bare calendar date.
function shiftDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/* Date window per the UI's bucket toggle — ROLLING relative to today in the store's timezone (or UTC
 * when none is known). Windows INCLUDE today (the live, in-progress day) so the report aligns with the
 * Spyne console's calendar days: "Today" is the current day, "Yesterday" the one before, last7/14/30 the
 * trailing N days ENDING today, Lifetime all history. `end` is exclusive = tomorrow, so today is in range.
 * Caveat: the current day is PARTIAL — end-call-reports enrich a few minutes after each call ends and the
 * sync pulls on its own cadence, so "Today" trails a live console slightly until the day closes. (This
 * replaced the old "Today = latest *complete* day" shift, which made every window read a day behind and
 * disagree with the console's "Today".) */
export function rangeFor(bucket: Bucket, timeZone?: string): { start: string; end: string } {
  const today = todayIn(timeZone);   // current calendar day, store-local
  const end = shiftDays(today, 1);   // exclusive upper bound = tomorrow, so today is included
  switch (bucket) {
    case "today": return { start: today, end };
    case "yesterday": return { start: shiftDays(today, -1), end: today };
    case "last7": return { start: shiftDays(today, -6), end };
    case "last14": return { start: shiftDays(today, -13), end };
    case "last30": return { start: shiftDays(today, -29), end };
    // Month-to-date: 1st of the current (store-local) month → today inclusive.
    case "mtd": return { start: `${today.slice(0, 7)}-01`, end };
    case "lifetime": return { start: "2020-01-01", end };
    default: return { start: shiftDays(today, -29), end };
  }
}

/* Short, human label for an IANA timezone (e.g. "America/Los_Angeles" → "PDT"/"PST"). Used to tell the
 * dealer which timezone the report's days/times are in. Returns "" when unknown/unparseable. */
export function tzShortLabel(tz?: string | null): string {
  if (!tz) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date());
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

// Shift an inclusive ISO date one day forward — turns a UI date-picker "end" into the exclusive end the queries expect.
export function addDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Period-over-period % change. Returns null (not 0) when there's NO prior basis (prev === 0) so the UI
// can distinguish "new / no prior data" from a genuine 0% change — rendering "▲ 0%" for real growth
// from an empty prior window is misleading.
const pctDelta = (curr: number, prev: number): number | null => (prev ? Math.round(((curr - prev) / prev) * 100) : null);

/* Dollar-value layer removed in v3 (user decision 2026-07-07): the report leads with real counts —
 * appointments, conversations, hand-offs, time — not appts × a hardcoded rate, which dealers read as
 * fake. Value framing (avg-RO / gross-per-copy) can return later as a dealer-configurable model. */

export interface LiveOpts {
  teamId?: string;
  bucket?: Bucket;
  start?: string;
  end?: string;
  force?: boolean; // bypass the cache (used by the Refresh button)
  spyneToken?: string; // host-forwarded Spyne API token (prod); omit locally (server uses env)
  spyneEnv?: string; // host-forwarded ?env=uat|stag|prod — which Spyne backend the server should call
}

// Minimal per-agent totals for the prior equal-length window — the basis for real period deltas.
// The v3 fields are optional so older cached payloads (and the mock path) still parse.
export interface Basis {
  calls: number;
  conversations: number;
  qualified: number;
  appointments: number;
  leads: number;
  sms: number;
  appointmentsAssisted?: number;
  transfers?: number;
  transfersFailed?: number;
  callbacks?: number;
  talkMinutes?: number;
  afterHours?: number;
}

/* THE ROOFTOP'S OWN DISTINCT-LEAD RUNGS, served by the canonical API — NOT the sum of the agent rows.
 * A lead worked by BOTH Sales Inbound and Sales Outbound is genuinely reached/engaged/qualified on
 * both agent cards, but it is ONE lead at the rooftop, so adding the cards double-counts the overlap:
 * team 3d3deabc98 sums to 270 qualified where the rooftop's distinct answer is 253. (Vendor-internal
 * measurement read off the canonical endpoint — not an audited industry figure.)
 *
 * `dept` and `agentTypes` are the SCOPE this triple was computed over, carried so the client can PROVE
 * a given agent list is exactly that scope before substituting — see rooftopRungsFor(). They are not
 * display data, and nothing may hardcode "sales" from them: the API decides its own scope.
 *
 * Absent whenever the canonical call did not land (older deploy, no token, API down, or the call was
 * made without a Spyne credential). Every consumer then keeps summing the agent rows, which is the
 * pre-existing behaviour. */
export interface RooftopRungs {
  /** The department the API was asked for — "sales" today (see route.ts). Read it, never assume it. */
  dept: string;
  /** The agent types the API actually counted, narrowed to those with lead activity in the window. */
  agentTypes: string[];
  leadsAttempted: number;
  engaged: number;
  qualified: number;
  /** The same three for the prior equal-length window. Absent when the API sent no `previous` block. */
  prior?: { leadsAttempted: number; engaged: number; qualified: number };
  /** The API's own period-over-period %, per field, null when the prior window was empty (its contract
   *  matches pctDelta's: a dash, never a fabricated "+256%" off a base of nothing). */
  deltaPct?: { leadsAttempted: number | null; engaged: number | null; qualified: number | null };
  /** "Qualified, NOT yet booked" — the hero tile's and the ROI PDF's number, served directly rather
   *  than subtracted. `qualified - booked` is the WRONG answer: not every booked lead qualified
   *  (see CanonicalHotLeads in lib/spyne/consoleReports.ts). 222 where the subtraction gave 234. */
  hotLeads?: number;
}

export interface FetchResult {
  agents: AgentData[];
  hasData: boolean; // the SELECTED window has rows — drives inline "empty window" notes, not the gate
  // Has this rooftop EVER produced data (lifetime, any window)? Gates the full-surface "Coming soon"
  // placeholder: a live account whose selected window is empty still renders the report (with zeros).
  // Absent on the mock/error fallback → callers fall back to hasData (prior, window-scoped behavior).
  everLive?: boolean;
  fetchedAt: number; // epoch ms — drives the "last synced" label
  // The fetch failed or the server degraded (transient Supabase blip / cold-start timeout). A degraded
  // result is NOT cached and must NEVER flip the report to the "Coming soon" gate — an outage is not the
  // same as a rooftop that never went live. Callers treat it as "still loading" and retry.
  degraded?: boolean;
  // The request was rejected 401/403 (missing/invalid or wrong-team credential). TERMINAL — not degraded,
  // so the self-heal re-arm never fires. Locally this just means no ?auth_key= on the URL.
  // MUST be handled by every caller that gates on `everLive`/`hasData`: a denial carries neither, so an
  // unhandled 403 renders as "this rooftop has no data yet" over a rooftop that is fully live. That is
  // exactly what happened to Paragon Honda (2026-09-10) — see ReportAccessDenied.
  unauthorized?: boolean;
  // WHICH denial: 401 = no credential reached the API (the host forwarded no ?auth_key=), 403 = the
  // credential names a DIFFERENT rooftop than the one requested (the group rooftop-switch case). The two
  // need different words in front of the dealer, so the status is carried, not just the boolean.
  authStatus?: 401 | 403;
  /* ROOFTOP leads whose FIRST touch fell outside opening hours — the "Captured after-hours" tile.
   * A CUSTOMER count, and deliberately not `fleet.afterHours`, which sums each agent's after-hours
   * CALLS. The two answer different questions and the tile asks the first one. Distinct at rooftop
   * level, so it is never the sum of the agent rows. Absent when the canonical API is unavailable. */
  capturedAfterHours?: number;
  /* The canonical rooftop rungs + the scope they were computed over. Same contract as
   * capturedAfterHours above: present only when the canonical API answered, absent otherwise, and
   * never partially filled. Read it through rooftopRungsFor() — the raw object carries a SCOPE, and
   * handing a department- or subset-filtered view a figure computed over a different agent set swaps
   * an over-count for a flatly wrong number. */
  rooftop?: RooftopRungs;
  prior: Record<string, Basis>; // per-agent-id totals for the prior window (for fleet deltas)
  // The window the server actually resolved (store-local when a timezone was known) + that timezone.
  // Informational — lets the UI label the period / note the zone. Absent on the mock/error fallback.
  start?: string;
  end?: string;
  timezone?: string | null;
  // v3 named lists (rooftop-wide; the per-agent scoped copies live on agent.report). Absent on the
  // mock/degraded path — sections omit. LIVE-ONLY, never fabricated.
  namedAppointments?: NamedAppt[];
  /** AI-booked bookings that belong to no agent (no direction resolvable), rooftop-wide — see aggregateFleet. */
  appointmentsUnattributed?: number;
  /** The same bookings split by the department that DOES own them; `unknown` belongs to neither.
   *  Read it through unattributedApptsFor() — never add the rooftop total into a department's tile. */
  appointmentsUnattributedBy?: { sales: number; service: number; unknown: number };
  /** Rooftop AI-assisted (CRM) totals by department, from the appointment snapshot. The rooftop truth:
   *  the spine can only credit an assist to an AGENT when the lead has an in-window conversation, so the
   *  agent rows are a subset. Read it through assistedApptsFor(); absent on an older API response, in
   *  which case aggregateFleet falls back to summing the agent rows. */
  appointmentsAssistedBy?: { sales: number; service: number; unknown: number };
  /* When the AGGREGATE was last rebuilt (sync_state.last_run_at), NOT when this client fetched. The
   * header's "Synced …" line reads this: fetchedAt says how fresh the REQUEST is, which is always
   * "just now" and told dealers the numbers were current when the ETL was hours behind. */
  syncedAt?: string | null;
  warmLeads?: WarmLeadItem[];
}

// Per-direction sums for the hero tiles' Inbound/Outbound tri-split rows.
export interface FleetSplit {
  leads: number;
  conversations: number;
  qualified: number;
  appointments: number;
  appointmentsAssisted: number;
  transfers: number;
  transfersFailed: number;
  callbacks: number;
  handoffs: number; // transfers + callbacks (canonical "Hand-offs to team")
  calls: number;
  smsSent: number;
  talkMinutes: number;
  afterHours: number;
}

// Live fleet roll-up for the Overview: sums the account's live agents and computes real deltas
// from the prior-window basis. Dollar figures are intentionally absent (v3: counts, not $).
export interface FleetLive {
  calls: number;
  /* THE THREE DISTINCT-LEAD RUNGS. When `rungsAreDistinct` is true these are the rooftop's own
     distinct counts from the canonical API; otherwise they are the agent rows added up, which
     double-counts any lead two agents both worked. See aggregateFleet. */
  leads: number; // distinct leads touched/contacted (funnel entry) — the "Leads touched" MAIN tile
  conversations: number;
  qualified: number;
  /* Are `leads` / `conversations` / `qualified` (and the funnel's first three stages, and their three
     deltas) the ROOFTOP'S DISTINCT counts rather than the sum of the agent rows? Exposed so no
     consumer has to re-derive the gate — re-deriving it is how the Overview tile, the funnel and the
     ROI PDF drifted apart in the first place. False is a correct, coarser answer to the same question
     (an over-count bounded by the cross-agent overlap), NOT a different metric. */
  rungsAreDistinct: boolean;
  appointments: number;
  /* The part of `appointments` that belongs to NO agent, so anywhere the total is shown beside a
     per-agent or per-direction breakdown it can be named instead of read as an arithmetic error.
     Honda of Downtown Los Angeles, service, 30d: the funnel's other three stages equal the two agent
     cards exactly (810 = 559+251, 633 = 502+131, 247 = 236+11) and appointments read 97 over 88+7.
     Both of those 2 are one lead whose meeting was created ONE SECOND after the lead itself, with no
     call and no conversation anywhere — there is no evidence to attribute them to either agent. */
  appointmentsNoAgent: number;
  appointmentsAssisted: number; // canonical: AI-assisted (CRM) — SECONDARY, never folded into appointments
  transfers: number; // canonical: completed hand-offs (lead-level when RPC available)
  transfersFailed: number; // reported separately, never folded in
  callbacks: number;
  handoffs: number; // transfers + callbacks
  // Query resolution (INBOUND only): a customer asked and the AI answered. Numerator = inbound
  // query_resolved (callFlow.handledByAI); denominator = queryConversations (inbound real conversations).
  // Scoped to inbound because outbound reactivation has ~no query_resolved and would dilute the rate.
  queryResolved: number;
  queryConversations: number;
  queryResolutionRate: number | null;
  // Response time = avg first-response (speed-to-lead) in seconds, from Sales-Inbound STL accumulators.
  // The honest rooftop "Response time" figure; null when no measurable new-lead touches. SMS reply
  // latency is shown on the Recent-calls detail page, not folded into this headline.
  responseTimeSec: number | null;
  // Speed-to-Lead runs on this rooftop (Sales Inbound is live). Window-independent — gates the STL
  // "not switched on" upsell so an empty window (e.g. "Today") shows "—" instead of a false upsell.
  stlEnabled: boolean;
  // % of real conversations the AI handled end-to-end (no transfer) — the workload-offload headline.
  // null when there are no conversations.
  handledEndToEndPct: number | null;
  afterHours: number;
  talkMinutes: number;
  smsSent: number; // OUTBOUND SMS messages sent (activity volume)
  smsThreads: number; // SMS CONVERSATIONS (threads) — the conversation-grained count for "Calls & texts"
  chats: number; // WEB CHAT sessions — same conversation grain; 0 on rooftops that don't run chat
  optOuts: number;
  csat: number;
  sentiment: number;
  connectRate: number; // blended connected-calls / calls across IB+OB — kept for back-compat
  // Inbound-only answer rate (answered inbound calls / inbound calls). The honest figure for a
  // "Connect / answer" cell, which is an inbound concept; null when the fleet has no inbound calls.
  answerRateInbound: number | null;
  // null === no prior-window basis ("new"); a number is a real % change (incl. 0).
  deltas: {
    appointments: number | null; leads: number | null; calls: number | null; conversations: number | null;
    qualified: number | null; sms: number | null; handoffs: number | null;
    talkMinutes: number | null; afterHours: number | null;
  };
  funnel: { label: string; value: number }[];
  bySplit: { inbound: FleetSplit; outbound: FleetSplit };
}

/* Server shape, tolerant of an older cached payload that only carried the rooftop scalar. Such a payload
 * cannot say WHICH department a booking belonged to, so all of it goes to `unknown`: "All" still counts
 * it and a department tile does not, which is the direction that cannot put a tile over its own list. */
function normalizeUnattributed(raw: unknown, total: unknown): { sales: number; service: number; unknown: number } {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    return { sales: n(r.sales), service: n(r.service), unknown: n(r.unknown) };
  }
  return { sales: 0, service: 0, unknown: n(total) };
}

/* The unattributed bookings THIS scope owns. A department tile takes only its own department's; only
 * the rooftop view ("All") adds the ones whose department could not be resolved at all. Passing the
 * rooftop total into a department scope is the bug this exists to prevent — see route.ts. */
export function unattributedApptsFor(feed: { appointmentsUnattributedBy?: { sales: number; service: number; unknown: number }; appointmentsUnattributed?: number } | null | undefined, dept: string): number {
  if (!feed) return 0;
  const by = normalizeUnattributed(feed.appointmentsUnattributedBy, feed.appointmentsUnattributed);
  if (dept === "sales") return by.sales;
  if (dept === "service") return by.service;
  return by.sales + by.service + by.unknown;
}

/* The rooftop's AI-assisted total for a department, straight from the appointment snapshot (see the
 * matching block in the reports route). Mirrors unattributedApptsFor: a department scope takes its own
 * department's, and only the rooftop view ("All") also picks up rows whose department is unresolved.
 * undefined when the API didn't send it (older deploy) → aggregateFleet keeps summing the agent rows. */
export function assistedApptsFor(feed: { appointmentsAssistedBy?: { sales: number; service: number; unknown: number } } | null | undefined, dept: string): number | undefined {
  const by = feed?.appointmentsAssistedBy;
  if (!by) return undefined;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  if (dept === "sales") return n(by.sales);
  if (dept === "service") return n(by.service);
  return n(by.sales) + n(by.service) + n(by.unknown);
}

/* Re-admit the server's `rooftop` object across the JSON boundary. The response is parsed as
 * Partial<FetchResult>, so every field is a CLAIM, not a guarantee — an older deploy, a truncated body
 * or a half-built object would otherwise hand rooftopRungsFor() a scope it cannot trust and open the
 * gate over nonsense. Anything that is not a complete, finite triple with a scope is dropped, and the
 * UI goes back to summing. */
function normalizeRooftop(raw: unknown): RooftopRungs | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const leadsAttempted = num(r.leadsAttempted), engaged = num(r.engaged), qualified = num(r.qualified);
  if (leadsAttempted === undefined || engaged === undefined || qualified === undefined) return undefined;
  if (typeof r.dept !== "string" || !r.dept) return undefined;
  if (!Array.isArray(r.agentTypes) || !r.agentTypes.every((t) => typeof t === "string")) return undefined;
  const triple = (v: unknown) => {
    if (!v || typeof v !== "object") return undefined;
    const o = v as Record<string, unknown>;
    const a = num(o.leadsAttempted), b = num(o.engaged), c = num(o.qualified);
    return a === undefined || b === undefined || c === undefined ? undefined : { leadsAttempted: a, engaged: b, qualified: c };
  };
  // deltaPct keeps null ("no prior basis") as a VALUE — dropping it to undefined would silently fall
  // through to a summed prior, which is the mismatch rungDelta exists to avoid.
  const pct = (v: unknown) => {
    if (!v || typeof v !== "object") return undefined;
    const o = v as Record<string, unknown>;
    const g = (k: string) => (o[k] === null ? null : num(o[k]));
    const a = g("leadsAttempted"), b = g("engaged"), c = g("qualified");
    return a === undefined || b === undefined || c === undefined ? undefined : { leadsAttempted: a, engaged: b, qualified: c };
  };
  return {
    dept: r.dept,
    agentTypes: r.agentTypes as string[],
    leadsAttempted, engaged, qualified,
    prior: triple(r.prior),
    deltaPct: pct(r.deltaPct),
    hotLeads: num(r.hotLeads),
  };
}

/* THE ROOFTOP'S DISTINCT RUNGS — but ONLY when `agents` is exactly the agent set the canonical API
 * computed them over. Mirrors unattributedApptsFor()/assistedApptsFor(): the caller hands over the
 * scope it is rendering and gets back that scope's own figure, or undefined.
 *
 * WHY A SET COMPARISON AND NOT THE DEPARTMENT SELECTOR. The canonical overview is fetched for
 * dept="sales" only (route.ts), and buildResult overlays it per agent BY AGENT TYPE, so Service agents
 * keep the aggregate's own numbers. On a dept="all" view of a rooftop that also runs Service, the
 * sales-only rooftop figure is not that view's answer — substituting it would DELETE every Service
 * lead from the rung, which is worse than the over-count it replaces. The department selector cannot
 * see that; comparing the agents on screen against the agents the API says it counted can, and the
 * same single predicate also catches a one-department, one-direction or one-agent subset, and any
 * call site that does not exist yet. It fails CLOSED: anything unrecognised falls back to summing.
 *
 * Idle agents are excluded on both sides. An agent the API reports with no lead activity cannot move
 * the rooftop number, and agentsForAccount() deliberately keeps a declared-but-idle agent on the CSM
 * sheet — comparing raw lists would read that as a mismatch and close the gate for no reason. */
export function rooftopRungsFor(
  feed: { rooftop?: RooftopRungs } | null | undefined,
  dept: string,
  agents: AgentData[],
): RooftopRungs | undefined {
  const r = feed?.rooftop;
  if (!r) return undefined;                                   // older deploy, no token, or the canonical call failed
  if (dept !== "all" && dept !== r.dept) return undefined;     // e.g. the Service tab: a sales-only figure is not its rooftop
  /* FAIL CLOSED ON AN UNKNOWN AGENT TYPE. This was `.map(...).filter(Boolean)`, which silently DROPPED
     any agentType this build cannot map. A backend that starts counting a new agent type would then
     widen the rooftop total while the predicate below still saw a matching set — so the gate would open
     over a total covering an agent that is not on screen. That is exactly the deletion this helper
     exists to prevent, arriving by the one path that looked harmless, and it contradicted the "fails
     CLOSED" contract stated above. An unmappable type now closes the gate and we keep summing. */
  const mapped = r.agentTypes.map((t) => ID_BY_AGENT_TYPE[t]);
  if (mapped.some((id) => !id)) return undefined;              // the API counted an agent type this build cannot map
  const covered = new Set(mapped);
  if (!covered.size) return undefined;                         // API counted nobody — nothing to substitute
  const live = agents.filter(hasAgentActivity);
  if (live.some((a) => !covered.has(a.id))) return undefined;  // an agent on screen the API never counted (e.g. Service on "All")
  const present = new Set(live.map((a) => a.id));
  for (const id of covered) if (!present.has(id)) return undefined; // a filtered subset of the scope
  return r;
}

/* The leads a distinct total and its Inbound/Outbound rows DISAGREE about: those worked by both
 * agents, counted once in the total and twice across the split. Once the rungs are the rooftop's own
 * distinct counts the bracket beside them stops adding up (253 over Inbound+Outbound = 270 on team
 * 3d3deabc98) — a dealer reads that as an arithmetic error unless it is named, which is the same rule
 * the appointments row already follows with its "no agent" residue. Derived from the two values
 * ACTUALLY RENDERED, never from a second source, so it can never drift from the rows beside it.
 * There is no canonical per-direction rooftop figure to fix the split itself with: the overview is
 * fetched without a `direction`, so the split stays agent-summed by necessity. */
export function workedByBoth(total: number, inbound: number, outbound: number): number {
  return Math.max(0, inbound + outbound - total);
}

/* ★ `rungs` must be scoped THE SAME WAY as `agents` — call rooftopRungsFor() with the same list and
 * the same dept, on the same line. Nothing in the type system enforces that pairing (the same shape of
 * mistake the ★ note on `unattributedAppointments` below exists for), and rooftopRungsFor() is what
 * decides whether substituting is safe at all. This function does NO scope inference of its own:
 * guessing from `agents.length` or a department string is exactly the guess that would make a filtered
 * view print a number that does not match the agent cards under it. */
export function aggregateFleet(agents: AgentData[], prior?: Record<string, Basis>, unattributedAppointments = 0, assistedTotal?: number, rungs?: RooftopRungs): FleetLive {
  const sum = (f: (a: AgentData) => number) => agents.reduce((s, a) => s + f(a), 0);
  const calls = sum((a) => a.metrics.calls);
  const connectedCalls = sum((a) => a.metrics.conversations); // connected CALLS — the answer-rate basis
  // Inbound-only slice for an honest answer rate (answer rate is an inbound concept; folding outbound
  // dial connect-rate into the same number makes it meaningless).
  const isInbound = (a: AgentData) => a.dir === "Inbound";
  const inboundCalls = agents.filter(isInbound).reduce((s, a) => s + a.metrics.calls, 0);
  const inboundAnswered = agents.filter(isInbound).reduce((s, a) => s + a.metrics.conversations, 0);
  const smsSent = sum((a) => a.metrics.smsSent);
  // SMS CONVERSATIONS (threads), not outbound messages — carried per-agent on channelSplit.sms (= sms_threads
  // from build.ts). This is the conversation-grained "texts" count for the "Calls & texts" tile, so a text
  // count that claims to be "conversations handled" matches a DB SMS-conversation count (RETCONVAI-4151/4166).
  const smsThreads = sum((a) => a.channelSplit?.sms ?? 0);
  // WEB CHAT sessions — the third channel, same conversation grain as smsThreads (migration 0021).
  const chats = sum((a) => a.metrics.chats ?? 0);
  const afterHours = sum((a) => a.metrics.afterHours);
  const talkMinutes = sum((a) => a.metrics.talkMinutes);
  const optOuts = sum((a) => a.metrics.optOuts);

  /* Unique-lead stages. The displayed "Leads touched"/"Conversations"/"Qualified" counts AND the funnel
   * all read these three locals, so a given label shows ONE number everywhere — which is also why all
   * three switch basis together or none does: replacing only `qualified` can break the monotonic
   * contract (reached >= engaged >= qualified) that LiveFunnelCard and the ROI PDF divide by.
   *
   * PREFERRED BASIS: the rooftop's OWN distinct counts, when the caller proved its agent list is the
   * scope the canonical API measured (see rooftopRungsFor). Summing the agent rows counts a lead worked
   * by two agents twice — real on both cards, one lead at the rooftop. Team 3d3deabc98: summed 270
   * qualified vs the rooftop's distinct 253, a 17-lead overlap. The comment that used to sit here
   * justified the sum as correct; it is correct per AGENT and wrong at rooftop grain.
   *
   * FALLBACK, verbatim as it shipped: sum the agent leadFunnels, or event counts when no agent carries
   * one. connectRate stays on connected CALLS either way (it is an answer rate, not a lead count). */
  const hasLeadFunnel = agents.some((a) => a.leadFunnel);
  const lf = (pick: (f: NonNullable<AgentData["leadFunnel"]>) => number) =>
    agents.reduce((s, a) => s + (a.leadFunnel ? pick(a.leadFunnel) : 0), 0);
  const conversations = rungs?.engaged ?? (hasLeadFunnel ? lf((f) => f.connected) : connectedCalls); // unique connected leads
  const qualified = rungs?.qualified ?? (hasLeadFunnel ? lf((f) => f.qualified) : sum((a) => a.metrics.qualified)); // unique qualified leads
  /* Rooftop AI-booked = every agent's, PLUS the bookings no agent owns. A meeting with no call, chat or
   * conversation behind it cannot be attributed to a direction, so it appears on no agent card — but it
   * is a real appointment and it IS in the rooftop list, so leaving it out of the rooftop number would
   * put that tile under its own list. Zero on nearly every rooftop; 2 of 103 on team 9923577d07.
   *
   * ★ `unattributedAppointments` must be SCOPED THE SAME WAY as `agents` — call unattributedApptsFor()
   * with the same dept. Handing a department-scoped tile the rooftop-wide number counts another
   * department's booking on this one (Principle BMW MINI: service read 46 over a list of 45). */
  const appointments = sum((a) => a.metrics.appointments) + unattributedAppointments;
  /* ROOFTOP AI-assisted. Prefer the snapshot total the caller passes: the spine can only attribute an
   * assist to an agent when the lead has an in-window conversation, so the agent sum is a SUBSET of the
   * meetings the CRM flags (2b110492b6, 30d: 19 vs 23). Falls back to the agent sum when the caller has
   * no snapshot total — an older API response, or a surface that never had one. The per-agent cards keep
   * reading their own metrics.appointmentsAssisted, which is the attributed half and correct AS a per-agent
   * number; only this rooftop roll-up is allowed to exceed their sum. */
  const appointmentsAssisted = assistedTotal ?? sum((a) => a.metrics.appointmentsAssisted ?? 0);
  // Hand-offs: transfers are lead-level (build prefers report_lead_counts), callbacks call-level daily
  // sums — both windowed. Failed transfers tracked separately, never added into transfers/handoffs.
  const cf = (f: (c: NonNullable<AgentData["report"]["callFlow"]>) => number) =>
    agents.reduce((s, a) => s + (a.report?.callFlow ? f(a.report.callFlow) : 0), 0);
  const transfers = cf((c) => c.transferred);
  const transfersFailed = cf((c) => c.transfersFailed ?? 0);
  const callbacks = cf((c) => c.callbacks ?? 0);
  const handoffs = transfers + callbacks;
  // Query resolution is an INBOUND concept: a customer asked something and the AI answered it. Outbound
  // reactivation has ~no query_resolved, so dividing by ALL conversations wrongly dilutes the rate (e.g.
  // to ~5% on outbound-heavy rooftops). Numerator AND denominator are inbound-only. query_resolved rides
  // on callFlow.handledByAI; the denominator is inbound real conversations (unique connected leads).
  // Numerator and denominator MUST be the same grain: query_resolved (callFlow.handledByAI) is a per-day
  // event sum, so the denominator is inbound connected CONVERSATIONS (metrics.conversations, also per-day
  // event-summed) — NOT window-distinct leadFunnel.connected, which would mismatch grains and pin the rate
  // at 100% on multi-day windows. resolved ⊆ connected, so the rate stays ≤ 100 naturally.
  const queryResolved = agents.filter(isInbound).reduce((s, a) => s + (a.report?.callFlow?.handledByAI ?? 0), 0);
  const queryConversations = agents.filter(isInbound).reduce((s, a) => s + a.metrics.conversations, 0);
  const queryResolutionRate = queryConversations > 0 ? Math.min(100, Math.round((100 * queryResolved) / queryConversations)) : null;
  // Leads touched = distinct leads the AI contacted (funnel entry). Rooftop-distinct when the gate is
  // open (see `conversations`/`qualified` above), else the unique-lead sum, else event counts.
  const leads = rungs?.leadsAttempted ?? (hasLeadFunnel ? lf((f) => f.contacted) : sum((a) => a.report?.leadsAttempted ?? 0));
  // Response time = the Sales-Inbound speed-to-lead avg (only slot with a new-lead first-response funnel).
  const responseTimeSec = agents.find((a) => a.id === "sales_ib")?.report.speedToLead?.avgSec ?? null;
  // Speed-to-Lead is a Sales-Inbound capability: it's ENABLED whenever the rooftop runs Sales Inbound.
  // This is window-INDEPENDENT — so a short window (e.g. "Today") with no new-lead sample shows "—",
  // NOT the "not switched on" upsell. The upsell only shows for rooftops that don't run Sales Inbound.
  const stlEnabled = agents.some((a) => a.id === "sales_ib");

  // Per-direction split for the hero tri-rows.
  const splitFor = (dir: "Inbound" | "Outbound"): FleetSplit => {
    const mine = agents.filter((a) => a.dir === dir);
    const s = (f: (a: AgentData) => number) => mine.reduce((acc, a) => acc + f(a), 0);
    const tr = s((a) => a.report?.callFlow?.transferred ?? 0);
    const cb = s((a) => a.report?.callFlow?.callbacks ?? 0);
    return {
      leads: s((a) => a.leadFunnel?.contacted ?? a.report?.leadsAttempted ?? 0),
      conversations: s((a) => a.leadFunnel?.connected ?? a.metrics.conversations),
      qualified: s((a) => a.leadFunnel?.qualified ?? a.metrics.qualified),
      appointments: s((a) => a.metrics.appointments),
      appointmentsAssisted: s((a) => a.metrics.appointmentsAssisted ?? 0),
      transfers: tr,
      transfersFailed: s((a) => a.report?.callFlow?.transfersFailed ?? 0),
      callbacks: cb,
      handoffs: tr + cb,
      calls: s((a) => a.metrics.calls),
      smsSent: s((a) => a.metrics.smsSent),
      talkMinutes: s((a) => a.metrics.talkMinutes),
      afterHours: s((a) => a.metrics.afterHours),
    };
  };

  // call-weighted quality so a low-volume agent can't swing the fleet number
  const wAvg = (f: (a: AgentData) => number) => (calls ? agents.reduce((s, a) => s + f(a) * a.metrics.calls, 0) / calls : 0);
  const pSum = (f: (b: Basis) => number) => agents.reduce((s, a) => s + (prior?.[a.id] ? f(prior[a.id]) : 0), 0);

  /* DELTA FOR A DISTINCT RUNG. Both halves of the division have to share one definition. Once the
   * CURRENT value is the rooftop's distinct count, dividing it by the agent-summed prior puts two
   * different definitions on either side of one division — worse than either alone, and the exact
   * defect the canonical prior-window overlay in build.ts was written to prevent.
   * Order: the API's own deltaPct (already null, not 0, for an empty prior window — same contract as
   * pctDelta), then its `previous` rooftop block, then NULL. Null renders as "New"/a dash, which is
   * honest; a mismatched percentage is not. Without the rungs, the summed delta exactly as before. */
  const rungDelta = (
    curr: number,
    fromApi: (d: NonNullable<RooftopRungs["deltaPct"]>) => number | null,
    fromPrior: (p: NonNullable<RooftopRungs["prior"]>) => number,
    fromSum: (b: Basis) => number,
  ): number | null => {
    if (!rungs) return pctDelta(curr, pSum(fromSum));
    if (rungs.deltaPct) return fromApi(rungs.deltaPct);
    if (rungs.prior) return pctDelta(curr, fromPrior(rungs.prior));
    return null;
  };

  // Funnel: every stage is distinct leads (monotonic: contacted ≥ connected ≥ qualified ≥ appt), with
  // the canonical wordings. Falls back to activity volumes only when no agent carries leadFunnel.
  const funnel = hasLeadFunnel
    ? [
        { label: "Leads reached", value: leads },
        { label: "Real conversations", value: conversations },
        { label: "Qualified leads", value: qualified },
        { label: "Appointments — AI-booked", value: appointments },
      ]
    : [
        { label: "Outreach & calls", value: calls + smsSent },
        { label: "Real conversations", value: connectedCalls },
        { label: "Qualified leads", value: qualified },
        { label: "Appointments — AI-booked", value: appointments },
      ];
  return {
    calls,
    leads,
    conversations,
    qualified,
    rungsAreDistinct: rungs != null,
    appointments,
    // Derived from the two direction splits rather than from unattributedAppointments directly, so it is
    // whatever the breakdown ACTUALLY leaves over — it cannot drift from the rows beside it.
    appointmentsNoAgent: Math.max(0, appointments - splitFor("Inbound").appointments - splitFor("Outbound").appointments),
    appointmentsAssisted,
    transfers,
    transfersFailed,
    callbacks,
    handoffs,
    queryResolved,
    queryConversations,
    queryResolutionRate,
    responseTimeSec,
    stlEnabled,
    /* A small residual over-count survives here by necessity when the rungs ARE distinct: the
       denominator is the rooftop's distinct conversations, but `transfers` is agent-summed and the API
       serves no rooftop equivalent, so a lead both agents transferred is subtracted twice. Bounded by
       the cross-agent overlap and in the conservative direction (the ratio reads low, never high). */
    handledEndToEndPct: conversations > 0 ? Math.max(0, Math.round(((conversations - transfers) / conversations) * 100)) : null,
    afterHours,
    talkMinutes,
    smsSent,
    smsThreads,
    chats,
    optOuts,
    csat: +wAvg((a) => a.quality.csat).toFixed(1),
    sentiment: Math.round(wAvg((a) => a.quality.sentiment)),
    connectRate: calls ? Math.round((connectedCalls / calls) * 100) : 0,
    answerRateInbound: inboundCalls ? Math.round((inboundAnswered / inboundCalls) * 100) : null,
    deltas: {
      appointments: pctDelta(appointments, pSum((b) => b.appointments)),
      leads: rungDelta(leads, (d) => d.leadsAttempted, (p) => p.leadsAttempted, (b) => b.leads),
      calls: pctDelta(calls, pSum((b) => b.calls)),
      conversations: rungDelta(conversations, (d) => d.engaged, (p) => p.engaged, (b) => b.conversations),
      qualified: rungDelta(qualified, (d) => d.qualified, (p) => p.qualified, (b) => b.qualified),
      sms: pctDelta(smsSent, pSum((b) => b.sms)),
      handoffs: pctDelta(handoffs, pSum((b) => (b.transfers ?? 0) + (b.callbacks ?? 0))),
      talkMinutes: pctDelta(talkMinutes, pSum((b) => b.talkMinutes ?? 0)),
      afterHours: pctDelta(afterHours, pSum((b) => b.afterHours ?? 0)),
    },
    funnel,
    bySplit: { inbound: splitFor("Inbound"), outbound: splitFor("Outbound") },
  };
}

// Client-side cache so switching back to a team/window doesn't re-hit the server. 5-minute TTL.
const CACHE = new Map<string, FetchResult>();
const CACHE_TTL_MS = 5 * 60 * 1000;

/* Cache key for a team + window. Relative buckets key by the bucket NAME (not a client-computed date
 * range) because the server now resolves the actual dates in the store's timezone — the client no
 * longer knows the exact window up front. Custom date-picker ranges key by their explicit dates. */
function cacheKeyFor(teamId: string, opts: LiveOpts): string {
  return opts.start && opts.end ? `${teamId}|${opts.start}|${opts.end}` : `${teamId}|b:${opts.bucket ?? "last30"}`;
}

/* Synchronously read a cached window without touching the network — lets the UI paint instantly when
 * you navigate back to a page (stale-while-revalidate: show what we have, then fetchAgents refreshes
 * in the background per the TTL). Returns whatever is cached regardless of age, or null. */
export function peekAgents(opts: LiveOpts = {}): FetchResult | null {
  if (!opts.teamId) return null;
  return CACHE.get(cacheKeyFor(opts.teamId, opts)) ?? null;
}

/* Fetch the materialized report for a team + window in ONE request to /api/reports (which reads the
 * Supabase aggregate the sync maintains). Replaces the previous ~84 Metabase round-trips. Keeps the
 * same FetchResult shape + client cache, so pages and aggregateFleet() are unchanged. On any network
 * error it falls back to mock agents so the report still renders. */
export async function fetchAgents(opts: LiveOpts = {}): Promise<FetchResult> {
  const teamId = opts.teamId || DEFAULT_TEAM_ID;
  const cacheKey = cacheKeyFor(teamId, opts);
  if (!opts.force) {
    const cached = CACHE.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;
  }

  // Relative buckets send the bucket NAME and let the server compute the window in the store's
  // timezone; custom ranges send explicit (store-local) dates. Either way the server owns the dates,
  // so they're consistent with the timezone it resolved.
  const query: Record<string, string> = opts.start && opts.end
    ? { team_id: teamId, start: opts.start, end: opts.end }
    : { team_id: teamId, bucket: opts.bucket ?? "last30" };
  if (opts.spyneEnv) query.env = opts.spyneEnv;

  // Forward the host's Spyne token (prod) as a Bearer header so /api/reports can resolve timezone +
  // onboarded agents. Omitted locally → the server falls back to its env token.
  const headers = opts.spyneToken ? { Authorization: `Bearer ${opts.spyneToken}` } : undefined;

  // Retry transient failures before giving up. A cold serverless start, a 504, or a momentary Supabase
  // blip makes the FIRST call fail/degrade — and a degraded response (no everLive, hasData:false) is
  // indistinguishable from "never live", so without a retry an established rooftop wrongly flips to the
  // "Coming soon" gate until the user manually refreshes. We retry with backoff and cache ONLY a clean
  // response, so a failure is never pinned for the 5-min TTL.
  const MAX_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const qs = new URLSearchParams(query);
      /* NOT "no-store". The route returns `private, max-age=900, stale-while-revalidate=1800`, and
         `no-store` here overrode it — so every reload went back to the server even when nothing had
         changed, and a reload landing on a cold Vercel instance paid the full 6-16s. Measured from the
         page: 5,442ms on a cold no-store fetch vs a flat ~240ms with the browser cache allowed.
         `force` (the Refresh button) sends "reload", which bypasses the browser copy and revalidates
         upstream — so refreshing always gets live numbers. */
      const r = await fetch(`/api/reports?${qs.toString()}`, { cache: opts.force ? "reload" : "default", headers });
      // Auth failures are TERMINAL — no credential to retry with. Retrying (and the page's self-heal
      // re-arm) would hammer the endpoint forever. Return a non-degraded result so the re-arm never fires.
      if (r.status === 401 || r.status === 403) {
        return { agents: [], hasData: false, unauthorized: true, authStatus: r.status, fetchedAt: Date.now(), prior: {} };
      }
      const j = (await r.json().catch(() => null)) as (Partial<FetchResult> & { degraded?: boolean }) | null;
      if (!r.ok || !j || !Array.isArray(j.agents)) throw new Error("bad /api/reports response");
      // Server flags a Supabase read failure as degraded (200 body, no everLive) → treat as transient.
      if (j.degraded) throw new Error("degraded /api/reports response");
      const result: FetchResult = {
        agents: j.agents as AgentData[],
        hasData: Boolean(j.hasData),
        everLive: typeof j.everLive === "boolean" ? j.everLive : undefined,
        fetchedAt: typeof j.fetchedAt === "number" ? j.fetchedAt : Date.now(),
        prior: (j.prior as Record<string, Basis>) ?? {},
        /* This object is an explicit ALLOW-LIST, not a spread — a field the server adds is dropped
           here unless it is named. */
        capturedAfterHours: typeof j.capturedAfterHours === "number" ? j.capturedAfterHours : undefined,
        rooftop: normalizeRooftop(j.rooftop),
        start: j.start,
        end: j.end,
        timezone: j.timezone ?? null,
        namedAppointments: Array.isArray(j.namedAppointments) ? (j.namedAppointments as NamedAppt[]) : undefined,
        syncedAt: typeof j.syncedAt === "string" ? j.syncedAt : null,
        appointmentsUnattributed: typeof j.appointmentsUnattributed === "number" ? j.appointmentsUnattributed : 0,
        appointmentsUnattributedBy: normalizeUnattributed(j.appointmentsUnattributedBy, j.appointmentsUnattributed),
        appointmentsAssistedBy: j.appointmentsAssistedBy && typeof j.appointmentsAssistedBy === "object"
          ? normalizeUnattributed(j.appointmentsAssistedBy, 0)
          : undefined,
        warmLeads: Array.isArray(j.warmLeads) ? (j.warmLeads as WarmLeadItem[]) : undefined,
      };
      CACHE.set(cacheKey, result); // cache ONLY a clean response
      return result;
    } catch {
      // back off then retry; ~0.4s, ~0.8s between attempts
      if (attempt < MAX_ATTEMPTS - 1) await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
    }
  }

  // All attempts failed/degraded → return a degraded result WITHOUT caching, so the next view or refresh
  // re-hits the server. degraded:true keeps the UI in the "syncing" state instead of the "coming soon"
  // gate or fake zeros.
  return { agents: [], hasData: false, degraded: true, fetchedAt: Date.now(), prior: {} };
}

/* Coming-soon metrics derived from ClickHouse and stored in Supabase by scripts/push_metrics.py — read
 * from GET /api/reports/metrics (rooftop-level, separate from the Q12227 aggregate fetchAgents reads).
 * Only the fields the UI renders are typed. Returns null when no rooftop / on any error → the widgets
 * stay on their "coming soon" placeholder, so a missing push never breaks the report. */
export interface TransferQualityMetric {
  service_type: string | null; // "sales" | "service"
  transfers_ok: number;
  transfers_failed: number;
  forwarded: number;
  success_rate: number | null;
}
export interface ReportMetrics {
  transfer_quality: TransferQualityMetric[];
  calls_by_reason: Array<{ direction: string | null; reason: string; calls: number; booked: number }>;
  missed: Array<{ service_type: string | null; channel: string; category: string; count: number }>;
  highlights: Array<{ direction: string | null; service_type: string | null; use_case: string | null; score: number | null; title: string | null; occurred_on: string | null }>;
  // Also pushed by the ETL and returned by GET /api/reports/metrics — carried through for the report
  // library (show-rate and objection reports). Absent sections degrade to [] like the rest.
  appt_status: Array<{ service_type: string | null; booked_via: string | null; booked: number; showed: number; no_show: number; cancelled: number; upcoming: number }>;
  objections: Array<{ kind: string; label: string; channel: string | null; count: number }>;
}

export async function fetchReportMetrics(teamId: string, spyneToken?: string): Promise<ReportMetrics | null> {
  if (!teamId) return null;
  try {
    // Forward the host's Spyne token (prod) so the now-authenticated GET /api/reports/metrics authorizes,
    // same as fetchAgents/fetchMeetings. Omitted locally → the server falls back to its env token.
    const headers = spyneToken ? { Authorization: `Bearer ${spyneToken}` } : undefined;
    const r = await fetch(`/api/reports/metrics?team_id=${encodeURIComponent(teamId)}`, { cache: "no-store", headers });
    if (!r.ok) return null;
    const j = (await r.json()) as Partial<ReportMetrics> | null;
    if (!j) return null;
    return {
      transfer_quality: Array.isArray(j.transfer_quality) ? j.transfer_quality : [],
      calls_by_reason: Array.isArray(j.calls_by_reason) ? j.calls_by_reason : [],
      missed: Array.isArray(j.missed) ? j.missed : [],
      highlights: Array.isArray(j.highlights) ? j.highlights : [],
      appt_status: Array.isArray(j.appt_status) ? j.appt_status : [],
      objections: Array.isArray(j.objections) ? j.objections : [],
    };
  } catch {
    return null;
  }
}

/* ── Action items (dealer_leads.actionItems via /api/action-items) ─────────────────────────────────
 * Two shapes: the working LIST (scope=open/overdue) and the rooftop STATS scoreboard (scope=stats:
 * created/closed in-window + open/overdue/due-today now + who-closed-most). Both auth-required — forward
 * the host Spyne token in prod (omitted locally → server env / dev bypass). Return null / [] on error. */
export interface ActionItem {
  id: string;
  intent: string;
  leadId: string | null;
  assignedTo: string | null;
  description: string;
  priority: string;
  completed: boolean;
  dept: "sales" | "service" | "other";
  customer: string | null;
  phone: string | null;
  dueAt: string;
  at: string;
}
export interface ActionItemStats { created: number; completed: number; open: number; overdue: number; dueToday: number }
export interface ActionItemCloser { assignedTo: string; closed: number }

export async function fetchActionItemStats(
  teamId: string,
  opts: { start?: string; end?: string; bucket?: Bucket; service?: "sales" | "service" | "both"; spyneToken?: string; spyneEnv?: string } = {},
): Promise<{ stats: ActionItemStats; closers: ActionItemCloser[] } | null> {
  if (!teamId) return null;
  const query: Record<string, string> = { team_id: teamId, scope: "stats", serviceType: opts.service ?? "both" };
  // Explicit start/end (custom picker, or the Overview's server-resolved window) win. Otherwise pass the
  // preset `bucket` and let the server resolve it store-local (RETCONVAI-4144) — never compute a UTC window
  // client-side here, which is what drifted the Action Items tab off the Overview card.
  if (opts.start && opts.end) { query.start = opts.start; query.end = opts.end; }
  else if (opts.bucket) { query.bucket = opts.bucket; }
  if (opts.spyneEnv) query.env = opts.spyneEnv;
  try {
    const headers = opts.spyneToken ? { Authorization: `Bearer ${opts.spyneToken}` } : undefined;
    const r = await fetch(`/api/action-items?${new URLSearchParams(query)}`, { cache: "default", headers });
    if (!r.ok) return null;
    const j = (await r.json().catch(() => null)) as { stats?: ActionItemStats; closers?: ActionItemCloser[] } | null;
    if (!j || !j.stats) return null;
    return { stats: j.stats, closers: Array.isArray(j.closers) ? j.closers : [] };
  } catch {
    return null;
  }
}

export async function fetchActionItems(
  teamId: string,
  opts: { scope?: "open" | "overdue" | "recent" | "created"; service?: "sales" | "service" | "both"; limit?: number; start?: string; end?: string; spyneToken?: string } = {},
): Promise<ActionItem[]> {
  if (!teamId) return [];
  const query: Record<string, string> = {
    team_id: teamId,
    scope: opts.scope ?? "open",
    serviceType: opts.service ?? "both",
    limit: String(opts.limit ?? 100),
  };
  // scope=created is windowed — pass the report's store-local window so it matches the stats/hero counts.
  if (opts.start && opts.end) { query.start = opts.start; query.end = opts.end; }
  try {
    const headers = opts.spyneToken ? { Authorization: `Bearer ${opts.spyneToken}` } : undefined;
    const r = await fetch(`/api/action-items?${new URLSearchParams(query)}`, { cache: "default", headers });
    const j = (await r.json().catch(() => null)) as { actionItems?: ActionItem[] } | null;
    if (!r.ok || !j || !Array.isArray(j.actionItems)) return [];
    return j.actionItems;
  } catch {
    return [];
  }
}

/* Paginated variant for exports (CSV/XLSX) — the on-screen queue only ever wants a bounded preview
 * (fetchActionItems above), but "download everything the report is showing" means the export can't
 * silently stop at one page. Pages via `offset` + the API's `hasMore` flag (server hard-caps `limit`
 * at 200 regardless of what's requested) until a page comes back short, capped at 25 pages (5,000
 * items) as a backstop against a pathological backlog looping forever. */
export async function fetchAllActionItems(
  teamId: string,
  opts: { scope?: "open" | "overdue" | "recent"; service?: "sales" | "service" | "both"; spyneToken?: string } = {},
): Promise<ActionItem[]> {
  if (!teamId) return [];
  const headers = opts.spyneToken ? { Authorization: `Bearer ${opts.spyneToken}` } : undefined;
  const pageSize = 200;
  const all: ActionItem[] = [];
  for (let page = 0; page < 25; page++) {
    const query: Record<string, string> = {
      team_id: teamId,
      scope: opts.scope ?? "open",
      serviceType: opts.service ?? "both",
      limit: String(pageSize),
      offset: String(page * pageSize),
    };
    try {
      const r = await fetch(`/api/action-items?${new URLSearchParams(query)}`, { cache: "default", headers });
      const j = (await r.json().catch(() => null)) as { actionItems?: ActionItem[]; hasMore?: boolean } | null;
      if (!r.ok || !j || !Array.isArray(j.actionItems)) break;
      all.push(...j.actionItems);
      if (!j.hasMore) break;
    } catch {
      break;
    }
  }
  return all;
}

/* ── Customers / lead book (dealer_leads.leads via /api/customers) ── */
export interface Customer {
  leadId: string | null;
  customer: string;
  phone: string | null;
  source: string;
  status: string;
  statusBucket: "active" | "sold" | "lost" | "service" | "other";
  sold: boolean;
  crmLeadId: string | null;
  lastActivity: string;
}
export async function fetchCustomers(
  teamId: string,
  opts: { bucket?: "active" | "sold" | "lost" | "service" | "all"; q?: string; limit?: number; spyneToken?: string } = {},
): Promise<Customer[]> {
  if (!teamId) return [];
  const query: Record<string, string> = { team_id: teamId, bucket: opts.bucket ?? "all", limit: String(opts.limit ?? 100) };
  if (opts.q) query.q = opts.q;
  try {
    const headers = opts.spyneToken ? { Authorization: `Bearer ${opts.spyneToken}` } : undefined;
    const r = await fetch(`/api/customers?${new URLSearchParams(query)}`, { cache: "no-store", headers });
    const j = (await r.json().catch(() => null)) as { customers?: Customer[] } | null;
    if (!r.ok || !j || !Array.isArray(j.customers)) return [];
    return j.customers;
  } catch {
    return [];
  }
}

/* ── Recent conversations (dealer_leads.endcallreports / smsMessages via /api/conversations) ── */
export interface Conversation {
  id: string;
  leadId: string | null;
  callId?: string | null;
  phone: string | null;
  customer: string | null;
  email?: string | null;
  channel: "call" | "sms";
  dept: "sales" | "service" | "other";
  agent?: string | null; // AI agent name (calls)
  direction: "inbound" | "outbound";
  title: string; // the call's intent/title
  summary: string;
  vehicle?: string | null; // vehicle of interest (from report_sales.vehicleRequested)
  durationSec?: number; // call length in seconds
  recordingUrl?: string | null; // call recording (calls)
  score?: number; // AI score out of 10 (report_aiScore_totalScore)
  sentiment?: string; // "Neutral" | "Negative" (derived from frustration)
  outcome?: string; // "Resolved" | "Not Resolved" (derived from query resolution)
  appointmentScheduled: boolean;
  queryResolved: boolean;
  hasActionItem: boolean;
  aiScore?: number | null; // AI-quality scorePercentage (0-100), when present
  grade?: string | null;
  frustrated?: boolean;
  msgs?: number;
  // SMS-thread rows only: the message bubbles (oldest→newest), for the preview drawer.
  sms?: { authorType: string; body: string; status: string; at: string; direction: string }[];
  at: string;
}
export async function fetchConversations(
  teamId: string,
  opts: { channel?: "call" | "sms" | "both"; service?: "sales" | "service" | "both"; since?: string; end?: string; bucket?: Bucket; leadId?: string; limit?: number; spyneToken?: string; spyneEnv?: string } = {},
): Promise<Conversation[]> {
  if (!teamId) return [];
  const query: Record<string, string> = {
    team_id: teamId,
    channel: opts.channel ?? "call",
    serviceType: opts.service ?? "both",
    limit: String(opts.limit ?? 100),
  };
  // Prefer an explicit [since,end) window (already store-local from the server-resolved feed); else pass
  // the preset `bucket` and let the server resolve a store-local window (RETCONVAI-4152). `since` alone
  // (no end) keeps the old "since → now" behaviour used by the transactional-email poll.
  if (opts.since) query.since = opts.since;
  if (opts.end) query.end = opts.end;
  else if (opts.bucket && !opts.since) query.bucket = opts.bucket;
  // Lead-scoped drill-down: fetch this lead's full recent history (server ignores the time window).
  if (opts.leadId) query.leadId = opts.leadId;
  if (opts.spyneEnv) query.env = opts.spyneEnv;
  try {
    const headers = opts.spyneToken ? { Authorization: `Bearer ${opts.spyneToken}` } : undefined;
    const r = await fetch(`/api/conversations?${new URLSearchParams(query)}`, { cache: "no-store", headers });
    const j = (await r.json().catch(() => null)) as { conversations?: Conversation[] } | null;
    if (!r.ok || !j || !Array.isArray(j.conversations)) return [];
    return j.conversations;
  } catch {
    return [];
  }
}

export interface MeetingFetchOpts {
  teamId: string;
  enterpriseId?: string; // host-forwarded on the iframe URL; else the server decodes it from the token
  service?: "sales" | "service" | "both"; // default "both" (rooftop-wide)
  scope?: "window" | "upcoming"; // "upcoming" = from now forward; "window" = the report's date range
  bucket?: Bucket;
  start?: string;
  end?: string;
  agentType?: string; // report slot id (sales_ib/…) — scopes the drill to that agent's booked leads
  spyneToken?: string; // host-forwarded Spyne token (prod); omit locally (server uses env)
  spyneEnv?: string; // host-forwarded ?env=uat|stag|prod — which Spyne backend the server should call
}

/* Fetch the meeting/appointment records behind an appointment count (scope:"window") or the upcoming
 * bookings (scope:"upcoming") via /api/meetings, which proxies the Spyne product API server-side so the
 * token never reaches the browser. Returns an empty list on any error → the card/modal shows its empty
 * state rather than breaking. */
export async function fetchMeetings(opts: MeetingFetchOpts): Promise<MeetingsResult> {
  const { teamId, enterpriseId, service = "both", scope = "window", bucket, start, end, agentType, spyneToken, spyneEnv } = opts;
  const query: Record<string, string> = { team_id: teamId, serviceType: service, scope };
  if (enterpriseId) query.enterprise_id = enterpriseId;
  if (spyneEnv) query.env = spyneEnv;
  if (scope === "window") {
    if (start && end) { query.start = start; query.end = end; }
    else query.bucket = bucket ?? "last30";
    if (agentType) query.agent_type = agentType;
  }
  try {
    const qs = new URLSearchParams(query);
    const headers = spyneToken ? { Authorization: `Bearer ${spyneToken}` } : undefined;
    const r = await fetch(`/api/meetings?${qs.toString()}`, { cache: "no-store", headers });
    const j = (await r.json().catch(() => null)) as Partial<MeetingsResult> | null;
    if (!r.ok || !j || !Array.isArray(j.meetings)) return { meetings: [], total: 0 };
    return { meetings: j.meetings as Meeting[], total: typeof j.total === "number" ? j.total : j.meetings.length };
  } catch {
    return { meetings: [], total: 0 };
  }
}
