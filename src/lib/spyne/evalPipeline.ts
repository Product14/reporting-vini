/* Conversation-outcome evals (Spyne "eval pipeline") — SALES only, split inbound / outbound.
 *
 * The eval pipeline scores each AI conversation post-hoc and answers three questions the report's own
 * aggregate can't: what the caller actually wanted (callType → primaryIntent), what outcome the AI
 * reached vs what was reachable (outcomeAchieved / outcomeAchievable / outcomeGap), and where the path
 * to an appointment or a transfer broke (funnelEval steps, incl. LLM-judged ones).
 *
 * ─────────────────────────── WHY WE READ THE *LIST* ENDPOINT ───────────────────────────
 * There are three purpose-built dashboard endpoints (call-flow-summary, funnels/summary, tool-metrics),
 * but their query DTOs accept only enterpriseId / teamId / dates (+ callType / primaryIntent /
 * secondaryIntent) — verified against the backend source (src/eval-pipeline/dto/*.dto.ts) and by probing
 * prod, which rejects anything else with `property <x> should not exist`. They therefore CANNOT scope to
 * a department or a direction: one call blends Sales with Service, and inbound with outbound.
 *
 * `GET /conversation/eval-pipeline` (the paginated list) DOES accept `agentType` and `agentCallType`, so
 * we page the raw scored conversations for agentType=sales + one direction and aggregate them here into
 * the same shapes the dashboard endpoints return. That is the only API-sourced way to honour
 * "sales only, inbound and outbound separately".
 *
 * BACKEND ASK: add `agentType` / `agentCallType` to QueryCallFlowDto, QueryFunnelSummaryDto and
 * QueryToolCallMetricsDto (they already exist on QueryConversationEvalDto) and this module collapses to
 * three plain proxy calls, with the funnel/tool caveats below disappearing.
 *
 * ─────────────────────────── WINDOWING: EVAL-RUN TIME vs CONVERSATION TIME ───────────────────────────
 * Every eval endpoint filters on the eval doc's own `createdAt` — which is when the SCORER ran, not when
 * the conversation happened. Those diverge by days (a 2026-07-28 call scored on 2026-08-05 was observed
 * in prod), and eval volume by createdAt is lumpy in backfill batches, so filtering on it would put
 * weeks-old calls inside a "last 7 days" window and drop yesterday's calls that aren't scored yet.
 *
 * So we ask the API for createdAt ≥ window start (no upper bound — a late-scored in-window call must not
 * be missed) and then re-window each conversation on its OWN start time, decoded from the UUIDv7
 * `conversationId` whose first 48 bits are the unix-ms timestamp. Verified against
 * conversational_ai_pg.calls.started_at: the decoded time matched within seconds on every row checked,
 * and eval `agentCallType` agreed with `calls.direction` on 444/444 conversations for the probe rooftop.
 * A conversationId that isn't UUIDv7-shaped is KEPT (dated by createdAt) rather than silently dropped.
 */

import { spyneGet, cached } from "./client";

// ───────────────────────── shapes ─────────────────────────

export type EvalDirection = "inbound" | "outbound";

/** One outcome rung → how many conversations ended there. Keys are OutcomeLevel values. */
export type OutcomeTally = Record<string, number>;

export interface EvalIntentGroup {
  id: string;
  label: string;
  total: number;
  outcomes: OutcomeTally;
}

export interface EvalCallTypeGroup {
  id: string;
  label: string;
  /** True for the call types that are unambiguously a sales conversation (drives the funnel cohort). */
  sales: boolean;
  total: number;
  outcomes: OutcomeTally;
  primaries: EvalIntentGroup[];
}

export interface EvalFunnelStep {
  key: string;
  label: string;
  count: number;
  /** LLM-judged step (no deterministic system signal) — the UI marks these. */
  llm: boolean;
}

export interface EvalFunnel {
  key: string;
  label: string;
  totalEligible: number;
  steps: EvalFunnelStep[];
}

