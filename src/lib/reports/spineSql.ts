/* Loads the conversation spine (agentBaseFact.sql) with the callback→outbound rule injected once, the
 * reseller scope resolved, and the {START} date-floor substituted. Server-only (reads the .sql off
 * disk) — used by the ETL (scripts/backfill.ts), never bundled into a Vercel route.
 *
 * The callback injection and the {RESELLER_SCOPE} substitution both happen at module load (once);
 * loadSpineSql only swaps the date floor, so a caller can cheaply produce the hot-window vs
 * full-reconcile variants. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyCallbackOutboundAttribution } from "./callbackAttribution";
import { resellerScope } from "./enterpriseScope";

const here = dirname(fileURLToPath(import.meta.url));
const RESELLER_PLACEHOLDER = "{RESELLER_SCOPE}";
const RAW = readFileSync(join(here, "agentBaseFact.sql"), "utf8");
// Assert rather than silently no-op: losing this placeholder means the spine falls back to whatever
// literal predicate replaced it, quietly dropping the allowlisted rooftops from reporting again.
if (!RAW.includes(RESELLER_PLACEHOLDER)) {
  throw new Error(
    `[spineSql] agentBaseFact.sql is missing the ${RESELLER_PLACEHOLDER} placeholder — the reseller` +
      " screen must come from enterpriseScope.ts, not a hand-written predicate",
  );
}
const SPINE = applyCallbackOutboundAttribution(
  RAW.replaceAll(RESELLER_PLACEHOLDER, resellerScope("ed")),
  "agentBaseFact.sql",
);

/** The spine with callback attribution applied and the {START}/{END} window substituted — ClickHouse
 *  date expressions bounding `toDate(createdAt)` to `[startFloor, endCeil)`. Both bounds keep each scan
 *  to a small window (the ETL chunks a long backfill into many of these), so the read never approaches
 *  the cluster's memory ceiling. e.g. loadSpineSql("toDate('2026-06-01')", "toDate('2026-06-15')").
 *
 *  `teams` narrows lead_canonical to those rooftops ({TEAM_SCOPE}). This is an OPTIMIZER hint for
 *  scoped ETL runs, not an isolation boundary — the caller still filters and asserts on the result
 *  (see backfill.ts SCOPED MODE). Omit or pass [] for a normal fleet-wide run. */
export function loadSpineSql(startFloor: string, endCeil: string, teams: readonly string[] = []): string {
  const teamScope = teams.length
    ? `l.team_id IN (${teams.map((t) => `'${t.replace(/'/g, "''")}'`).join(", ")})`
    : "1=1";
  return SPINE
    .replaceAll("{START}", startFloor)
    .replaceAll("{END}", endCeil)
    .replaceAll("{TEAM_SCOPE}", teamScope);
}
