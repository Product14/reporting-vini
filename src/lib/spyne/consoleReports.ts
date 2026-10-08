/* THE CANONICAL NUMBERS, FROM THE BACKEND THAT OWNS THEM.
 *
 * `conversational-ai-backend` now serves Reached → Engaged → Qualified → Booked from one place
 * (`/conversation/reports/*`). Before this, every rung was recomputed here from the Supabase
 * aggregate, and the same word meant different things on different cards — 412 "reached" under a
 * funnel whose card said 261, five separate definitions of "qualified" across two screens.
 *
 * This module is the ONLY way those numbers enter the report. It is server-only: it goes through
 * `spyneGet`, so the dealer's token never reaches the browser and local dev falls back to
 * SPYNE_API_TOKEN exactly like every other Spyne call.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: invent anything. Every field below exists in the API response.
 * Anything the API does not serve (hourly buckets, trend7, quality, the report blocks) keeps coming
 * from the aggregate — see buildResult, which overlays these numbers onto that.
 */
import { spyneGet } from "./client";

/** Windows are store-local and END-EXCLUSIVE, matching the API. */
export interface CanonicalWindow {
  start: string;
  end: string;
  timezone: string | null;
}

/** One appointment row. The list behind a count, so a drill-down cannot disagree with the tile. */
export interface CanonicalAppointment {
  meetingId: string;
  leadId: string | null;
  customerName: string;
  customerPhone: string | null;
  vehicle: string;
  bookedAt: string;
  meetingStartTime: string;
  status: string;
  serviceType: string;
  agentType: string | null;
  direction: "inbound" | "outbound" | null;
  assisted: boolean;
}

export interface CanonicalSpeedToLead {
  avgSec: number;
  medianSec: number;
  newLeads: number;
  instantlyTouched: number;
  within1Min: number;
  pctWithin5: number;
  afterHoursInstant: number;
  bookedFromAnInstantTouch: number | null;
  instantToAppointmentRate: number | null;
}

/** One agent card. `agentType` is "Sales Inbound" etc. — the same key ID_BY_AGENT_TYPE maps. */
export interface CanonicalAgent {
  agentType: string;
  direction: "inbound" | "outbound";
  leadsAttempted: number;
  engaged: number;
  qualified: number;
  bookedLeads: number | null;
  bookedRecords: number | null;
  leadsDialed: number;
  pipeline: number;
  closeRate: number;
  turnRate: number;
  transfers: number;
  transferAttempts: number;
  transfersFailed: number;
  calls: number;
  texts: number;
  chats: number;
  talkMinutes: number;
  callsDuringHours: number;
  callsAfterHours: number;
  appointments: CanonicalAppointment[] | null;
  /** AI-assisted, attributed by the lead's LATEST conversation. Never inside bookedRecords. */
  assistedAppointments: number | null;
  speedToLead: CanonicalSpeedToLead | null;
}

/* THE ROOFTOP IS DISTINCT, NOT THE SUM OF THE AGENTS. A lead worked by both agents is real on both
 * cards; adding them over-counted contacts by 326 leads on the reference rooftop. Both are returned so
 * nothing here ever has to add agent rows up. */
export interface CanonicalRooftop {
  leadsAttempted: number;
  engaged: number;
  qualified: number;
  /** Leads whose FIRST touch fell outside opening hours. A customer count, not a conversation count. */
  capturedAfterHours: number;
  assistedAppointments: number | null;
  appointments: CanonicalAppointment[] | null;
  bookedLeads: number | null;
  bookedRecords: number | null;
}

/** The prior window of equal length. `deltaPct` is null when the prior window is 0 — "+256%" against
 *  a base of nothing is not growth, and a dash is the honest render. */
export interface CanonicalPrevious {
  window: CanonicalWindow;
  rooftop: { leadsAttempted: number; engaged: number; qualified: number; bookedRecords: number | null };
  agents: {
    agentType: string;
    direction: "inbound" | "outbound";
    leadsAttempted: number;
    engaged: number;
    qualified: number;
    bookedRecords: number | null;
  }[];
  deltaPct: {
    rooftop: {
      leadsAttempted: number | null;
      engaged: number | null;
      qualified: number | null;
      bookedRecords: number | null;
    };
    agents: {
      agentType: string;
      direction: "inbound" | "outbound";
      leadsAttempted: number | null;
      engaged: number | null;
      qualified: number | null;
      bookedRecords: number | null;
    }[];
  };
}

