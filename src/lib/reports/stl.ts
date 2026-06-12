/* Speed-to-lead helpers — isolated from the main aggregate so STL cross-day dedup does not
 * touch any other metric. Each lead contributes at most once, on the activity_day of their
 * earliest is_speed_to_lead conversation (by activity_ts). */

import type { RawRow, AgentDailyRow } from "./schema";
import type { DayOfFn } from "./tzMap";

export interface StlLeadEntry {
  team_id: string;
  agent_type: string;
  lead_id: string;
  activity_day: string;
  activity_ts: string;
  response_sec: number | null;
  after_hours: number;
  had_appt: number;
}

export interface StlLeadFirstRow {
  team_id: string;
  agent_type: string;
  lead_id: string;
  activity_day: string;
  activity_ts: string;
  response_sec: number | null;
}

export interface StlCollectOpts {
  dayOf?: DayOfFn;
}

const num = (v: unknown): number => {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const str = (v: unknown, fallback = ""): string => (v == null ? fallback : String(v));

/** Cap each lead's contribution to stl_seconds_sum (the average numerator). Raw times stay in
 * stl_lead_first for debugging; within-5-min still uses the uncapped value vs 300s. */
export const STL_AVG_CAP_SEC = 600; // 10 minutes

export function stlLeadKey(team: string, type: string, lead: string): string {
  return `${team}|${type}|${lead}`;
}

/** Merge STL rows into a per-lead map, keeping the earliest activity_ts per lead. */
export function collectEarliestStl(
  rows: RawRow[],
  prior?: Map<string, StlLeadEntry>,
  opts: StlCollectOpts = {},
): Map<string, StlLeadEntry> {
  const map = prior ? new Map(prior) : new Map<string, StlLeadEntry>();
  for (const r of rows) {
    if (num(r.is_speed_to_lead) !== 1) continue;
    const team = str(r["cs.team_id"]);
    const type = str(r.agent_type);
    const lead = str(r["cs.lead_id"]);
    const rawDay = str(r.activity_day);
    const activityTs = str(r.activity_ts);
    const ts = Date.parse(activityTs);
    if (!team || !type || !lead || !rawDay || !Number.isFinite(ts)) continue;
    const day = opts.dayOf?.(team, activityTs, rawDay) ?? rawDay;
    const rt = r.speed_to_lead_response_time;
    const responseSec = rt != null && Number.isFinite(Number(rt)) ? num(rt) : null;
    const k = stlLeadKey(team, type, lead);
    const prev = map.get(k);
    if (!prev || ts < Date.parse(prev.activity_ts)) {
      map.set(k, {
        team_id: team,
        agent_type: type,
        lead_id: lead,
        activity_day: day,
        activity_ts: activityTs,
        response_sec: responseSec,
        after_hours: num(r.after_hours) > 0 ? 1 : 0,
        had_appt: num(r.appointment_booked) > 0 ? 1 : 0,
      });
    }
  }
  return map;
}

export type StlDailyCounts = Pick<
  AgentDailyRow,
  "new_leads" | "stl_within5" | "stl_within1" | "stl_seconds_sum" | "stl_count" | "stl_afterhours_within5" | "stl_within5_appts"
>;

export function stlCountsForGroup(
  earliest: Map<string, StlLeadEntry>,
  day: string,
  team: string,
  type: string,
): StlDailyCounts {
  let new_leads = 0;
  let stl_within5 = 0;
  let stl_within1 = 0;
  let stl_seconds_sum = 0;
  let stl_count = 0;
  let stl_afterhours_within5 = 0;
  let stl_within5_appts = 0;
  for (const e of earliest.values()) {
    if (e.activity_day !== day || e.team_id !== team || e.agent_type !== type) continue;
    new_leads += 1;
    if (e.response_sec == null) continue;
    stl_count += 1;
    stl_seconds_sum += Math.min(e.response_sec, STL_AVG_CAP_SEC);
    if (e.response_sec <= 60) stl_within1 += 1;
    if (e.response_sec <= 300) {
      stl_within5 += 1;
      if (e.after_hours) stl_afterhours_within5 += 1;
      if (e.had_appt) stl_within5_appts += 1;
    }
  }
  return { new_leads, stl_within5, stl_within1, stl_seconds_sum, stl_count, stl_afterhours_within5, stl_within5_appts };
}

export function stlRowsToMap(rows: StlLeadFirstRow[]): Map<string, StlLeadEntry> {
  const map = new Map<string, StlLeadEntry>();
  for (const r of rows) {
    map.set(stlLeadKey(r.team_id, r.agent_type, r.lead_id), {
      team_id: r.team_id,
      agent_type: r.agent_type,
      lead_id: r.lead_id,
      activity_day: r.activity_day,
      activity_ts: r.activity_ts,
      response_sec: r.response_sec,
      after_hours: 0,
      had_appt: 0,
    });
  }
  return map;
}

export function stlEntryToRow(e: StlLeadEntry): StlLeadFirstRow {
  return {
    team_id: e.team_id,
    agent_type: e.agent_type,
    lead_id: e.lead_id,
    activity_day: e.activity_day,
    activity_ts: e.activity_ts,
    response_sec: e.response_sec,
  };
}

const ZERO_STL: StlDailyCounts = {
  new_leads: 0, stl_within5: 0, stl_within1: 0, stl_seconds_sum: 0, stl_count: 0,
  stl_afterhours_within5: 0, stl_within5_appts: 0,
};

export function stlColumnsChanged(row: StlDailyCounts, next: StlDailyCounts): boolean {
  return (Object.keys(ZERO_STL) as (keyof StlDailyCounts)[]).some((k) => row[k] !== next[k]);
}

export { ZERO_STL };
