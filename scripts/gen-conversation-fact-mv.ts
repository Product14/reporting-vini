/* Generate the ClickHouse refreshable-MV DDL for the conversation spine, DIRECTLY from
 * src/lib/reports/agentBaseFact.sql — the single source of truth.
 *
 * WHY THIS EXISTS (read before hand-editing anything it emits):
 * The Supabase aggregate path (scripts/backfill.ts → agent_daily / agent_daily_breakdown /
 * agent_lead_days) has two structural defects that cost us four months of reporting data on
 * 2026-08-21:
 *   1. DDL lives in supabase/migrations/ and is applied by NOBODY on deploy. Migration 0021 added
 *      agent_daily.chats; aggregate.ts started writing it the same day; the column never existed in
 *      prod, so every insert failed with PGRST204.
 *   2. syncChunk() DELETEs a day-range BEFORE it INSERTs. The delete commits, the insert throws, and
 *      the window is gone. The daily --full pass does this across FULL_RECONCILE_DAYS (120) at once.
 * Net effect: agent_daily's newest row froze at 2026-04-24 while every GitHub Actions run stayed
 * green (runChunk swallows per-chunk errors and the process exits 0).
 *
 * A refreshable MV removes BOTH failure modes by construction:
 *   • The schema IS the SELECT. There is no second system holding DDL that can go unapplied.
 *   • `REFRESH ... TO <target>` computes into a temp table and swaps. A FAILED refresh leaves the
 *     target's previous contents intact — the exact inverse of delete-then-insert.
 *
 * THE RULE THIS SCRIPT ENFORCES: the MV is GENERATED from the spine, never hand-written. dev's
 * existing vini_reporting.conversation_fact is a hand-frozen snapshot of this same spine from months
 * ago, and it has silently drifted from canonical — measured against the current spine it is missing
 * web chat (no is_chat/qualified_via_chat), the callback→outbound re-attribution (48 calls sat in
 * Sales Inbound instead of Sales Outbound for one rooftop), the Sales Outbound campaign-outcome
 * qualified rule (25 → 9), the Sales Inbound report.qualified rule, the 25-label buying-intent
 * vocabulary, and the meta.source='warm_transfer' appointment exclusion (329 meetings across 24 teams
 * in 45d wrongly counted as AI-booked). Regenerate instead of patching, or it drifts again.
 *
 * Usage:
 *   npx tsx scripts/gen-conversation-fact-mv.ts                    # emit DDL + validate the SELECT
 *   npx tsx scripts/gen-conversation-fact-mv.ts --floor=2025-09-01 # override the history floor
 *   npx tsx scripts/gen-conversation-fact-mv.ts --out=path.sql
 *
 * This script is READ-ONLY against ClickHouse: it uses DESCRIBE to resolve the SELECT's column types
 * (which also proves the query parses and analyzes) and writes the DDL to a file. Our credential holds
 * dev_readonly_role, so APPLYING the DDL needs a write-capable credential — hand the emitted file to
 * whoever owns the ClickHouse cluster. Nothing here mutates the cluster.
 */
import fs from "node:fs";
import { loadSpineSql } from "../src/lib/reports/spineSql";
import { queryRows } from "../src/lib/reports/clickhouseQuery";

for (const line of fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8").split("\n") : []) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
}

const arg = (k: string, d: string) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};

const DB = arg("db", "vini_reporting");
// Distinct from dev's live conversation_fact / rmv_conversation_fact so this can be built and diffed
// side-by-side without disturbing whatever still reads theirs. Rename at cutover, not before.
const TARGET = arg("target", "conversation_fact_canonical");
const VIEW = arg("view", "rmv_conversation_fact_canonical");
const FLOOR = arg("floor", "2025-09-01"); // dev's MV starts 2025-09-19; keep at least that much history
const EVERY = arg("every", "30 MINUTE");
const OUT = arg("out", `supabase/../clickhouse/${TARGET}.sql`);

/* The spine's terminal SELECT aliases two columns with a DOT — `cs.lead_id AS "cs.lead_id"` — because
 * the Node aggregator reads them off the JSON row by that literal key. A dotted identifier cannot be a
 * MergeTree sorting key, and `team_id` is the leading key here, so flatten both. Anchored on the exact
 * emitted text; if the spine renames them this throws rather than silently producing a table whose
 * ORDER BY doesn't resolve. */
