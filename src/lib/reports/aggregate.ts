/* Reduce Q12227's event-level rows (one per conversation) into the materialized aggregate:
 * summable daily facts + tall breakdown distributions, both keyed by
 * (activity_day, team_id, agent_type). Pure + dependency-free so it can be unit/parity-tested
 * against a real Q12227 pull without touching Supabase. See schema.ts for the column→field mapping. */

import type { RawRow, AgentDailyRow, BreakdownRow, AggregateResult, BreakdownDim, LeadDayRow } from "./schema";
import { collectEarliestStl, stlCountsForGroup, type StlLeadEntry } from "./stl";
import { storeLocalDay } from "./tzMap";

const num = (v: unknown): number => {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const str = (v: unknown, fallback = ""): string => (v == null ? fallback : String(v));
const key = (day: string, team: string, type: string) => `${day}|${team}|${type}`;

// Hour-of-day 0–23 of an ISO timestamp, or null if unparseable. In the store's tz when `tz` is given
// (so the "hourly" 7a–6p chart reflects local call times, not UTC) — else UTC.
function hourOf(ts: string, tz?: string): number | null {
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return null;
  if (!tz) return d.getUTCHours();
  try {
    const s = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(d);
    const h = parseInt(s, 10);
    return Number.isFinite(h) ? h % 24 : d.getUTCHours(); // some envs render midnight as "24"
  } catch {
    return d.getUTCHours();
  }
}

export interface AggregateOpts {
  // Resolve a team_id to its IANA timezone. When provided, each row is bucketed by the team's LOCAL
  // day (derived from activity_ts) rather than the raw UTC `activity_day`.
  tzOf?: (teamId: string) => string | undefined;
  // Cross-day deduped earliest STL per lead (from mergeStlEarliest). When omitted, built from `rows`.
  stlEarliest?: Map<string, StlLeadEntry>;
}

// Whole-day offset between lead creation and an activity (>=0), or null.
function dayOffset(createdAt: string | null, ts: string): number | null {
  if (!createdAt) return null;
  const a = Date.parse(createdAt);
  const b = Date.parse(ts);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((b - a) / 86_400_000));
}
const offsetBucket = (o: number): string => (o >= 3 ? "3+" : String(o));

interface Acc extends AgentDailyRow {
  _leads: Set<string>;
  _apptLeads: Set<string>; // distinct leads with an appointment (the card counts these, not flag-sum)
}

function blankAcc(day: string, team: string, type: string, r: RawRow): Acc {
  return {
    activity_day: day, team_id: team, agent_type: type,
    enterprise_name: str(r.enterprise_name), rooftop_name: str(r.rooftop_name), rooftop_stage: str(r.rooftop_stage),
    calls: 0, sms_threads: 0, conv_count: 0, connected: 0, reached_person: 0, qualified: 0, appointments: 0,
    sms_sent: 0, sms_replied: 0, after_hours: 0, talk_seconds: 0, transfers: 0, callbacks: 0, query_resolved: 0,
    opt_outs: 0, leads_attempted: 0, quality_score_sum: 0, quality_basis: 0,
    new_leads: 0, stl_within5: 0, stl_within1: 0, stl_seconds_sum: 0, stl_count: 0,
    stl_afterhours_within5: 0, stl_within5_appts: 0,
    _leads: new Set(), _apptLeads: new Set(),
  };
}

type BAcc = Omit<BreakdownRow, never>;
const bkey = (g: string, dim: BreakdownDim, val: string) => `${g}${dim}${val}`;