export interface EvalToolMetric {
  tool: string;
  label: string;
  ok: number;
  failed: number;
  total: number;
  failRate: number | null;
  errors: { errorType: string; count: number }[];
}

/** Everything one direction of one rooftop's SALES evals says, for the selected window. */
export interface EvalOutcomes {
  dir: EvalDirection;
  /** Every conversation the eval pipeline scored in this window — engaged + ghost. */
  scored: number;
  /* GHOST — scored but never actually engaged: the caller hung up, went silent, or hit voicemail before
   * anything could be established. Set aside from the flow (it would otherwise be one enormous grey bar
   * — 303 of 339 on an outbound rooftop) and reported as its own line. Verified against the call log:
   * these run 17s median and end in customer_hangup / silence_timeout / voicemail, where the rest run
   * 43s and end in assistant_ended / transferred. */
  ghost: number;
  /** scored − ghost: the conversations that actually happened. Denominator for the quality rates. */
  engaged: number;
  /* SMS conversations the scorer rated for this agent, NOT included anywhere above — this panel is
   * call-only (see the channel note in listSalesEvals). Counted by scoring date rather than conversation
   * time (it's a cheap head request), so treat it as indicative; it exists so the exclusion is visible
   * rather than silent. Null when the count couldn't be fetched. */
  smsScored: number | null;
  /** Call-type lanes for the flow — GHOST EXCLUDED. Lane shares are of `scored`, so lanes + ghost = 100%. */
  groups: EvalCallTypeGroup[];
  secondary: { id: string; label: string; count: number }[];
  outcomes: OutcomeTally;
  /** Scored conversations where a better outcome was reachable than the one achieved. */
  outcomeGap: number;
  /** Buying-intent conversations (canonical "Qualified lead" rung, or an Appointment/Transfer above it). */
  qualified: number;
  avgScore: number | null;
  interest: Record<string, number>;
  funnels: EvalFunnel[];
  tools: EvalToolMetric[];
  /* Funnel + tool cohort caveat, surfaced in the UI. "exact" — this rooftop scored only THIS direction in
   * the window, so the call-type-matched cohort can't contain the other one. "sales-approx" — the cohort
   * is sales call types across both directions (see the backend ask above). */
  derivedScope: "exact" | "sales-approx";
  /** Sales-intent conversations behind the funnels (the funnel cohort size, not `scored`). */
  funnelBase: number;
}

// ───────────────────────── labels ─────────────────────────

/* Call types that ARE a sales conversation. The rest (no_signal, human_request, operational, other, …)
 * are raised by sales AND service agents alike, so they can't narrow a cohort by department — which is
 * why the funnel/tool fan-out below uses only this set. Mirrors the buckets the eval dashboard treats as
 * its sales base. */
const SALES_CALL_TYPES = new Set([
  "sales_shopping",
  "sales_routing",
  "sales_appointment_booking",
  "price_inquiry",
  "inventory_browse",
  "test_drive_scheduling",
  "financing_new_inquiry",
  "finance_routing",
  "trade_in_inquiry",
]);

/* Call types that mean "nothing was established" — see the `ghost` field. `No Intent Captured` shows up
 * as a callType (not just an intent) on a large slice of rows, so both spellings are folded in. */
const GHOST_CALL_TYPES = new Set(["no_signal", "No Intent Captured", "no_intent_captured", ""]);

const CALL_TYPE_LABELS: Record<string, string> = {
  sales_shopping: "Shopping a vehicle",
  sales_routing: "Asked for sales dept",
  sales_appointment_booking: "Appointment request",
  price_inquiry: "Pricing / payment",
  inventory_browse: "Browsing inventory",
  test_drive_scheduling: "Test drive",
  financing_new_inquiry: "Financing",
  finance_routing: "Finance question",
  trade_in_inquiry: "Trade-in",
  service_routing: "Service (misrouted)",
  service_appointment_new: "Service appointment",
  parts_routing: "Parts",
  parts_inquiry: "Parts question",
  human_request: "Asked for a person",
  operational: "Hours / operational",
  no_signal: "No signal captured",
  other: "Other / misc",
};

