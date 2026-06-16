/* Store-local day bucketing + Spyne working-hours timezone lookup (used by sync/backfill).
 * Kept dependency-light (no Supabase) so aggregate.ts stays pure/parity-testable — the persisted
 * team_tz map lives in tzStore.ts. */

import type { RawRow } from "./schema";

/** Calendar day (YYYY-MM-DD) of `activityTs` in `tz`, or `rawDay` when tz is missing/invalid. */
export function storeLocalDay(activityTs: string, tz: string | undefined, rawDay: string): string {
  if (!tz) return rawDay;
  const d = new Date(activityTs);
  if (!Number.isFinite(d.getTime())) return rawDay;
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  } catch {
    return rawDay;
  }
}

export type DayOfFn = (team: string, activityTs: string, rawDay: string) => string;

/* team_id → IANA timezone, from the Spyne working-hours API. Best-effort: without SPYNE_API_TOKEN,
 * returns an empty map → aggregate falls back to UTC bucketing. */
export async function fetchTzMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const token = process.env.SPYNE_API_TOKEN?.trim();
  const base = process.env.SPYNE_API_BASE || "https://api.spyne.ai";
  if (!token) return map;
  try {
    for (let page = 1; page <= 50; page++) {
      const res = await fetch(`${base}/conversation/admin-tools/working-hours?page=${page}&limit=200`, {
        headers: { accept: "application/json", authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`working-hours HTTP ${res.status}`);
      const json = await res.json();
      const data: Array<{ teamId?: string; timezone?: string }> = Array.isArray(json?.data) ? json.data : [];
      for (const row of data) {
        const team = String(row?.teamId || ""), tz = String(row?.timezone || "");
        if (team && tz) map.set(team, tz);
      }
      const totalPages = Number(json?.pagination?.totalPages) || 1;
      if (page >= totalPages || data.length === 0) break;
    }
  } catch {
    return new Map();
  }
  return map;
}

export function teamsInRows(rows: RawRow[]): string[] {
  const s = new Set<string>();
  for (const r of rows) {
    const t = String(r["cs.team_id"] ?? "").trim();
    if (t) s.add(t);
  }
  return [...s];
}