export function aggregate(rows: RawRow[], opts: AggregateOpts = {}): AggregateResult {
  const dayOf = (team: string, activityTs: string, rawDay: string) =>
    storeLocalDay(activityTs, opts.tzOf?.(team), rawDay);
  const stl = opts.stlEarliest ?? collectEarliestStl(rows, undefined, { dayOf });

  const groups = new Map<string, Acc>();
  const breaks = new Map<string, BAcc>();
  const leadMap = new Map<string, LeadDayRow>(); // key: day|team|type|lead — one row per lead per day
  // "Leads by source" is a LEAD funnel, not an event count: per (day, team, type, source) we keep the
  // DISTINCT leads touched, the subset that engaged two-way, and the subset that booked. Summing these
  // per-day sets over a window gives lead-days (≈ distinct leads for short windows) — vastly closer to
  // truth than summing conversation events, which over-counts every lead by its number of touches.
  const srcMap = new Map<string, { activity_day: string; team_id: string; agent_type: string; source: string; leads: Set<string>; engaged: Set<string>; appt: Set<string> }>();

  const bump = (g: { activity_day: string; team_id: string; agent_type: string }, dim: BreakdownDim, val: string, count: number, qualified: number, appts: number) => {
    if (!val) return;
    const k = bkey(key(g.activity_day, g.team_id, g.agent_type), dim, val);
    let b = breaks.get(k);
    if (!b) { b = { activity_day: g.activity_day, team_id: g.team_id, agent_type: g.agent_type, dim, dim_value: val, count: 0, qualified: 0, appts: 0 }; breaks.set(k, b); }
    b.count += count; b.qualified += qualified; b.appts += appts;
  };

  for (const r of rows) {
    const team = str(r["cs.team_id"]);
    const type = str(r.agent_type);
    const day = dayOf(team, str(r.activity_ts), str(r.activity_day));
    if (!day || !team || !type) continue;

    const gk = key(day, team, type);
    let a = groups.get(gk);
    if (!a) { a = blankAcc(day, team, type, r); groups.set(gk, a); }

    const isCall = num(r.is_call), isSms = num(r.is_sms);
    a.calls += isCall;
    a.sms_threads += isSms;
    a.conv_count += 1;
    if (num(r.talk_seconds) > 0) a.connected += 1;
    a.reached_person += num(r.reached_person);
    a.qualified += num(r.qualified);
    a.sms_sent += num(r.n_sms_outbound);
    a.sms_replied += num(r.sms_replied);
    a.after_hours += num(r.after_hours);
    a.talk_seconds += num(r.talk_seconds);
    // transfers: prefer the spine's disposition-based `transferred` flag (set when ended_reason=
    // 'transferred') — it matches the Calls tab / console (Honda DTLA Jun 16: 94 ≈ 93). Fall back to the
    // legacy `had_transfer` (IRA/resolution flag) on older Q12227 versions that don't emit it — that one
    // undercounts ~⅓ (62 vs 94). Presence-checked (!= null) so a real 0 isn't read as "column absent".
    a.transfers += r.transferred != null ? num(r.transferred) : num(r.had_transfer);
    a.callbacks += num(r.had_callback);
    a.query_resolved += num(r.query_resolved);
    a.opt_outs += num(r.opted_out_sms);

    const lead = str(r["cs.lead_id"]);
    const leadSource = str(r.lead_source);
    if (lead) {
      a._leads.add(lead);
      if (num(r.appointment_booked)) a._apptLeads.add(lead);
      // lead-day grain → exact window-distinct counts at read time (vs summing daily distincts)
      const lk = `${day}|${team}|${type}|${lead}`;
      let ld = leadMap.get(lk);
      if (!ld) { ld = { team_id: team, agent_type: type, lead_id: lead, activity_day: day, lead_source: leadSource || null, dialed: false, connected: false, qualified: false, appointment: false }; leadMap.set(lk, ld); }
      else if (!ld.lead_source && leadSource) ld.lead_source = leadSource; // backfill source if first row lacked it
      if (num(r.is_call) > 0) ld.dialed = true;
      if (num(r.talk_seconds) > 0 || num(r.sms_replied) > 0) ld.connected = true; // two-way conversation
      if (num(r.qualified) > 0) ld.qualified = true;
      if (num(r.appointment_booked) > 0) ld.appointment = true;
    }

    const q = r.quality_score;
    if (q != null && Number.isFinite(Number(q))) { a.quality_score_sum += num(q); a.quality_basis += 1; }

    const intent = str(r.primary_intent);
    if (intent) bump(a, "intent", intent, 1, num(r.query_resolved), num(r.appointment_booked));
    // source breakdown is lead-distinct (see srcMap above), so it needs the lead id — not an event bump.
    // This per-day breakdown is now only a FALLBACK; the window-distinct truth comes from agent_lead_days
    // via report_source_counts (build.ts prefers it). Kept so a degraded read still shows something.
    const source = leadSource;
    if (source && lead) {
      const sk = `${day}|${team}|${type}|${source}`;
      let s = srcMap.get(sk);
      if (!s) { s = { activity_day: day, team_id: team, agent_type: type, source, leads: new Set(), engaged: new Set(), appt: new Set() }; srcMap.set(sk, s); }
      s.leads.add(lead);
      if (num(r.talk_seconds) > 0 || num(r.sms_replied) > 0) s.engaged.add(lead); // two-way conversation
      if (num(r.appointment_booked) > 0) s.appt.add(lead);
    }
    const h = hourOf(str(r.activity_ts), opts.tzOf?.(team));
    if (h != null) bump(a, "hour", String(h), isCall || 1, 0, 0);
    if (isSms) {
      const off = dayOffset(str(r.lead_created_at) || null, str(r.activity_ts));
      if (off != null) bump(a, "reply_offset", offsetBucket(off), 1, num(r.sms_replied), 0);
    }
  }

  const daily: AgentDailyRow[] = [];
  for (const a of groups.values()) {
    a.leads_attempted = a._leads.size;
    a.appointments = a._apptLeads.size;
    const stlCols = stlCountsForGroup(stl, a.activity_day, a.team_id, a.agent_type);
    Object.assign(a, stlCols);
    a.talk_seconds = Math.round(a.talk_seconds);
    a.quality_score_sum = Math.round(a.quality_score_sum);
    a.stl_seconds_sum = Math.round(a.stl_seconds_sum);
    const { _leads, _apptLeads, ...row } = a; // eslint-disable-line @typescript-eslint/no-unused-vars
    daily.push(row);
  }
  // Materialize the lead-distinct source breakdown into the same tall table the other dims use.
  // For dim='source': count = distinct leads touched, qualified = distinct two-way-engaged leads,
  // appts = distinct leads that booked (all per day; build.ts maps these onto Interacted/Total/Booked).
  for (const s of srcMap.values()) {
    const k = bkey(key(s.activity_day, s.team_id, s.agent_type), "source", s.source);
    breaks.set(k, { activity_day: s.activity_day, team_id: s.team_id, agent_type: s.agent_type, dim: "source", dim_value: s.source, count: s.leads.size, qualified: s.engaged.size, appts: s.appt.size });
  }
  return { daily, breakdown: Array.from(breaks.values()), leadDays: Array.from(leadMap.values()) };
}
