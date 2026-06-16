/* Persisted rooftop timezone map (Supabase `team_tz`, see migration 0006).
 *
 * A rooftop's tz almost never changes, so persisting it removes the per-run dependency on a live Spyne
 * token: any sync that fetches the live working-hours map seeds this table; later runs (and /api/reports)
 * read it as a fallback, so day/hour bucketing stays store-local even across token outages — the regression
 * that put Honda DTLA back on UTC. All best-effort: a missing table (migration not applied) or read/write
 * error degrades to the caller's prior behavior (UTC bucketing) rather than failing the sync.
 *
 * Kept out of tzMap.ts on purpose — tzMap is imported by the pure/parity-tested aggregate.ts, so it must
 * stay free of the Supabase dependency. */

import type { SupabaseClient } from "@supabase/supabase-js";
import { TEAM_TZ } from "./supabase";

/** Upsert a team_id→tz map into team_tz (refreshes updated_at). No-op on empty map; swallows errors. */
export async function saveTzMap(sb: SupabaseClient, map: Map<string, string>, nowIso: string): Promise<void> {
  if (map.size === 0) return;
  const rows = [...map].map(([team_id, timezone]) => ({ team_id, timezone, updated_at: nowIso }));
  try {
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await sb.from(TEAM_TZ).upsert(rows.slice(i, i + 500), { onConflict: "team_id" });
      if (error) { console.warn(`team_tz upsert skipped: ${error.message} — has migration 0006 been applied?`); return; }
    }
    console.log(`tz: persisted ${rows.length} rooftops → ${TEAM_TZ}`);
  } catch (e) {
    console.warn(`team_tz upsert skipped: ${(e as Error).message}`);
  }
}

/** Load the whole persisted team_id→tz map (empty on missing table / error). */
export async function loadTzMap(sb: SupabaseClient): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const { data, error } = await sb.from(TEAM_TZ).select("team_id, timezone");
    if (error || !Array.isArray(data)) return map;
    for (const r of data as Array<{ team_id?: string; timezone?: string }>) {
      if (r.team_id && r.timezone) map.set(r.team_id, r.timezone);
    }
  } catch { /* degrade to empty → UTC bucketing */ }
  return map;
}

/** Persisted tz for a single rooftop, or null (used by /api/reports when the live API can't be reached). */
export async function loadTeamTz(sb: SupabaseClient, teamId: string): Promise<string | null> {
  if (!teamId) return null;
  try {
    const { data, error } = await sb.from(TEAM_TZ).select("timezone").eq("team_id", teamId).maybeSingle();
    if (error || !data) return null;
    return (data as { timezone?: string }).timezone || null;
  } catch {
    return null;
  }
}