function flattenAliases(sql: string): string {
  let out = sql;
  for (const col of ["lead_id", "team_id"]) {
    const from = `cs.${col} AS "cs.${col}"`;
    if (!out.includes(from)) throw new Error(`spine no longer emits \`${from}\` — update flattenAliases()`);
    out = out.replace(from, `cs.${col} AS ${col}`);
  }
  return out;
}

/* ORDER BY / PARTITION BY columns must not be Nullable. The spine derives team_id, agent_type and
 * activity_day from non-null sources, but ClickHouse still infers Nullable through the LEFT JOINs, so
 * DESCRIBE reports e.g. Nullable(String). Strip the wrapper for the key columns only — a genuine null
 * here would be a spine bug we want to surface loudly, not silently bucket. */
const KEYS = ["team_id", "agent_type", "activity_day"];
const denull = (t: string) => t.replace(/^Nullable\((.*)\)$/, "$1");

(async () => {
  const select = flattenAliases(loadSpineSql(`toDate('${FLOOR}')`, "today() + 1"));

  // DESCRIBE analyzes without executing — cheap, and it proves the generated SELECT is valid.
  const cols = await queryRows<{ name: string; type: string }>(
    `DESCRIBE (${select})`,
  );
  if (!cols.length) throw new Error("DESCRIBE returned no columns");

  const missing = KEYS.filter((k) => !cols.some((c) => c.name === k));
  if (missing.length) throw new Error(`generated SELECT is missing key column(s): ${missing.join(", ")}`);

  const colDefs = cols
    .map((c) => `  \`${c.name}\` ${KEYS.includes(c.name) ? denull(c.type) : c.type}`)
    .join(",\n");

  const ddl = `-- GENERATED by scripts/gen-conversation-fact-mv.ts — DO NOT HAND-EDIT.
-- Source of truth: src/lib/reports/agentBaseFact.sql (callback→outbound attribution injected by
-- src/lib/reports/callbackAttribution.ts at load). Regenerate after ANY spine change:
--     npx tsx scripts/gen-conversation-fact-mv.ts
-- History floor: ${FLOOR}   Refresh: EVERY ${EVERY}   Columns: ${cols.length}

CREATE DATABASE IF NOT EXISTS ${DB};

-- Target table. \`REFRESH ... TO\` computes each refresh into a temp table and swaps it in, so a FAILED
-- refresh leaves these rows untouched. That is the property the Supabase delete-then-insert path
-- lacked. Sorting key matches the read pattern of every reporting query (team + agent + day), so a
-- per-rooftop windowed read is a primary-key prefix scan.
CREATE TABLE IF NOT EXISTS ${DB}.${TARGET} (
${colDefs}
)
ENGINE = SharedMergeTree
PARTITION BY toYYYYMM(activity_day)
ORDER BY (${KEYS.join(", ")});

-- The refreshable MV. Full recompute every ${EVERY}; the window is [${FLOOR}, today()+1) so it always
-- covers through the current day. Measured cost of this scan on prod: ~58M rows read, 62-104s,
-- 6.6-7.9 GiB peak against a 57.6 GiB cluster ceiling.
CREATE OR REPLACE MATERIALIZED VIEW ${DB}.${VIEW}
REFRESH EVERY ${EVERY}
TO ${DB}.${TARGET}
AS
${select};
`;

  fs.mkdirSync(OUT.replace(/\/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(OUT, ddl);

  const chat = cols.filter((c) => /chat/i.test(c.name)).map((c) => c.name);
  console.log(`✓ validated + wrote ${OUT}`);
  console.log(`  columns: ${cols.length}  (target ${DB}.${TARGET}, view ${DB}.${VIEW})`);
  console.log(`  chat channel carried: ${chat.length ? chat.join(", ") : "NONE — spine regression, investigate"}`);
  console.log(`  keys forced non-null: ${KEYS.join(", ")}`);
  console.log(`\n  NOTE: applying this needs a write-capable ClickHouse credential (ours is dev_readonly_role).`);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
