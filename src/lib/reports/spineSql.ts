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

/** The spine with callback attribution applied and {START} replaced by `startFloor` — a ClickHouse date
 *  expression, e.g. `toDate('2026-06-20')` or `addDays(today(), -3)`. Floors both the conversation_spine
 *  and ecr_events scans (and the injected callback CTE) to bound the read against the OOM ceiling. */
export function loadSpineSql(startFloor: string): string {
  return SPINE.replaceAll("{START}", startFloor);
}
