/* WHICH ENTERPRISE A REQUEST IS ABOUT — the one input every enterprise-keyed upstream call needs
 * (the canonical /conversation/reports/*, dealer-leads /reports/action-items, the live meetings feed).
 *
 * THE BUG THIS EXISTS FOR (audit A2 F1/F18, 2026-10-08). The digest cron authorizes with CRON_SECRET and
 * forwards no dealer token. `enterpriseIdFromToken(null)` then fell back to the ENV `SPYNE_API_TOKEN` —
 * one fixed enterprise, not the rooftop's — and the dealer-leads action-item stats answered that
 * mismatched pair with a clean 200 full of zeros. Every digest since 2026-10-01 printed 0 overdue /
 * 0 closed. The canonical overview calls carry the same wrong enterprise and only work while that
 * backend ignores the parameter.
 *
 * THE RULE.
 *   • Dealer token on the request → the enterprise that token carries (unchanged behaviour).
 *   • Service caller (CRON_SECRET) with no dealer token → NEVER the env token. The rooftop's own
 *     enterprise from eventila.enterprise_team_details, cross-checked against an explicit
 *     `?enterprise_id=` when the caller sends one. No trustworthy answer → null, and the caller skips the
 *     upstream path for its ClickHouse / aggregate fallback rather than reading another enterprise.
 *   • No credential at all (only reachable under `next dev`, see requireTeamAuth) → the env fallback,
 *     exactly as before: that is the local-dev convenience the env token exists for. */

import { cached, decodeTokenPayload } from "@/lib/spyne/client";
import { enterpriseIdFromToken } from "@/lib/spyne/meetings";
import { runClickhouse, chEsc, hasClickhouseCreds } from "@/lib/spyne/clickhouse";
import { isServiceRequest } from "@/lib/reports/auth";

const idOk = (s: string) => /^[A-Za-z0-9_-]{1,64}$/.test(s);

export type EnterpriseSource = "token" | "param" | "team-map" | "env-dev" | "none";
export interface EnterpriseDecision {
  enterpriseId: string | null;
  source: EnterpriseSource;
  /** Why a service caller got no enterprise — for logs and the response's `upstream` note. */
  reason?: string;
}

/* PURE. The enterprise a service (CRON_SECRET) caller may use for `teamId`, given the explicit param it
 * sent (if any) and the team's enterprise(s) per the id map (null = the lookup itself failed).
 * Strict on a mismatch: a param naming a different enterprise is a caller bug, and silently "correcting"
 * it would hide that bug — so it yields none rather than either id. */
export function serviceEnterprise(param: string | null | undefined, teamEnterprises: string[] | null): EnterpriseDecision {
  if (teamEnterprises === null) return { enterpriseId: null, source: "none", reason: "team→enterprise lookup unavailable" };
  const known = teamEnterprises.filter(idOk);
  if (!known.length) return { enterpriseId: null, source: "none", reason: "team not mapped to an enterprise" };
  const p = (param ?? "").trim();
  if (p) {
    return known.includes(p)
      ? { enterpriseId: p, source: "param" }
      : { enterpriseId: null, source: "none", reason: "enterprise_id does not match team_id" };
  }
  return known.length === 1
    ? { enterpriseId: known[0], source: "team-map" }
    : { enterpriseId: null, source: "none", reason: "team maps to more than one enterprise" };
}

/* The team's enterprise id(s) from eventila.enterprise_team_details (unique per team in prod: 0 of
 * 935,289 teams map to two). Cached per instance (10 min, successes only). null on any failure or when
 * the team is unmapped — the two are not distinguished because neither is trustworthy. */
export async function lookupTeamEnterprises(teamId: string): Promise<string[] | null> {
  if (!idOk(teamId) || !hasClickhouseCreds()) return null;
  return cached(`team-ent:${teamId}`, async () => {
    const rows = await runClickhouse<{ e?: string }>(
      `SELECT DISTINCT toString(enterprise_id) AS e FROM eventila.enterprise_team_details WHERE team_id = '${chEsc(teamId)}'`,
    );
    const ids = rows.map((r) => String(r.e ?? "").trim()).filter(Boolean);
    return ids.length ? ids : null;
  });
}

/* The enterprise for this request (see the rule at the top). `preferParam` keeps /api/meetings' existing
 * contract for DEALER callers — an explicit ?enterprise_id= wins over the token there (the host scopes
 * the iframe with it) — while every other route keeps reading the token. `lookup` is injectable for tests. */
export async function resolveRequestEnterprise(
  request: Request,
  teamId: string,
  spyneToken: string | null,
  opts: { preferParam?: boolean; lookup?: (teamId: string) => Promise<string[] | null> } = {},
): Promise<EnterpriseDecision> {
  const param = (new URL(request.url).searchParams.get("enterprise_id") || "").trim() || null;
  const service = isServiceRequest(request);
  if (service) {
    /* Validated even when a token rides along (?auth_key= / X-Spyne-Token): the service secret can read
       any team, and the cron forwards ONE token for every rooftop, so neither the param nor that token's
       enterprise says anything about this team until the id map confirms it. */
    const known = await (opts.lookup ?? lookupTeamEnterprises)(teamId);
    const decided = serviceEnterprise(param, known);
    if (decided.enterpriseId || !spyneToken || known !== null) return decided;
    /* The map itself is unavailable AND a request token rides along: keep the route's pre-existing
       behaviour for that token-carrying call (the explicit param on /api/meetings, else the token's own
       enterprise), never the env token's. A mismatch against a WORKING map stays rejected above. */
    if (opts.preferParam && param && idOk(param)) return { enterpriseId: param, source: "param" };
    const fromToken = tokenEnterprise(spyneToken);
    return fromToken ? { enterpriseId: fromToken, source: "token" } : decided;
  }
  if (spyneToken) {
    if (opts.preferParam && param && idOk(param)) return { enterpriseId: param, source: "param" };
    return { enterpriseId: enterpriseIdFromToken(spyneToken), source: "token" };
  }
  // No credential: only reachable in a non-production runtime (requireTeamAuth 401s it in prod).
  if (opts.preferParam && param && idOk(param)) return { enterpriseId: param, source: "param" };
  return { enterpriseId: enterpriseIdFromToken(null), source: "env-dev" };
}

/* The enterprise a REQUEST token carries, with no env fallback (enterpriseIdFromToken would fall back to
 * SPYNE_ENTERPRISE_ID when the token does not decode). */
function tokenEnterprise(token: string): string | null {
  const p = decodeTokenPayload(token.trim());
  const id = p?.enterpriseId ?? p?.enterprise_id;
  return typeof id === "string" && id ? id : null;
}
