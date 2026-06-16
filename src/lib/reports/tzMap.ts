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

/* One rooftop's IANA timezone from the Spyne get-working-days endpoint, or null.
 *
 * This is the CUSTOMER-scoped endpoint (`user-management/v1/team/get-working-days`), keyed by teamId.
 * It's what works in prod: the report iframe forwards the dealer's own bearer token, which can't reach
 * the admin-tools route the report used before. It also currently requires no token at all, so the sync
 * (which has no customer token) can resolve every rooftop's tz too — including brand-new ones — with no
 * admin credential. The optional `token` is forwarded when present (harmless) but is not required. */
export async function fetchTeamTz(teamId: string, token?: string | null): Promise<string | null> {
  if (!teamId) return null;
  const base = process.env.SPYNE_API_BASE || "https://api.spyne.ai";
  try {
    const headers: Record<string, string> = { accept: "application/json, text/plain, */*" };
    if (token && token.trim()) headers.authorization = `Bearer ${token.trim()}`;
    const res = await fetch(`${base}/user-management/v1/team/get-working-days?teamId=${encodeURIComponent(teamId)}`, {
      headers,
      cache: "no-store",
    });
    if (!res.ok) return null;
    const json = await res.json();
    const tz = json?.data?.timezone;
    return tz ? String(tz) : null;
  } catch {
    return null;
  }
}

/* Resolve tz for a set of rooftops (concurrency-limited), dropping any that don't resolve. Used by the
 * sync to build the re-bucketing map for exactly the teams present in the pulled data. */
export async function fetchTeamTzs(teamIds: string[], token?: string | null, concurrency = 16): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const ids = [...new Set(teamIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += concurrency) {
    const batch = ids.slice(i, i + concurrency);
    const tzs = await Promise.all(batch.map((t) => fetchTeamTz(t, token)));
    batch.forEach((t, j) => { const tz = tzs[j]; if (tz) map.set(t, tz); });
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
