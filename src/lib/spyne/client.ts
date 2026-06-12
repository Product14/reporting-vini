/* Minimal server-only client for Spyne's product API (api.spyne.ai).
 *
 * Used by the report backend to enrich the materialized aggregate with two things Q12227 can't give us:
 *   • the rooftop's IANA timezone + working hours  (admin-tools/working-hours)  → timezone-correct windows
 *   • which agents the dealer actually has onboarded (agents/team/:id/onboarded-agents) → gate the report
 *
 * AUTH MODEL. Both endpoints need a Bearer token; the working-hours one is an admin-tools route, so it
 * needs an admin-scoped token.
 *   • PROD: the token is forwarded per-request from the host (passed into /api/reports) and handed to
 *     these functions as the `token` argument.
 *   • LOCAL DEV: falls back to `SPYNE_API_TOKEN` from the env (.env.local), so you don't need the host.
 * When neither is present every call returns null and callers degrade to the previous behavior (UTC
 * windows, all agents shown). The dashboard's token is a short-lived session JWT. See ONE_PAGER. */

const BASE = process.env.SPYNE_API_BASE || "https://api.spyne.ai";

// Per-request token wins (prod, host-forwarded); env token is the local-dev fallback.
function resolveToken(override?: string | null): string | null {
  const t = (override && override.trim()) || process.env.SPYNE_API_TOKEN;
  return t && t.trim() ? t.trim() : null;
}

/** True when a credential is available (request-forwarded or env). */
export function spyneConfigured(token?: string | null): boolean {
  return resolveToken(token) !== null;
}

/* GET a JSON path from the Spyne API. Returns null on any failure (no token, network error, non-2xx,
 * bad JSON) so the report never breaks because an enrichment call hiccuped. Best-effort by design. */
export async function spyneGet<T>(path: string, token?: string | null): Promise<T | null> {
  const auth = resolveToken(token);
  if (!auth) return null;
  try {
    const r = await fetch(`${BASE}${path}`, {
      headers: { accept: "application/json, text/plain, */*", authorization: `Bearer ${auth}` },
      cache: "no-store",
    });
    if (!r.ok) {
      console.error(`[spyne] GET ${path} → ${r.status}`);
      return null;
    }
    return (await r.json()) as T;
  } catch (e) {
    console.error(`[spyne] GET ${path} failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/* Tiny module-level TTL cache. Working hours / onboarded agents change rarely, but /api/reports is hit
 * per page load — without this each report would re-fetch both. Keyed by an arbitrary string. */
const cache = new Map<string, { at: number; value: unknown }>();
const TTL_MS = 10 * 60 * 1000; // 10 min

export async function cached<T>(key: string, load: () => Promise<T | null>): Promise<T | null> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T | null;
  const value = await load();
  // Cache successes only — a transient null shouldn't be pinned for 10 min.
  if (value !== null) cache.set(key, { at: Date.now(), value });
  return value;
}
