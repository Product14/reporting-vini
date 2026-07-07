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
 *      The token is a base64-encoded JSON blob carrying authKey + deviceId + enterprise_id + team_id
 *      (NOT a signed JWT — see meetings.ts enterpriseIdFromToken). Every genuine dealer token carries a
 *      team_id, and that team_id MUST equal the requested team_id (no cross-tenant reads). A token that
 *      carries a DIFFERENT team, NO team_id, or that does not decode to a JSON object is rejected (403).
 *      (It used to be that a no-team_id / undecodable token fell through to "allow any team" as a
 *      supposed admin credential — that let a forged `{"enterprise_id":…}` blob or literally any junk
 *      bearer read every rooftop's PII. There is no legitimate no-team_id dealer token, and the service
 *      caller uses CRON_SECRET, so blank-scope credentials are now denied.)
 *
 * Why decode-and-compare rather than verify a signature: the token isn't signed, so this is a scope
 * check, not cryptographic auth. The real trust boundary for service traffic is CRON_SECRET; the token
 * check stops a browser/iframe session from reading a team other than the one it was issued for.
 *
 * KNOWN RESIDUAL (Hole B — accepted, tracked). Because the token is unsigned, the team_id it carries is
 * a self-asserted claim: a caller holding ANY valid token can decode it, swap in a victim's team_id,
 * re-encode, and pass this check. Closing that requires a signed/host-verified scope token or a live
 * authKey→team verification against Spyne — a platform change, deferred by decision (2026-07-08). This
 * guard closes the UNAUTHENTICATED leak (no/garbage/blank-scope/wrong-team credential); it does not stop
 * forgery by a party who already holds a valid Spyne token.
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

/* The team scope a presented credential carries. A real Spyne session token is base64(JSON{authKey,
 * deviceId, enterprise_id, team_id}) (see meetings.ts) — it ALWAYS carries a team_id. So we distinguish
 * three cases, and only the first is a usable dealer credential:
 *   - "team"    → decoded to an object carrying a non-empty team_id (the real dealer token shape).
 *   - "noScope" → decoded to an object but with no team_id. No genuine dealer token looks like this; the
 *                 only thing that produces it is a hand-crafted blob. MUST NOT be treated as an any-team
 *                 admin credential (that was the forgery hole: `{"enterprise_id":"x"}` → read anything).
 *   - "invalid" → not a decodable JSON object at all (e.g. `Bearer garbage`). MUST be rejected — treating
 *                 it as "no scope → allow" let any junk bearer read every rooftop's PII with no account.
 * NOTE: the token is unsigned, so a "team" result is a self-asserted claim, not proof — a caller can still
 * forge `{team_id: <victim>}`. This function only tells us WHAT scope is claimed; closing forgery requires
 * verifying the credential server-side against Spyne (tracked separately). */
type TokenScope =
  | { kind: "team"; teamId: string }
  | { kind: "noScope" }
  | { kind: "invalid" };

function decodeTokenScope(token: string): TokenScope {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(token, "base64").toString("utf8"));
  } catch {
    return { kind: "invalid" };
  }
  if (!payload || typeof payload !== "object") return { kind: "invalid" };
  const raw = (payload as { team_id?: unknown }).team_id;
  const teamId = (typeof raw === "string" ? raw : "").trim();
  return teamId ? { kind: "team", teamId } : { kind: "noScope" };
}

export type AuthResult = { ok: true } | { ok: false; status: 401 | 403; error: string };

/* Authorize a GET for `teamId`. SERVICE (CRON_SECRET) → allowed for any team. Otherwise a Spyne session
 * token is required and its claimed team scope MUST equal teamId — a token that carries a different team
 * (403), no team at all (403), or doesn't decode (403) is rejected. No credential at all → 401.
 *
 * SCOPE OF THIS CHECK. The Spyne token is unsigned, so the team_id it carries is a self-asserted claim.
 * This guard stops (a) un-credentialed reads, (b) a session reading a team OTHER than the one its token
 * names, and (c) junk/blank-scope bearers that used to fall through to "allow any team". It does NOT by
 * itself stop a caller who forges `{team_id: <victim>}` — the token is not verified against Spyne here.
 * Closing that requires either a signed/host-verified scope token or a live authKey→team check. */
export function requireTeamAuth(request: Request, teamId: string): AuthResult {
  const cred = readBearer(request);

  // SERVICE path FIRST: the shared cron secret authorizes any team, presented as a bearer OR as ?key=.
  // Evaluated before the no-credential check so a service caller that presents ONLY ?key=<secret> (a
  // documented, supported form — readBearer does not read `key`, so `cred` is null in that case) is still
  // authorized instead of falling into the 401 below.
  const secret = process.env.CRON_SECRET;
  const keyParam = new URL(request.url).searchParams.get("key");
  if (secret && (cred === secret || keyParam === secret)) return { ok: true };

  if (!cred) {
    // LOCAL DEV bypass. The browser forwards NO credential locally — the host injects the dealer's
    // Spyne token (as ?auth_key=) only in prod, and the read-API client omits it (see liveData.ts).
    // Without this, every read route 401s under `next dev` and the report flips to the "on its way"
    // gate. Allow the request in a non-production runtime only; downstream Spyne enrichment still uses
    // the env SPYNE_API_TOKEN. Deployed envs (Vercel preview + prod) build with NODE_ENV=production, so
    // this never applies there and the guard stays fully enforced against un-credentialed reads.
    if (process.env.NODE_ENV !== "production") return { ok: true };
    return { ok: false, status: 401, error: "authentication required" };
  }

  // SPYNE TOKEN path: the token must carry a team scope, and it must equal the requested team. A token
  // with a different team, no team scope, or one that doesn't decode is NOT authorized for this rooftop.
  // (Previously a no-scope / undecodable token fell through to "allow any team" — a forged or garbage
  // bearer could then read any rooftop's PII. See decodeTokenScope.)
  const scope = decodeTokenScope(cred);
  if (scope.kind === "team" && scope.teamId === teamId) return { ok: true };
  return { ok: false, status: 403, error: "token is not authorized for this team_id" };
}
