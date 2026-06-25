/* Loads the conversation spine (agentBaseFact.sql) with the callback→outbound rule injected once and
 * the {START} date-floor substituted. Server-only (reads the .sql off disk) — used by the ETL
 * (scripts/backfill.ts), never bundled into a Vercel route.
 *
 * The callback injection happens at module load (once); loadSpineSql only swaps the date floor, so a
 * caller can cheaply produce the hot-window vs full-reconcile variants. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyCallbackOutboundAttribution } from "./callbackAttribution";

const here = dirname(fileURLToPath(import.meta.url));
const SPINE = applyCallbackOutboundAttribution(
  readFileSync(join(here, "agentBaseFact.sql"), "utf8"),
  "agentBaseFact.sql",
);

/** The spine with callback attribution applied and the {START}/{END} window substituted — ClickHouse
 *  date expressions bounding `toDate(createdAt)` to `[startFloor, endCeil)`. Both bounds keep each scan
 *  to a small window (the ETL chunks a long backfill into many of these), so the read never approaches
 *  the cluster's memory ceiling. e.g. loadSpineSql("toDate('2026-06-01')", "toDate('2026-06-15')"). */
export function loadSpineSql(startFloor: string, endCeil: string): string {
  return SPINE.replaceAll("{START}", startFloor).replaceAll("{END}", endCeil);
}