const INTENT_LABELS: Record<string, string> = {
  vehicle_availability: "Vehicle availability",
  price_inquiry: "Pricing / payment",
  inventory_browse: "Browsing inventory",
  sales_appointment_booking: "Appointment request",
  callback_scheduling: "Callback request",
  delivery_logistics: "Delivery / logistics",
  financing_new_inquiry: "Financing",
  financing_status_check: "Financing status",
  test_drive_scheduling: "Test drive",
  reach_sales_dept: "Reach sales dept",
  reach_named_employee: "Reach a person",
  return_missed_call: "Returning a call",
  carfax_vehicle_history: "Vehicle history",
  features_configuration: "Features / config",
  human_escalation: "Talk to a human",
  hours_location: "Hours / location",
  wrong_number: "Wrong number",
  privacy_dnc_request: "Do not call",
  complaint_dissatisfaction: "Complaint",
  trade_in_valuation: "Trade-in value",
  "No Intent Captured": "No intent captured",
};

const FUNNEL_LABELS: Record<string, string> = {
  Appointment: "Appointment",
  Transfer: "Transfer",
  Callback: "Callback",
};

/* Step labels are written for the DEALER, not the pipeline. The raw keys name internal mechanics
 * ("bookingToolCalled", "crmAppointmentWritten") which mean nothing in a showroom — these say what
 * happened with the customer instead. */
const STEP_LABELS: Record<string, string> = {
  step1_conversationReached: "Reached the customer",
  step2_intentIdentifiedAsSales: "Wanted to buy",
  step3_buyerQualified: "Qualified buyer",
  step4_appointmentPitched: "Offered an appointment",
  step5_customerAgreed: "Customer said yes",
  step6_bookingToolCalled: "Appointment created",
  step7_crmAppointmentWritten: "Confirmed in your CRM",
  step2_transferTriggerIdentified: "Asked for a person",
  step3_transferToolCalled: "Call put through",
  step4_transferConnected: "Reached someone",
  step2_callbackRequested: "Asked for a call back",
  step3_callbackToolCalled: "Call back logged",
  step4_callbackLogged: "Call back scheduled",
};

const TOOL_LABELS: Record<string, string> = {
  communication_transfer_call_v3: "Transfer to a human",
  communication_transfer_call_v2: "Transfer to a human (v2)",
  warm_transfer: "Warm transfer",
  sales_create_meeting: "Appointment booking",
  inventory_search_vehicles_v3: "Inventory search",
  inventory_search_vehicles: "Inventory search",
  inventory_get_carfax_history: "Vehicle history lookup",
  dealership_check_hours: "Hours lookup",
  get_finance_offers_tool: "Finance offers",
  communication_send_sms: "Send SMS",
  communication_get_details: "Lead details",
  communication_end_call: "End call",
  end_call: "End call",
  get_current_datetime: "Date / time",
};

