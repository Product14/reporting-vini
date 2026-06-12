/* Persist and reconcile cross-day STL dedup during /api/sync and backfill. */

import type { SupabaseClient } from "@supabase/supabase-js";
import { STL_LEAD_FIRST } from "./supabase";
import type { AgentDailyRow, RawRow } from "./schema";
import {
  collectEarliestStl,
  stlColumnsChanged,
  stlCountsForGroup,
  stlEntryToRow,
  stlRowsToMap,
  type StlCollectOpts,
  type StlLeadEntry,
} from "./stl";
import { teamsInRows } from "./tzMap";

const CHUNK = 500;

const STL_COLS =
  "activity_day, team_id, agent_type, new_leads, stl_within5, stl_within1, stl_seconds_sum, stl_count, stl_afterhours_within5, stl_within5_appts";

async function loadPriorStl(sb: SupabaseClient, teamIds: string[]): Promise<Map<string, StlLeadEntry>> {
  if (!teamIds.length) return new Map();
  const { data, error } = await sb.from(STL_LEAD_FIRST).select("*").in("team_id", teamIds);
  if (error || !data?.length) return new Map();
  return stlRowsToMap(data as Parameters<typeof stlRowsToMap>[0]);
}

async function chunkedUpsert(sb: SupabaseClient, rows: ReturnType<typeof stlEntryToRow>[]): Promise<string | null> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await sb.from(STL_LEAD_FIRST).upsert(rows.slice(i, i + CHUNK), {
      onConflict: "team_id,agent_type,lead_id",
    });
    if (error) return error.message;
  }
  return null;
}

/** Merge batch STL rows with persisted earliest-per-lead state; upsert to stl_lead_first. */
export async function mergeStlEarliest(
  sb: SupabaseClient,
  rows: RawRow[],
  opts: { full: boolean; dayOf?: StlCollectOpts["dayOf"] },
): Promise<{ earliest: Map<string, StlLeadEntry>; tableMissing?: boolean }> {
  const teamIds = teamsInRows(rows);
  let prior = new Map<string, StlLeadEntry>();

  if (opts.full) {
    const { error: delErr } = await sb.from(STL_LEAD_FIRST).delete().gte("team_id", "");
    if (delErr?.code === "42P01") return { earliest: collectEarliestStl(rows, undefined, { dayOf: opts.dayOf }), tableMissing: true };
    if (delErr) throw new Error(`delete stl_lead_first: ${delErr.message}`);
  } else {
    prior = await loadPriorStl(sb, teamIds);
  }

  const earliest = collectEarliestStl(rows, opts.full ? undefined : prior, { dayOf: opts.dayOf });
  const toUpsert = [...earliest.values()].filter((e) => teamIds.includes(e.team_id)).map(stlEntryToRow);
  if (toUpsert.length) {
    const err = await chunkedUpsert(sb, toUpsert);
    if (err?.includes("does not exist") || err?.includes("42P01")) {
      return { earliest: collectEarliestStl(rows, undefined, { dayOf: opts.dayOf }), tableMissing: true };
    }
    if (err) throw new Error(`upsert stl_lead_first: ${err}`);
  }
  return { earliest };
}

/** Patch STL columns on agent_daily rows before the sync window (incremental only). */
export async function reconcileHistoricalStl(
  sb: SupabaseClient,
  teamIds: string[],
  earliest: Map<string, StlLeadEntry>,
  windowStart: string,
): Promise<number> {
  if (!teamIds.length || windowStart <= "1900-01-01") return 0;
  const { data, error } = await sb
    .from("agent_daily")
    .select(STL_COLS)
    .in("team_id", teamIds)
    .lt("activity_day", windowStart);
  if (error || !data?.length) return 0;

  let patched = 0;
  for (const row of data as AgentDailyRow[]) {
    const next = stlCountsForGroup(earliest, row.activity_day, row.team_id, row.agent_type);
    if (!stlColumnsChanged(row, next)) continue;
    const { error: upErr } = await sb
      .from("agent_daily")
      .update(next)
      .eq("activity_day", row.activity_day)
      .eq("team_id", row.team_id)
      .eq("agent_type", row.agent_type);
    if (!upErr) patched += 1;
  }
  return patched;
}