export interface CanonicalOverview {
  enterpriseId: string;
  teamId: string;
  dept: string;
  direction: "inbound" | "outbound" | null;
  window: CanonicalWindow;
  rooftop: CanonicalRooftop;
  agents: CanonicalAgent[];
  previous?: CanonicalPrevious;
  /* Names what could NOT be served, so the UI shows a dash instead of a stale number. `appointments`
   * here means the meetings API failed — it is NEVER backfilled from the warehouse. */
  degraded: string[];
  generatedAt: string;
}

/** Qualified-minus-booked. "Hot" is a label on that set, not a separate rule. */
export interface CanonicalHotLeads {
  window: CanonicalWindow;
  qualified: number;
  booked: number | null;
  /** The intersection. `qualified - booked` gives the WRONG answer: not every booked lead qualified. */
  bookedQualified: number | null;
  count: number;
  leads: { leadId: string; customer: string; phone: string; type: string; source: string }[];
  degraded: string[];
}

/* ── fetchers ─────────────────────────────────────────────────────────────────────────────────── */

/** The API is mounted under /conversation (setGlobalPrefix). */
const PREFIX = "/conversation/reports";

/* A CONCURRENCY GATE FOR THE PAGE-LOAD CALLS.
 *
 * One report page asks for overview + outcomes(x2) + lead-sources(x2) + hot-leads, all at the same
 * instant. Each is a multi-second warehouse query, and firing six together is what turned a slow
 * endpoint into a 504 — the gateway gave up before the upstream did. Two at a time finishes the same
 * work in about the same wall-clock without ever presenting that burst.
 *
 * DELIBERATELY NOT APPLIED to the drill or the transcript fetch: those happen on a click, and queueing
 * a click behind a page load is exactly the latency a user notices. */
/* TWO AT A TIME, raised from one on 2026-10-01.
 *
 * It was one because two still 504'd: `outcomes` ran ~11s and `overview` ~5s, so any pair overlapping
 * pushed past the gateway timeout and BOTH died, the client retried, and the retries collided. That
 * reasoning was sound at the query weight of the time.
 *
 * The weight changed. The canonical rungs query -- which overview AND outcomes both run -- went from
 * 4,622 marks to 1,493 (3.1x), measured byte-identical output, when GROUPING SETS replaced the
 * UNION ALL rollup and the child CTEs got a padded date predicate for partition pruning. Wall clock
 * on the reference rooftop: 3.94s -> 1.93s mean over four interleaved passes.
 *
 * Serial was costing far more than it looked: 17 real page queries measured 19.0-20.7s serial against
 * 2.5-4.2s fully concurrent. Two is the deliberate next step rather than the full lift -- the old
 * comment's failure mode is real and the cluster still varies ~8x on identical SQL. Raise further only
 * after watching this hold; do NOT go back to one without also reverting the backend query change,
 * since the two were measured together. */
const MAX_CONCURRENT = 2;
let active = 0;
const waiting: (() => void)[] = [];

/* DEADLINE-AWARE (2026-10-09). The gate is module-level, so on a warm Vercel instance it is shared by
 * EVERY concurrent invocation. At the top of each hour the digest cron fires ~10 rooftops at once, each
 * asking for up to four gated calls — tens of calls queued behind two slots, and every request still
 * waiting at 60s was killed (39 /api/reports 504s in 3h on 2026-10-08, all at :00-:01). A caller may now
 * pass two signals (see Deadline): if either fires while the call is still QUEUED, the call leaves the
 * queue and never runs, so abandoned work stops holding up everyone behind it; if the hard `signal` fires
 * while the call is RUNNING, the fetch is aborted (spyneGet) and the slot is released. A call that got its
 * slot before `queueSignal` fired is allowed to finish — aborting nearly-done work wastes the slot it
 * already spent. Either way the caller gets null — the same "upstream unavailable" every caller already
 * handles. No signals → unchanged. */
