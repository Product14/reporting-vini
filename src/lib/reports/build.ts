/* Rebuild the AgentData[] the reporting UI consumes from the materialized aggregate (agent_daily +
 * agent_daily_breakdown), summed over a date range. This is the server-side equivalent of
 * liveData.ts `fetchAgents()` — it OVERLAYS live values onto the mock AGENTS so the UI renders the
 * same shape; any field with no backing column (revenue/cost/deals/showed, csat/sentiment, the
 * human-baseline story) keeps its mock value, exactly as the card path does today.
 *
 * Returns a FetchResult so the rewritten client `fetchAgents()` can pass it through unchanged and
 * pages keep calling aggregateFleet(agents, prior). */

import { AGENTS as MOCK_AGENTS, type AgentData, type NamedAppt, type WarmLeadItem } from "@/components/reports/data";
import { fmtWhenShortIn } from "./storeTime";
import type { FetchResult, Basis, RooftopRungs } from "@/components/reports/liveData";
import type { CanonicalOverview, CanonicalHotLeads, CanonicalLeadSources } from "@/lib/spyne/consoleReports";
import { toLeadsBySource } from "@/lib/spyne/consoleReports";
import type { AgentDailyRow, BreakdownRow, CallbackRow, CampaignRow, OutcomeRow, ReportAppointmentRow, WarmLeadRow } from "./schema";

/** Report agent id → agent_type label. Exported so the route can map live per-agent numbers back. */
export const AGENT_TYPE_BY_ID: Record<AgentData["id"], string> = {
  sales_ib: "Sales Inbound",
  sales_ob: "Sales Outbound",
  service_ib: "Service Inbound",
  service_ob: "Service Outbound",
};
const COLORS = ["#6366f1", "#813fed", "#10b981", "#f59e0b", "#0ea5e9", "#94a3b8", "#ef4444", "#14b8a6"];

/** The per-agent channel split: voice calls vs SMS threads, straight from the summed counts. Never mock. */
export function channelSplitOf(calls: number, smsThreads: number): { voice: number; sms: number } {
  return { voice: Number(calls) || 0, sms: Number(smsThreads) || 0 };
}

const pctDelta = (curr: number, prev: number): number => (prev ? Math.round(((curr - prev) / prev) * 100) : 0);
function fmtHandle(sec: number): string {
  if (!sec) return "—";
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return m ? `${m}m ${s.toString().padStart(2, "0")}s` : `${s}s`;
}
function shortDay(d: string): string {
  const m = d.match(/\d{4}-(\d{2})-(\d{2})/);
  return m ? `${Number(m[2])}/${Number(m[1])}` : d.slice(0, 6);
}

// Σ a numeric column over a set of daily rows.
const sum = (rows: AgentDailyRow[], f: (r: AgentDailyRow) => number) => rows.reduce((s, r) => s + (f(r) || 0), 0);

// Collapse breakdown rows (already filtered to one agent_type) into value → totals, biggest first.
// transferred/callbacks are intent-dim measures (0 elsewhere; 0 on pre-0017 rows until a --full re-aggregate).
function rollupDim(rows: BreakdownRow[], dim: BreakdownRow["dim"]): { value: string; count: number; qualified: number; appts: number; transferred: number; callbacks: number }[] {
  const m = new Map<string, { value: string; count: number; qualified: number; appts: number; transferred: number; callbacks: number }>();
  for (const r of rows) {
    if (r.dim !== dim) continue;
    let e = m.get(r.dim_value);
    if (!e) { e = { value: r.dim_value, count: 0, qualified: 0, appts: 0, transferred: 0, callbacks: 0 }; m.set(r.dim_value, e); }
    e.count += r.count; e.qualified += r.qualified; e.appts += r.appts;
    e.transferred += r.transferred ?? 0; e.callbacks += r.callbacks ?? 0;
  }
  return Array.from(m.values()).sort((a, b) => b.count - a.count);
}

