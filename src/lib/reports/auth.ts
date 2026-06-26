/* Shared request auth for the read (GET) API routes.
 *
 * THE PROBLEM (P1-1). These routes return per-customer PII (names, phone numbers, call summaries,
 * action items) for ANY ?team_id with no auth at all — the Spyne token was only ever used for
 * enrichment, never required or checked against the requested rooftop. Anyone who can reach the
 * endpoint could enumerate every dealer's customers.
 *
 * THE AUTH MODEL. A caller authorizes a request in one of two ways:
 *   1. SERVICE — presents the shared CRON_SECRET (Authorization: Bearer <secret>, or ?key=<secret>).
 *      This is the trusted server-to-server path the digest/poll cron uses; it may read any team.
 *      Same secret that already guards the /api/reports/metrics ingest POST.
 *   2. SPYNE SESSION TOKEN — the dealer's forwarded session token (Authorization: Bearer …, or
 *      ?auth_key=/?spyne_token=/?token= — the same sources every route already reads for enrichment).
 *      The token is a base64-encoded JSON blob carrying enterprise_id + team_id (NOT a signed JWT —
 *      see meetings.ts enterpriseIdFromToken). When it carries a team scope, that scope MUST match the
 *      requested team_id (no cross-tenant reads). A token that decodes but carries no team_id is treated
 *      as a rooftop-agnostic session/admin token and is allowed (it's still a held credential).
 *
 * Why decode-and-compare rather than verify a signature: the token isn't signed, so this is a scope
 * check, not cryptographic auth. The real trust boundary for service traffic is CRON_SECRET; the token
 * check stops a browser/iframe session from reading a team other than the one it was issued for.
 *
 * NOTE ON THE CRON CALLER: the digest poll (vini-daily-calls server/roi-cron/eventRunner.cjs) must
 * forward a credential on these routes — either CRON_SECRET or the Spyne session token. Today it
 * forwards a token only to /api/meetings; the conversations / action-items / reports calls send none.
 * Those calls must be updated to send `Authorization: Bearer ${CRON_SECRET}` (preferred) or an
 * `auth_key`/`key` query param, or they will (correctly) start returning 401 once this guard is live.
 */

// Read the bearer credential from the same sources the enrichment path uses: the Authorization header
// first, then the auth_key/spyne_token/token query params. "Bearer " prefix stripped.
export function readBearer(request: Request): string | null {
  const url = new URL(request.url);
  const src = request.headers.get("authorization")
    || url.searchParams.get("auth_key")
    || url.searchParams.get("spyne_token")
    || url.searchParams.get("token")
    || "";
  const t = src.replace(/^Bearer\s+/i, "").trim();
  return t || null;
}

/* The Spyne session token to use for DOWNSTREAM Spyne API calls (live meetings, store timezone,
 * onboarded agents) — NOT for authorizing this request (that's requireTeamAuth). Reads the same sources
 * as readBearer, but the shared CRON_SECRET is NEVER a Spyne token: the service cron presents
 * CRON_SECRET (header bearer or ?key=) to AUTHORIZE, and forwards the real dealer session token
 * separately as ?auth_key=. The routes used to read the Authorization header first for this too, so the
 * CRON_SECRET shadowed the real token — every Spyne call 401'd and the live sections (the appointments
 * list, store timezone, onboarded agents) silently came back empty. Skip the secret and fall through to
 * the query-param token; resolveToken() then applies the env fallback for local dev. A browser still
 * works: it forwards its real session token in the Authorization header (≠ secret), which is used. */
export function spyneTokenFrom(request: Request): string | null {
  const url = new URL(request.url);
  const secret = process.env.CRON_SECRET;
  const candidates = [
    request.headers.get("authorization"),
    url.searchParams.get("auth_key"),
    url.searchParams.get("spyne_token"),
    url.searchParams.get("token"),
  ];
  for (const c of candidates) {
    const t = (c || "").replace(/^Bearer\s+/i, "").trim();
    if (!t) continue;
    if (secret && t === secret) continue; // the service secret authorizes; it is not a Spyne token
    return t;
  }
  return null;
}

// The team_id a Spyne session token is scoped to, or null when the token doesn't decode or carries no
// team scope. Mirrors enterpriseIdFromToken (meetings.ts): base64 → JSON → field.
function teamIdFromToken(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token, "base64").toString("utf8")) as { team_id?: string };
    const t = (payload?.team_id || "").trim();
    return t || null;
  } catch {
    return null;
  }
}

export type AuthResult = { ok: true } | { ok: false; status: 401 | 403; error: string };

/* Authorize a GET for `teamId`. SERVICE (CRON_SECRET) → allowed for any team. Otherwise a Spyne token
 * is required; if it carries a team scope it must equal teamId (else 403), and a token that decodes with
 * no team scope is accepted. No credential at all → 401. */
export function requireTeamAuth(request: Request, teamId: string): AuthResult {
  const cred = readBearer(request);
  if (!cred) return { ok: false, status: 401, error: "authentication required" };

  // SERVICE path: shared cron secret (header bearer or ?key=). Trusted server caller — any team.
  const secret = process.env.CRON_SECRET;
  const keyParam = new URL(request.url).searchParams.get("key");
  if (secret && (cred === secret || keyParam === secret)) return { ok: true };

  // SPYNE TOKEN path: enforce team scope when the token carries one.
  const scopedTeam = teamIdFromToken(cred);
  if (scopedTeam && scopedTeam !== teamId) {
    return { ok: false, status: 403, error: "token is not authorized for this team_id" };
  }
  // Valid credential present (CRON_SECRET unset in this env, or a token with no/ matching team scope).
  return { ok: true };
}