export interface Deadline {
  /** Hard deadline: a queued call leaves the queue, a running call is aborted. */
  signal?: AbortSignal | null;
  /** Admission deadline: a call not yet running when this fires never starts. */
  queueSignal?: AbortSignal | null;
}
function admission(d: Deadline): AbortSignal | null {
  const sigs = [d.signal, d.queueSignal].filter((x): x is AbortSignal => !!x);
  return sigs.length === 0 ? null : sigs.length === 1 ? sigs[0] : AbortSignal.any(sigs);
}
async function gate<T>(run: () => Promise<T | null>, deadline: Deadline = {}): Promise<T | null> {
  const signal = admission(deadline);
  if (signal?.aborted) return null;
  if (active >= MAX_CONCURRENT) {
    const admitted = await new Promise<boolean>((resolve) => {
      const wake = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve(true);
      };
      const onAbort = () => {
        const i = waiting.indexOf(wake);
        if (i >= 0) waiting.splice(i, 1);
        resolve(false);
      };
      waiting.push(wake);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    if (!admitted) return null;
  }
  active += 1;
  try {
    return await run();
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}

function qs(params: Record<string, string | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
  return sp.toString();
}

/* WINDOW CONTRACT. `end` is EXCLUSIVE here, exactly as the API documents it. The caller passes the
 * window it already resolved, so the report and the API cannot disagree about which days are in. */
export async function fetchCanonicalOverview(
  args: {
    enterpriseId: string;
    teamId: string;
    dept?: "sales" | "service";
    direction?: "inbound" | "outbound";
    start: string;
    end: string;
    /** Optional deadline — see gate(). */
    signal?: AbortSignal | null;
    queueSignal?: AbortSignal | null;
  },
  token?: string | null,
  env?: string | null,
  onError?: (info: { status: number | null; message: string }) => void,
): Promise<CanonicalOverview | null> {
  const query = qs({
    enterpriseId: args.enterpriseId,
    teamId: args.teamId,
    dept: args.dept ?? "sales",
    direction: args.direction,
    startDate: args.start,
    endDate: args.end,
  });
  return gate(() => spyneGet<CanonicalOverview>(`${PREFIX}/overview?${query}`, token, env, onError, args.signal), args);
}

export async function fetchCanonicalHotLeads(
  args: {
    enterpriseId: string;
    teamId: string;
    dept?: "sales" | "service";
    direction?: "inbound" | "outbound";
    start: string;
    end: string;
    /** Optional deadline — see gate(). */
    signal?: AbortSignal | null;
    queueSignal?: AbortSignal | null;
  },
  token?: string | null,
  env?: string | null,
): Promise<CanonicalHotLeads | null> {
  const query = qs({
    enterpriseId: args.enterpriseId,
    teamId: args.teamId,
    dept: args.dept ?? "sales",
    direction: args.direction,
    startDate: args.start,
    endDate: args.end,
  });
  return gate(() => spyneGet<CanonicalHotLeads>(`${PREFIX}/hot-leads?${query}`, token, env, undefined, args.signal), args);
}

/* ── outcomes ─────────────────────────────────────────────────────────────────────────────────── */

interface CanonLabelled {
  key: string;
  label: string;
  count: number;
}
interface CanonIntent {
  key: string;
  label: string;
  conversations: number;
  share: number;
  outcomes: CanonLabelled[];
}
interface CanonGroup {
  key: string;
  label: string;
  conversations: number;
  share: number;
  outcomes: CanonLabelled[];
  intents: CanonIntent[];
}
interface CanonFunnelStep {
  key: string;
  count: number;
  llm: boolean;
  /** The review's OWN figure, kept when the rung was replaced by a canonical or meetings-API count. */
  reviewedCount?: number;
  source?: string;
}
interface CanonFunnel {
  key: string;
  direction: "inbound" | "outbound";
  totalEligible: number;
  /** Always false: the steps are judged independently, so step-to-step ratios are NOT conversion. */
  monotonic: boolean;
  steps: CanonFunnelStep[];
}

export interface CanonicalOutcomesDirection {
  direction: "inbound" | "outbound";
  /** Review COVERAGE, not a funnel rung — what the eval pipeline looked at. */
  scored: number;
  ghost: number;
  /** The canonical rungs, lead grain, all channels. */
  engaged: number;
  qualified: number;
  bookedRecords: number | null;
  outcomes: Record<string, number>;
  outcomesLabelled: CanonLabelled[];
  groups: CanonGroup[];
  groupsByChannel: { call: CanonGroup[]; sms: CanonGroup[]; chat: CanonGroup[] };
  interest: Record<string, number>;
  interestByChannel: { call: Record<string, number>; sms: Record<string, number>; chat: Record<string, number> };
  /** "Also came up" — secondaryIntent is an Array(String), so these do NOT sum to the lane totals. */
  secondary: CanonLabelled[];
  outcomeGap: number;
  avgScore: number | null;
  funnels: CanonFunnel[];
  funnelBase: number;
}

export interface CanonicalOutcomes {
  enterpriseId: string;
  teamId: string;
  dept: string;
  window: CanonicalWindow;
  directions: CanonicalOutcomesDirection[];
  degraded: string[];
  generatedAt: string;
}

export async function fetchCanonicalOutcomes(
  args: { enterpriseId: string; teamId: string; dept?: "sales" | "service"; start: string; end: string },
  token?: string | null,
  env?: string | null,
): Promise<CanonicalOutcomes | null> {
  const query = qs({
    enterpriseId: args.enterpriseId,
    teamId: args.teamId,
    dept: args.dept ?? "sales",
    startDate: args.start,
    endDate: args.end,
  });
  return gate(() => spyneGet<CanonicalOutcomes>(`${PREFIX}/outcomes?${query}`, token, env));
}

/* ── adapter: our payload → the EvalOutcomes the components already draw ──────────────────────────
 *
 * Deliberately an ADAPTER and not a component change. Every panel on the Reports page already reads
 * EvalOutcomes; re-pointing them one by one would be a far larger diff for the same result, and would
 * give two shapes to keep in step. Mapping once here means the flow card, the funnels, the transfer
 * card and the interest mix all move to the canonical source together.
 */
import { funnelLabel, stepLabel, SALES_CALL_TYPES, type EvalOutcomes, type EvalCallTypeGroup, type EvalChannelFlow, type OutcomeTally } from "./evalPipeline";

const tally = (rows: CanonLabelled[]): OutcomeTally =>
  Object.fromEntries(rows.map((o) => [o.key, o.count]));

const toGroup = (g: CanonGroup): EvalCallTypeGroup => ({
  id: g.key,
  label: g.label,
  sales: SALES_CALL_TYPES.has(g.key),
  total: g.conversations,
  outcomes: tally(g.outcomes),
  primaries: g.intents.map((i) => ({
    id: i.key,
    label: i.label,
    total: i.conversations,
    outcomes: tally(i.outcomes),
  })),
});

/* One channel's slice. `scored`/`engaged` are the sum of that channel's lanes, which is exact: lanes
 * partition the scored set minus ghosts. PER-CHANNEL GHOST IS NOT SERVED, so it is 0 here — the
 * ghost note then hides itself rather than printing a number we did not measure. The all-channel
 * ghost, which IS measured, stays on the top-level flow. */
function toChannelFlow(groups: CanonGroup[], secondary: CanonLabelled[]): EvalChannelFlow {
  const total = groups.reduce((s, g) => s + g.conversations, 0);
  const outcomes: OutcomeTally = {};
  for (const g of groups) for (const o of g.outcomes) outcomes[o.key] = (outcomes[o.key] ?? 0) + o.count;
  return {
    scored: total,
    ghost: 0,
    engaged: total,
    groups: groups.map(toGroup),
    secondary: secondary.map((s) => ({ id: s.key, label: s.label, count: s.count })),
    outcomes,
  };
}

export function toEvalOutcomes(d: CanonicalOutcomesDirection): EvalOutcomes {
  return {
    dir: d.direction,
    /* COVERAGE, not a rung. `scored`/`ghost` say what the review looked at; `engaged` and `qualified`
       are the canonical lead-grain rungs and are deliberately different numbers. */
    scored: d.scored,
    ghost: d.ghost,
    engaged: d.engaged,
    qualified: d.qualified,
    /* The "phone calls only — texts are elsewhere" disclaimer. Obsolete: texts are a first-class
       channel here (smsFlow below), so the note must not render. */
    smsScored: null,
    groups: d.groups.map(toGroup),
    smsFlow: d.groupsByChannel.sms.length ? toChannelFlow(d.groupsByChannel.sms, d.secondary) : null,
    secondary: d.secondary.map((s) => ({ id: s.key, label: s.label, count: s.count })),
    outcomes: d.outcomes,
    outcomeGap: d.outcomeGap,
    avgScore: d.avgScore,
    interest: d.interest,
    funnels: d.funnels.map((f) => ({
      key: f.key,
      label: funnelLabel(f.key),
      totalEligible: f.totalEligible,
      steps: f.steps.map((s) => ({ key: s.key, label: stepLabel(s.key), count: s.count, llm: s.llm })),
    })),
    /* Per-tool fire/fail counts. Not served and not rendered anywhere — the tool panel is internal
       plumbing that was deliberately kept off this page. */
    tools: [],
    /* "exact": our funnels are scoped to THIS direction, so the caveat note about steps covering both
       directions never applies. */
    derivedScope: "exact",
    funnelBase: d.funnelBase,
  };
}

/* ── action items (dealer-leads, not conversational-ai) ───────────────────────────────────────── */

export interface CanonicalActionItemStats {
  window: CanonicalWindow;
  stats: { created: number; completed: number; open: number; overdue: number; dueToday: number };
  closers: { assignedTo: string; closed: number }[];
  /** "lead" — every figure is distinct leads, not action-item rows. */
  grain: string;
}

/* A DIFFERENT SERVICE: dealer-leads owns action items, and is mounted under /leads/dealer.
 *
 * Reads MONGO, where the items are written, rather than the ClickHouse CDC replica the report used to
 * query. Verified equal on the reference rooftop (559/558/1/1/1 both ways), so this buys correctness
 * of SOURCE — no CDC lag, and windows resolved in the rooftop's own timezone rather than ClickHouse
 * server time — not a change of number. */
export async function fetchCanonicalActionItemStats(
  args: {
    enterpriseId: string;
    teamId: string;
    serviceType?: string;
    start: string;
    end: string;
    timezone?: string | null;
  },
  token?: string | null,
  env?: string | null,
): Promise<CanonicalActionItemStats | null> {
  const query = qs({
    enterpriseId: args.enterpriseId,
    teamId: args.teamId,
    serviceType: args.serviceType,
    scope: "stats",
    start: args.start,
    end: args.end,
    timezone: args.timezone ?? undefined,
  });
  return gate(() => spyneGet<CanonicalActionItemStats>(`/leads/dealer/v3/reports/action-items?${query}`, token, env));
}

/* ── lead sources ─────────────────────────────────────────────────────────────────────────────── */

export interface CanonicalLeadSourceRow {
  type: string;
  source: string;
  /** Leads with any touch — the canonical Reached rung, scoped to this type/source. */
  contacted: number;
  /** Of those, the ones that engaged. */
  reached: number;
  /* The four MUTUALLY EXCLUSIVE buckets the bar is drawn from; they sum to `contacted`. */
  appt: number;
  qualifiedOnly: number;
  reachedOnly: number;
  notReached: number;
}

export interface CanonicalLeadSources {
  window: CanonicalWindow;
  leadSources: CanonicalLeadSourceRow[];
  degraded: string[];
}

export async function fetchCanonicalLeadSources(
  args: {
    enterpriseId: string;
    teamId: string;
    dept?: "sales" | "service";
    direction?: "inbound" | "outbound";
    start: string;
    end: string;
    /** Optional deadline — see gate(). */
    signal?: AbortSignal | null;
    queueSignal?: AbortSignal | null;
  },
  token?: string | null,
  env?: string | null,
): Promise<CanonicalLeadSources | null> {
  const query = qs({
    enterpriseId: args.enterpriseId,
    teamId: args.teamId,
    dept: args.dept ?? "sales",
    direction: args.direction,
    startDate: args.start,
    endDate: args.end,
  });
  return gate(() => spyneGet<CanonicalLeadSources>(`${PREFIX}/lead-sources?${query}`, token, env, undefined, args.signal), args);
}

/** Our per-(type, source) rows → the flat by-source list the card draws. Sources repeated across CRM
 *  types are summed, because the card keys on the source name alone. */
export function toLeadsBySource(
  rows: CanonicalLeadSourceRow[],
): { source: string; interacted: number; engaged: number; total: number; handoffs: number; appts: number }[] {
  const by = new Map<string, { source: string; total: number; reached: number; appt: number }>();
  for (const r of rows) {
    const k = r.source || "Unknown";
    const cur = by.get(k) ?? { source: k, total: 0, reached: 0, appt: 0 };
    cur.total += r.contacted;
    cur.reached += r.reached;
    cur.appt += r.appt;
    by.set(k, cur);
  }
  return [...by.values()]
    .sort((a, b) => b.total - a.total)
    .map((s) => ({
      source: s.source,
      interacted: s.reached,
      engaged: s.reached,
      total: s.total,
      /* No canonical source, and none before either — the card renders 0 today. */
      handoffs: 0,
      appts: s.appt,
    }));
}

/* ── conversation drill ───────────────────────────────────────────────────────────────────────── */

export interface CanonicalDrillRow {
  /** callId on a call, conversationId on a text thread. */
  id: string;
  leadId: string;
  customer: string;
  phone: string;
  at: string;
  durationSec: number;
  summary: string;
  outcome: string;
  outcomeLabel: string;
  hasRecording: boolean;
  isSms: boolean;
  messages: number;
}

export interface CanonicalDrill {
  conversations: CanonicalDrillRow[];
  window: CanonicalWindow;
  degraded: boolean;
}

/** The conversations behind ONE cell of the flow card. `callType` alone selects a lane; adding
 *  `primaryIntent` narrows to a sub-row; adding `outcome` narrows to one coloured segment. */
export async function fetchCanonicalDrill(
  args: {
    enterpriseId: string;
    teamId: string;
    dept?: "sales" | "service";
    direction?: "inbound" | "outbound";
    channel?: string;
    callType?: string;
    primaryIntent?: string;
    outcome?: string;
    start: string;
    end: string;
  },
  token?: string | null,
  env?: string | null,
): Promise<CanonicalDrill | null> {
  const query = qs({
    enterpriseId: args.enterpriseId,
    teamId: args.teamId,
    dept: args.dept ?? "sales",
    direction: args.direction,
    channel: args.channel,
    callType: args.callType,
    primaryIntent: args.primaryIntent,
    outcome: args.outcome,
    startDate: args.start,
    endDate: args.end,
  });
  return spyneGet<CanonicalDrill>(`${PREFIX}/conversation-drill?${query}`, token, env);
}

/* ── one lead's conversations, with the transcript ────────────────────────────────────────────── */

export interface CanonicalLeadConversation {
  id: string;
  callId: string | null;
  leadId: string;
  channel: "call" | "sms";
  direction: string | null;
  at: string;
  durationSec: number;
  summary: string;
  outcome: string;
  recordingUrl: string | null;
  messages: { role: "agent" | "customer"; text: string; at: string | null }[];
}

export interface CanonicalLeadConversations {
  conversations: CanonicalLeadConversation[];
  degraded: boolean;
}

/* DELIBERATELY SEPARATE FROM THE DRILL. The drill returns up to 150 summary rows for a cell and is
 * cheap; this returns message bodies and call transcripts and is not. Folding them together would make
 * every cell click pay for transcripts nobody opened. */
export async function fetchCanonicalLeadConversations(
  args: { teamId: string; leadId: string; channel?: "call" | "sms" | "both" },
  token?: string | null,
  env?: string | null,
): Promise<CanonicalLeadConversations | null> {
  const query = qs({ teamId: args.teamId, leadId: args.leadId, channel: args.channel ?? "both" });
  return spyneGet<CanonicalLeadConversations>(`${PREFIX}/lead-conversations?${query}`, token, env);
}
