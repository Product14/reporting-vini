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

export type SpyneEnv = "uat" | "stag" | "prod";

/* Which Spyne API to hit for a given iframe `env` (mirrors action-items-console's apiBaseForEnv, so a
 * dealer embedded with ?env=uat gets the UAT backend instead of always hitting prod). Absent/unrecognised
 * env (no host-forwarded env — e.g. an older embed, or a token-less background job) falls back to the
 * SPYNE_API_BASE override or prod, exactly as before this was per-request aware. */
export function apiBaseForEnv(env?: string | null): string {
  switch (env) {
    case "uat":
      return "https://uat-api.spyne.xyz";
    case "stag":
      return "https://beta-api.spyne.xyz";
    default:
      return process.env.SPYNE_API_BASE || "https://api.spyne.ai";
  }
}

// Per-request token wins (prod, host-forwarded); env token is the local-dev fallback.
export function resolveToken(override?: string | null): string | null {
  const t = (override && override.trim()) || process.env.SPYNE_API_TOKEN;
  return t && t.trim() ? t.trim() : null;
}

/** True when a credential is available (request-forwarded or env). */
export function spyneConfigured(token?: string | null): boolean {
  return resolveToken(token) !== null;
}

/* GET a JSON path from the Spyne API. Returns null on any failure (no token, network error, non-2xx,
 * bad JSON) so the report never breaks because an enrichment call hiccuped. Best-effort by design. */
/* Why `onError`: most callers (working hours, onboarded agents) genuinely want the "never throws,
 * degrade to null" contract — a hiccup on those shouldn't break the report. But one caller (the live
 * meetings feed, meetings.ts) needs to tell an auth/HTTP failure apart from a legitimately empty
 * result, because collapsing both to "nothing" is exactly what let a dead Spyne token look like zero
 * appointments fleet-wide for 40h (2026-09-19→21) with no alert anywhere. Rather than change the
 * return contract for every caller, failures are ALSO reported through this optional callback — pass
 * nothing and behavior is identical to before; a caller that cares can observe the reason without
 * spyneGet throwing. */
export async function spyneGet<T>(
  path: string,
  token?: string | null,
  env?: string | null,
  onError?: (info: { status: number | null; message: string }) => void,
): Promise<T | null> {
  const auth = resolveToken(token);
  if (!auth) {
    onError?.({ status: null, message: "no Spyne token configured" });
    return null;
  }
  const base = apiBaseForEnv(env);
  try {
    const r = await fetch(`${base}${path}`, {
      headers: { accept: "application/json, text/plain, */*", authorization: `Bearer ${auth}` },
      cache: "no-store",
    });
    if (!r.ok) {
      console.error(`[spyne] GET ${path} → ${r.status}`);
      onError?.({ status: r.status, message: `Spyne API returned HTTP ${r.status} for ${path}` });
      return null;
    }
    return (await r.json()) as T;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[spyne] GET ${path} failed: ${message}`);
    onError?.({ status: null, message: `Spyne API call failed: ${message}` });
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

/* Decode a Spyne session token's claims — WITHOUT verifying a signature; this only ever reads a
 * self-asserted claim (see auth.ts for the trust model that depends on it). Two shapes are live in
 * prod: an older opaque token, base64(JSON{authKey, deviceId, enterprise_id, team_id}) — decode the
 * whole string; and a signed JWT — three dot-separated segments, payload keys camelCase (enterpriseId,
 * teamId). Every caller that reads a claim from a Spyne token (meetings.ts enterpriseIdFromToken,
 * auth.ts decodeTokenScope) MUST go through this, not its own ad hoc decode — a decode that only
 * handles one shape silently breaks the moment the other shape is what's actually presented: the old
 * whole-string decode throws on every real JWT (3 segments glued with dots isn't valid base64), which
 * for auth.ts's caller means every real JWT-holding session gets REJECTED (403), not just degraded.
 * Returns null when the token doesn't decode to a JSON object in either shape. */
export function decodeTokenPayload(token: string): Record<string, unknown> | null {
  const decode = (segment: string): Record<string, unknown> | null => {
    try {
      // base64url (JWT segments use '-'/'_', no padding) → standard base64
      const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
      const parsed: unknown = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const parts = token.split(".");
  return parts.length === 3 ? decode(parts[1]) : decode(token);
}
