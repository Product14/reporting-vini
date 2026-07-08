/* Enterprise ↔ rooftop (team) mapping, resolved from production ClickHouse.
 *
 * The Supabase aggregate (agent_daily / agent_lead_days) is keyed by team_id and carries only an
 * enterprise_NAME, never an enterprise_ID. The canonical id↔id map lives in ClickHouse
 * (eventila.enterprise_team_details), so the bulk metrics API resolves its team universe here: which
 * team_ids belong to a set of enterprises, plus the display names and the test-account flag used to
 * drop internal/test rooftops.
 *
 * Read-only, degrades to [] (never throws) exactly like the rest of the CH client — a mapping hiccup
 * yields an empty universe (→ empty page), never a 502.
 */
import { runClickhouse, chEsc, hasClickhouseCreds } from "@/lib/spyne/clickhouse";

export interface TeamMeta {
  teamId: string;
  enterpriseId: string;
  teamName: string;
  dealerName: string;
  isTest: boolean;
}

// Same id shape the other routes validate (see /api/customers). Guards the inlined IN lists.
const idOk = (s: string) => /^[A-Za-z0-9_-]{1,64}$/.test(s);

/** IN (...) clause from validated ids, or "" when the filter is absent (no restriction on that column). */
function inClause(col: string, ids: string[]): string {
  const clean = ids.filter(idOk);
  if (!clean.length) return "";
  return ` AND ${col} IN (${clean.map((v) => `'${chEsc(v)}'`).join(",")})`;
}

/* Resolve the rooftop universe for a bulk request.
 *  - enterpriseIds present → only teams under those enterprises.
 *  - teamIds present       → only those teams (further narrowed by enterpriseIds if both are given).
 *  - neither               → every mapped team (the "all rooftops" case).
 * Deduped to one row per team_id (a team can appear under several role_name rows). Test accounts are
 * dropped unless includeTest. Returned sorted by (enterpriseId, teamId) so the caller can paginate
 * deterministically BEFORE fetching any metrics. */
export async function resolveTeams(opts: {
  enterpriseIds?: string[];
  teamIds?: string[];
  includeTest?: boolean;
}): Promise<TeamMeta[]> {
  if (!hasClickhouseCreds()) return [];

  // A teamIds filter that survives validation to empty (all ids malformed) must mean "no teams", not
  // "all teams" — otherwise a garbage filter silently widens to the whole fleet. Same for enterpriseIds.
  const entIds = (opts.enterpriseIds ?? []).filter(idOk);
  const teamIds = (opts.teamIds ?? []).filter(idOk);
  if ((opts.enterpriseIds?.length && !entIds.length) || (opts.teamIds?.length && !teamIds.length)) {
    return [];
  }

  const sql =
    "SELECT team_id AS teamId," +
    " any(enterprise_id) AS enterpriseId," +
    " any(team_name) AS teamName," +
    " any(ifNull(dealer_name,'')) AS dealerName," +
    " max(ifNull(is_test_account,0)) AS isTest" +
    " FROM eventila.enterprise_team_details" +
    " WHERE 1=1" +
    inClause("enterprise_id", entIds) +
    inClause("team_id", teamIds) +
    " GROUP BY team_id" +
    (opts.includeTest ? "" : " HAVING isTest = 0") +
    " ORDER BY enterpriseId, teamId";

  const rows = await runClickhouse<Record<string, string | number>>(sql);
  return rows.map((r) => ({
    teamId: String(r.teamId || ""),
    enterpriseId: String(r.enterpriseId || ""),
    teamName: String(r.teamName || ""),
    dealerName: String(r.dealerName || ""),
    isTest: Number(r.isTest) === 1,
  })).filter((t) => t.teamId);
}