// Friendly labels for the buying-intent action-item vocab shown on warm-lead chips; anything unmapped
// falls back to a sentence-cased version of the raw value ("purchase intent" → "Purchase intent").
const INTENT_PRETTY: Record<string, string> = {
  ScheduleAppointment: "Asked to book",
  RescheduleAppointment: "Wants to reschedule",
  SALES_SCHEDULE_SHOWROOM_VISIT: "Showroom visit",
  CheckVehicleAvailability: "Vehicle availability",
  CheckVehiclePrice: "Vehicle price",
  InquireFinanceStatus: "Financing",
  SALES_CONNECT_TO_FINANCE: "Financing",
  InquireTradeInValue: "Trade-in value",
  SALES_TRADE_IN_FOLLOW_UP: "Trade-in follow-up",
  ScheduleTestDrive: "Test drive",
  SALES_SCHEDULE_TEST_DRIVE: "Test drive",
  InquireLeaseOptions: "Lease options",
  SALES_FOLLOW_UP_WITH_QUOTE: "Waiting on a quote",
  SERVICE_SCHEDULE_APPOINTMENT: "Service appointment",
  SERVICE_SEND_ESTIMATE: "Service estimate",
};
function prettyInterest(raw: string | null | undefined): string {
  if (!raw) return "";
  const mapped = INTENT_PRETTY[raw];
  if (mapped) return mapped;
  const s = raw.replace(/_/g, " ").trim().toLowerCase();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

const REPLY_LABEL: Record<string, string> = { "0": "Same day", "1": "Day 1", "2": "Day 2", "3+": "Day 3+" };
const REPLY_ORDER = ["0", "1", "2", "3+"];

export interface BuildInput {
  /* THE CANONICAL RUNGS, from conversational-ai-backend (`/conversation/reports/overview`).
   * Optional on purpose: absent (API down, no token, service dept) → every overlay below is skipped
   * and the aggregate's own numbers render, which is the pre-existing behaviour. */
  canonical?: CanonicalOverview | null;
  /* Qualified-minus-booked, from the same backend. Replaces the report_warm_leads snapshot, which was
   * built from CAMPAIGN OUTCOMES and carried its own hot/warm vocabulary. */
  canonicalHotLeads?: CanonicalHotLeads | null;
  /* Keyed by DIRECTION: the card is per agent, and the canonical endpoint is direction-scoped. */
  canonicalLeadSources?: Partial<Record<"inbound" | "outbound", CanonicalLeadSources | null>>;
  daily: AgentDailyRow[]; // current window, this team
  breakdown: BreakdownRow[]; // current window, this team
  priorDaily: AgentDailyRow[]; // prior equal-length window, this team (basis for deltas)
  // rooftop-level detail (fed from ClickHouse by scripts/backfill.ts); attached to the relevant agents below.
  callbacks?: CallbackRow[];
  /* The rooftop's IANA timezone, for the one server-formatted timestamp below (callback `due`).
   * Optional and null-tolerant — absent → UTC, the previous behaviour. */
  timezone?: string | null;
  campaigns?: CampaignRow[];
  // Outbound disposition mix (from card 12231 via report_outcomes); attached to the matching outbound
  // agent. Replaces the dead Q12227 `outbound_outcome` path (that column never existed in Q12227).
  outcomes?: OutcomeRow[];
  // v3 named lists (report_appointments already window-filtered by the route; report_warm_leads is a
  // "now" snapshot). Scoped per agent below AND returned rooftop-wide on the FetchResult.
  namedAppointments?: ReportAppointmentRow[];
  /* agent_type → store-local day → AI-booked appointments booked that day, counted from the SAME rows
   * the headline counts. Without it the day-on-day chart plots agent_daily's own appointment column,
   * which is a different source: Heiser Chevrolet's chart summed to 33 under a funnel reading 37. */
  apptDayCounts?: Record<string, Record<string, number>>;
  warmLeads?: WarmLeadRow[];
  // Slot ids the dealer has actually onboarded (from the Spyne onboarded-agents API). When provided,
  // the report is GATED to these slots — agents the dealer hasn't paid for are dropped (personas kept
  // as-is). null/undefined → don't gate (show all four), the previous behavior.
  onboardedSlots?: Set<AgentData["id"]> | null;
  // The dealer's REAL agent name per slot (from the onboarded-agents API), e.g. { service_ob: "Mark" }.
  // Overrides the mock persona (summary.person) so the report shows the name the dealer actually gave
  // the agent instead of a fabricated one. A missing slot / undefined → keep the mock persona.
  onboardedNames?: Partial<Record<AgentData["id"], string>> | null;
  // The dealer's REAL agent avatar per slot (imageUrl from the onboarded-agents API). Sets agent.photoUrl
  // so the report shows the actual photo; a missing slot → keep the mock avatar.
  onboardedPhotos?: Partial<Record<AgentData["id"], string>> | null;
  // EXACT window-distinct lead counts per agent_type (from report_lead_counts). When present, used for
  // "Leads dialed" (= unique leads contacted) + distinct appointments instead of summing per-day
  // distincts (which over-counts cross-day leads). undefined → fall back to the daily sum.
  leadCounts?: LeadCounts;
  priorLeadCounts?: LeadCounts;
  // Window-distinct "Leads by source" per agent_type (from report_source_counts → COUNT(DISTINCT
  // lead_id) per source). When present, REPLACES the per-day breakdown rollup, which sums per-day
  // distincts and so over-counts any lead touched on multiple days. undefined → fall back to breakdown.
  sourceCounts?: Record<string, { source: string; total: number; interacted: number; booked: number }[]>;
}

// Per-agent_type window-distinct lead counts (keyed by agent_type label, e.g. "Sales Outbound").
// canonical: apptLeads = AI-booked (source='spyne', PRIMARY); apptLeadsAssisted = AI-assisted (CRM, SECONDARY).
export type LeadCounts = Record<string, { contacted: number; dialed: number; connected: number; qualified: number; apptLeads: number; apptLeadsAssisted: number; transferLeads: number; transferFailedLeads: number }>;

/* Format a timestamp as a short "when" label (e.g. "Jun 11 · 9:30 AM") IN THE STORE'S ZONE.
 *
 * Sole caller: the callback/follow-up `due` below. Pre-formatting a timestamp on the SERVER is itself the
 * defect here — once it is a string the client can no longer re-zone it — so the zone has to be applied
 * at this point or not at all. Appointment rows are deliberately NOT formatted here (they pass
 * meeting_start through raw and the client formats them), which is why this is the follow-up surface and
 * not the appointment one.
 *
 * Null timezone → UTC, exactly as before. NOTE nothing in the UI currently renders report.followUps, so
 * this change has no visible signal; it is here for correctness, not for a screenshot. */
function fmtWhen(iso: string | null, tz?: string | null): string {
  return fmtWhenShortIn(iso, tz);
}

// The card sends `vehicle` as a JSON-encoded array of VIN/identifier strings — "[]" when empty,
// '["1N4BL...","..."]' when populated. Parse it to a clean comma-joined label; "" → UI "Vehicle TBD".
function fmtVehicle(raw: string | null | undefined): string {
  if (!raw) return "";
  const s = raw.trim();
  if (s === "" || s === "[]") return "";
  try {
    const arr = JSON.parse(s);
    if (Array.isArray(arr)) return arr.map((v) => String(v).trim()).filter(Boolean).join(", ");
  } catch {
    /* not JSON — fall through and show the raw value */
  }
  return s;
}

/* THE CANONICAL ROOFTOP RUNGS, PUBLISHED TO THE CLIENT WITH THE SCOPE THEY WERE MEASURED OVER.
 *
 * These are DISTINCT lead counts: the rooftop's own answer, not the sum of the agent rows, which
 * double-counts every lead two agents both worked (consoleReports.ts: 326 contacts over-counted on the
 * reference rooftop; 17 qualified on team 3d3deabc98). The client cannot derive them — only the API
 * knows which leads overlap — so this is the one place they can enter the payload.
 *
 * `dept` and `agentTypes` ride along because the figures are NOT rooftop-wide. The overview is fetched
 * for dept="sales" only (route.ts) and the per-agent overlay is matched by agentType, so Service agents
 * keep the aggregate's own numbers. A client that substituted this triple into a dept="all" view of a
 * Service-running rooftop would delete every Service lead from the rung. Carrying the scope lets
 * rooftopRungsFor() check the agents on screen against the agents the API actually counted, instead of
 * trusting a department string — and it self-maintains if the backend is later asked for another dept.
 *
 * agentTypes is narrowed to agents with lead activity: an agent the API counted as all-zero cannot move
 * the rooftop number, so whether the caller renders it is irrelevant, and demanding its presence would
 * close the gate over a declared-but-idle agent for no reason. The null check is explicit rather than a
 * `> 0` truthiness test — the sibling canonical types use `number | null`, and a null slipping through
 * would quietly shrink the covered set and open the gate over an agent the API did not count.
 *
 * Same contract as capturedAfterHours below: entirely absent when the canonical call did not land, so
 * the no-API path is byte-identical to what shipped. */
function rooftopRungs(canonical: CanonicalOverview | null | undefined, hot: CanonicalHotLeads | null | undefined): RooftopRungs | undefined {
  if (!canonical) return undefined;
  /* `degraded` names what the API could NOT serve. The exact vocabulary is not visible from this repo,
     so this matches the field names we read and is a no-op otherwise — it can only ever fail closed
     (back to summing), never open. */
  const broken = new Set(canonical.degraded ?? []);
  if (["rooftop", "leadsAttempted", "engaged", "qualified"].some((k) => broken.has(k))) return undefined;
  const prev = canonical.previous;
  return {
    dept: canonical.dept,
    agentTypes: canonical.agents.filter((a) => typeof a.leadsAttempted === "number" && a.leadsAttempted > 0).map((a) => a.agentType),
    leadsAttempted: canonical.rooftop.leadsAttempted,
    engaged: canonical.rooftop.engaged,
    qualified: canonical.rooftop.qualified,
    prior: prev ? { leadsAttempted: prev.rooftop.leadsAttempted, engaged: prev.rooftop.engaged, qualified: prev.rooftop.qualified } : undefined,
    deltaPct: prev ? { leadsAttempted: prev.deltaPct.rooftop.leadsAttempted, engaged: prev.deltaPct.rooftop.engaged, qualified: prev.deltaPct.rooftop.qualified } : undefined,
    /* "Qualified, not yet booked", served rather than subtracted — the hero tile and the ROI PDF both
       print that exact phrase. Its own degraded array gates it independently: a missing hot-lead count
       must not cost the rooftop its three rungs. */
    hotLeads: hot && !(hot.degraded ?? []).includes("count") && typeof hot.count === "number" ? hot.count : undefined,
  };
}

export function buildResult({ canonical, canonicalHotLeads, canonicalLeadSources, daily, breakdown, priorDaily, callbacks, timezone, campaigns, outcomes, namedAppointments, apptDayCounts, warmLeads, onboardedSlots, onboardedNames, onboardedPhotos, leadCounts, priorLeadCounts, sourceCounts }: BuildInput): FetchResult {
  /* "Do we have numbers for this window?" — NOT "does the aggregate have rows?".
   *
   * Once the canonical API supplies the rungs, a rooftop can be fully populated with an empty
   * aggregate. Left as `daily.length > 0` the UI read that as an empty window: it rendered zeros and
   * re-fetched on the self-heal timer (42 requests on one page load) over data it already had. */
  const canonHasActivity = Boolean(
    canonical?.agents.some((a) => a.leadsAttempted || a.engaged || a.calls || a.texts || a.chats),
  );
  const hasData = daily.length > 0 || canonHasActivity;

  // Keep service_type so each agent shows only its department's callbacks (sales agents → sales leads,
  // service → service) — a service-heavy rooftop's callbacks must not leak onto the Sales cards.
  const callbackItems = (callbacks ?? []).map((c) => ({
    serviceType: (c.service_type ?? "").toLowerCase(),
    customer: c.customer_name ?? "—", due: fmtWhen(c.callback_due, timezone), intent: c.intent ?? "", priority: c.priority ?? "",
  }));
  const campaignItems = (campaigns ?? []).map((c) => ({
    agentType: c.agent_type, name: c.campaign, useCase: c.use_case ?? "", enrolled: c.enrolled, appts: c.appointments,
    apptRate: c.appt_rate_pct ?? 0, warmLeads: c.warm_leads, optOuts: c.opt_outs, noReach: c.no_reach,
  }));
  // Outbound disposition slices — keep the raw bucket (canonical best→least ordering) and strip the
  // numeric sort-prefix ("1 No reach" → "No reach") for display.
  const outcomeItems = (outcomes ?? []).map((o) => ({
    agentType: o.agent_type, bucket: o.outcome_bucket, label: o.outcome_bucket.replace(/^\d+\s+/, ""), value: o.mappings,
  }));

  // ── v3 named lists (display shapes; PII stays behind the authed API) ──
  // Named appointments: one row per LEAD (reschedules create multiple active meeting records — keep
  // the AI-booked row over an assisted one, then the latest booking). canonical: `assisted` rows are
  // AI-assisted (CRM) — labeled distinctly, never counted into the AI-booked headline.
  const namedApptItems: (NamedAppt & { direction: string })[] = (() => {
    const rows = (namedAppointments ?? [])
      .map((a) => ({
        customer: a.customer_name?.trim() || "—",
        phone: a.phone ?? "",
        channel: (a.assisted ? null : a.direction === "inbound" ? "Inbound" : a.direction === "outbound" ? "Outbound" : null) as NamedAppt["channel"],
        /* "on call" only when we KNOW it was a call. It used to be the fallback for an unknown channel,
           which labelled bookings that have no call, chat or conversation at all as "AI-booked, on
           call" — team 9923577d07 had two. Unknown now says just "AI-booked" rather than asserting a
           channel we cannot show. */
        how: a.assisted
          ? "AI-assisted → CRM"
          : a.booked_via === "sms" ? "AI-booked, via SMS"
            : a.booked_via === "chat" ? "AI-booked, in web chat"
              : a.booked_via === "call" ? "AI-booked, on call"
                : "AI-booked",
        vehicle: fmtVehicle(a.vehicle),
        when: a.meeting_start ?? null,
        bookedAt: a.booked_at ?? null,
        status: a.status ?? "",
        intent: (a.intent ?? "").trim(),
        assisted: Boolean(a.assisted),
        serviceType: (a.service_type ?? "").toLowerCase(),
        direction: (a.direction ?? "").toLowerCase(),
        leadId: a.lead_id ?? a.meeting_id ?? "",
      }))
      .sort((x, y) => (x.assisted === y.assisted ? (y.bookedAt ?? "").localeCompare(x.bookedAt ?? "") : x.assisted ? 1 : -1));
    // ★ NO LEAD DEDUPE (removed 2026-09-09). This list used to collapse to one row per lead so it
    // matched a lead-grain tile, which HID real appointments: at Honda of Downtown Los Angeles, 3 of
    // 99 service bookings in a 30d window vanished from the export that way (4 would have, had the
    // key been the caller's lead instead of the meeting's). The tile now counts appointment records,
    // so the list shows every appointment and the two tie by construction. Each row is one meeting —
    // meeting_id is the natural key and the snapshot already holds one row per meeting.
    const out: (NamedAppt & { direction: string })[] = rows.map((r) => {
      const { leadId, ...item } = r; // eslint-disable-line @typescript-eslint/no-unused-vars
      return item;
    });
    return out.sort((x, y) => (y.bookedAt ?? "").localeCompare(x.bookedAt ?? ""));
  })();
  const warmLeadItems: WarmLeadItem[] = (warmLeads ?? [])
    .filter((w) => (w.customer_name ?? "").trim() || (w.phone ?? "").trim())
    .map((w) => ({
      customer: w.customer_name?.trim() || "—",
      phone: w.phone ?? "",
      tier: (w.tier === "warm" ? "warm" : "hot") as WarmLeadItem["tier"],
      interest: prettyInterest(w.outcome),
      campaign: w.campaign?.trim() ?? "",
      lastActivity: w.last_activity ?? null,
      serviceType: (w.service_type ?? "").toLowerCase(),
      source: (w.source === "ib" ? "ib" : "ob") as WarmLeadItem["source"],
      leadId: w.lead_id ?? null,
    }))
    .sort((x, y) => (x.tier === y.tier ? (y.lastActivity ?? "").localeCompare(x.lastActivity ?? "") : x.tier === "hot" ? -1 : 1));

  /* ── CANONICAL HOT LEADS ──────────────────────────────────────────────────────────────────────
   * ONE LIST, ONE RULE: qualified and not yet booked. The snapshot above came from campaign outcomes
   * and split the list into hot/warm on outcome strings like "customer considering" — a second
   * vocabulary, from the same universe whose booked count said 77 against a calendar holding 9.
   *
   * Decision (Ishan, 2026-09-29): warm leads ARE qualified leads, so the tier goes and every row is
   * "hot". `interest`, `campaign` and `lastActivity` have no canonical source and are left empty
   * rather than invented — the modal already falls back to "Engaged" for a blank interest.
   */
  const canonHot: WarmLeadItem[] = (canonicalHotLeads?.leads ?? []).map((l) => ({
    customer: l.customer?.trim() || "—",
    phone: l.phone ?? "",
    tier: "hot" as const,
    interest: "",
    campaign: "",
    lastActivity: null,
    // The dept this list was fetched for; the Overview filters its chips on it.
    serviceType: "sales",
    /* Not rendered anywhere — the canonical list is rooftop-wide and carries no per-lead direction.
       Typed as a union, so a value is required. */
    source: "ob" as const,
    leadId: l.leadId,
  }));
  /* SALES ONLY. The canonical hot-leads call is made with dept:"sales", so every row above is stamped
     serviceType:"sales". Replacing the whole list wholesale therefore DELETED the service department's
     warm leads: OverviewView filters these chips on `w.serviceType === dept`, so the Service tab matched
     nothing and rendered "0 Hot Leads" with an empty card — a regression against the aggregate, not
     merely an unmigrated surface. Swap out only the sales rows and leave service on the snapshot. */
  const warmLeadsOut = canonicalHotLeads
    ? [...canonHot, ...warmLeadItems.filter((w) => w.serviceType !== "sales")]
    : warmLeadItems;

  // prior-window per-agent basis (drives report.deltas + fleet deltas)
  const prior: Record<string, Basis> = {};
  for (const base of MOCK_AGENTS) {
    const type = AGENT_TYPE_BY_ID[base.id];
    const pr = priorDaily.filter((r) => r.agent_type === type);
    const plc = priorLeadCounts?.[type];
    prior[base.id] = {
      calls: sum(pr, (r) => r.calls),
      // unique-lead basis when available (matches the displayed conversations/qualified), else daily sum
      conversations: plc ? plc.connected : sum(pr, (r) => r.connected),
      qualified: plc ? plc.qualified : sum(pr, (r) => r.qualified),
      // record grain, matching the current-window headline above
      appointments: sum(pr, (r) => r.appointments),
      leads: plc ? plc.contacted : sum(pr, (r) => r.leads_attempted),
      sms: sum(pr, (r) => r.sms_sent),
      // v3 hero deltas: hand-offs (transfers lead-level when available + callbacks), talk, after-hours.
      appointmentsAssisted: sum(pr, (r) => r.appointments_assisted),
      transfers: plc ? plc.transferLeads : sum(pr, (r) => r.transfers),
      transfersFailed: plc ? plc.transferFailedLeads : sum(pr, (r) => r.transfers_failed),
      callbacks: sum(pr, (r) => r.callbacks),
      talkMinutes: Math.round(sum(pr, (r) => r.talk_seconds) / 60),
      afterHours: sum(pr, (r) => r.after_hours),
    };
  }

  /* PRIOR WINDOW, canonical. The API resolves its own prior window: the SAME length, adjacent, and
   * END-EXCLUSIVE, so the two never share a boundary day — an inclusive end double-counts it and
   * reports growth that is really one day counted twice.
   *
   * Only the four rungs are overlaid. calls / sms / transfers / talk / afterHours keep the aggregate's
   * prior, because the API's `previous` block does not carry them and a half-canonical Basis would
   * make some delta chips canonical and others not. */
  if (canonical?.previous) {
    const idByType = Object.fromEntries(
      Object.entries(AGENT_TYPE_BY_ID).map(([id, t]) => [t, id as AgentData["id"]]),
    ) as Record<string, AgentData["id"]>;
    for (const pv of canonical.previous.agents) {
      const id = idByType[pv.agentType];
      if (!id || !prior[id]) continue;
      prior[id] = {
        ...prior[id],
        leads: pv.leadsAttempted,
        conversations: pv.engaged,
        qualified: pv.qualified,
        // null only when the meetings API failed — keep the aggregate rather than invent a 0 base.
        ...(pv.bookedRecords !== null ? { appointments: pv.bookedRecords } : {}),
      };
    }
  }

  // Which slots to render: the onboarded ones (when the dealer's list is known) UNION any agent_type
  // that actually has activity rows in this window. Activity is ground truth — an agent running live
  // but missing from the onboarded list (or that list being unavailable) must never be silently
  // dropped. null onboardedSlots → show all four (previous behavior). Personas are NOT changed.
  const activeTypes = new Set(daily.map((r) => r.agent_type));
  const slots = MOCK_AGENTS.filter(
    (base) => (onboardedSlots ? onboardedSlots.has(base.id) : true) || activeTypes.has(AGENT_TYPE_BY_ID[base.id]),
  );

  const agents = slots.map((base): AgentData => {
    const type = AGENT_TYPE_BY_ID[base.id];
    const rows = daily.filter((r) => r.agent_type === type).sort((a, b) => a.activity_day.localeCompare(b.activity_day));
    const bd = breakdown.filter((r) => r.agent_type === type);
    const a: AgentData = structuredClone(base);
    // Real agent avatar from the dealer's onboarded-agents config (imageUrl); null → keep mock art.
    a.photoUrl = onboardedPhotos?.[base.id]?.trim() || null;
    // NOTE: we do NOT early-return mock when rows is empty. An agent with no activity in the
    // selected window must read as ZERO on a live rooftop — returning mock here let fabricated
    // volume leak into the fleet roll-up and "Value created" (e.g. a 1-day window showing more
    // appointments than a 7-day one). The overlay below produces zeros from the empty sums; the
    // residual mock visuals are cleared at the end of the loop.

    const inbound = base.dir === "Inbound";
    const lc = leadCounts?.[type]; // exact window-distinct counts for this agent_type (if available)
    const calls = sum(rows, (r) => r.calls);
    const connected = sum(rows, (r) => r.connected);
    const qualified = sum(rows, (r) => r.qualified);
    // ★ APPOINTMENT RECORDS (2026-09-09), summed across the window's days — NOT report_lead_counts'
    // apptLeads. The tile is labelled "Appointments — AI-booked" and the export lists one row per
    // appointment, so both count appointments. agent_daily.appointments is now a per-day record count
    // and a meeting lands on exactly one day, so this sum is exact — no window-distinct rpc needed.
    // apptLeads stays available on `lc` for anything that genuinely wants "how many LEADS booked".
    // canonical: this is AI-booked (meetings.source='spyne') — the PRIMARY/headline appointments number.
    const appointments = sum(rows, (r) => r.appointments);
    // canonical: AI-assisted (CRM) appointments — SECONDARY. Reported separately ("+N AI-assisted"),
    // NEVER folded into `appointments`. Same record grain as the headline.
    const appointmentsAssisted = sum(rows, (r) => r.appointments_assisted);
    const smsSent = sum(rows, (r) => r.sms_sent);
    const smsThreads = sum(rows, (r) => r.sms_threads);
    // web chat — third channel. 0 on rows aggregated before migration 0021, so the tile self-hides.
    const chats = sum(rows, (r) => r.chats);
    const afterHours = sum(rows, (r) => r.after_hours);
    const talkSeconds = sum(rows, (r) => r.talk_seconds);
    // canonical: transfers = window-DISTINCT leads with a completed transfer (lead grain, matches the
    // funnel); fall back to the call-level daily sum when lead-counts are unavailable.
    const transfers = lc ? lc.transferLeads : sum(rows, (r) => r.transfers);
    const transfersFailed = lc ? lc.transferFailedLeads : sum(rows, (r) => r.transfers_failed);
    const callbacks = sum(rows, (r) => r.callbacks);
    const queryResolved = sum(rows, (r) => r.query_resolved);
    const optOuts = sum(rows, (r) => r.opt_outs);
    // "Leads dialed/attempted" = unique leads CONTACTED over the window (distinct lead_id, any touch).
    // The daily sum double-counts a lead touched on multiple days; window-distinct fixes that.
    const leadsAttempted = lc ? lc.contacted : sum(rows, (r) => r.leads_attempted);
    const connectRate = calls ? Math.round((connected / calls) * 100) : 0;
    const aht = connected ? talkSeconds / connected : 0;
    // Unique-lead funnel stages (distinct leads over the window). Falls back to event counts when the
    // lead-day counts are unavailable so the funnel still renders. contacted ≥ connected ≥ qualified ≥ appt.
    const leadConnected = lc ? lc.connected : connected;
    const leadQualified = lc ? lc.qualified : qualified;
    // Distinct leads actually DIALED (a call was placed), separate from `contacted` which also counts
    // SMS-only touches. Outbound cards label their number "Leads dialed", so it must be the dialed count,
    // not contacted. Falls back to contacted when the RPC row is unavailable (keeps the funnel rendering).
    const leadDialed = lc ? lc.dialed : leadsAttempted;

    // ── metrics: live-backed fields only, real 0 stays 0. Fields with NO Q12227 source
    //    (showed/deals/revenue/cost) are zeroed — never fabricated — and surfaced as "coming soon"
    //    in the UI rather than carrying mock values. ──
    a.metrics = {
      ...a.metrics,
      calls,
      conversations: connected,
      connectRate,
      qualified,
      appointments, // canonical: AI-booked (source='spyne') — PRIMARY/headline
      appointmentsAssisted, // canonical: AI-assisted (CRM) — SECONDARY, shown smaller, never in headline
      showed: 0,
      deals: 0,
      revenue: 0,
      cost: 0,
      afterHours,
      talkMinutes: Math.round(talkSeconds / 60),
      smsSent,
      chats, // web-chat sessions (see migration 0021)
      optOuts,
    };

    // ── unique-lead funnel (distinct leads at each stage) → fleet + per-agent "Outreach → conversation
    //    → qualified → appointment" funnels. Every stage is window-distinct, so no lead is counted twice. ──
    a.leadFunnel = { contacted: leadsAttempted, dialed: leadDialed, connected: leadConnected, qualified: leadQualified, appt: appointments };

    /* ── CANONICAL OVERLAY ────────────────────────────────────────────────────────────────────
     * Reached → Engaged → Qualified → Booked now come from conversational-ai-backend, which owns
     * the definitions. Everything above stays as the fallback: when the API is unreachable this
     * block simply does not run and the aggregate's own numbers render, exactly as before.
     *
     * WHY OVERWRITE RATHER THAN REPLACE THE MATH ABOVE: the aggregate still feeds a dozen things the
     * API does not serve (hourly buckets, trend7, quality, the report blocks). Overlaying only the
     * rungs keeps those alive while making the four numbers that appear on five different cards
     * agree — which is the entire point of the exercise.
     *
     * `engaged` is LEAD grain, so it is deliberately a different number from `connected` (event
     * grain) that the quality block above still uses. Appointments stay record grain and assisted
     * stays OUT of the headline, both matching the API.
     */
    const canon = canonical?.agents.find((x) => x.agentType === type);
    if (canon) {
      a.metrics = {
        ...a.metrics,
        calls: canon.calls,
        conversations: canon.engaged,
        qualified: canon.qualified,
        // null only when the meetings API itself failed — keep the aggregate rather than show 0.
        appointments: canon.bookedRecords ?? a.metrics.appointments,
        appointmentsAssisted: canon.assistedAppointments ?? a.metrics.appointmentsAssisted,
        talkMinutes: canon.talkMinutes,
        smsSent: canon.texts,
        chats: canon.chats,
        // The API returns BOTH halves of the day. The console used to derive during-hours by
        // subtracting an all-channel after-hours count from the call count, which floored it at 0.
        afterHours: canon.callsAfterHours,
      };
      a.leadFunnel = {
        contacted: canon.leadsAttempted,
        dialed: canon.leadsDialed,
        connected: canon.engaged,
        qualified: canon.qualified,
        appt: canon.bookedRecords ?? 0,
      };
    }

    // ── quality: only the live-backed bits. csat/sentiment have no Q12227 column → zeroed (the UI
    //    hides them); handleTime is "—" when there's no talk time, never a mock value. ──
    a.quality = {
      ...a.quality,
      primary: connectRate,
      handleTime: aht ? fmtHandle(aht) : "—",
      csat: 0,
      sentiment: 0,
    };

    // ── channel split (counts: voice calls vs sms threads) ──
    /* ALWAYS assigned from the real counts (fixed 2026-10-09, audit A2 F12). This used to run only when
       calls || smsThreads, and the mock-clearing block below only when the agent had NO rows — so an
       agent with rows but no calls and no SMS threads (a chat-only day) kept the cloned MOCK_AGENTS split
       (90/10, 62/38, 88/12, 55/45). Dream Nissan Midwest Service Inbound, 10-07, served {voice: 88,
       sms: 12} beside metrics.calls = 0, and 22 digests printed a fabricated "Call 90" / "Call 88". */
    a.channelSplit = channelSplitOf(calls, smsThreads);

    // ── hourly 7a–6p (12 buckets) from the hour breakdown ──
    const hours = rollupDim(bd, "hour");
    if (hours.length) {
      const byHour: Record<number, number> = {};
      for (const h of hours) byHour[Number(h.value)] = h.count;
      a.hourly = Array.from({ length: 12 }, (_, i) => byHour[7 + i] ?? 0);
    }

    // ── trend7 = last 7 days of calls ──
    if (rows.length) a.trend7 = rows.slice(-7).map((r) => r.calls);

    // ── report block ──
    const intents = rollupDim(bd, "intent");
    const sources = rollupDim(bd, "source");
    const replies = rollupDim(bd, "reply_offset");
    a.report = {
      ...a.report,
      /* Take the CANONICAL figure when the overlay above ran. a.leadFunnel.contacted is
         canon.leadsAttempted at this point; the bare `leadsAttempted` const is the pre-overlay
         aggregate value, and assigning it here silently un-did the overlay for every consumer that
         reads report.leadsAttempted rather than leadFunnel.contacted. The agent-selector chip on
         /reports/agents does exactly that, and rendered "0 leads attempted" beside a funnel reading
         630 for the same agent. Mirrors the `leadFunnel?.contacted ?? report.leadsAttempted`
         precedence every other caller already applies. */
      leadsAttempted: a.leadFunnel?.contacted ?? leadsAttempted,
      // conversion rates on a consistent unique-lead basis (appt-leads / qualified-leads / connected-leads)
      abr: leadQualified ? Math.round((appointments / leadQualified) * 100) : 0,
      qualifiedPct: leadConnected ? Math.round((leadQualified / leadConnected) * 100) : 0,
      callFlow: {
        total: calls,
        answered: connected,
        missed: Math.max(0, calls - connected),
        transferred: transfers,
        transfersFailed, // canonical: failed transfers — reported separately, never in `transferred`
        callbacks,
        lost: Math.max(0, connected - qualified),
        handledByAI: queryResolved,
      },
      /* appts from the appointment LIST when we have it, so the chart and the funnel above it plot the
         same bookings. Falls back to agent_daily's column when the map is absent.
         ★ THE CHART'S DAYS COME FROM THE APPOINTMENTS TOO, NOT ONLY FROM agent_daily (fixed 2026-09-11).
         These rows are the agent's activity days, so a booking made on a day that agent had no OTHER
         recorded activity had no bar to land on and silently vanished from the chart while still
         counting in the tile above it. Paragon Acura, Service Outbound, 30d: tile 4, chart 1 — the
         bookings on Aug 24, Aug 25 and Sep 10 all fell on days absent from agent_daily. Fleet sweep of
         all 116 live rooftops found 12 such agents across 11 rooftops, the chart always LOW.
         Appointment-only days carry zero touched/qualified, which is exactly what happened. */
      dayOnDay: (() => {
        const appts = apptDayCounts?.[type];
        if (!apptDayCounts) return rows.map((r) => ({ day: shortDay(r.activity_day), touched: r.calls, qualified: r.qualified, appts: r.appointments }));
        const byDay = new Map<string, { touched: number; qualified: number }>();
        for (const r of rows) byDay.set(String(r.activity_day), { touched: r.calls, qualified: r.qualified });
        for (const d of Object.keys(appts ?? {})) if (!byDay.has(d)) byDay.set(d, { touched: 0, qualified: 0 });
        return [...byDay.keys()].sort().map((d) => {
          const v = byDay.get(d)!;
          return { day: shortDay(d), touched: v.touched, qualified: v.qualified, appts: appts?.[d] ?? 0 };
        });
      })(),
      intent: intents.length
        ? intents.slice(0, 8).map((r, i) => ({ label: r.value, value: r.count, color: COLORS[i % COLORS.length] }))
        : [],
      queries: intents.length
        ? intents.slice(0, 8).map((r) => ({ label: r.value, total: r.count, resolved: r.qualified }))
        : [],
      // v3: per-intent outcome mix (IB "what customers wanted & how it was handled"). Call-side only —
      // intent comes from IRA, which exists only for calls. Inbound agents only.
      intentOutcomes: inbound && intents.length
        ? intents.slice(0, 8).map((r) => ({ label: r.value, conversations: r.count, resolved: r.qualified, booked: r.appts, transferred: r.transferred, callback: r.callbacks }))
        : undefined,
      multiDayReply: replies.length
        ? REPLY_ORDER.filter((o) => replies.some((r) => r.value === o)).map((o) => {
            const r = replies.find((x) => x.value === o)!;
            return { day: REPLY_LABEL[o], pct: r.count ? Math.round((100 * r.qualified) / r.count) : 0 };
          })
        : [],
      summary: {
        ...a.report.summary,
        // Real agent name from the dealer's onboarded-agents config; fall back to the mock persona.
        person: onboardedNames?.[base.id]?.trim() || a.report.summary.person,
        conversations: connected,
        apptsBooked: appointments,
        bookingRate: leadQualified ? Math.round((appointments / leadQualified) * 100) : 0,
      },
    };

    // ── outbound disposition mix → "Outbound outcomes" widget. Sourced from card 12231
    //    (report_outcomes), attached in the cumulative-detail block below (it's rooftop-wide, not
    //    window-scoped, so it must survive the quiet-agent zeroing — like campaigns). ──

    // ── inbound-only: leads by source + speed to lead. Always assigned from live data (or cleared) —
    //    never left as the cloned mock when there's nothing live to show. ──
    // "Leads by source": prefer the window-distinct RPC (sourceCounts: COUNT(DISTINCT lead_id) per
    // source — exact). Fall back to the per-day breakdown rollup (lead-days; over-counts cross-day leads)
    // only when the RPC is unavailable. Both map onto Total leads / Interacted (two-way) / Booked.
    const srcRows = sourceCounts?.[type];
    // Leads by source — shown for BOTH inbound (where leads came from) and outbound (which list/source
    // the dialed leads came from). Prefer the window-distinct RPC; fall back to the breakdown rollup.
    /* CANONICAL FIRST. Every stage here is the same windowed, lead-grain rule as the funnel above, so
       the card's "contacted" column equals the agent's Leads reached instead of being a second count
       of the same thing. The two fallbacks below are untouched. */
    /* GATED ON DEPARTMENT, not direction alone. The only producer fetches dept:"sales"
       (api/reports/route.ts), so keying on base.dir by itself handed the SALES lead-source table to
       Service Inbound / Service Outbound — a source table contradicting the funnel printed directly
       above it on the same card, and carried into that agent's CSV/XLSX/PDF export. The rung overlay
       above is dept-safe because it matches on agentType; this one has to say so explicitly. */
    const canonSrc =
      base.dept === "Service"
        ? undefined
        : canonicalLeadSources?.[base.dir === "Inbound" ? "inbound" : "outbound"]?.leadSources;
    a.report.leadsBySource = canonSrc && canonSrc.length
      ? toLeadsBySource(canonSrc).slice(0, 8)
      : srcRows && srcRows.length
        ? srcRows.slice(0, 8).map((s) => ({ source: s.source, interacted: s.interacted, engaged: s.interacted, total: s.total, handoffs: 0, appts: s.booked }))
        : sources.length
          ? sources.slice(0, 8).map((r) => ({ source: r.value, interacted: r.qualified, engaged: r.qualified, total: r.count, handoffs: 0, appts: r.appts }))
          : undefined;
    // Speed-to-lead is a SALES INBOUND concept only — service inbound has no new-CRM-lead funnel,
    // so it never shows the card (base.id gate, not just `inbound`).
    if (base.id === "sales_ib") {
      const newLeads = sum(rows, (r) => r.new_leads);
      const within5 = sum(rows, (r) => r.stl_within5);
      const within1 = sum(rows, (r) => r.stl_within1);
      const stlSec = sum(rows, (r) => r.stl_seconds_sum);
      const stlCnt = sum(rows, (r) => r.stl_count);
      const afterHoursInstant = sum(rows, (r) => r.stl_afterhours_within5);
      const instantAppts = sum(rows, (r) => r.stl_within5_appts);
      a.report.speedToLead = (newLeads || stlCnt)
        ? {
            avg: stlCnt ? fmtHandle(stlSec / stlCnt) : "—",
            avgSec: stlCnt ? Math.round(stlSec / stlCnt) : null, // numeric basis for the fleet "Response time" tile
            pctWithin5: newLeads ? Math.round((100 * within5) / newLeads) : 0,
            crmLeadsNew: newLeads,
            instantlyTouched: within5,
            afterHoursInstant,
            instantAppts,
            instantApptRate: within5 ? Math.round((100 * instantAppts) / within5) : 0,
            // median first-response ≤ 1 min ⇔ at least half of measured leads were touched within 1 min.
            // false (slow, or no measurable leads) → the UI pitches the STL upsell instead of the card.
            medianUnderMin: stlCnt > 0 && within1 * 2 >= stlCnt,
            missedCalledBack: 0, // no Q12227 source
            pctTouched: 0,
            note: "",
          }
        : undefined;
    } else {
      a.report.speedToLead = undefined;
    }

    // ── real period-over-period deltas vs prior window ──
    const pb = prior[base.id];
    if (pb) {
      const abrPrev = pb.qualified ? Math.round((pb.appointments / pb.qualified) * 100) : 0;
      a.report.deltas = {
        leadsAttempted: pctDelta(leadsAttempted, pb.leads),
        // unique-lead basis (matches the funnel's qualified stage), not the qualified-events flag-sum
        leadsQualified: pctDelta(leadQualified, pb.qualified),
        appointments: pctDelta(appointments, pb.appointments),
        totalCalls: pctDelta(calls, pb.calls),
        totalSms: pctDelta(smsSent, pb.sms),
        abr: pctDelta(a.report.abr, abrPrev),
      };
    }

    // No activity in this window → strip the mock visuals that fall back when there are no rows,
    // so the agent reads as a genuine zero (metrics/report counts are already 0 from empty sums).
    if (!rows.length) {
      a.trend7 = a.trend7.map(() => 0);
      a.hourly = a.hourly.map(() => 0);
      a.channelSplit = { voice: 0, sms: 0 };
      a.report = {
        ...a.report,
        intent: [],
        queries: [],
        multiDayReply: [],
        /* KEPT when the canonical API supplied it. This block exists to stop the cloned MOCK leaking
           on an agent with no rows — but an empty aggregate no longer means no activity, and wiping a
           real canonical list here left the card blank on exactly the rooftops the migration fixes.
           trend7 / hourly / channelSplit above stay zeroed: we do not serve those, so mock values
           there would be fabricated. */
        leadsBySource: canonSrc && canonSrc.length ? a.report.leadsBySource : undefined,
        speedToLead: undefined,
        outcomes: undefined,
        intentOutcomes: undefined,
      };
    }

    // Rooftop-level detail, attached after the zeroing above so it survives for quiet agents (a warm
    // lead or callback is still workable on a day the agent made no calls).
    // Dead legacy fields — explicitly undefined so the cloned mock never leaks fabricated rows.
    a.report.upcomingAppointments = undefined; // served live by /api/meetings (agents page card)
    a.report.moneyOnTable = undefined; // retired with the $ layer (source table dropped in 0011)
    // Callbacks scoped to the agent's DEPARTMENT (sales agents → sales leads' callbacks, service →
    // service) so a service-heavy rooftop's follow-ups don't leak onto the Sales cards. Rows with an
    // unknown/blank service_type fall back to showing (better than hiding a real callback).
    const dept = base.dept === "Service" ? "service" : "sales";
    const dir = inbound ? "ib" : "ob";
    const myCallbacks = callbackItems.filter((c) => !c.serviceType || c.serviceType === dept);
    a.report.followUps = myCallbacks.length
      ? myCallbacks.map((c) => ({ customer: c.customer, due: c.due, intent: c.intent, priority: c.priority }))
      : undefined;
    /* v3 named lists scoped to this agent: dept always, plus direction.
     *
     * ★ AN AI-BOOKED ROW WITH NO DIRECTION IS LISTED FOR NEITHER AGENT (fixed 2026-09-09). It used to be
     * listed for BOTH, which double-counted it across the two agents' sheets and put the list above the
     * card it sits under: on team 9923577d07 the Service Inbound export listed 89 AI-booked records
     * (87 inbound + 2 undirected) beside a card of 84, and the same 2 rows also appeared under Service
     * Outbound — 94 + 16 rows drawn from a rooftop that only has 103. The per-agent card cannot count an
     * appointment it cannot attribute, so the per-agent list must not either. They remain visible in the
     * rooftop-wide views (Overview, the Appointments tab), which is where an unattributed booking belongs.
     *
     * ASSISTED rows still show on both directions of the dept: they carry no direction by nature (a CRM
     * meeting has no call behind it) and are attributed lead-level, which is how the card counts them. */
    const myAppts = namedApptItems.filter((n) => n.serviceType === dept && (n.assisted || n.direction === (inbound ? "inbound" : "outbound")));
    a.report.namedAppointments = myAppts.length
      ? myAppts.map(({ direction: _d, ...rest }) => rest) // eslint-disable-line @typescript-eslint/no-unused-vars
      : undefined;
    const myWarm = warmLeadItems.filter((w) => w.serviceType === dept && w.source === dir);
    a.report.warmLeads = myWarm.length ? myWarm : undefined;
    if (!inbound) {
      const mine = campaignItems.filter((c) => c.agentType === type);
      a.report.activeCampaigns = mine.length
        ? mine.map((c) => ({ name: c.name, useCase: c.useCase, enrolled: c.enrolled, appts: c.appts, apptRate: c.apptRate, warmLeads: c.warmLeads, optOuts: c.optOuts, noReach: c.noReach }))
        : undefined;
      // Disposition mix, biggest slice first (the widget computes its own percentages from value).
      // `bucket` (raw, sort-prefixed) rides along for the canonical best→least table ordering.
      const mineOutcomes = outcomeItems.filter((o) => o.agentType === type);
      a.report.outcomes = mineOutcomes.length
        ? [...mineOutcomes].sort((x, y) => y.value - x.value).slice(0, 12).map((o) => ({ label: o.label, value: o.value, bucket: o.bucket }))
        : undefined;
    }


    /* ── CANONICAL OVERLAY, PART 2 ────────────────────────────────────────────────────────────
     * Runs AFTER a.report is assembled, because these three live on it.
     *
     * The deltas are the important one. Part 1 replaced the current-window numbers and the prior
     * basis with canonical ones, but the delta block above still divides the AGGREGATE's current by
     * the canonical prior — two different definitions on either side of one division, which is worse
     * than either alone. Recomputed here from a.metrics / a.leadFunnel, both already canonical.
     *
     * pctDelta returns null (not 0) when the prior window is empty, so "new rooftop" renders as a dash
     * rather than as fabricated growth. That matches the API's own deltaPct contract exactly.
     */
    if (canon) {
      a.report.callFlow = {
        ...a.report.callFlow,
        // Lead grain, matching the funnel — not the call-level count the aggregate sums.
        transferred: canon.transfers,
        transfersFailed: canon.transfersFailed,
      };

      const pbc = prior[base.id];
      if (pbc) {
        const abrNow = a.leadFunnel?.qualified
          ? Math.round((a.metrics.appointments / a.leadFunnel.qualified) * 100)
          : 0;
        const abrPrevC = pbc.qualified ? Math.round((pbc.appointments / pbc.qualified) * 100) : 0;
        a.report.deltas = {
          leadsAttempted: pctDelta(a.leadFunnel?.contacted ?? 0, pbc.leads),
          leadsQualified: pctDelta(a.leadFunnel?.qualified ?? 0, pbc.qualified),
          appointments: pctDelta(a.metrics.appointments, pbc.appointments),
          totalCalls: pctDelta(a.metrics.calls, pbc.calls),
          totalSms: pctDelta(a.metrics.smsSent, pbc.sms),
          abr: pctDelta(abrNow, abrPrevC),
        };
      }

      /* Speed to lead, Sales Inbound only — the API returns it for no one else, which matches the
         card's own `base.id === "sales_ib"` gate above. `medianUnderMin` reads the real median here
         instead of the aggregate's within1*2 >= count proxy. */
      const stl = canon.speedToLead;
      if (stl && base.id === "sales_ib") {
        a.report.speedToLead = {
          ...a.report.speedToLead,
          /* Explicit rather than only spread: a.report.speedToLead is optional, so on a rooftop with
             no aggregate rows the spread contributes nothing and these would be missing. */
          missedCalledBack: a.report.speedToLead?.missedCalledBack ?? 0,
          pctTouched: a.report.speedToLead?.pctTouched ?? 0,
          note: a.report.speedToLead?.note ?? "",
          avg: stl.newLeads ? fmtHandle(stl.avgSec) : "—",
          avgSec: stl.newLeads ? stl.avgSec : null,
          pctWithin5: stl.pctWithin5,
          crmLeadsNew: stl.newLeads,
          instantlyTouched: stl.instantlyTouched,
          afterHoursInstant: stl.afterHoursInstant,
          // Composed server-side against the MEETINGS set, not the warehouse — same rule as every
          // other appointment number on the page.
          instantAppts: stl.bookedFromAnInstantTouch ?? 0,
          instantApptRate: Math.round(stl.instantToAppointmentRate ?? 0),
          medianUnderMin: stl.newLeads > 0 && stl.medianSec <= 60,
        };
      }
    }

    return a;
  });

  // Rooftop-wide named lists for the Overview (per-agent scoped copies live on agent.report).
  const namedApptsOut: NamedAppt[] = namedApptItems.map(({ direction: _d, ...rest }) => rest); // eslint-disable-line @typescript-eslint/no-unused-vars
  return {
    agents,
    hasData,
    fetchedAt: Date.now(),
    capturedAfterHours: canonical?.rooftop.capturedAfterHours,
    rooftop: rooftopRungs(canonical, canonicalHotLeads),
    prior,
    namedAppointments: namedApptsOut.length ? namedApptsOut : undefined,
    warmLeads: warmLeadsOut.length ? warmLeadsOut : undefined,
  };
}