/** Human label for a snake_case id, falling back to a de-underscored Sentence case. */
function pretty(id: string, dict: Record<string, string>): string {
  if (dict[id]) return dict[id];
  const s = id.replace(/[_-]+/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Unclassified";
}

// ───────────────────────── UUIDv7 → conversation start time ─────────────────────────

const UUID7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* Conversation start time in unix ms, decoded from a UUIDv7 conversationId (first 48 bits = ms since
 * epoch). Returns null for any id that isn't UUIDv7 — the caller then dates the row by its eval
 * createdAt rather than dropping it. */
export function conversationStartedAtMs(conversationId: string): number | null {
  if (!UUID7_RE.test(conversationId)) return null;
  const ms = Number.parseInt(conversationId.replace(/-/g, "").slice(0, 12), 16);
  // Sanity floor/ceiling: a decoded time outside [2020, now+1d] means the id isn't a timestamped v7.
  if (!Number.isFinite(ms) || ms < 1_577_836_800_000 || ms > Date.now() + 86_400_000) return null;
  return ms;
}

// ───────────────────────── raw API shapes ─────────────────────────

interface RawEval {
  conversationId?: string;
  callId?: string | null;
  agentType?: string;
  agentCallType?: string;
  channel?: string;
  callType?: string;
  primaryIntent?: string | null;
  secondaryIntent?: string[] | null;
  outcomeAchieved?: string;
  outcomeAchievable?: string;
  outcomeGap?: boolean;
  conversationScore?: number | null;
  interest?: string | null;
  createdAt?: string;
}

/* NOTE the two envelope shapes. The LIST endpoint spreads its result (`{ success, data: [...], total }`),
 * so its rows are at top level — but the dashboard endpoints nest theirs (`{ success, data: { funnels } }`).
 * Reading `.funnels` off the envelope silently yields undefined, i.e. an empty funnel with no error. */
interface RawFunnelSummary {
  data?: {
    funnels?: {
      funnelKey?: string;
      totalEligible?: number;
      steps?: { key?: string; order?: number; evidenceSource?: string; count?: number }[];
    }[];
  };
}

interface RawToolMetrics {
  data?: {
    tools?: {
      toolName?: string;
      ok?: number;
      failed?: number;
      total?: number;
      errors?: { errorType?: string; count?: number }[];
    }[];
  };
}

// ───────────────────────── paging ─────────────────────────

const PAGE_SIZE = 200;
const MAX_PAGES = 25; // 5 000 scored conversations per direction — far above any rooftop's 30-day volume

/* Every scored SALES conversation for one direction whose own start time falls in [startMs, endMs).
 * The API window is start-open-ended on purpose (see the header note on eval-run vs conversation time). */
async function listSalesEvals(
  args: { enterpriseId: string; teamId: string; dir: EvalDirection; agentType: "sales" | "service"; startISO: string },
  token?: string | null,
  env?: string | null,
): Promise<RawEval[] | null> {
  const rows: RawEval[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const qs = new URLSearchParams({
      enterpriseId: args.enterpriseId,
      teamId: args.teamId,
      agentType: args.agentType,
      agentCallType: args.dir,
      // CALLS ONLY. SMS conversations are scored by the same pipeline and are 37% of the sales cohort
      // fleet-wide — but this panel's coverage line divides by the agent's CALL count, and both funnels
      // and the tool metrics are call-based (tool-metrics joins through endcallreports). Mixing SMS in
      // inflated the numerator against a call denominator. The SMS cohort is counted separately and
      // stated on the card so it reads as deliberately excluded, not missing.
      channel: "call",
      startDate: args.startISO,
      page: String(page),
      limit: String(PAGE_SIZE),
    });
    const res = await spyneGet<{ data?: RawEval[]; total?: number }>(`/conversation/eval-pipeline?${qs}`, token, env);
    // A failed FIRST page is a real failure (→ null, caller degrades). A failure mid-paging keeps what we
    // have rather than throwing the whole window away, so a blip can only under-count.
    if (!res) return page === 1 ? null : rows;
    const batch = Array.isArray(res.data) ? res.data : [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return rows;
}

// ───────────────────────── aggregation ─────────────────────────

function bump(t: OutcomeTally, k: string): void {
  t[k] = (t[k] ?? 0) + 1;
}

/* callType → primaryIntent → outcomeAchieved, the same nesting call-flow-summary returns, but built from
 * a cohort we could actually scope to sales + one direction. */
function groupFlow(rows: RawEval[]): EvalCallTypeGroup[] {
  const byType = new Map<string, { total: number; outcomes: OutcomeTally; primaries: Map<string, { total: number; outcomes: OutcomeTally }> }>();
  for (const r of rows) {
    const ct = (r.callType || "no_signal").trim() || "no_signal";
    const pi = (r.primaryIntent || "__none__").trim() || "__none__";
    const oc = (r.outcomeAchieved || "None").trim() || "None";
    const g = byType.get(ct) ?? { total: 0, outcomes: {}, primaries: new Map() };
    g.total++;
    bump(g.outcomes, oc);
    const p = g.primaries.get(pi) ?? { total: 0, outcomes: {} };
    p.total++;
    bump(p.outcomes, oc);
    g.primaries.set(pi, p);
    byType.set(ct, g);
  }
  return [...byType.entries()]
    .map(([id, g]) => ({
      id,
      label: pretty(id, CALL_TYPE_LABELS),
      sales: SALES_CALL_TYPES.has(id),
      total: g.total,
      outcomes: g.outcomes,
      primaries: [...g.primaries.entries()]
        .map(([pid, p]) => ({
          id: pid,
          label: pid === "__none__" ? "Unclassified" : pretty(pid, INTENT_LABELS),
          total: p.total,
          outcomes: p.outcomes,
        }))
        .sort((a, b) => b.total - a.total),
    }))
    // Sales buckets first (the dealer cares about those), then by volume.
    .sort((a, b) => (a.sales === b.sales ? b.total - a.total : a.sales ? -1 : 1));
}

function topSecondary(rows: RawEval[], max = 10): { id: string; label: string; count: number }[] {
  const tally = new Map<string, number>();
  for (const r of rows) for (const s of r.secondaryIntent ?? []) if (s) tally.set(s, (tally.get(s) ?? 0) + 1);
  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([id, count]) => ({ id, label: pretty(id, INTENT_LABELS), count }));
}

/* The funnels for the sales-intent slice of this cohort. funnels/summary can only be narrowed by
 * callType, so we fan out over the sales call types actually present and sum — a conversation carries
 * exactly one callType, so the per-callType cohorts are disjoint and the step counts add cleanly. */
async function fetchFunnels(
  args: { enterpriseId: string; teamId: string; startISO: string; endISO: string; callTypes: string[] },
  token?: string | null,
  env?: string | null,
): Promise<{ funnels: EvalFunnel[]; base: number }> {
  const results = await Promise.all(
    args.callTypes.map((ct) => {
      const qs = new URLSearchParams({
        enterpriseId: args.enterpriseId,
        teamId: args.teamId,
        startDate: args.startISO,
        endDate: args.endISO,
        callType: ct,
      });
      return spyneGet<RawFunnelSummary>(`/conversation/eval-pipeline/funnels/summary?${qs}`, token, env);
    }),
  );

  // funnelKey → step key → summed count, keeping first-seen order/evidence per step.
  type Acc = { eligible: number; order: string[]; counts: Map<string, number>; llm: Set<string> };
  const merged = new Map<string, Acc>();
  for (const res of results) {
    for (const f of res?.data?.funnels ?? []) {
      const key = (f.funnelKey || "").trim();
      if (!key) continue;
      const m: Acc = merged.get(key) ?? { eligible: 0, order: [], counts: new Map(), llm: new Set() };
      m.eligible += f.totalEligible ?? 0;
      for (const s of [...(f.steps ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
        const sk = (s.key || "").trim();
        if (!sk) continue;
        if (!m.counts.has(sk)) m.order.push(sk);
        m.counts.set(sk, (m.counts.get(sk) ?? 0) + (s.count ?? 0));
        if (s.evidenceSource === "llm") m.llm.add(sk);
      }
      merged.set(key, m);
    }
  }

  const funnels: EvalFunnel[] = [...merged.entries()].map(([key, m]) => ({
    key,
    label: pretty(key, FUNNEL_LABELS),
    totalEligible: m.eligible,
    steps: m.order.map((sk) => ({ key: sk, label: pretty(sk, STEP_LABELS), count: m.counts.get(sk) ?? 0, llm: m.llm.has(sk) })),
  }));
  // Appointment first, then Transfer, then anything else — the order the report reads in.
  const rank = (k: string) => (k === "Appointment" ? 0 : k === "Transfer" ? 1 : 2);
  funnels.sort((a, b) => rank(a.key) - rank(b.key));
  const base = Math.max(0, ...funnels.map((f) => f.totalEligible), 0);
  return { funnels, base };
}

/* Tool execution for the same sales-intent slice — tool-metrics is likewise callType-narrowable only, so
 * it gets the same fan-out, then rows are merged per tool. */
async function fetchTools(
  args: { enterpriseId: string; teamId: string; startISO: string; endISO: string; callTypes: string[] },
  token?: string | null,
  env?: string | null,
): Promise<EvalToolMetric[]> {
  const results = await Promise.all(
    args.callTypes.map((ct) => {
      const qs = new URLSearchParams({
        enterpriseId: args.enterpriseId,
        teamId: args.teamId,
        startDate: args.startISO,
        endDate: args.endISO,
        callType: ct,
      });
      return spyneGet<RawToolMetrics>(`/conversation/eval-pipeline/tool-metrics?${qs}`, token, env);
    }),
  );

  const merged = new Map<string, { ok: number; failed: number; errors: Map<string, number> }>();
  for (const res of results) {
    for (const t of res?.data?.tools ?? []) {
      const name = (t.toolName || "").trim();
      if (!name) continue;
      const m = merged.get(name) ?? { ok: 0, failed: 0, errors: new Map() };
      m.ok += t.ok ?? 0;
      m.failed += t.failed ?? 0;
      for (const e of t.errors ?? []) {
        const et = (e.errorType || "unknown").trim() || "unknown";
        m.errors.set(et, (m.errors.get(et) ?? 0) + (e.count ?? 0));
      }
      merged.set(name, m);
    }
  }

  return [...merged.entries()]
    .map(([tool, m]) => {
      const total = m.ok + m.failed;
      return {
        tool,
        label: pretty(tool, TOOL_LABELS),
        ok: m.ok,
        failed: m.failed,
        total,
        failRate: total ? m.failed / total : null,
        errors: [...m.errors.entries()].map(([errorType, count]) => ({ errorType, count })).sort((a, b) => b.count - a.count),
      };
    })
    .sort((a, b) => b.total - a.total);
}

// ───────────────────────── entry point ─────────────────────────

/* Scored SALES conversations for one rooftop and one direction, over [startISO, endISO).
 *
 * Returns null when the eval API is unreachable/unauthorised (caller hides the panel), and a zeroed
 * EvalOutcomes when the API answered but nothing is scored in the window (a real "not scored yet"
 * state, which the UI says out loud rather than showing an empty chart).
 *
 * Cached for 10 min per (env, team, dir, window) — the Overview and the By-agent tab both ask for the
 * same slice, and the eval scorer only ever appends. */
export async function fetchSalesOutcomes(
  args: { enterpriseId: string; teamId: string; dir: EvalDirection; agentType?: "sales" | "service"; startISO: string; endISO: string },
  token?: string | null,
  env?: string | null,
): Promise<EvalOutcomes | null> {
  const { enterpriseId, teamId, dir, startISO, endISO } = args;
  const agentType = args.agentType ?? "sales";
  if (!enterpriseId || !teamId) return null;

  return cached(`eval:${env ?? "prod"}:${teamId}:${agentType}:${dir}:${startISO}:${endISO}`, async () => {
    const raw = await listSalesEvals({ enterpriseId, teamId, dir, agentType, startISO }, token, env);
    if (!raw) return null;

    // Re-window on the conversation's OWN start time; rows whose id isn't UUIDv7 fall back to createdAt.
    const startMs = Date.parse(startISO);
    const endMs = Date.parse(endISO);
    const rows = raw.filter((r) => {
      const t = conversationStartedAtMs(r.conversationId || "") ?? (r.createdAt ? Date.parse(r.createdAt) : NaN);
      return Number.isFinite(t) && t >= startMs && t < endMs;
    });

    // Ghost is split off BEFORE the flow is grouped, so it never becomes a lane.
    const ghostRows = rows.filter((r) => GHOST_CALL_TYPES.has((r.callType || "").trim()));
    const engagedRows = rows.filter((r) => !GHOST_CALL_TYPES.has((r.callType || "").trim()));
    const groups = groupFlow(engagedRows);
    const outcomes: OutcomeTally = {};
    const interest: Record<string, number> = {};
    let gap = 0;
    let qualified = 0;
    let scoreSum = 0;
    let scoreN = 0;
    // Tallied over ENGAGED rows only: folding ghosts in makes every rate look worse than it is (they are
    // all outcome "None", interest "no vehicle discussed", score 0) and the legend one huge grey block.
    for (const r of engagedRows) {
      const oc = (r.outcomeAchieved || "None").trim() || "None";
      bump(outcomes, oc);
      if (r.outcomeGap === true) gap++;
      // Buying intent = the canonical "Qualified Lead" rung or any rung above it (Appointment/Transfer).
      if (oc === "Qualified Lead" || oc === "Appointment" || oc === "Transfer") qualified++;
      if (typeof r.conversationScore === "number") {
        scoreSum += r.conversationScore;
        scoreN++;
      }
      const it = (r.interest || "").trim();
      if (it) interest[it] = (interest[it] ?? 0) + 1;
    }

    // Funnel / tool cohort: the sales call types this direction actually produced (capped — a rooftop
    // with a long tail shouldn't fan out unbounded).
    const salesTypes = groups.filter((g) => g.sales && g.total > 0).map((g) => g.id).slice(0, 12);
    const [{ funnels, base }, tools] = await Promise.all([
      salesTypes.length ? fetchFunnels({ enterpriseId, teamId, startISO, endISO, callTypes: salesTypes }, token, env) : Promise.resolve({ funnels: [], base: 0 }),
      salesTypes.length ? fetchTools({ enterpriseId, teamId, startISO, endISO, callTypes: salesTypes }, token, env) : Promise.resolve([]),
    ]);

    /* Is the funnel/tool cohort direction-clean? It is when this rooftop scored NO sales conversations in
     * the other direction over the window — then a call-type-matched cohort cannot contain the other
     * direction's calls. Costs one cheap head request (limit=1) and turns the UI caveat off for the many
     * rooftops that only run one sales direction. */
    const otherDir: EvalDirection = dir === "inbound" ? "outbound" : "inbound";
    const otherQs = new URLSearchParams({
      enterpriseId,
      teamId,
      agentType,
      agentCallType: otherDir,
      startDate: startISO,
      page: "1",
      limit: "1",
    });
    const other = await spyneGet<{ total?: number }>(`/conversation/eval-pipeline?${otherQs}`, token, env);
    const derivedScope: EvalOutcomes["derivedScope"] = other && (other.total ?? 0) === 0 ? "exact" : "sales-approx";

    // How much SMS this panel is leaving out (head request — we only want `total`).
    const smsQs = new URLSearchParams({
      enterpriseId, teamId, agentType, agentCallType: dir, channel: "sms",
      startDate: startISO, endDate: endISO, page: "1", limit: "1",
    });
    const sms = await spyneGet<{ total?: number }>(`/conversation/eval-pipeline?${smsQs}`, token, env);

    return {
      dir,
      scored: rows.length,
      ghost: ghostRows.length,
      engaged: engagedRows.length,
      smsScored: typeof sms?.total === "number" ? sms.total : null,
      groups,
      secondary: topSecondary(engagedRows),
      outcomes,
      outcomeGap: gap,
      qualified,
      avgScore: scoreN ? Math.round((scoreSum / scoreN) * 10) / 10 : null,
      interest,
      funnels,
      tools,
      derivedScope,
      funnelBase: base,
    };
  });
}
